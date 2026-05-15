import fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { BrowserCheckService, ImgBbUploader, PtpClient, PtpFormSubmitter, QBittorrentClient } from "@popcorn-queue/integrations";
import {
  type PtpSubmitter,
  type TorrentDownloadClient
} from "@popcorn-queue/worker";
import type { ApiRouteContext, BuildServerOptions } from "./api-context.js";
import { WebSessionAuth, makeBrowserAuthHook } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { createApiLogger } from "./logger.js";
import { PrismaPersistence } from "./persistence.js";
import { PreparationService } from "./preparation.js";
import { registerApiRoutes } from "./routes/index.js";
import { toolCommandMap } from "./services/diagnostics.js";
import { defaultSettingsEnvPath } from "./settings.js";

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

  registerApiRoutes(app, routeContext);

  return app;
}
