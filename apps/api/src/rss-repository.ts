import { randomUUID } from "node:crypto";
import { redactSecretUrl, type BrowserCheckResult, type RssFilterConfig, type RssItemStatus, type SourceSite } from "@popcorn-queue/core";
import type { PrismaPersistence } from "./persistence.js";

export interface RssSettingsRecord {
  id: string;
  updateIntervalMs: number;
  updatedAt: string;
}

export interface RssSubscriptionRecord {
  id: string;
  name: string;
  site: SourceSite;
  feedUrl: string;
  feedUrlDisplay: string;
  enabled: boolean;
  filter: RssFilterConfig;
  lastFetchedAt: string | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RssPtpTarget {
  groupId: string;
  displayTitle: string;
  year: string | null;
  imdbId: string | null;
  ptpUrl: string;
  resolvedFrom: "imdb" | "title_year";
}

export interface RssItemRecord {
  id: string;
  subscriptionId: string;
  guid: string | null;
  sourceUrl: string | null;
  sourceUrlDisplay: string | null;
  downloadUrl: string | null;
  downloadUrlDisplay: string | null;
  title: string;
  subtitle: string | null;
  size: number | null;
  publishedAt: string | null;
  status: RssItemStatus;
  filterReason: string | null;
  checkResult: BrowserCheckResult | null;
  ptpTarget: RssPtpTarget | null;
  acceptedJobId: string | null;
  lastError: string | null;
  raw: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRssSubscriptionInput {
  name: string;
  site: SourceSite;
  feedUrl: string;
  enabled: boolean;
  filter: RssFilterConfig;
}

export interface UpsertRssItemInput {
  subscriptionId: string;
  guid: string | null;
  sourceUrl: string | null;
  downloadUrl: string | null;
  title: string;
  subtitle: string | null;
  size: number | null;
  publishedAt: string | null;
  status: RssItemStatus;
  filterReason: string | null;
  checkResult: BrowserCheckResult | null;
  ptpTarget: RssPtpTarget | null;
  raw: Record<string, unknown>;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  return value ? JSON.parse(value) as T : fallback;
}

function dateIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function optionalDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

export class PrismaRssSettingsRepository {
  constructor(private readonly persistence: PrismaPersistence) {}

  async get(): Promise<RssSettingsRecord> {
    await this.persistence.ensure();
    const row = await this.persistence.query(() => this.persistence.prisma.rssSettings.upsert({
      where: { id: "default" },
      create: { id: "default", updateIntervalMs: BigInt(600_000), updatedAt: new Date() },
      update: {}
    }));
    return { id: row.id, updateIntervalMs: Number(row.updateIntervalMs), updatedAt: row.updatedAt.toISOString() };
  }

  async update(input: { updateIntervalMs: number }): Promise<RssSettingsRecord> {
    await this.persistence.ensure();
    const row = await this.persistence.query(() => this.persistence.prisma.rssSettings.upsert({
      where: { id: "default" },
      create: { id: "default", updateIntervalMs: BigInt(input.updateIntervalMs), updatedAt: new Date() },
      update: { updateIntervalMs: BigInt(input.updateIntervalMs), updatedAt: new Date() }
    }));
    return { id: row.id, updateIntervalMs: Number(row.updateIntervalMs), updatedAt: row.updatedAt.toISOString() };
  }
}

export class PrismaRssSubscriptionRepository {
  constructor(private readonly persistence: PrismaPersistence) {}

  async create(input: CreateRssSubscriptionInput): Promise<RssSubscriptionRecord> {
    await this.persistence.ensure();
    const now = new Date();
    const row = await this.persistence.query(() => this.persistence.prisma.rssSubscription.create({
      data: {
        id: randomUUID(),
        name: input.name,
        site: input.site,
        feedUrl: input.feedUrl,
        enabled: input.enabled,
        filterJson: JSON.stringify(input.filter),
        createdAt: now,
        updatedAt: now
      }
    }));
    return this.deserialize(row);
  }

  async list(): Promise<RssSubscriptionRecord[]> {
    await this.persistence.ensure();
    const rows = await this.persistence.query(() => this.persistence.prisma.rssSubscription.findMany({ orderBy: { createdAt: "desc" } }));
    return rows.map((row) => this.deserialize(row));
  }

