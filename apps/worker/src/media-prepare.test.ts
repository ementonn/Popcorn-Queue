import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandExecutor } from "./commands.js";
import { ensurePtpSafeUploadPath, prepareUploadMedia } from "./media-prepare.js";

describe("prepareUploadMedia", () => {
  it("places uploadable MKV files in media/upload using hardlink or copy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-media-"));
    const source = path.join(root, "download", "Movie.mkv");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "mkv");

    const result = await prepareUploadMedia({
      sourcePath: source,
      uploadDirectory: path.join(root, "job", "media", "upload"),
      intermediateDirectory: path.join(root, "job", "media", "intermediates"),
      runExternalTools: false,
      ffmpegCommand: "ffmpeg",
      commandExecutor: async () => {
        throw new Error("ffmpeg must not run for MKV hardlink/copy");
      }
    });

    expect(result.outputPath).toBe(path.join(root, "job", "media", "upload", "Movie.mkv"));
    expect(await readFile(result.outputPath, "utf8")).toBe("mkv");
    expect(["hardlink", "copy"]).toContain(result.mode);

    const inputStat = await stat(source);
    const outputStat = await stat(result.outputPath);
    if (result.mode === "hardlink") expect(outputStat.ino).toBe(inputStat.ino);
  });

  it("transliterates and sanitizes upload filenames before torrent creation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-media-safe-name-"));
    const source = path.join(root, "download", "脑洞大开.Flying.Mind.2024.1080p.WEB-DL.HEVC.10bit.HDR.AAC2.0-ZmWeb.mkv");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "mkv");

    const result = await prepareUploadMedia({
      sourcePath: source,
      uploadDirectory: path.join(root, "job", "media", "upload"),
      intermediateDirectory: path.join(root, "job", "media", "intermediates"),
      runExternalTools: false,
      ffmpegCommand: "ffmpeg",
      commandExecutor: async () => {
        throw new Error("ffmpeg must not run for MKV hardlink/copy");
      }
    });

    const uploadName = path.basename(result.outputPath);
    expect(uploadName).toMatch(/Flying\.Mind\.2024/);
    expect(uploadName).toMatch(/\.mkv$/);
    expect(uploadName).not.toContain("脑洞大开");
    expect(uploadName).toMatch(/^[\x20-\x7E]+$/);
    expect(uploadName).not.toMatch(/[\\/:*?"<>|]/);
  });

  it("creates a safe upload-path alias for already prepared legacy filenames", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-media-legacy-name-"));
    const unsafePath = path.join(root, "media", "upload", "脑洞大开.Flying.Mind.2024.mkv");
    await mkdir(path.dirname(unsafePath), { recursive: true });
    await writeFile(unsafePath, "mkv");

    const safePath = await ensurePtpSafeUploadPath(unsafePath);

    expect(path.basename(safePath)).toBe("Nao Dong Da Kai.Flying.Mind.2024.mkv");
    expect(await readFile(safePath, "utf8")).toBe("mkv");
    expect(await readFile(unsafePath, "utf8")).toBe("mkv");
  });

  it("remuxes MP4 to MKV through the injected executor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-remux-"));
    const source = path.join(root, "download", "Movie.mp4");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "mp4");
    const calls: string[] = [];
    const executor: CommandExecutor = async (invocation) => {
      calls.push(`${invocation.command} ${invocation.args.join(" ")}`);
      const outputPath = invocation.args.at(-1);
      if (typeof outputPath === "string") await writeFile(outputPath, "mkv");
      return {
        command: invocation.command,
        args: invocation.args,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 1
      };
    };

    const result = await prepareUploadMedia({
      sourcePath: source,
      uploadDirectory: path.join(root, "job", "media", "upload"),
      intermediateDirectory: path.join(root, "job", "media", "intermediates"),
      runExternalTools: true,
      ffmpegCommand: "ffmpeg",
      commandExecutor: executor
    });

    expect(result.mode).toBe("remux");
    expect(result.outputPath.endsWith("Movie.mkv")).toBe(true);
    expect(await readFile(result.outputPath, "utf8")).toBe("mkv");
    expect(calls[0]).toContain("-c copy");
  });

  it("copies MP4 to an MKV output path without ffmpeg when external tools are disabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-mp4-copy-"));
    const source = path.join(root, "download", "Movie.mp4");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "mp4");
    let called = false;

    const result = await prepareUploadMedia({
      sourcePath: source,
      uploadDirectory: path.join(root, "job", "media", "upload"),
      intermediateDirectory: path.join(root, "job", "media", "intermediates"),
      runExternalTools: false,
      ffmpegCommand: "ffmpeg",
      commandExecutor: async () => {
        called = true;
        throw new Error("ffmpeg must not run when external tools are disabled");
      }
    });

    expect(result).toMatchObject({
      inputPath: source,
      outputPath: path.join(root, "job", "media", "upload", "Movie.mkv"),
      mode: "copy",
      remuxed: false
    });
    expect(await readFile(result.outputPath, "utf8")).toBe("mp4");
    expect(called).toBe(false);
  });

  it("stages MP4 remux output and overwrites stale retry files after success", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-remux-retry-"));
    const source = path.join(root, "download", "Movie.mp4");
    const uploadDirectory = path.join(root, "job", "media", "upload");
    const intermediateDirectory = path.join(root, "job", "media", "intermediates");
    const finalOutput = path.join(uploadDirectory, "Movie.mkv");
    const tempOutput = path.join(intermediateDirectory, "Movie.mkv");
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(uploadDirectory, { recursive: true });
    await mkdir(intermediateDirectory, { recursive: true });
    await writeFile(source, "mp4");
    await writeFile(finalOutput, "stale-final");
    await writeFile(tempOutput, "stale-temp");
    const calls: string[] = [];
    const executor: CommandExecutor = async (invocation) => {
      calls.push(`${invocation.command} ${invocation.args.join(" ")}`);
      const outputPath = invocation.args.at(-1);
      if (typeof outputPath === "string") await writeFile(outputPath, "fresh-remux");
      return {
        command: invocation.command,
        args: invocation.args,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 1
      };
    };

    const result = await prepareUploadMedia({
      sourcePath: source,
      uploadDirectory,
      intermediateDirectory,
      runExternalTools: true,
      ffmpegCommand: "ffmpeg",
      commandExecutor: executor
    });

    expect(result).toMatchObject({
      outputPath: finalOutput,
      mode: "remux",
      remuxed: true
    });
    expect(calls[0]).toContain("-y");
    expect(calls[0]).toContain(tempOutput);
    expect(calls[0]).not.toContain(finalOutput);
    expect(await readFile(finalOutput, "utf8")).toBe("fresh-remux");
  });
});
