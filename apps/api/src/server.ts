import fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { type BrowserCheckResult, type TorrentCandidate } from "@popcorn-queue/core";
import { BrowserCheckService, PtpClient } from "@popcorn-queue/integrations";
import { makeBrowserAuthHook } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { createApiLogger } from "./logger.js";
import { PrismaPersistence } from "./persistence.js";

interface CreateManualJobBody extends Partial<TorrentCandidate> {
  title: string;
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

export function buildServer(config: ApiConfig) {
  const logger = createApiLogger(config);
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
  const browserAuth = makeBrowserAuthHook(config.browserToken);

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
    return reply.code(201).send({ job });
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/start", async (request, reply) => {
    const job = await jobRepository.start(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/pause", async (request, reply) => {
    const job = await jobRepository.pause(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (request, reply) => {
    const job = await jobRepository.retry(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/advance", async (request, reply) => {
    const job = await jobRepository.advance(request.params.id);
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
        torrentBytes = Buffer.concat(chunks).byteLength;
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

    const job = await jobRepository.createFromBrowser(createInput);
    return reply.code(201).send({ job });
  });

  return app;
}
