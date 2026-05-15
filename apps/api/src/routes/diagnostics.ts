import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../api-context.js";
import { readLogTail } from "../job-logs.js";
import {
  cacheEntryCount,
  collectToolDiagnostics,
  fileSize,
  freeBytes,
  integrationSummary,
  queueDiagnostics,
  sqliteDatabasePath,
  toolCheckStatus,
  type DiagnosticCheckTarget
} from "../services/diagnostics.js";

const DIAGNOSTIC_TARGETS = new Set<DiagnosticCheckTarget>(["qbittorrent", "ptp", "image-host", "tools"]);

export function registerDiagnosticsRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  app.get("/api/logs/global", async () => ({
    api: await readLogTail(context.config().paths.apiLogFile, 200)
  }));

  app.get("/api/diagnostics", async () => {
    const config = context.config();
    const jobs = await context.jobRepository.list();
    const databasePath = sqliteDatabasePath();
    const tools = await collectToolDiagnostics(config, context.options.commandExecutor);
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
        cacheEntries: await cacheEntryCount(context.cache),
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
    const config = context.config();
    if (!DIAGNOSTIC_TARGETS.has(target)) return reply.code(404).send({ error: "diagnostic_target_not_found" });
    const checkedAt = new Date().toISOString();
    const summary = integrationSummary(config, target);
    if (target === "tools" && !config.integrations.runExternalTools) {
      return { target, configured: false, status: "disabled" as const, detail: "External tools are disabled.", checkedAt };
    }
    if (!summary.configured) return { target, ...summary, status: "missing" as const, checkedAt };
    if (target === "qbittorrent") {
      try {
        const torrentClient = context.getTorrentClient();
        if (torrentClient?.ping) await torrentClient.ping();
        return { target, configured: true, status: torrentClient?.ping ? "ok" : "configured", detail: torrentClient?.ping ? "qBittorrent responded." : "qBittorrent is configured.", checkedAt };
      } catch (error) {
        return { target, configured: true, status: "failed" as const, detail: error instanceof Error ? error.message : "qBittorrent check failed.", checkedAt };
      }
    }
    if (target === "tools") {
      const tools = await collectToolDiagnostics(config, context.options.commandExecutor);
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
}
