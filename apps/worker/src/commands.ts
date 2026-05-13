import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";

export type WorkerTool = "ffmpeg" | "mediainfo" | "mkvmerge" | "mpv" | "oxipng" | "xvfb-run";

export interface CommandInvocation {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: {
    code?: string;
    message: string;
  };
}

export type CommandExecutor = (invocation: CommandInvocation) => Promise<CommandResult>;

export interface ToolAvailability {
  tool: WorkerTool;
  command: string;
  available: boolean;
  version: string | null;
  location: string | null;
  error: string | null;
}

function makeResult(
  invocation: CommandInvocation,
  startedAt: number,
  fields: Pick<CommandResult, "exitCode" | "signal" | "stdout" | "stderr"> & { error?: CommandResult["error"] }
): CommandResult {
  const result: CommandResult = {
    command: invocation.command,
    args: invocation.args,
    exitCode: fields.exitCode,
    signal: fields.signal,
    stdout: fields.stdout,
    stderr: fields.stderr,
    durationMs: Date.now() - startedAt
  };
  if (fields.error) result.error = fields.error;
  return result;
}

export const nodeCommandExecutor: CommandExecutor = async (invocation) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const options: SpawnOptionsWithoutStdio = {};
    if (invocation.cwd) options.cwd = invocation.cwd;
    if (invocation.env) options.env = invocation.env;

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;

    const settle = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      resolve(result);
    };

    const child = spawn(invocation.command, invocation.args, options);

    if (invocation.timeoutMs && invocation.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKillTimeout = setTimeout(() => {
          child.kill("SIGKILL");
        }, 500);
      }, invocation.timeoutMs);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      const commandError: CommandResult["error"] = { message: error.message };
      if (error.code) commandError.code = error.code;
      settle(
        makeResult(invocation, startedAt, {
          exitCode: null,
          signal: null,
          stdout,
          stderr,
          error: commandError
        })
      );
    });
    child.on("close", (exitCode, signal) => {
      const timeoutError: CommandResult["error"] | undefined = timedOut
        ? {
            code: "ETIMEDOUT",
            message: `Command timed out after ${invocation.timeoutMs}ms.`
          }
        : undefined;
      settle(
        makeResult(invocation, startedAt, {
          exitCode,
          signal,
          stdout,
          stderr,
          ...(timeoutError ? { error: timeoutError } : {})
        })
      );
    });
  });

export function commandSucceeded(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.error;
}

function availabilityArgs(tool: WorkerTool): string[] {
  if (tool === "ffmpeg") return ["-version"];
  if (tool === "mediainfo") return ["--Version"];
  if (tool === "xvfb-run") return ["--help"];
  return ["--version"];
}

function firstVersionLine(result: CommandResult): string | null {
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => /\d/.test(line)) ?? lines[0] ?? null;
}

async function resolveCommandLocation(command: string, executor: CommandExecutor): Promise<string | null> {
  if (command.includes("/")) return command;
  const result = await executor({
    command: "which",
    args: [command],
    timeoutMs: 5000
  });
  if (!commandSucceeded(result)) return null;
  return firstVersionLine(result);
}

export async function checkToolAvailability(
  tool: WorkerTool,
  executor: CommandExecutor = nodeCommandExecutor,
  command: string = tool
): Promise<ToolAvailability> {
  const result = await executor({
    command,
    args: availabilityArgs(tool),
    timeoutMs: 5000
  });
  const available = commandSucceeded(result);
  return {
    tool,
    command,
    available,
    version: available ? firstVersionLine(result) : null,
    location: available ? await resolveCommandLocation(command, executor) : null,
    error: available ? null : result.error?.message ?? (result.stderr.trim() || `Exit code ${result.exitCode ?? "unknown"}`)
  };
}

export async function checkWorkerTools(
  executor: CommandExecutor = nodeCommandExecutor,
  commands: Partial<Record<WorkerTool, string>> = {}
): Promise<Record<WorkerTool, ToolAvailability>> {
  const [ffmpeg, mediainfo, mkvmerge, mpv, oxipng, xvfbRun] = await Promise.all([
    checkToolAvailability("ffmpeg", executor, commands.ffmpeg ?? "ffmpeg"),
    checkToolAvailability("mediainfo", executor, commands.mediainfo ?? "mediainfo"),
    checkToolAvailability("mkvmerge", executor, commands.mkvmerge ?? "mkvmerge"),
    checkToolAvailability("mpv", executor, commands.mpv ?? "mpv"),
    checkToolAvailability("oxipng", executor, commands.oxipng ?? "oxipng"),
    checkToolAvailability("xvfb-run", executor, commands["xvfb-run"] ?? "xvfb-run")
  ]);
  return { ffmpeg, mediainfo, mkvmerge, mpv, oxipng, "xvfb-run": xvfbRun };
}

export async function runCommand(
  executor: CommandExecutor,
  command: string,
  args: string[],
  options: Omit<CommandInvocation, "command" | "args"> = {}
): Promise<CommandResult> {
  const invocation: CommandInvocation = { command, args };
  if (options.cwd) invocation.cwd = options.cwd;
  if (options.env) invocation.env = options.env;
  if (options.timeoutMs) invocation.timeoutMs = options.timeoutMs;
  return executor(invocation);
}
