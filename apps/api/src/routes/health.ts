import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../api-context.js";
import type { ApiConfig } from "../config.js";

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

export function registerHealthRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  app.get("/api/health", async () => {
    const config = context.config();
    return {
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
    };
  });

  app.get("/api/features", async () => {
    const config = context.config();
    return {
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
    };
  });
}
