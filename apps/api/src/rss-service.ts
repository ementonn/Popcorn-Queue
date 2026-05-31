import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
  buildJobWorkspacePaths,
  evaluateRssFilter,
  parseRssFeed,
  redactSecretUrl,
  rssItemStatusFromDecision,
  rssItemToTorrentCandidate,
  type BrowserCheckResult,
  type RssFilterConfig,
  type RssItemStatus,
  type SourceSite,
  type TorrentCandidate
} from "@popcorn-queue/core";
import { downloadTorrentFromUrl } from "./intake.js";
import type { Job, JobRepository } from "./jobs.js";
import type { RssItemRecord, RssPtpTarget, RssSettingsRecord, RssSubscriptionRecord, UpsertRssItemInput } from "./rss-repository.js";

export interface RssSettingsStore {
  get(): Promise<RssSettingsRecord>;
  update(input: { updateIntervalMs: number }): Promise<RssSettingsRecord>;
}

export interface RssSubscriptionStore {
  create(input: { name: string; site: SourceSite; feedUrl: string; enabled: boolean; filter: RssFilterConfig }): Promise<RssSubscriptionRecord>;
  list(): Promise<RssSubscriptionRecord[]>;
  get(id: string): Promise<RssSubscriptionRecord | null>;
  update(
    id: string,
    patch: Partial<{ name: string; site: SourceSite; feedUrl: string; enabled: boolean; filter: RssFilterConfig; lastFetchedAt: string | null; lastRunStatus: string | null; lastRunMessage: string | null }>
  ): Promise<RssSubscriptionRecord | null>;
  delete(id: string): Promise<boolean>;
}

export interface RssItemStore {
  upsertFromRefresh(input: UpsertRssItemInput): Promise<RssItemRecord>;
  list(subscriptionId: string, options: { view?: "proposals" | "all"; status?: RssItemStatus }): Promise<{ items: RssItemRecord[] }>;
  get(id: string): Promise<RssItemRecord | null>;
  markIgnored(id: string): Promise<RssItemRecord | null>;
  markAccepted(id: string, jobId: string): Promise<RssItemRecord | null>;
  markAcceptError(id: string, error: string): Promise<RssItemRecord | null>;
  findAcceptedBySource(sourceUrl: string | null, downloadUrl: string | null): Promise<RssItemRecord | null>;
}

export interface RssDuplicateCheckService {
  check(candidate: TorrentCandidate): Promise<BrowserCheckResult>;
}

export interface RssRefreshResult {
  subscriptionId: string;
  fetched: number;
  proposals: number;
  filtered: number;
  duplicates: number;
  errors: number;
}

type MaybePromise<T> = T | Promise<T>;

interface RssJobStore {
  createFromBrowser(input: Parameters<JobRepository["createFromBrowser"]>[0]): MaybePromise<Job>;
  attachWorkspace(id: string, input: Parameters<JobRepository["attachWorkspace"]>[1]): MaybePromise<Job | null>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown RSS error");
}

function sanitizeCandidate(candidate: TorrentCandidate): TorrentCandidate {
  const { downloadUrl: _downloadUrl, ...safeCandidate } = candidate;
  return safeCandidate;
}

function sanitizeCheckResult(result: BrowserCheckResult): BrowserCheckResult {
  return {
    ...result,
    candidate: sanitizeCandidate(result.candidate)
  };
}

function ptpTargetFromCheckResult(result: BrowserCheckResult): RssPtpTarget | null {
  const movie = result.decision.movie;
  const groupId = movie?.GroupId;
  const ptpUrl = result.decision.ptpUrl;
  if (!groupId || !ptpUrl) return null;
  const title = movie.Title ?? movie.Name ?? "PTP movie";
  const year = movie.Year ? String(movie.Year) : null;
  return {
    groupId: String(groupId),
    displayTitle: year ? `${title} [${year}]` : title,
    year,
    imdbId: movie.ImdbId ? String(movie.ImdbId) : result.candidate.imdbId ?? null,
    ptpUrl,
    resolvedFrom: result.candidate.imdbId ? "imdb" : "title_year"
  };
}

