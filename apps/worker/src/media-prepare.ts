import { copyFile, link, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
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
  ffmpegCommand: string;
  commandExecutor: CommandExecutor;
}

function outputName(sourcePath: string): string {
  const parsed = path.parse(sourcePath);
  return parsed.ext.toLowerCase() === ".mp4" ? `${parsed.name}.mkv` : parsed.base;
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
      options.ffmpegCommand,
      ["-hide_banner", "-loglevel", "error", "-y", "-i", options.sourcePath, "-c", "copy", stagedOutputPath],
      {
        timeoutMs: 120_000
      }
    );
    if (result.exitCode !== 0) throw new Error(result.stderr || `ffmpeg remux failed with exit code ${result.exitCode}`);
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