  async get(id: string): Promise<RssSubscriptionRecord | null> {
    await this.persistence.ensure();
    const row = await this.persistence.query(() => this.persistence.prisma.rssSubscription.findUnique({ where: { id } }));
    return row ? this.deserialize(row) : null;
  }

  async update(
    id: string,
    patch: Partial<CreateRssSubscriptionInput> & { lastFetchedAt?: string | null; lastRunStatus?: string | null; lastRunMessage?: string | null }
  ): Promise<RssSubscriptionRecord | null> {
    await this.persistence.ensure();
    const data: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.site !== undefined) data.site = patch.site;
    if (patch.feedUrl !== undefined) data.feedUrl = patch.feedUrl;
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    if (patch.filter !== undefined) data.filterJson = JSON.stringify(patch.filter);
    if (patch.lastFetchedAt !== undefined) data.lastFetchedAt = optionalDate(patch.lastFetchedAt);
    if (patch.lastRunStatus !== undefined) data.lastRunStatus = patch.lastRunStatus;
    if (patch.lastRunMessage !== undefined) data.lastRunMessage = patch.lastRunMessage;
    const row = await this.persistence.query(() => this.persistence.prisma.rssSubscription.update({ where: { id }, data }).catch(() => null));
    return row ? this.deserialize(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    await this.persistence.ensure();
    await this.persistence.query(() => this.persistence.prisma.rssItem.deleteMany({ where: { subscriptionId: id } }));
    const result = await this.persistence.query(() => this.persistence.prisma.rssSubscription.deleteMany({ where: { id } }));
    return result.count > 0;
  }

  private deserialize(row: {
    id: string;
    name: string;
    site: string;
    feedUrl: string;
    enabled: boolean;
    filterJson: string;
    lastFetchedAt: Date | null;
    lastRunStatus: string | null;
    lastRunMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): RssSubscriptionRecord {
    return {
      id: row.id,
      name: row.name,
      site: row.site as SourceSite,
      feedUrl: row.feedUrl,
      feedUrlDisplay: redactSecretUrl(row.feedUrl),
      enabled: row.enabled,
      filter: parseJson<RssFilterConfig>(row.filterJson, {}),
      lastFetchedAt: dateIso(row.lastFetchedAt),
      lastRunStatus: row.lastRunStatus,
      lastRunMessage: row.lastRunMessage,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    };
  }
}

export class PrismaRssItemRepository {
  constructor(private readonly persistence: PrismaPersistence) {}

  async upsertFromRefresh(input: UpsertRssItemInput): Promise<RssItemRecord> {
    await this.persistence.ensure();
    const existing = await this.findExisting(input);
    if (existing?.status === "ignored" || existing?.status === "accepted") return existing;
    const now = new Date();
    const data = {
      guid: input.guid,
      sourceUrl: input.sourceUrl,
      downloadUrl: input.downloadUrl,
      title: input.title,
      subtitle: input.subtitle,
      size: input.size === null ? null : BigInt(input.size),
      publishedAt: optionalDate(input.publishedAt),
      status: input.status,
      filterReason: input.filterReason,
      checkResultJson: input.checkResult ? JSON.stringify(input.checkResult) : null,
      ptpTargetJson: input.ptpTarget ? JSON.stringify(input.ptpTarget) : null,
      lastError: null,
      rawJson: JSON.stringify(input.raw),
      updatedAt: now
    };
    const row = existing
      ? await this.persistence.query(() => this.persistence.prisma.rssItem.update({ where: { id: existing.id }, data }))
      : await this.persistence.query(() => this.persistence.prisma.rssItem.create({
          data: { id: randomUUID(), subscriptionId: input.subscriptionId, ...data, createdAt: now }
        }));
    return this.deserialize(row);
  }

