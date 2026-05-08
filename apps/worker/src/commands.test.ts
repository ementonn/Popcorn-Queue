import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkToolAvailability, nodeCommandExecutor, type CommandExecutor, type CommandInvocation, type CommandResult } from "./commands.js";

function result(invocation: CommandInvocation, overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    command: invocation.command,
    args: invocation.args,
    exitCode: 0,
    signal: null,
    stdout: "tool version 1.0\n",
    stderr: "",
    durationMs: 1,
    ...overrides
  };
}

describe("worker command wrappers", () => {
  it("checks tool availability with the expected command", async () => {
    const calls: CommandInvocation[] = [];
    const executor: CommandExecutor = async (invocation) => {
      calls.push(invocation);
      return result(invocation);
    };

    const availability = await checkToolAvailability("mediainfo", executor, "/usr/local/bin/mediainfo");

    expect(availability.available).toBe(true);
    expect(availability.command).toBe("/usr/local/bin/mediainfo");
    expect(availability.version).toBe("tool version 1.0");
    expect(calls[0]).toMatchObject({
      command: "/usr/local/bin/mediainfo",
      args: ["--Version"]
    });
  });

  it("reports unavailable tools without throwing", async () => {
    const executor: CommandExecutor = async (invocation) =>
      result(invocation, {
        exitCode: null,
        stdout: "",
        error: {
          code: "ENOENT",
          message: "not found"
        }
      });

    const availability = await checkToolAvailability("ffmpeg", executor);

    expect(availability.available).toBe(false);
    expect(availability.error).toBe("not found");
  });

  it("returns a timeout result when a child ignores SIGTERM", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "popcorn-command-timeout-"));
    const pidFile = path.join(dir, "child.pid");
    const script = [
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);"
    ].join("");

    try {
      const pending = nodeCommandExecutor({
        command: process.execPath,
        args: ["-e", script],
        timeoutMs: 50
      });
      const result = await Promise.race([
        pending,
        new Promise<CommandResult>((_, reject) => {
          setTimeout(() => reject(new Error("executor did not resolve after timeout")), 700);
        })
      ]);

      expect(result.exitCode).toBeNull();
      expect(result.error).toMatchObject({ code: "ETIMEDOUT" });
    } finally {
      try {
        const pid = Number(await readFile(pidFile, "utf8"));
        if (Number.isFinite(pid)) process.kill(pid, "SIGKILL");
      } catch {
        // The command executor may already have killed the process.
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
