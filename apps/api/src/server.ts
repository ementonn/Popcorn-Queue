import { access, mkdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import {
  buildJobWorkspacePaths,
  makePtpCacheKey,
  type BrowserCheckResult,
  type CacheStore,
  type JobManifest,
  type NormalizedPtpResponse,
  type PtpMovie,
  type PtpTorrent,
  type ReviewDraftPatch,
  type TorrentCandidate,
  type UploadPhase
} from "@popcorn-queue/core";
import { BrowserCheckService, ImgBbUploader, PtpClient, PtpFormSubmitter, QBittorrentClient } from "@popcorn-queue/integrations";
import {
  PhaseRunner,
  checkWorkerTools,
  createPhaseContext,
  type CommandExecutor,
  type CreatePhaseContextOptions,
  type PhaseLogLevel,
  type PhaseOutputMap,
  type PtpCacheSyncInput,
  type PtpCacheSyncer,
  type PtpSubmitter,
  type TorrentDownloadClient,
  type WorkerTool
} from "@popcorn-queue/worker";
import type { ApiRouteContext, BuildServerOptions } from "./api-context.js";
import { WebSessionAuth, makeBrowserAuthHook } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { normalizeUploadedFilename } from "./filenames.js";
import { createManualIntakeJob, IntakeError, readManualIntakeRequest, resolveManualPtpTarget, searchPtpMovies, validateMediaPath } from "./intake.js";
import { appendJobEvent, readLogTail } from "./job-logs.js";
import { createApiLogger } from "./logger.js";
import { PrismaPersistence } from "./persistence.js";
import { PreparationService } from "./preparation.js";
import { registerApiRoutes } from "./routes/index.js";
import { defaultSettingsEnvPath, loadConfigFromEnvPath, saveSettingsEnv, settingsResponse, type SaveSettingsInput } from "./settings.js";
import { JOB_PHASES, RETRYABLE_COMPLETED_PHASES, type Job, type PhaseRun, type PhaseState } from "./jobs.js";

interface CreateManualJobBody extends Partial<TorrentCandidate> {
  title: string;
}

interface ImportJobBody {
  jobPath: string;
  manifest?: JobManifest;
}

type DeleteJobMode = "queue" | "downloads" | "everything";

interface DeleteJobBody {
  mode?: DeleteJobMode;
  confirm?: boolean;
}

type DiagnosticCheckStatus = "not_checked" | "ok" | "configured" | "missing" | "failed" | "disabled";
type DiagnosticCheckTarget = "qbittorrent" | "ptp" | "image-host" | "tools";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sqliteDatabasePath(): string | null {
  const databaseUrl = process.env.DATABASE_URL ?? "file:./popcorn-queue.db";
  if (!databaseUrl.startsWith("file:")) return null;
  const filePath = databaseUrl.slice("file:".length);
  if (!filePath || filePath.startsWith(":")) return null;
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

async function fileSize(filePath: string | null): Promise<number | null> {
  if (!filePath) return null;
  try {
    return (await stat(filePath)).size;
  } catch {
    return null;
  }
}

async function freeBytes(filePath: string): Promise<number | null> {
  try {
    const info = await statfs(filePath);
    return info.bavail * info.bsize;
  } catch {
    return null;
  }
}

async function cacheEntryCount(cache: unknown): Promise<number | null> {
  const maybeCount = (cache as { count?: () => Promise<number> }).count;
  if (!maybeCount) return null;
  try {
    return await maybeCount.call(cache);
  } catch {
    return null;
  }
}

function integrationSummary(config: ApiConfig, target: DiagnosticCheckTarget): { configured: boolean; status: DiagnosticCheckStatus; detail: string } {
  if (target === "qbittorrent") {
    const configured = Boolean(config.integrations.qbittorrentUrl);
    return {
      configured,
      status: "not_checked",
      detail: configured ? "qBittorrent is configured." : "qBittorrent URL is not configured."
    };
  }
  if (target === "ptp") {
    const configured = Boolean(config.ptp.apiUser && config.ptp.apiKey);
    return {
      configured,
      status: "not_checked",
      detail: configured ? "PTP API credentials are configured." : "PTP API user/key are not configured."
    };
  }
  if (target === "image-host") {
    const configured = (config.integrations.imageHost === "imgbb" && Boolean(config.integrations.imgbbApiKey)) || Boolean(config.integrations.ptpImgApiKey);
    return {
      configured,
      status: "not_checked",
      detail: configured ? `${config.integrations.imageHost || "image host"} is configured.` : "No image host API key is configured."
    };
  }
  return {
    configured: config.integrations.runExternalTools,
    status: "not_checked",
    detail: config.integrations.runExternalTools ? "External media tools are enabled." : "External tools are disabled."
  };
}

function toolCommandMap(config: ApiConfig): Partial<Record<WorkerTool, string>> {
  return {
    ffmpeg: config.integrations.ffmpegBin,
    mediainfo: config.integrations.mediainfoBin,
    mkvmerge: config.integrations.mkvmergeBin,
    mpv: config.integrations.mpvBin,
    oxipng: config.integrations.oxipngBin,
    "xvfb-run": config.integrations.xvfbRunBin
  };
}

function toolCheckStatus(tools: Awaited<ReturnType<typeof checkWorkerTools>>): DiagnosticCheckStatus {
  return Object.values(tools).every((tool) => tool.available) ? "ok" : "failed";
}

function optionalString(value: string | null | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

function uploadedPtpTorrent(input: PtpCacheSyncInput): PtpTorrent {
  const torrent: PtpTorrent = {
    Id: input.uploadResult.torrentId,
    Quality: input.parsed.qualityType,
    ReleaseName: input.releaseName,
    Trumpable: false,
    Seeders: 1
  };
  const source = optionalString(input.reviewDraft?.source) ?? optionalString(input.parsed.source);
  const codec = optionalString(input.reviewDraft?.codec) ?? optionalString(input.parsed.codec);
  const resolution = optionalString(input.reviewDraft?.resolution) ?? optionalString(input.parsed.resolution);
  const remasterTitle = optionalString(input.reviewDraft?.remasterTitle);
  if (source) torrent.Source = source;
  if (codec) torrent.Codec = codec;
  if (resolution) torrent.Resolution = resolution;
  if (remasterTitle) torrent.RemasterTitle = remasterTitle;
  return torrent;
}

function fallbackPtpMovie(input: PtpCacheSyncInput): PtpMovie {
  const movie = input.checkResult?.decision.movie;
  const fallback: PtpMovie = {
    ...(movie ?? {}),
    GroupId: input.uploadResult.groupId,
    Title: movie?.Title ?? input.parsed.searchName,
    Name: movie?.Name ?? movie?.Title ?? input.parsed.searchName,
    Torrents: movie?.Torrents ?? []
  };
  const year = movie?.Year ?? input.parsed.year;
  const imdbId = movie?.ImdbId ?? input.candidate.imdbId ?? null;
  if (year) fallback.Year = year;
  if (imdbId) fallback.ImdbId = imdbId;
  return fallback;
}

function withUploadedTorrent(movie: PtpMovie, torrent: PtpTorrent): PtpMovie {
  const torrents = (movie.Torrents ?? []).filter((item) => item.Id !== torrent.Id && item.ReleaseName !== torrent.ReleaseName);
  return {
    ...movie,
    Torrents: [...torrents, torrent]
  };
}

function syncUploadedTorrentData(data: NormalizedPtpResponse, input: PtpCacheSyncInput): { data: NormalizedPtpResponse; torrentCount: number } {
  const torrent = uploadedPtpTorrent(input);
  const groupId = input.uploadResult.groupId;
  const fallbackMovie = fallbackPtpMovie(input);
  let matched = false;
  let torrentCount = 1;
  const sourceMovies = data.movies.length ? data.movies : [fallbackMovie];
  const movies = sourceMovies.map((movie) => {
    if (movie.GroupId !== groupId) return movie;
    matched = true;
    const next = withUploadedTorrent(movie, torrent);
    torrentCount = next.Torrents?.length ?? 1;
    return next;
  });

  if (!matched) {
    const next = withUploadedTorrent(fallbackMovie, torrent);
    torrentCount = next.Torrents?.length ?? 1;
    movies.push(next);
  }

  return {
    data: {
      ...data,
      totalResults: data.totalResults ?? movies.length,
      movies
    },
    torrentCount
  };
}

function createPtpCacheSyncer(cache: CacheStore<NormalizedPtpResponse>): PtpCacheSyncer {
  return {
    async syncUpload(input) {
      const cacheKey = input.checkResult?.cache.key ?? makePtpCacheKey(input.candidate);
      const entry = await cache.get(cacheKey);
      const baseData = entry?.data ?? { movies: [] };
      const synced = syncUploadedTorrentData(baseData, input);
      await cache.set(cacheKey, synced.data);
      return {
        cacheKey,
        groupId: input.uploadResult.groupId,
        torrentId: input.uploadResult.torrentId,
        torrentCount: synced.torrentCount
      };
    }
  };
}

async function collectToolDiagnostics(config: ApiConfig, commandExecutor?: CommandExecutor) {
  return checkWorkerTools(commandExecutor, toolCommandMap(config));
}

function queueDiagnostics(jobs: Job[]) {
  const counts = {
    total: jobs.length,
    preparing: 0,
    review: 0,
    failed: 0,
    done: 0,
    paused: 0,
    uploading: 0,
    seeding: 0,
    needsReseed: 0
  };
  const staleCutoff = Date.now() - 30 * 60 * 1000;
  const stuck: Array<{ id: string; state: string; phase: string; updatedAt: string; title: string }> = [];
  const recentFailures: Array<{ id: string; message: string; title: string }> = [];

  for (const job of jobs) {
    if (job.state === "preparing") counts.preparing += 1;
    else if (job.state === "review") counts.review += 1;
    else if (job.state === "failed") counts.failed += 1;
    else if (job.state === "done") counts.done += 1;
    else if (job.state === "paused") counts.paused += 1;
    else if (job.state === "uploading") counts.uploading += 1;
    else if (job.state === "seeding") counts.seeding += 1;
    else if (job.state === "needs_reseed") counts.needsReseed += 1;

    const updatedAt = Date.parse(job.updatedAt);
    if ((job.state === "preparing" || job.state === "uploading") && Number.isFinite(updatedAt) && updatedAt < staleCutoff) {
      stuck.push({ id: job.id, state: job.state, phase: job.phase, updatedAt: job.updatedAt, title: job.artifacts.releaseName ?? job.candidate?.title ?? job.source.title ?? job.id });
    }
    if (job.state === "failed") {
      recentFailures.push({ id: job.id, message: job.events.at(0)?.message ?? job.humanStep, title: job.artifacts.releaseName ?? job.candidate?.title ?? job.source.title ?? job.id });
    }
  }

  return {
    ...counts,
    stuck: stuck.slice(0, 10),
    recentFailures: recentFailures.slice(0, 10)
  };
}

async function missingRestoredFiles(jobPath: string, manifest: JobManifest): Promise<string[]> {
  const relativePaths = [...manifest.uploadFiles];
  if (manifest.torrentFile) relativePaths.push(manifest.torrentFile);
  const missing: string[] = [];
  for (const relativePath of relativePaths) {
    if (!(await pathExists(path.join(jobPath, relativePath)))) missing.push(relativePath);
  }
  return missing;
}

function phaseStateFromStatus(status: PhaseOutputMap[UploadPhase]["status"]): PhaseState {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  return "warning";
}

function mergePhaseRuns(job: Job, outputs: Partial<PhaseOutputMap>): PhaseRun[] {
  return job.phases.map((run) => {
    const output = outputs[run.phase];
    if (!output) return run;
    const next: PhaseRun = {
      ...run,
      state: phaseStateFromStatus(output.status),
      message: output.message,
      finishedAt: output.producedAt
    };
    if (!next.startedAt) next.startedAt = output.producedAt;
    return next;
  });
}

function jobLogPath(config: ApiConfig, job: Job): string {
  return job.workspace?.jobRoot ? path.join(job.workspace.jobRoot, "logs", "job.log") : buildJobWorkspacePaths(config.paths.dataRoot, job.id).logs.jobLog;
}

function jobRootPath(config: ApiConfig, job: Job): string {
  return job.workspace?.jobRoot ?? buildJobWorkspacePaths(config.paths.dataRoot, job.id).jobRoot;
}

function isInsideOrEqual(parentPath: string, childPath: string | null | undefined): boolean {
  if (!childPath) return false;
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

interface TorrentCleanupResult {
  infoHash: string;
  role: "download" | "seed";
  status: "removed" | "skipped" | "failed";
  deleteData: boolean;
  message: string;
}

interface JobDeleteCleanupResult {
  localPaths: Array<{ path: string; status: "deleted" | "skipped" | "failed"; message: string }>;
  torrents: TorrentCleanupResult[];
}

async function removeLocalPath(targetPath: string): Promise<JobDeleteCleanupResult["localPaths"][number]> {
  try {
    await rm(targetPath, { recursive: true, force: true });
    return { path: targetPath, status: "deleted", message: "Deleted." };
  } catch (error) {
    return { path: targetPath, status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

async function removeJobTorrent(
  client: TorrentDownloadClient | null,
  infoHash: string | null | undefined,
  role: "download" | "seed",
  deleteDataRoot: string
): Promise<TorrentCleanupResult | null> {
  if (!infoHash) return null;
  if (!client?.removeTorrent) {
    return {
      infoHash,
      role,
      status: "skipped",
      deleteData: false,
      message: "Torrent client removal is not configured."
    };
  }

  let deleteData = false;
  try {
    const status = await client.getStatus(infoHash);
    deleteData = isInsideOrEqual(deleteDataRoot, status.contentPath) || isInsideOrEqual(deleteDataRoot, status.savePath);
  } catch {
    deleteData = false;
  }

  try {
    await client.removeTorrent(infoHash, { deleteData });
    return {
      infoHash,
      role,
      status: "removed",
      deleteData,
      message: deleteData ? "Torrent and managed data removed." : "Torrent removed without deleting external data."
    };
  } catch (error) {
    return {
      infoHash,
      role,
      status: "failed",
      deleteData,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function jobDownloadInfoHash(job: Job): string | null {
  return job.artifacts.qbDownloadInfoHash?.trim() || job.downloadStatus?.infoHash?.trim() || null;
}

async function deleteJobDownloads(config: ApiConfig, job: Job, client: TorrentDownloadClient | null): Promise<JobDeleteCleanupResult> {
  const jobRoot = jobRootPath(config, job);
  const downloadDirectory = path.join(jobRoot, "download");
  const torrents = [
    await removeJobTorrent(client, jobDownloadInfoHash(job), "download", downloadDirectory)
  ].filter((item): item is TorrentCleanupResult => Boolean(item));
  return {
    localPaths: [await removeLocalPath(downloadDirectory)],
    torrents
  };
}

async function deleteEntireJob(config: ApiConfig, job: Job, client: TorrentDownloadClient | null): Promise<JobDeleteCleanupResult> {
  const jobRoot = jobRootPath(config, job);
  const downloadDirectory = path.join(jobRoot, "download");
  const torrents = [
    await removeJobTorrent(client, jobDownloadInfoHash(job), "download", downloadDirectory),
    await removeJobTorrent(client, job.artifacts.qbSeedInfoHash, "seed", jobRoot)
  ].filter((item): item is TorrentCleanupResult => Boolean(item));
  return {
    localPaths: [await removeLocalPath(jobRoot)],
    torrents
  };
}

function configuredPtpSubmitter(config: ApiConfig, override?: PtpSubmitter): PtpSubmitter | undefined {
  if (override) return override;
  if (!config.ptp.username || !config.ptp.password || !config.ptp.announceUrl) return undefined;
  const submitterConfig: ConstructorParameters<typeof PtpFormSubmitter>[0] = {
    username: config.ptp.username,
    password: config.ptp.password,
    announceUrl: config.ptp.announceUrl,
    baseUrl: config.ptp.baseUrl,
    userAgent: config.ptp.userAgent
  };
  if (config.ptp.cookieFile) submitterConfig.cookieFile = config.ptp.cookieFile;
  return new PtpFormSubmitter(submitterConfig);
}

function configuredImageHosts(config: ApiConfig): string[] {
  const primary = config.integrations.imageHost;
  const hosts = [
    primary && (primary !== "imgbb" || config.integrations.imgbbApiKey) ? primary : "",
    primary !== "imgbb" && config.integrations.imgbbApiKey ? "imgbb" : "",
    primary !== "ptpimg" && config.integrations.ptpImgApiKey ? "ptpimg" : "",
    "imgbox",
    "freeimage"
  ].filter(Boolean);
  return [...new Set(hosts)];
}

function urlPort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

function hostnameFromHostHeader(host: string | undefined): string | null {
  if (!host) return null;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

function configuredWebPorts(config: ApiConfig): Set<string> {
  const ports = new Set<string>();
  for (const value of config.allowedOrigins) {
    try {
      ports.add(urlPort(new URL(value)));
    } catch {
      // Ignore invalid configured origins; loadConfig only emits URLs.
    }
  }
  return ports;
}

function isSameHostWebOrigin(config: ApiConfig, origin: string, hostHeader: string | undefined): boolean {
  const apiHostname = hostnameFromHostHeader(hostHeader);
  if (!apiHostname) return false;

  try {
    const originUrl = new URL(origin);
    return originUrl.hostname === apiHostname && configuredWebPorts(config).has(urlPort(originUrl));
  } catch {
    return false;
  }
}

function isCorsOriginAllowed(config: ApiConfig, origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin || config.allowedOrigins.length === 0 || config.allowedOrigins.includes(origin)) return true;
  return isSameHostWebOrigin(config, origin, hostHeader);
}

export function buildServer(config: ApiConfig, options: BuildServerOptions = {}) {
  const logger = createApiLogger(config);
  const autoPrepare = options.autoPrepare ?? true;
  const settingsEnvPath = options.settingsEnvPath ?? defaultSettingsEnvPath();
  const app = logger ? fastify({ loggerInstance: logger }) : fastify({ logger: false });
  const persistence = new PrismaPersistence({
    jobs: {
      imageHosts: configuredImageHosts(config)
    }
  });
  const jobRepository = persistence.jobs;
  const cache = persistence.ptpCache;

  let ptpClient: PtpClient;
  let browserChecks: BrowserCheckService;
  let torrentClient: TorrentDownloadClient | null;
  let ptpSubmitter: PtpSubmitter | undefined;
  let browserAuthHook: ReturnType<typeof makeBrowserAuthHook>;
  let webAuth: WebSessionAuth;
  let preparation: PreparationService;

  function applyRuntimeConfig(nextConfig: ApiConfig): void {
    config = nextConfig;
    jobRepository.setOptions({ imageHosts: configuredImageHosts(config) });
    ptpClient = new PtpClient({
      apiUser: config.ptp.apiUser,
      apiKey: config.ptp.apiKey,
      baseUrl: config.ptp.baseUrl,
      userAgent: config.ptp.userAgent
    });
    browserChecks = new BrowserCheckService(ptpClient, cache, {
      requestDelayMs: config.ptp.requestDelayMs
    });
    torrentClient = options.torrentClient ?? (config.integrations.qbittorrentUrl
      ? new QBittorrentClient({
          baseUrl: config.integrations.qbittorrentUrl,
          username: config.integrations.qbittorrentUsername,
          password: config.integrations.qbittorrentPassword
        })
      : null);
    const imageUploader =
      config.integrations.imageHost === "imgbb" && config.integrations.imgbbApiKey
        ? new ImgBbUploader(config.integrations.imgbbApiKey)
        : undefined;
    ptpSubmitter = configuredPtpSubmitter(config, options.ptpSubmitter);
    browserAuthHook = makeBrowserAuthHook(config.browserToken);
    webAuth = new WebSessionAuth({
      enabled: config.webAuth.enabled,
      username: config.ptp.username,
      password: config.ptp.password,
      sessionCookieName: config.webAuth.sessionCookieName,
      sessionMaxAgeSeconds: config.webAuth.sessionMaxAgeSeconds
    });
    preparation = new PreparationService({
      dataRoot: config.paths.dataRoot,
      jobs: jobRepository,
      runExternalTools: config.integrations.runExternalTools,
      toolCommands: toolCommandMap(config),
      ...(imageUploader ? { imageUploader } : {}),
      ...(config.ptp.announceUrl ? { ptpAnnounceUrl: config.ptp.announceUrl } : {}),
      ...(torrentClient ? { torrentClient } : {}),
      ...(options.commandExecutor ? { commandExecutor: options.commandExecutor } : {}),
      torrentClientOptions: {
        ...(config.integrations.qbittorrentCategory ? { category: config.integrations.qbittorrentCategory } : {}),
        ...(config.integrations.qbittorrentTags.length ? { tags: config.integrations.qbittorrentTags } : {}),
        waitTimeoutMs: config.integrations.qbittorrentDownloadWaitMs,
        waitIntervalMs: config.integrations.qbittorrentDownloadPollMs
      }
    });
  }

  applyRuntimeConfig(config);

  const browserAuth = async (...args: Parameters<ReturnType<typeof makeBrowserAuthHook>>) => browserAuthHook(...args);

  function enqueuePreparation(jobId: string): void {
    if (autoPrepare) preparation.enqueue(jobId);
  }

  async function resumeInterruptedPreparation(): Promise<void> {
    if (!autoPrepare) return;
    const jobs = await jobRepository.list();
    for (const job of jobs) {
      if (job.state !== "preparing") continue;
      await jobRepository.markPreparationResumed(job.id);
      enqueuePreparation(job.id);
    }
  }

  const routeContext: ApiRouteContext = {
    config: () => config,
    jobRepository,
    cache,
    options,
    settingsEnvPath,
    getPtpClient: () => ptpClient,
    getBrowserChecks: () => browserChecks,
    getTorrentClient: () => torrentClient,
    getPtpSubmitter: () => ptpSubmitter,
    getPreparation: () => preparation,
    getWebAuth: () => webAuth,
    getBrowserAuthHook: () => browserAuthHook,
    enqueuePreparation,
    applyRuntimeConfig
  };

  app.addHook("onClose", async () => {
    await persistence.disconnect();
  });

  app.addHook("onReady", resumeInterruptedPreparation);

  app.register(cors, {
    delegator(request, callback) {
      const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
      const host = typeof request.headers.host === "string" ? request.headers.host : undefined;
      callback(null, {
        credentials: true,
        methods: ["GET", "HEAD", "POST", "PATCH", "OPTIONS"],
        origin: isCorsOriginAllowed(config, origin, host)
      });
    }
  });
  app.register(multipart, {
    limits: {
      fileSize: 32 * 1024 * 1024
    }
  });
  app.addHook("preHandler", async (request, reply) => webAuth.hook()(request, reply));

  app.get("/api/auth/session", async (request) => webAuth.info(request));

  app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", async (request, reply) => {
    const body = request.body ?? {};
    return webAuth.login(String(body.username ?? ""), String(body.password ?? ""), reply);
  });

  app.post("/api/auth/logout", async (request, reply) => webAuth.logout(request, reply));

  app.get("/api/settings", async () => settingsResponse(settingsEnvPath, config));

  app.patch<{ Body: SaveSettingsInput }>("/api/settings", async (request, reply) => {
    try {
      await saveSettingsEnv(settingsEnvPath, request.body ?? {});
      applyRuntimeConfig(loadConfigFromEnvPath(settingsEnvPath));
      return reply.send({
        ...settingsResponse(settingsEnvPath, config),
        saved: true,
        reloaded: true,
        restartRequired: false
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "settings_save_failed" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    ptpConfigured: Boolean(config.ptp.apiUser && config.ptp.apiKey),
    browserTokenConfigured: Boolean(config.browserToken),
    cachePolicy: "permanent",
    persistence: "sqlite",
    publicWebUrl: config.publicWebUrl,
    publicApiUrl: config.publicApiUrl,
    external: {
      tmdbConfigured: Boolean(config.integrations.tmdbApiKey),
      imageHost: config.integrations.imageHost,
      imgbbConfigured: Boolean(config.integrations.imgbbApiKey),
      ptpImgConfigured: Boolean(config.integrations.ptpImgApiKey),
      torrentClientConfigured: Boolean(config.integrations.qbittorrentUrl),
      externalToolsEnabled: config.integrations.runExternalTools,
      tools: {
        ffmpeg: config.integrations.ffmpegBin,
        mediainfo: config.integrations.mediainfoBin,
        mkvmerge: config.integrations.mkvmergeBin,
        mpv: config.integrations.mpvBin,
        oxipng: config.integrations.oxipngBin,
        "xvfb-run": config.integrations.xvfbRunBin
      }
    }
  }));

  app.get("/api/features", async () => ({
    features: [
      {
        id: "ptp-cache",
        name: "Backend PTP cache",
        status: "implemented",
        detail: "PTP lookups are cached permanently in the API until manually refreshed or invalidated."
      },
      {
        id: "upload-plan",
        name: "Upsies-style upload plan",
        status: "implemented",
        detail: "Every job receives metadata, release-name, scene, screenshot, torrent-reuse, media, and review-gate plans."
      },
      {
        id: "phase-runner",
        name: "Restartable upload phases",
        status: "implemented",
        detail: "Jobs can be started, paused, retried, skipped through debug routing, and blocked by review gates."
      },
      {
        id: "ptp-rules",
        name: "PTP rule gates",
        status: "implemented",
        detail: "Banned groups, EVO encode handling, MP4 remux checks, missing IMDb, and parse-confidence warnings are surfaced as review gates."
      },
      {
        id: "external-enrichment",
        name: "IMDb/TMDb/TVmaze enrichment",
        status: "planned",
        detail: config.integrations.tmdbApiKey
          ? "TMDb is configured for manual integration testing; provider clients still run through the metadata phase contract."
          : "Provider plans are generated now; add TMDB_API_KEY when live provider clients are wired into the metadata phase."
      },
      {
        id: "image-host-upload",
        name: "Screenshot host fallback",
        status: "planned",
        detail: config.integrations.imgbbApiKey || config.integrations.ptpImgApiKey
          ? `${configuredImageHosts(config).join(", ")} configured for screenshot hosting plans.`
          : "Screenshot timestamps and fallback hosts are planned now; add IMGBB_API_KEY or PTPIMG_API_KEY when image-host upload is enabled."
      },
      {
        id: "torrent-client",
        name: "Torrent client handoff",
        status: "planned",
        detail: config.integrations.qbittorrentUrl
          ? "qBittorrent connection details are configured for manual service wiring."
          : "Set QBITTORRENT_URL and credentials when seed-start handoff is enabled."
      },
      {
        id: "external-tools",
        name: "Worker media tools",
        status: config.integrations.runExternalTools ? "configured" : "disabled",
        detail: config.integrations.runExternalTools
          ? `Worker may run ${config.integrations.ffmpegBin}, ${config.integrations.mediainfoBin}, ${config.integrations.mkvmergeBin}, and ${config.integrations.oxipngBin} during manual execution.`
          : "External tools are disabled; media preparation will skip or mock command execution."
      }
    ]
  }));

  app.get("/api/jobs", async () => ({ jobs: await jobRepository.list() }));
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = await jobRepository.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/download-status", async (request, reply) => {
    const job = await jobRepository.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { downloadStatus: job.downloadStatus ?? null };
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/logs", async (request, reply) => {
    const job = await jobRepository.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { lines: await readLogTail(buildJobWorkspacePaths(config.paths.dataRoot, request.params.id).logs.jobLog, 200) };
  });

  app.get("/api/logs/global", async () => ({
    api: await readLogTail(config.paths.apiLogFile, 200)
  }));

  app.get("/api/diagnostics", async () => {
    const jobs = await jobRepository.list();
    const databasePath = sqliteDatabasePath();
    const tools = await collectToolDiagnostics(config, options.commandExecutor);
    return {
      system: {
        api: "online",
        persistence: "sqlite",
        publicWebUrl: config.publicWebUrl,
        publicApiUrl: config.publicApiUrl,
        browserBridgeConfigured: Boolean(config.browserToken),
        ptpApiConfigured: Boolean(config.ptp.apiUser && config.ptp.apiKey),
        externalToolsEnabled: config.integrations.runExternalTools
      },
      integrations: {
        qbittorrent: integrationSummary(config, "qbittorrent"),
        ptp: integrationSummary(config, "ptp"),
        imageHost: integrationSummary(config, "image-host"),
        tools: integrationSummary(config, "tools")
      },
      queue: queueDiagnostics(jobs),
      tools,
      storage: {
        dataRoot: config.paths.dataRoot,
        databasePath,
        jobCount: jobs.length,
        cacheEntries: await cacheEntryCount(cache),
        databaseBytes: await fileSize(databasePath),
        dataRootFreeBytes: await freeBytes(config.paths.dataRoot)
      },
      logs: {
        api: await readLogTail(config.paths.apiLogFile, 200)
      }
    };
  });

  app.post<{ Params: { target: DiagnosticCheckTarget } }>("/api/diagnostics/check/:target", async (request, reply) => {
    const target = request.params.target;
    if (!["qbittorrent", "ptp", "image-host", "tools"].includes(target)) return reply.code(404).send({ error: "diagnostic_target_not_found" });
    const checkedAt = new Date().toISOString();
    const summary = integrationSummary(config, target);
    if (target === "tools" && !config.integrations.runExternalTools) {
      return { target, configured: false, status: "disabled" as const, detail: "External tools are disabled.", checkedAt };
    }
    if (!summary.configured) return { target, ...summary, status: "missing" as const, checkedAt };
    if (target === "qbittorrent") {
      try {
        if (torrentClient?.ping) await torrentClient.ping();
        return { target, configured: true, status: torrentClient?.ping ? "ok" : "configured", detail: torrentClient?.ping ? "qBittorrent responded." : "qBittorrent is configured.", checkedAt };
      } catch (error) {
        return { target, configured: true, status: "failed" as const, detail: error instanceof Error ? error.message : "qBittorrent check failed.", checkedAt };
      }
    }
    if (target === "tools") {
      const tools = await collectToolDiagnostics(config, options.commandExecutor);
      const status = toolCheckStatus(tools);
      return {
        target,
        configured: true,
        status,
        detail: status === "ok" ? "External media tools are available." : "One or more external media tools are unavailable.",
        tools,
        checkedAt
      };
    }
    return { target, configured: true, status: "configured" as const, detail: summary.detail, checkedAt };
  });

  app.post<{ Body: CreateManualJobBody }>("/api/jobs", async (request, reply) => {
    const body = request.body;
    if (!body?.title) return reply.code(400).send({ error: "title_required" });

    const candidate: TorrentCandidate = {
      site: body.site ?? "unknown",
      title: body.title
    };
    if (body.imdbId !== undefined) candidate.imdbId = body.imdbId;
    if (body.resolution !== undefined) candidate.resolution = body.resolution;
    if (body.sourceUrl !== undefined) candidate.sourceUrl = body.sourceUrl;
    if (body.downloadUrl !== undefined) candidate.downloadUrl = body.downloadUrl;
    if (body.sourceTorrentId !== undefined) candidate.sourceTorrentId = body.sourceTorrentId;

    const job = await jobRepository.create({ candidate });
    enqueuePreparation(job.id);
    return reply.code(201).send({ job });
  });

  app.post<{ Body: ImportJobBody }>("/api/jobs/import", async (request, reply) => {
    const body = request.body;
    if (!body?.jobPath) return reply.code(400).send({ error: "job_path_required" });
    const manifest =
      body.manifest ??
      (JSON.parse(await readFile(path.join(body.jobPath, "manifest.json"), "utf8")) as JobManifest);

    const imported = await jobRepository.importRestored({ jobPath: body.jobPath, manifest });
    const missingFiles = await missingRestoredFiles(body.jobPath, manifest);
    if (missingFiles.length > 0) {
      const job =
        (await jobRepository.markRestoreBlocked(imported.id, {
          message: "Restored job is missing upload files.",
          missingFiles
        })) ?? imported;
      return reply.code(201).send({ job });
    }
    let job = imported;
    if (manifest.state === "done") {
      job =
        (await jobRepository.markNeedsReseed(
          imported.id,
          torrentClient ? "Restored done job needs qBittorrent reseed verification." : "qBittorrent is not configured for automatic reseed."
        )) ?? imported;
    }
    return reply.code(201).send({ job });
  });

  async function startUploadJob(id: string) {
    const started = await jobRepository.startUpload(id);
    if (!started || started.state !== "uploading") return started;
    if (!started.candidate) {
      return jobRepository.markUploadFailed(id, "Cannot upload a job without candidate metadata.");
    }

    const fallbackPaths = buildJobWorkspacePaths(config.paths.dataRoot, id);
    const jobRoot = started.workspace?.jobRoot ?? fallbackPaths.jobRoot;
    const logPath = jobLogPath(config, started);
    const mediaArtifact = started.artifacts.mediaFiles?.[0];
    const mediaPath = mediaArtifact ? (path.isAbsolute(mediaArtifact) ? mediaArtifact : path.join(jobRoot, mediaArtifact)) : undefined;
    await mkdir(path.dirname(logPath), { recursive: true });
    const contextOptions: CreatePhaseContextOptions = {
      log: async (level: PhaseLogLevel, message: string, payload?: unknown) => {
        await appendJobEvent(logPath, {
          at: new Date().toISOString(),
          level,
          message,
          payload
        });
      }
    };
    if (ptpSubmitter) contextOptions.ptpSubmitter = ptpSubmitter;
    contextOptions.ptpCacheSyncer = createPtpCacheSyncer(cache);
    if (config.ptp.announceUrl) contextOptions.ptpAnnounceUrl = config.ptp.announceUrl;
    if (torrentClient) {
      contextOptions.torrentClient = torrentClient;
      contextOptions.torrentClientOptions = {
        ...(config.integrations.qbittorrentCategory ? { category: config.integrations.qbittorrentCategory } : {}),
        ...(config.integrations.qbittorrentTags.length ? { tags: config.integrations.qbittorrentTags } : {}),
        waitTimeoutMs: config.integrations.qbittorrentDownloadWaitMs,
        waitIntervalMs: config.integrations.qbittorrentDownloadPollMs
      };
    }
    const context = createPhaseContext(
      id,
      {
        candidate: started.candidate,
        ...(started.checkResult ? { checkResult: started.checkResult } : {}),
        ...(started.torrent ? { torrent: started.torrent } : {}),
        ...(started.torrent?.filePath ? { sourceTorrentPath: started.torrent.filePath } : {}),
        ...(started.reviewDraft ? { reviewDraft: started.reviewDraft } : {}),
        ...(mediaPath ? { mediaPath } : {}),
        workingDirectory: jobRoot
      },
      contextOptions
    );

    const outputs = await new PhaseRunner().runUploadTail(context);
    const phaseRuns = mergePhaseRuns(started, outputs);
    const upload = outputs.upload;
    if (upload?.status === "completed" && upload.result) {
      const uploadArtifacts: Partial<Job["artifacts"]> = {};
      const seedInfoHash = outputs["post-hook"]?.infoHash;
      if (seedInfoHash) uploadArtifacts.qbSeedInfoHash = seedInfoHash;
      return jobRepository.markUploadResult(id, upload.result, phaseRuns, uploadArtifacts);
    }
    return jobRepository.markUploadFailed(id, upload?.message ?? "PTP upload did not complete.", phaseRuns);
  }

  async function retryFailedJob(id: string) {
    const existing = await jobRepository.get(id);
    if (!existing) return null;
    if (existing.state === "needs_reseed") return reseedJob(id);
    return jobRepository.retryFailed(id);
  }

  async function retryCompletedPhaseJob(id: string, phase: UploadPhase) {
    if (phase === "post-hook") {
      const queued = await jobRepository.retryCompletedPhase(id, phase);
      if (!queued) return null;
      return reseedJob(id);
    }
    return preparation.retryCompletedPhase(id, phase);
  }

  async function reseedJob(id: string) {
    const existing = await jobRepository.get(id);
    if (!existing) return null;
    if (!torrentClient) {
      return jobRepository.markNeedsReseed(existing.id, "qBittorrent is not configured for automatic reseed.");
    }

    const jobRoot = existing.workspace?.jobRoot ?? buildJobWorkspacePaths(config.paths.dataRoot, existing.id).jobRoot;
    const torrentPath = path.join(jobRoot, existing.artifacts.uploadTorrent ?? "torrent/upload.torrent");
    const downloadPath = path.join(jobRoot, "media", "upload");
    try {
      const addOptions: Parameters<TorrentDownloadClient["addTorrent"]>[0] = {
        torrentPath,
        downloadPath,
        skipHashCheck: true
      };
      if (config.integrations.qbittorrentCategory) addOptions.category = config.integrations.qbittorrentCategory;
      if (config.integrations.qbittorrentTags.length) addOptions.tags = config.integrations.qbittorrentTags;
      const result = await torrentClient.addTorrent(addOptions);
      return jobRepository.markReseeded(existing.id, result.infoHash);
    } catch {
      return jobRepository.markNeedsReseed(existing.id, "reseed failed");
    }
  }

  async function resumeJob(id: string) {
    const job = await jobRepository.resume(id);
    if (job?.state === "preparing") enqueuePreparation(id);
    return job;
  }

  async function skipJob(id: string) {
    return jobRepository.skip(id);
  }

  async function deleteJob(id: string, body: DeleteJobBody | undefined) {
    const mode = body?.mode;
    if (!mode || !["queue", "downloads", "everything"].includes(mode)) {
      return { status: 400 as const, body: { error: "unknown_delete_mode" } };
    }
    if (body?.confirm !== true) {
      return { status: 400 as const, body: { error: "delete_confirmation_required" } };
    }

    const job = await jobRepository.get(id);
    if (!job) return { status: 404 as const, body: { error: "job_not_found" } };

    if (mode === "queue") {
      const removed = await jobRepository.removeFromQueue(id);
      return removed
        ? { status: 200 as const, body: { job: removed, cleanup: { localPaths: [], torrents: [] } } }
        : { status: 404 as const, body: { error: "job_not_found" } };
    }

    if (mode === "downloads") {
      const cleanup = await deleteJobDownloads(config, job, torrentClient);
      const updated = await jobRepository.markDownloadFilesDeleted(id);
      return updated
        ? { status: 200 as const, body: { job: updated, cleanup } }
        : { status: 404 as const, body: { error: "job_not_found" } };
    }

    const cleanup = await deleteEntireJob(config, job, torrentClient);
    const deleted = await jobRepository.delete(id);
    return deleted
      ? { status: 200 as const, body: { deleted: true, jobId: id, cleanup } }
      : { status: 404 as const, body: { error: "job_not_found" } };
  }

  app.post<{ Params: { id: string } }>("/api/jobs/:id/start-upload", async (request, reply) => {
    const job = await startUploadJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/start", async (request, reply) => {
    const job = await startUploadJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.patch<{ Params: { id: string }; Body: ReviewDraftPatch }>("/api/jobs/:id/review-draft", async (request, reply) => {
    const job = await jobRepository.updateReviewDraft(request.params.id, request.body ?? {});
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/pause", async (request, reply) => {
    const job = await jobRepository.pause(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/resume", async (request, reply) => {
    const job = await resumeJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry-failed", async (request, reply) => {
    const job = await retryFailedJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string; phase: string } }>("/api/jobs/:id/phases/:phase/retry", async (request, reply) => {
    const phase = request.params.phase as UploadPhase;
    if (!JOB_PHASES.includes(phase)) return reply.code(400).send({ error: "unknown_phase" });
    if (!RETRYABLE_COMPLETED_PHASES.has(phase)) return reply.code(400).send({ error: "phase_retry_not_available" });
    const job = await retryCompletedPhaseJob(request.params.id, phase);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (request, reply) => {
    const job = await retryFailedJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/reseed", async (request, reply) => {
    const job = await reseedJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/debug/skip", async (request, reply) => {
    const job = await skipJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string }; Body: DeleteJobBody }>("/api/jobs/:id/delete", async (request, reply) => {
    const result = await deleteJob(request.params.id, request.body);
    return reply.code(result.status).send(result.body);
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/plan/refresh", async (request, reply) => {
    const job = await jobRepository.refreshPlan(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string; gateId: string } }>("/api/jobs/:id/review-gates/:gateId/resolve", async (request, reply) => {
    const job = await jobRepository.resolveGate(request.params.id, request.params.gateId);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Body: { mediaPath?: string } }>("/api/intake/media-path/validate", async (request) => {
    return validateMediaPath(request.body?.mediaPath ?? "");
  });

  app.post<{ Body: { title?: string; mediaPath?: string } }>("/api/intake/ptp-search", async (request) => {
    return searchPtpMovies(request.body ?? {}, ptpClient);
  });

  app.post<{ Body: { ptpUrl?: string; imdbUrl?: string } }>("/api/intake/ptp-target/resolve", async (request, reply) => {
    try {
      const target = await resolveManualPtpTarget(request.body ?? {}, ptpClient);
      return { target };
    } catch (error) {
      if (error instanceof IntakeError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post("/api/intake/jobs", async (request, reply) => {
    try {
      const input = await readManualIntakeRequest(request, options.fetchImpl ?? fetch);
      if (input.mediaPath) {
        const media = await validateMediaPath(input.mediaPath);
        if (!media.ok) return reply.code(400).send({ error: media.error ?? "invalid_media_path", media });
      }
      const job = await createManualIntakeJob({
        dataRoot: config.paths.dataRoot,
        jobRepository,
        releaseName: input.releaseName,
        ptpTarget: input.ptpTarget,
        ptpClient,
        ...(input.mediaPath ? { mediaPath: input.mediaPath } : {}),
        ...(input.torrent ? { torrent: input.torrent } : {})
      });
      enqueuePreparation(job.id);
      return reply.code(201).send({ job });
    } catch (error) {
      if (error instanceof IntakeError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post<{ Body: { candidates: TorrentCandidate[]; bypassCache?: boolean } }>(
    "/api/browser/check/batch",
    { preHandler: browserAuth },
    async (request) => {
      const candidates = request.body?.candidates ?? [];
      const options: { bypassCache?: boolean } = {};
      if (request.body?.bypassCache !== undefined) options.bypassCache = request.body.bypassCache;
      request.log.info({ candidateCount: candidates.length, bypassCache: Boolean(options.bypassCache) }, "browser check batch started");
      const results = await browserChecks.checkBatch(candidates, options);
      const cacheHits = results.filter((result) => result.cache.hit).length;
      request.log.info({ candidateCount: candidates.length, resultCount: results.length, cacheHits }, "browser check batch completed");
      return { results };
    }
  );

  app.post<{ Body: TorrentCandidate & { bypassCache?: boolean } }>(
    "/api/browser/check",
    { preHandler: browserAuth },
    async (request) => {
      const body = request.body;
      const options: { bypassCache?: boolean } = {};
      if (body.bypassCache !== undefined) options.bypassCache = body.bypassCache;
      const result = await browserChecks.check(body, options);
      return { result };
    }
  );

  app.post<{ Body: Pick<TorrentCandidate, "title" | "imdbId"> }>(
    "/api/browser/cache/invalidate",
    { preHandler: browserAuth },
    async (request) => {
      const key = await browserChecks.invalidate(request.body);
      return { ok: true, key };
    }
  );

  app.post("/api/browser/jobs", { preHandler: browserAuth }, async (request, reply) => {
    const parts = request.parts();
    let torrentBytes = 0;
    let torrentBuffer: Buffer | null = null;
    let torrentFilename = "source.torrent";
    let torrentContentType: string | undefined;
    let candidate: TorrentCandidate | undefined;
    let checkResult: BrowserCheckResult | undefined;

    for await (const part of parts) {
      if (part.type === "file") {
        torrentFilename = part.filename ? normalizeUploadedFilename(part.filename, torrentFilename) : torrentFilename;
        torrentContentType = part.mimetype;
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(chunk as Buffer);
        torrentBuffer = Buffer.concat(chunks);
        torrentBytes = torrentBuffer.byteLength;
      } else if (part.fieldname === "candidate") {
        candidate = JSON.parse(String(part.value)) as TorrentCandidate;
      } else if (part.fieldname === "checkResult") {
        checkResult = JSON.parse(String(part.value)) as BrowserCheckResult;
      }
    }

    if (!torrentBytes) {
      return reply.code(400).send({ error: "torrent_file_required" });
    }

    const torrent = { filename: torrentFilename, bytes: torrentBytes };
    if (torrentContentType) Object.assign(torrent, { contentType: torrentContentType });

    const createInput: Parameters<typeof jobRepository.createFromBrowser>[0] = { torrent };
    if (candidate) {
      createInput.candidate = candidate;
      if (candidate.sourceUrl) createInput.sourceUrl = candidate.sourceUrl;
      if (candidate.site) createInput.sourceSite = candidate.site;
      if (candidate.title) createInput.title = candidate.title;
    }
    if (checkResult) createInput.checkResult = checkResult;

    let job = await jobRepository.createFromBrowser(createInput);
    if (torrentBuffer) {
      const paths = buildJobWorkspacePaths(config.paths.dataRoot, job.id);
      await Promise.all([
        mkdir(paths.inputDir, { recursive: true }),
        mkdir(paths.torrentDir, { recursive: true }),
        mkdir(paths.sourceDownloadDir, { recursive: true }),
        mkdir(paths.logs.dir, { recursive: true })
      ]);
      await writeFile(paths.sourceTorrent, torrentBuffer);
      await writeFile(
        paths.sourceJson,
        `${JSON.stringify({ candidate, checkResult, torrent: { filename: torrentFilename, bytes: torrentBytes, contentType: torrentContentType } }, null, 2)}\n`,
        "utf8"
      );
      job =
        (await jobRepository.attachWorkspace(job.id, {
          workspace: {
            dataRoot: paths.dataRoot,
            jobRoot: paths.jobRoot,
            manifest: paths.manifest
          },
          torrentFilePath: paths.sourceTorrent
        })) ?? job;
    }
    enqueuePreparation(job.id);
    return reply.code(201).send({ job });
  });

  registerApiRoutes(app, routeContext);

  return app;
}
