import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import {
  buildJobWorkspacePaths,
  type BrowserCheckResult,
  type JobManifest,
  type ReviewDraftPatch,
  type TorrentCandidate,
  type UploadPhase
} from "@popcorn-queue/core";
import { BrowserCheckService, ImgBbUploader, PtpClient, PtpFormSubmitter, QBittorrentClient } from "@popcorn-queue/integrations";
import {
  type PtpSubmitter,
  type TorrentDownloadClient
} from "@popcorn-queue/worker";
import type { ApiRouteContext, BuildServerOptions } from "./api-context.js";
import { WebSessionAuth, makeBrowserAuthHook } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { normalizeUploadedFilename } from "./filenames.js";
import { createManualIntakeJob, IntakeError, readManualIntakeRequest, resolveManualPtpTarget, searchPtpMovies, validateMediaPath } from "./intake.js";
import { readLogTail } from "./job-logs.js";
import { createApiLogger } from "./logger.js";
import { PrismaPersistence } from "./persistence.js";
import { PreparationService } from "./preparation.js";
import { registerApiRoutes } from "./routes/index.js";
import { toolCommandMap } from "./services/diagnostics.js";
import {
  reseedJob,
  resumeJob,
  retryCompletedPhaseJob,
  retryFailedJob,
  skipJob,
  startUploadJob,
  type JobActionContext
} from "./services/job-upload.js";
import { defaultSettingsEnvPath } from "./settings.js";
import { JOB_PHASES, RETRYABLE_COMPLETED_PHASES, type Job } from "./jobs.js";

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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
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

  const jobActionContext: JobActionContext = {
    config: () => config,
    jobs: jobRepository,
    cache,
    getTorrentClient: () => torrentClient,
    getPtpSubmitter: () => ptpSubmitter,
    getPreparation: () => preparation,
    enqueuePreparation
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
    const job = await startUploadJob(jobActionContext, request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/start", async (request, reply) => {
    const job = await startUploadJob(jobActionContext, request.params.id);
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
    const job = await resumeJob(jobActionContext, request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry-failed", async (request, reply) => {
    const job = await retryFailedJob(jobActionContext, request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string; phase: string } }>("/api/jobs/:id/phases/:phase/retry", async (request, reply) => {
    const phase = request.params.phase as UploadPhase;
    if (!JOB_PHASES.includes(phase)) return reply.code(400).send({ error: "unknown_phase" });
    if (!RETRYABLE_COMPLETED_PHASES.has(phase)) return reply.code(400).send({ error: "phase_retry_not_available" });
    const job = await retryCompletedPhaseJob(jobActionContext, request.params.id, phase);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (request, reply) => {
    const job = await retryFailedJob(jobActionContext, request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/reseed", async (request, reply) => {
    const job = await reseedJob(jobActionContext, request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/debug/skip", async (request, reply) => {
    const job = await skipJob(jobActionContext, request.params.id);
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
