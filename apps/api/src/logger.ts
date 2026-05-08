import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import pino, { type Level, type StreamEntry } from "pino";
import type { ApiConfig } from "./config.js";

const REDACTED_PATHS = [
  "req.headers.authorization",
  "request.headers.authorization",
  "headers.authorization",
  "*.authorization",
  "*.apiKey",
  "*.api_key",
  "*.password",
  "*.token",
  "*.browserToken",
  "*.ptp.apiKey",
  "*.ptp.password",
  "*.integrations.imgbbApiKey",
  "*.integrations.ptpImgApiKey",
  "*.integrations.qbittorrentPassword"
];

export function createApiLogger(config: ApiConfig): FastifyBaseLogger | false {
  if (!config.logging.toConsole && !config.logging.toFile) return false;

  const streams: StreamEntry<Level>[] = [];
  const level = config.logging.level as Level;
  if (config.logging.toConsole) {
    streams.push({ level, stream: pino.destination(1) });
  }
  if (config.logging.toFile) {
    mkdirSync(dirname(config.logging.file), { recursive: true });
    streams.push({ level, stream: pino.destination({ dest: config.logging.file, sync: false }) });
  }

  return pino(
    {
      level,
      redact: {
        paths: REDACTED_PATHS,
        censor: "[redacted]"
      }
    },
    pino.multistream(streams, { dedupe: true })
  );
}
