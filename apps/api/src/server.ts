import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { buildJobWorkspacePaths, type BrowserCheckResult, type JobManifest, type ReviewDraftPatch, type TorrentCandidate, type UploadPhase } from "@popcorn-queue/core";
import { BrowserCheckService, ImgBbUploader, PtpClient, PtpFormSubmitter, QBittorrentClient } from "@popcorn-queue/integrations";
import { PhaseRunner, createPhaseContext, type CreatePhaseContextOptions, type PhaseLogLevel, type PhaseOutputMap, type PtpSubmitter } from "@popcorn-queue/worker";
import { makeBrowserAuthHook } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { appendJobEvent, readLogTail } from "./job-logs.js";
import { createApiLogger } from "./logger.js";
import { PrismaPersistence } from "./persistence.js";
import { PreparationService } from "./preparation.js";
import type { Job, PhaseRun, PhaseState } from "./jobs.js";

interface CreateManualJobBody extends Partial<TorrentCandidate> {
  title: string;
}

interface ImportJobBody {
  jobPath: string;
  manifest?: JobManifest;
}

export interface BuildServerOptions {
  autoPrepare?: boolean;
  ptpSubmitter?: PtpSubmitter;
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

export function buildServer(config: ApiConfig, options: BuildServerOptions = {}) {
  const logger = createApiLogger(config);
  const autoPrepare = options.autoPrepare ?? true;
  const app = logger ? fastify({ loggerInstance: logger }) : fastify({ logger: false });
  const persistence = new PrismaPersistence({
    jobs: {
      imageHosts: configuredImageHosts(config)
    }
  });
  const jobRepository = persistence.jobs;
  const cache = persistence.ptpCache;
  const ptpClient = new PtpClient({
    apiUser: config.ptp.apiUser,
    apiKey: config.ptp.apiKey,
    baseUrl: config.ptp.baseUrl,
    userAgent: config.ptp.userAgent
  });
  const browserChecks = new BrowserCheckService(ptpClient, cache, {
    requestDelayMs: config.ptp.requestDelayMs
  });
  const torrentClient = config.integrations.qbittorrentUrl
    ? new QBittorrentClient({
        baseUrl: config.integrations.qbittorrentUrl,
        username: config.integrations.qbittorrentUsername,
        password: config.integrations.qbittorrentPassword
      })
    : null;
  const imageUploader =
    config.integrations.imageHost === "imgbb" && config.integrations.imgbbApiKey
      ? new ImgBbUploader(config.integrations.imgbbApiKey)
      : undefined;
  const ptpSubmitter = configuredPtpSubmitter(config, options.ptpSubmitter);
  const browserAuth = makeBrowserAuthHook(config.browserToken);
  const preparation = new PreparationService({
    dataRoot: config.paths.dataRoot,
    jobs: jobRepository,
    runExternalTools: config.integrations.runExternalTools,
    toolCommands: {
      ffmpeg: config.integrations.ffmpegBin,
      mediainfo: config.integrations.mediainfoBin,
      oxipng: config.integrations.oxipngBin
    },
    ...(imageUploader ? { imageUploader } : {}),
    ...(torrentClient ? { torrentClient } : {}),
    torrentClientOptions: {
      ...(config.integrations.qbittorrentCategory ? { category: config.integrations.qbittorrentCategory } : {}),
      ...(config.integrations.qbittorrentTags.length ? { tags: config.integrations.qbittorrentTags } : {}),
      waitTimeoutMs: config.integrations.qbittorrentDownloadWaitMs,
      waitIntervalMs: config.integrations.qbittorrentDownloadPollMs
    }
  });

  function enqueuePreparation(jobId: string): void {
    if (autoPrepare) preparation.enqueue(jobId);
  }

  app.addHook("onClose", async () => {
    await persistence.disconnect();
  });

  app.register(cors, {
    origin(origin, callback) {
      if (!origin || config.allowedOrigins.length === 0 || config.allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("origin_not_allowed"), false);
    }
  });
  app.register(multipart, {
    limits: {
      fileSize: 32 * 1024 * 1024
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
        oxipng: config.integrations.oxipngBin
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
        detail: "Jobs can be started, paused, retried, advanced, and blocked by review gates."
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
        status: config.integrations.runExternalTools ? "configured" : "safe-default",
        detail: config.integrations.runExternalTools
          ? `Worker may run ${config.integrations.ffmpegBin}, ${config.integrations.mediainfoBin}, and ${config.integrations.oxipngBin} during manual execution.`
          : "External tools are disabled by default; tests and dry runs keep command execution mocked or skipped."
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
    api: await readLogTail(config.paths.apiLogFile, 200),
    worker: await readLogTail(config.paths.workerLogFile, 200)
  }));

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
    const context = createPhaseContext(
      id,
      {
        candidate: started.candidate,
        ...(started.checkResult ? { checkResult: started.checkResult } : {}),
        ...(started.torrent ? { torrent: started.torrent } : {}),
        ...(started.torrent?.filePath ? { sourceTorrentPath: started.torrent.filePath } : {}),
        ...(started.reviewDraft ? { reviewDraft: started.reviewDraft } : {}),
        workingDirectory: jobRoot
      },
      contextOptions
    );

    const outputs = await new PhaseRunner().runUploadTail(context);
    const phaseRuns = mergePhaseRuns(started, outputs);
    const upload = outputs.upload;
    if (upload?.status === "completed" && upload.result) {
      return jobRepository.markUploadResult(id, upload.result, phaseRuns);
    }
    return jobRepository.markUploadFailed(id, upload?.message ?? "PTP upload did not complete.", phaseRuns);
  }

  async function retryFailedJob(id: string) {
    return jobRepository.retryFailed(id);
  }

  async function advanceJob(id: string) {
    return jobRepository.advance(id);
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

  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry-failed", async (request, reply) => {
    const job = await retryFailedJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (request, reply) => {
    const job = await retryFailedJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/reseed", async (request, reply) => {
    const existing = await jobRepository.get(request.params.id);
    if (!existing) return reply.code(404).send({ error: "job_not_found" });
    if (!torrentClient) {
      const job = await jobRepository.markNeedsReseed(existing.id, "qBittorrent is not configured for automatic reseed.");
      return { job };
    }

    const jobRoot = existing.workspace?.jobRoot ?? buildJobWorkspacePaths(config.paths.dataRoot, existing.id).jobRoot;
    const torrentPath = path.join(jobRoot, existing.artifacts.uploadTorrent ?? "torrent/upload.torrent");
    const downloadPath = path.join(jobRoot, "media", "upload");
    try {
      const addOptions = {
        torrentPath,
        downloadPath,
        tags: config.integrations.qbittorrentTags
      };
      if (config.integrations.qbittorrentCategory) Object.assign(addOptions, { category: config.integrations.qbittorrentCategory });
      const result = await torrentClient.addTorrent(addOptions);
      const job = await jobRepository.markReseeded(existing.id, result.infoHash);
      return { job };
    } catch {
      const job = await jobRepository.markNeedsReseed(existing.id, "reseed failed");
      return { job };
    }
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/debug/advance", async (request, reply) => {
    const job = await advanceJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/debug/skip", async (request, reply) => {
    const job = await advanceJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/debug/force-state", async (request, reply) => {
    const job = await jobRepository.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/advance", async (request, reply) => {
    const job = await advanceJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
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
        torrentFilename = part.filename || torrentFilename;
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

  return app;
}