  async list(subscriptionId: string, options: { view?: "proposals" | "all"; status?: RssItemStatus } = {}): Promise<{ items: RssItemRecord[] }> {
    await this.persistence.ensure();
    const where: Record<string, unknown> = { subscriptionId };
    if (options.view === "proposals") where.status = "proposal";
    if (options.status) where.status = options.status;
    const rows = await this.persistence.query(() => this.persistence.prisma.rssItem.findMany({ where, orderBy: { createdAt: "desc" } }));
    return { items: rows.map((row) => this.deserialize(row)) };
  }

  async get(id: string): Promise<RssItemRecord | null> {
    await this.persistence.ensure();
    const row = await this.persistence.query(() => this.persistence.prisma.rssItem.findUnique({ where: { id } }));
    return row ? this.deserialize(row) : null;
  }

  async markIgnored(id: string): Promise<RssItemRecord | null> {
    return this.updateStatus(id, { status: "ignored", lastError: null });
  }

  async markAccepted(id: string, jobId: string): Promise<RssItemRecord | null> {
    return this.updateStatus(id, { status: "accepted", acceptedJobId: jobId, lastError: null });
  }

  async markAcceptError(id: string, error: string): Promise<RssItemRecord | null> {
    return this.updateStatus(id, { lastError: error });
  }

  async findAcceptedBySource(sourceUrl: string | null, downloadUrl: string | null): Promise<RssItemRecord | null> {
    await this.persistence.ensure();
    if (!sourceUrl && !downloadUrl) return null;
    const row = await this.persistence.query(() => this.persistence.prisma.rssItem.findFirst({
      where: {
        status: "accepted",
        OR: [
          ...(sourceUrl ? [{ sourceUrl }] : []),
          ...(downloadUrl ? [{ downloadUrl }] : [])
        ]
      }
    }));
    return row ? this.deserialize(row) : null;
  }

  private async updateStatus(id: string, patch: { status?: RssItemStatus; acceptedJobId?: string; lastError?: string | null }): Promise<RssItemRecord | null> {
    await this.persistence.ensure();
    const row = await this.persistence.query(() => this.persistence.prisma.rssItem.update({ where: { id }, data: { ...patch, updatedAt: new Date() } }).catch(() => null));
    return row ? this.deserialize(row) : null;
  }

  private async findExisting(input: UpsertRssItemInput): Promise<RssItemRecord | null> {
    const row = await this.persistence.query(() => this.persistence.prisma.rssItem.findFirst({
      where: {
        subscriptionId: input.subscriptionId,
        OR: [
          ...(input.guid ? [{ guid: input.guid }] : []),
          ...(input.sourceUrl ? [{ sourceUrl: input.sourceUrl }] : []),
          { title: input.title, publishedAt: optionalDate(input.publishedAt) }
        ]
      }
    }));
    return row ? this.deserialize(row) : null;
  }

  private deserialize(row: {
    id: string;
    subscriptionId: string;
    guid: string | null;
    sourceUrl: string | null;
    downloadUrl: string | null;
    title: string;
    subtitle: string | null;
    size: bigint | number | null;
    publishedAt: Date | null;
    status: string;
    filterReason: string | null;
    checkResultJson: string | null;
    ptpTargetJson: string | null;
    acceptedJobId: string | null;
    lastError: string | null;
    rawJson: string;
    createdAt: Date;
    updatedAt: Date;
  }): RssItemRecord {
    return {
      id: row.id,
      subscriptionId: row.subscriptionId,
      guid: row.guid,
      sourceUrl: row.sourceUrl,
      sourceUrlDisplay: row.sourceUrl ? redactSecretUrl(row.sourceUrl) : null,
      downloadUrl: row.downloadUrl,
      downloadUrlDisplay: row.downloadUrl ? redactSecretUrl(row.downloadUrl) : null,
      title: row.title,
      subtitle: row.subtitle,
      size: row.size === null ? null : Number(row.size),
      publishedAt: dateIso(row.publishedAt),
      status: row.status as RssItemStatus,
      filterReason: row.filterReason,
      checkResult: parseJson<BrowserCheckResult | null>(row.checkResultJson, null),
      ptpTarget: parseJson<RssPtpTarget | null>(row.ptpTargetJson, null),
      acceptedJobId: row.acceptedJobId,
      lastError: row.lastError,
      raw: parseJson<Record<string, unknown>>(row.rawJson, {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    };
  }
}