export class RssService {
  private readonly running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: {
    settings: RssSettingsStore;
    subscriptions: RssSubscriptionStore;
    items: RssItemStore;
    duplicateChecks: RssDuplicateCheckService;
    jobRepository: RssJobStore;
    dataRoot: string;
    fetchImpl: typeof fetch;
    enqueuePreparation(jobId: string): void;
  }) {}

  async refreshSubscription(subscriptionId: string): Promise<RssRefreshResult> {
    if (this.running.has(subscriptionId)) throw new Error("rss_refresh_already_running");
    this.running.add(subscriptionId);
    try {
      const subscription = await this.options.subscriptions.get(subscriptionId);
      if (!subscription) throw new Error("rss_subscription_not_found");
      const response = await this.options.fetchImpl(subscription.feedUrl);
      if (!response.ok) throw new Error(`rss_fetch_failed_${response.status}`);
      const parsed = parseRssFeed(await response.text(), { site: subscription.site });
      let proposals = 0;
      let filtered = 0;
      let duplicates = 0;
      let errors = 0;

      for (const parsedItem of parsed.items) {
        const filter = evaluateRssFilter(parsedItem, subscription.filter);
        if (!filter.passed) {
          filtered += 1;
          await this.options.items.upsertFromRefresh({ ...this.baseItem(subscription.id, parsedItem), status: "filtered", filterReason: filter.reason, checkResult: null, ptpTarget: null });
          continue;
        }

        const candidate = rssItemToTorrentCandidate(parsedItem);
        try {
          const rawCheckResult = await this.options.duplicateChecks.check(candidate);
          const checkResult = sanitizeCheckResult(rawCheckResult);
          const status = rssItemStatusFromDecision(checkResult.decision.status);
          if (status === "proposal") proposals += 1;
          else if (status === "duplicate_full" || status === "duplicate_skip") duplicates += 1;
          else errors += 1;
          await this.options.items.upsertFromRefresh({
            ...this.baseItem(subscription.id, parsedItem),
            status,
            filterReason: null,
            checkResult,
            ptpTarget: ptpTargetFromCheckResult(rawCheckResult)
          });
        } catch (error) {
          errors += 1;
          await this.options.items.upsertFromRefresh({
            ...this.baseItem(subscription.id, parsedItem),
            status: "check_error",
            filterReason: null,
            checkResult: null,
            ptpTarget: null,
            raw: { ...parsedItem.raw, error: errorMessage(error) }
          });
        }
      }

      await this.options.subscriptions.update(subscription.id, {
        lastFetchedAt: new Date().toISOString(),
        lastRunStatus: "ok",
        lastRunMessage: `Fetched ${parsed.items.length} item(s).`
      });
      return { subscriptionId, fetched: parsed.items.length, proposals, filtered, duplicates, errors };
    } catch (error) {
      await this.options.subscriptions.update(subscriptionId, {
        lastFetchedAt: new Date().toISOString(),
        lastRunStatus: "failed",
        lastRunMessage: errorMessage(error)
      });
      throw error;
    } finally {
      this.running.delete(subscriptionId);
    }
  }

  async acceptItem(itemId: string): Promise<{ item: RssItemRecord; job: Job }> {
    const item = await this.options.items.get(itemId);
    if (!item) throw new Error("rss_item_not_found");
    if (item.status !== "proposal") throw new Error("rss_item_not_proposal");
    if (!item.downloadUrl) throw new Error("rss_item_missing_download_url");
    const duplicate = await this.options.items.findAcceptedBySource(item.sourceUrl, item.downloadUrl);
    if (duplicate?.acceptedJobId) throw new Error(`rss_item_already_accepted:${duplicate.acceptedJobId}`);

    try {
      const torrent = await downloadTorrentFromUrl(item.downloadUrl, this.options.fetchImpl);
      const candidate: TorrentCandidate = {
        site: "unknown",
        title: item.title,
        ...(item.subtitle ? { subtitle: item.subtitle } : {}),
        ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {})
      };
      const checkResult = item.checkResult ? sanitizeCheckResult(item.checkResult) : null;
      const job = await this.options.jobRepository.createFromBrowser({
        candidate,
        ...(checkResult ? { checkResult } : {}),
        torrent: { filename: torrent.filename, bytes: torrent.bytes.byteLength, ...(torrent.contentType ? { contentType: torrent.contentType } : {}) },
        ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
        sourceSite: "rss",
        title: item.title
      });
      const paths = buildJobWorkspacePaths(this.options.dataRoot, job.id);
      await Promise.all([
        mkdir(paths.inputDir, { recursive: true }),
        mkdir(paths.torrentDir, { recursive: true }),
        mkdir(paths.sourceDownloadDir, { recursive: true }),
        mkdir(paths.logs.dir, { recursive: true })
      ]);
      await writeFile(paths.sourceTorrent, torrent.bytes);
      await writeFile(
        paths.sourceJson,
        `${JSON.stringify({ candidate, checkResult, rssItem: { id: item.id, sourceUrl: item.sourceUrl, ptpTarget: item.ptpTarget } }, null, 2)}\n`,
        "utf8"
      );
      const attached = await this.options.jobRepository.attachWorkspace(job.id, {
        workspace: { dataRoot: paths.dataRoot, jobRoot: paths.jobRoot, manifest: paths.manifest },
        torrentFilePath: paths.sourceTorrent,
        source: {
          site: "rss",
          title: item.title,
          ...(item.subtitle ? { subtitle: item.subtitle } : {}),
          ...(item.sourceUrl ? { url: item.sourceUrl } : {}),
          ...(item.ptpTarget ? { ptpTarget: item.ptpTarget } : {})
        }
      });
      const updatedItem = await this.options.items.markAccepted(item.id, job.id);
      this.options.enqueuePreparation(job.id);
      return { item: updatedItem ?? item, job: attached ?? job };
    } catch (error) {
      await this.options.items.markAcceptError(item.id, errorMessage(error));
      throw error;
    }
  }

  async ignoreItem(itemId: string): Promise<RssItemRecord> {
    const item = await this.options.items.markIgnored(itemId);
    if (!item) throw new Error("rss_item_not_found");
    return item;
  }

  async refreshEnabledSubscriptions(): Promise<void> {
    const subscriptions = await this.options.subscriptions.list();
    for (const subscription of subscriptions) {
      if (!subscription.enabled) continue;
      await this.refreshSubscription(subscription.id).catch(() => undefined);
    }
  }

  async startPolling(): Promise<void> {
    await this.stopPolling();
    const settings = await this.options.settings.get();
    this.timer = setInterval(() => {
      void this.refreshEnabledSubscriptions();
    }, settings.updateIntervalMs);
  }

  async stopPolling(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reschedule(): void {
    void this.startPolling();
  }

  private baseItem(subscriptionId: string, item: ReturnType<typeof parseRssFeed>["items"][number]) {
    return {
      subscriptionId,
      guid: item.guid,
      sourceUrl: item.sourceUrl,
      downloadUrl: item.downloadUrl,
      title: item.title,
      subtitle: item.subtitle,
      size: item.size,
      publishedAt: item.publishedAt,
      raw: item.raw
    };
  }
}

