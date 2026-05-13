import { copyFile, link, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { transliterate } from "transliteration";
import { runCommand, type CommandExecutor } from "./commands.js";

export type PreparedMediaMode = "hardlink" | "copy" | "remux";

export interface PreparedMediaResult {
  inputPath: string;
  outputPath: string;
  mode: PreparedMediaMode;
  remuxed: boolean;
}

export interface PrepareUploadMediaOptions {
  sourcePath: string;
  uploadDirectory: string;
  intermediateDirectory: string;
  runExternalTools: boolean;
  mkvmergeCommand: string;
  commandExecutor: CommandExecutor;
}

function sanitizeUploadFilename(filename: string): string {
  const sanitized = transliterate(filename)
    .replace(/[\\/:*?"<>|\0\r\n]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
  if (sanitized) return sanitized;
  throw new Error(`Upload filename ${JSON.stringify(filename)} became empty after sanitization`);
}

export function outputName(sourcePath: string): string {
  const parsed = path.parse(sourcePath);
  return sanitizeUploadFilename(parsed.ext.toLowerCase() === ".mp4" ? `${parsed.name}.mkv` : parsed.base);
}

export async function ensurePtpSafeUploadPath(inputPath: string): Promise<string> {
  const safePath = path.join(path.dirname(inputPath), sanitizeUploadFilename(path.basename(inputPath)));
  if (safePath === inputPath) return inputPath;

  await mkdir(path.dirname(safePath), { recursive: true });
  try {
    await link(inputPath, safePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return safePath;
    await copyFile(inputPath, safePath);
  }
  return safePath;
}

export async function prepareUploadMedia(options: PrepareUploadMediaOptions): Promise<PreparedMediaResult> {
  await mkdir(options.uploadDirectory, { recursive: true });
  await mkdir(options.intermediateDirectory, { recursive: true });

  const outputPath = path.join(options.uploadDirectory, outputName(options.sourcePath));
  if (path.extname(options.sourcePath).toLowerCase() === ".mp4") {
    if (!options.runExternalTools) {
      await copyFile(options.sourcePath, outputPath);
      return { inputPath: options.sourcePath, outputPath, mode: "copy", remuxed: false };
    }
    const stagedOutputPath = path.join(options.intermediateDirectory, outputName(options.sourcePath));
    await rm(stagedOutputPath, { force: true });
    const result = await runCommand(
      options.commandExecutor,
      options.mkvmergeCommand,
      ["-o", stagedOutputPath, options.sourcePath],
      {
        timeoutMs: 120_000
      }
    );
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `mkvmerge remux failed with exit code ${result.exitCode}`);
    await rm(outputPath, { force: true });
    await rename(stagedOutputPath, outputPath);
    return { inputPath: options.sourcePath, outputPath, mode: "remux", remuxed: true };
  }

  try {
    await link(options.sourcePath, outputPath);
    return { inputPath: options.sourcePath, outputPath, mode: "hardlink", remuxed: false };
  } catch {
    await copyFile(options.sourcePath, outputPath);
    return { inputPath: options.sourcePath, outputPath, mode: "copy", remuxed: false };
  }
}
