import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendJobEvent, readLogTail } from "./job-logs.js";

describe("job logs", () => {
  it("writes readable redacted per-job logs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-job-log-"));
    const logFile = path.join(root, "data", "jobs", "job-1", "logs", "job.log");

    await appendJobEvent(logFile, {
      at: "2026-05-08T00:00:00.000Z",
      level: "info",
      message: "PTP check completed.",
      payload: { apiKey: "secret", decision: "open" }
    });

    const text = await readFile(logFile, "utf8");
    expect(text).toContain("PTP check completed.");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("secret");
  });

  it("reads the newest log lines for diagnostics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-log-tail-"));
    const logFile = path.join(root, "job.log");
    for (let index = 0; index < 5; index += 1) {
      await appendJobEvent(logFile, {
        at: `2026-05-08T00:00:0${index}.000Z`,
        level: "info",
        message: `line ${index}`
      });
    }

    expect(await readLogTail(logFile, 2)).toEqual(expect.arrayContaining([expect.stringContaining("line 3"), expect.stringContaining("line 4")]));
  });
});