export class MemoryRssSettingsRepository implements RssSettingsStore {
  private settings: RssSettingsRecord = { id: "default", updateIntervalMs: 600_000, updatedAt: new Date(0).toISOString() };

  async get(): Promise<RssSettingsRecord> {
    return this.settings;
  }

  async update(input: { updateIntervalMs: number }): Promise<RssSettingsRecord> {
    this.settings = { id: "default", updateIntervalMs: input.updateIntervalMs, updatedAt: new Date().toISOString() };
    return this.settings;
  }
}

export class MemoryRssSubscriptionRepository implements RssSubscriptionStore {
  private subscriptions: RssSubscriptionRecord[] = [];

  async create(input: { name: string; site: SourceSite; feedUrl: string; enabled: boolean; filter: RssFilterConfig }): Promise<RssSubscriptionRecord> {
    const now = new Date().toISOString();
    const subscription: RssSubscriptionRecord = {
      id: randomUUID(),
      ...input,
      feedUrlDisplay: redactSecretUrl(input.feedUrl),
      lastFetchedAt: null,
      lastRunStatus: null,
      lastRunMessage: null,
      createdAt: now,
      updatedAt: now
    };
    this.subscriptions.unshift(subscription);
    return subscription;
  }

  async list(): Promise<RssSubscriptionRecord[]> {
    return this.subscriptions;
  }

