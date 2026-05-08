import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { redactForLog } from "@popcorn-queue/core";

export interface JobLogEvent {
  at: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  payload?: unknown;
}

export async function appendJobEvent(filePath: string, event: JobLogEvent): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const payload = event.payload === undefined ? "" : ` ${JSON.stringify(redactForLog(event.payload))}`;
  await appendFile(filePath, `${event.at} ${event.level.toUpperCase()} ${event.message}${payload}\n`, "utf8");
}

export async function readLogTail(filePath: string, lines: number): Promise<string[]> {
  try {
    const text = await readFile(filePath, "utf8");
    if (!text.trim()) return [];
    return text.trimEnd().split(/\r?\n/).slice(-lines);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
