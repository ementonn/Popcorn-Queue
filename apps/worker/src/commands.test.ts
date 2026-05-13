import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkToolAvailability, checkWorkerTools, nodeCommandExecutor, type CommandExecutor, type CommandInvocation, type CommandResult } from "./commands.js";

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
    expect(availability.location).toBe("/usr/local/bin/mediainfo");
    expect(availability.version).toBe("tool version 1.0");
    expect(calls[0]).toMatchObject({
      command: "/usr/local/bin/mediainfo",
      args: ["--Version"]
    });
  });

  it("resolves PATH command locations and checks mkvmerge", async () => {
    const calls: CommandInvocation[] = [];
    const executor: CommandExecutor = async (invocation) => {
      calls.push(invocation);
      if (invocation.command === "which") return result(invocation, { stdout: "/usr/bin/mkvmerge\n" });
      return result(invocation, { stdout: "mkvmerge v82.0\n" });
    };

    const availability = await checkToolAvailability("mkvmerge", executor);

    expect(availability).toMatchObject({
      tool: "mkvmerge",
      command: "mkvmerge",
      available: true,
      version: "mkvmerge v82.0",
      location: "/usr/bin/mkvmerge"
    });
    expect(calls).toEqual([
      expect.objectContaining({ command: "mkvmerge", args: ["--version"] }),
      expect.objectContaining({ command: "which", args: ["mkvmerge"] })
    ]);
  });

  it("checks mpv and xvfb-run as worker screenshot tools", async () => {
    const calls: CommandInvocation[] = [];
    const executor: CommandExecutor = async (invocation) => {
      calls.push(invocation);
      if (invocation.command === "which") return result(invocation, { stdout: `/usr/bin/${invocation.args[0] ?? "tool"}\n` });
      return result(invocation, { stdout: `${invocation.command} version test\n` });
    };

    const tools = await checkWorkerTools(executor, {
      mpv: "/opt/bin/mpv",
      "xvfb-run": "/opt/bin/xvfb-run"
    });

    expect(tools.mpv).toMatchObject({ tool: "mpv", command: "/opt/bin/mpv", available: true });
    expect(tools["xvfb-run"]).toMatchObject({ tool: "xvfb-run", command: "/opt/bin/xvfb-run", available: true });
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "/opt/bin/mpv", args: ["--version"] }),
        expect.objectContaining({ command: "/opt/bin/xvfb-run", args: ["--help"] })
      ])
    );
  });

  it("uses the MediaInfoLib line when mediainfo prints a heading before the version", async () => {
    const executor: CommandExecutor = async (invocation) => {
      if (invocation.command === "which") return result(invocation, { stdout: "/usr/bin/mediainfo\n" });
      return result(invocation, { stdout: "MediaInfo Command line,\nMediaInfoLib - v23.06\n" });
    };

    const availability = await checkToolAvailability("mediainfo", executor);

    expect(availability.version).toBe("MediaInfoLib - v23.06");
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