  async get(id: string): Promise<RssSubscriptionRecord | null> {
    return this.subscriptions.find((item) => item.id === id) ?? null;
  }

  async update(id: string, patch: Partial<RssSubscriptionRecord>): Promise<RssSubscriptionRecord | null> {
    const index = this.subscriptions.findIndex((item) => item.id === id);
    if (index < 0) return null;
    this.subscriptions[index] = { ...this.subscriptions[index]!, ...patch, updatedAt: new Date().toISOString() };
    return this.subscriptions[index]!;
  }

  async delete(id: string): Promise<boolean> {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter((item) => item.id !== id);
    return this.subscriptions.length !== before;
  }
}

export class MemoryRssItemRepository implements RssItemStore {
  private items: RssItemRecord[] = [];

  async upsertFromRefresh(input: UpsertRssItemInput): Promise<RssItemRecord> {
    const existing = this.items.find(
      (item) => item.subscriptionId === input.subscriptionId && ((input.guid && item.guid === input.guid) || (input.sourceUrl && item.sourceUrl === input.sourceUrl))
    );
    if (existing?.status === "ignored" || existing?.status === "accepted") return existing;
    const now = new Date().toISOString();
    const next: RssItemRecord = {
      id: existing?.id ?? randomUUID(),
      ...input,
      sourceUrlDisplay: input.sourceUrl ? redactSecretUrl(input.sourceUrl) : null,
      downloadUrlDisplay: input.downloadUrl ? redactSecretUrl(input.downloadUrl) : null,
      acceptedJobId: existing?.acceptedJobId ?? null,
      lastError: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.items = [next, ...this.items.filter((item) => item.id !== next.id)];
    return next;
  }

  async list(subscriptionId: string, options: { view?: "proposals" | "all"; status?: RssItemStatus } = {}): Promise<{ items: RssItemRecord[] }> {
    return {
      items: this.items.filter(
        (item) =>
          item.subscriptionId === subscriptionId &&
          (options.view === "proposals" ? item.status === "proposal" : true) &&
          (!options.status || item.status === options.status)
      )
    };
  }

  async get(id: string): Promise<RssItemRecord | null> {
    return this.items.find((item) => item.id === id) ?? null;
  }

  async markIgnored(id: string): Promise<RssItemRecord | null> {
    return this.patch(id, { status: "ignored", lastError: null });
  }

  async markAccepted(id: string, jobId: string): Promise<RssItemRecord | null> {
    return this.patch(id, { status: "accepted", acceptedJobId: jobId, lastError: null });
  }

  async markAcceptError(id: string, error: string): Promise<RssItemRecord | null> {
    return this.patch(id, { lastError: error });
  }

  async findAcceptedBySource(sourceUrl: string | null, downloadUrl: string | null): Promise<RssItemRecord | null> {
    return this.items.find((item) => item.status === "accepted" && ((sourceUrl && item.sourceUrl === sourceUrl) || (downloadUrl && item.downloadUrl === downloadUrl))) ?? null;
  }

  private async patch(id: string, patch: Partial<RssItemRecord>): Promise<RssItemRecord | null> {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return null;
    this.items[index] = { ...this.items[index]!, ...patch, updatedAt: new Date().toISOString() };
    return this.items[index]!;
  }
}
