import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandExecutor } from "./commands.js";
import { prepareUploadMedia } from "./media-prepare.js";

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
});
