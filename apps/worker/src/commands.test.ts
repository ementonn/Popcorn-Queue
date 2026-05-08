import { describe, expect, it } from "vitest";
import { checkToolAvailability, type CommandExecutor, type CommandInvocation, type CommandResult } from "./commands.js";

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
});
