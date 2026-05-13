import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildUploadPlan, type ReviewDraft, type TorrentCandidate } from "@popcorn-queue/core";
import type { CommandExecutor, CommandInvocation, CommandResult } from "./commands.js";
import { MemoryPhaseOutputStore, PhaseRunner, createDefaultPhaseHandlers, createPhaseContext, parseMediaInfoSummary, sanitizeMediaInfoText, type PhaseHandler } from "./phases.js";

const candidate: TorrentCandidate = {
  site: "mteam",
  title: "Perfect.Days.2023.1080p.BluRay.FLAC.x264-GROUP",
  imdbId: "tt27503384"
};

const reviewDraft: ReviewDraft = {
  releaseName: "Perfect.Days.2023.1080p.BluRay.FLAC.x264-GROUP",
  description: "Release description",
  groupId: "123",
  type: "Feature Film",
  codec: "H.264",
  container: "MKV",
  resolution: "1080p",
  source: "Blu-ray",
  remasterYear: "",
  remasterTitle: "",
  subtitles: [],
  trumpable: [],
  scene: true,
  personalRip: false,
  internal: false
};

function commandResult(invocation: CommandInvocation, stdout = `${invocation.command} version\n`): CommandResult {
  return {
    command: invocation.command,
    args: invocation.args,
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    durationMs: 1
  };
}

function fakeExecutor(calls: CommandInvocation[]): CommandExecutor {
  return async (invocation) => {
    calls.push(invocation);
    if (invocation.command === "mediainfo" && invocation.args[0] === "--Output=JSON") {
      return commandResult(
        invocation,
        JSON.stringify({
          media: {
            track: [
              { "@type": "General", Format: "Matroska", Duration: "7200.5" },
              { "@type": "Video", Width: "1920", Height: "1080", HDR_Format: "SMPTE ST 2086" },
              { "@type": "Audio" },
              { "@type": "Text" }
            ]
          }
        })
      );
    }
    if (invocation.command === "mediainfo" && invocation.args[0] !== "--Version") {
      return commandResult(invocation, `General\nComplete name                            : ${invocation.args[0]}\nFormat                                   : Matroska\n`);
    }
    return commandResult(invocation);
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("worker phase scaffold", () => {
  it("parses a useful MediaInfo summary", () => {
    const summary = parseMediaInfoSummary(
      JSON.stringify({
        media: {
          track: [
            { "@type": "General", Format: "Matroska", Duration: "5400" },
            { "@type": "Video", Width: "3840", Height: "2160" },
            { "@type": "Audio" }
          ]
        }
      })
    );

    expect(summary).toMatchObject({
      durationSeconds: 5400,
      format: "Matroska",
      video: {
        width: 3840,
        height: 2160
      },
      audioTrackCount: 1
    });
  });

  it("runs MediaInfo through the injected executor when enabled", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-worker-"));
    const mediaPath = path.join(tempDir, "movie.mkv");
    await writeFile(mediaPath, "");
    const calls: CommandInvocation[] = [];
    const inspectMedia = createDefaultPhaseHandlers().find((handler): handler is PhaseHandler<"inspect-media"> => handler.phase === "inspect-media");
    if (!inspectMedia) throw new Error("Missing inspect-media handler");

    const context = createPhaseContext(
      "job-1",
      {
        candidate,
        mediaPath
      },
      {
        runExternalTools: true,
        commandExecutor: fakeExecutor(calls)
      }
    );

    const output = await inspectMedia.run(context);

    expect(output.summary?.durationSeconds).toBe(7200.5);
    expect(calls.some((call) => call.command === "mediainfo" && call.args[0] === "--Output=JSON" && call.args[1] === mediaPath)).toBe(true);
  });

  it("inspect-media stores text and json mediainfo artifacts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-worker-mediainfo-"));
    const uploadRoot = path.join(tempDir, "media", "upload");
    const mediaPath = path.join(uploadRoot, "Movie.mkv");
    await mkdir(uploadRoot, { recursive: true });
    await writeFile(mediaPath, "");
    const calls: CommandInvocation[] = [];
    const inspectMedia = createDefaultPhaseHandlers().find((handler): handler is PhaseHandler<"inspect-media"> => handler.phase === "inspect-media");
    if (!inspectMedia) throw new Error("Missing inspect-media handler");

    const context = createPhaseContext(
      "job-mediainfo",
      {
        candidate,
        mediaPath,
        workingDirectory: tempDir
      },
      {
        runExternalTools: true,
        commandExecutor: fakeExecutor(calls)
      }
    );

    const output = await inspectMedia.run(context);

    expect(output.mediaInfoText.result?.stdout).toContain("General");
    expect(output.mediaInfoText.result?.stdout).toContain("Complete name                            : Movie.mkv");
    expect(output.mediaInfoJson.result?.stdout).toContain("\"media\"");
    expect(output.mediaInfo.result?.stdout).toBe(output.mediaInfoText.result?.stdout);
    expect(output.summary?.format).toBe("Matroska");
    expect(calls.some((call) => call.command === "mediainfo" && call.args[0] === mediaPath)).toBe(true);
    expect(calls.some((call) => call.command === "mediainfo" && call.args[0] === "--Output=JSON" && call.args[1] === mediaPath)).toBe(true);
  });

  it("sanitizeMediaInfoText removes absolute upload paths", () => {
    const input = "General\nComplete name                            : /jobs/abc/upload/Movie.mkv\nFormat                                   : Matroska\n";

    expect(sanitizeMediaInfoText(input, "/jobs/abc/upload")).toContain("Complete name                            : Movie.mkv");
  });

  it("ptp upload draft uses text mediainfo in release description", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-worker-draft-mediainfo-"));
    const mediaPath = path.join(tempDir, "media", "upload", "Movie.mkv");
    const torrentPath = path.join(tempDir, "torrent", "upload.torrent");
    await mkdir(path.dirname(mediaPath), { recursive: true });
    await mkdir(path.dirname(torrentPath), { recursive: true });
    await writeFile(mediaPath, "");
    await writeFile(torrentPath, "torrent");
    const textInvocation: CommandInvocation = { command: "mediainfo", args: [mediaPath], timeoutMs: 30_000 };
    const jsonInvocation: CommandInvocation = { command: "mediainfo", args: ["--Output=JSON", mediaPath], timeoutMs: 30_000 };
    const store = new MemoryPhaseOutputStore({
      "inspect-media": {
        status: "completed",
        message: "MediaInfo command completed.",
        producedAt: "2026-05-08T00:00:00.000Z",
        mediaPath,
        inspectionPlan: buildUploadPlan({ candidate }).media,
        tools: {
          ffmpeg: { tool: "ffmpeg", command: "ffmpeg", available: true, version: "ffmpeg test", location: "/usr/bin/ffmpeg", error: null },
          mediainfo: { tool: "mediainfo", command: "mediainfo", available: true, version: "mediainfo test", location: "/usr/bin/mediainfo", error: null },
          mkvmerge: { tool: "mkvmerge", command: "mkvmerge", available: true, version: "mkvmerge test", location: "/usr/bin/mkvmerge", error: null },
          mpv: { tool: "mpv", command: "mpv", available: true, version: "mpv test", location: "/usr/bin/mpv", error: null },
          oxipng: { tool: "oxipng", command: "oxipng", available: true, version: "oxipng test", location: "/usr/bin/oxipng", error: null },
          "xvfb-run": { tool: "xvfb-run", command: "xvfb-run", available: true, version: "xvfb-run test", location: "/usr/bin/xvfb-run", error: null }
        },
        mediaInfo: {
          invocation: textInvocation,
          result: commandResult(textInvocation, "General\nFormat                                   : Matroska\n")
        },
        mediaInfoText: {
          invocation: textInvocation,
          result: commandResult(textInvocation, "General\nFormat                                   : Matroska\n")
        },
        mediaInfoJson: {
          invocation: jsonInvocation,
          result: commandResult(jsonInvocation, "{\"media\":{\"track\":[{\"@type\":\"General\",\"Format\":\"Matroska\"}]}}")
        },
        summary: {
          durationSeconds: 7200,
          format: "Matroska",
          video: { width: 1920, height: 1080, hdrFormat: null },
          audioTrackCount: 1,
          subtitleTrackCount: 0
        }
      },
      "image-host-upload": {
        status: "completed",
        message: "Hosted",
        producedAt: "2026-05-08T00:00:00.000Z",
        files: [],
        hostedJsonPath: null,
        uploads: [
          {
            filePath: "screenshot-01.png",
            host: "imgbb",
            result: {
              host: "imgbb",
              url: "https://img.example/1.png",
              viewerUrl: "https://img.example/1",
              deleteUrl: null,
              mediumUrl: null,
              width: 1920,
              height: 1080
            }
          }
        ]
      },
      "torrent-create": {
        status: "completed",
        message: "Torrent created",
        producedAt: "2026-05-08T00:00:00.000Z",
        reusePlan: buildUploadPlan({ candidate }).torrentReuse,
        sourceTorrentPath: null,
        uploadTorrentPath: torrentPath
      }
    } as object);
    const preflight = createDefaultPhaseHandlers().find((handler): handler is PhaseHandler<"preflight"> => handler.phase === "preflight");
    if (!preflight) throw new Error("Missing preflight handler");

    const output = await preflight.run(
      createPhaseContext(
        "job-draft-mediainfo",
        { candidate, workingDirectory: tempDir },
        { outputStore: store }
      )
    );

    expect(output.uploadDraft.mediaInfo).toContain("General");
    expect(output.uploadDraft.description).toContain("General");
    expect(output.uploadDraft.description).not.toContain("MediaInfo:");
    expect(output.uploadDraft.description.startsWith("General\nFormat                                   : Matroska")).toBe(true);
    expect(output.uploadDraft.description).not.toContain("\"track\"");
    expect(output.uploadDraft.description).toContain("[img]https://img.example/1.png[/img]");
    expect(output.uploadDraft.description).not.toContain("[size=4][b]");
    expect(output.uploadDraft.description).not.toContain("Source:");
    expect(output.uploadDraft.description).not.toContain("PTP:");
    expect(output.uploadDraft.description).not.toContain("Duplicate check:");
  });

  it("plans screenshots without invoking ffmpeg when external tools are disabled", async () => {
    const calls: CommandInvocation[] = [];
    const screenshots = createDefaultPhaseHandlers().find((handler): handler is PhaseHandler<"screenshots"> => handler.phase === "screenshots");
    if (!screenshots) throw new Error("Missing screenshots handler");
    const context = createPhaseContext(
      "job-2",
      {
        candidate,
        workingDirectory: "/tmp/popcorn-worker-test"
      },
      {
        runExternalTools: false,
        commandExecutor: fakeExecutor(calls)
      }
    );

    const output = await screenshots.run(context);

    expect(output.plan.count).toBe(4);
    expect(output.ffmpeg).toHaveLength(4);
    expect(output.ffmpeg.every((attempt) => attempt.skippedReason === "External tool execution is disabled.")).toBe(true);
    expect(output.uploads.every((attempt) => attempt.skippedReason === "External upload execution is disabled.")).toBe(true);
    expect(calls.every((call) => call.args[0] !== "-hide_banner")).toBe(true);
  });

  it("uploads generated screenshots through an injected image host uploader", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-worker-upload-"));
    const mediaPath = path.join(tempDir, "movie.mkv");
    await writeFile(mediaPath, "");
    const uploaded: string[] = [];
    const calls: CommandInvocation[] = [];
    const screenshots = createDefaultPhaseHandlers().find((handler): handler is PhaseHandler<"screenshots"> => handler.phase === "screenshots");
    if (!screenshots) throw new Error("Missing screenshots handler");
    const executor: CommandExecutor = async (invocation) => {
      calls.push(invocation);
      const outputPath = invocation.args.at(-1);
      if (invocation.command === "ffmpeg" && invocation.args.includes("-frames:v") && typeof outputPath === "string") {
        await writeFile(outputPath, "png");
      }
      return commandResult(invocation);
    };
    const context = createPhaseContext(
      "job-uploads",
      {
        candidate,
        mediaPath,
        outputDirectory: path.join(tempDir, "screens")
      },
      {
        runExternalTools: true,
        commandExecutor: executor,
        imageUploader: {
          name: "imgbb",
          async uploadImage(filePath) {
            uploaded.push(filePath);
            return {
              host: "imgbb",
              url: `https://i.ibb.co/${path.basename(filePath)}`,
              viewerUrl: `https://ibb.co/${path.basename(filePath)}`,
              deleteUrl: null,
              mediumUrl: null,
              width: 1920,
              height: 1080
            };
          }
        }
      }
    );

    const output = await screenshots.run(context);

    expect(calls.some((call) => call.command === "ffmpeg")).toBe(true);
    expect(uploaded).toHaveLength(4);
    expect(output.uploads.every((attempt) => attempt.result?.host === "imgbb")).toBe(true);
  });

  it("fails preparation and stops when screenshot capture fails", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-worker-screenshot-fail-"));
    const mediaPath = path.join(tempDir, "movie.mkv");
    await writeFile(mediaPath, "mkv");
    const calls: CommandInvocation[] = [];
    const baseExecutor = fakeExecutor(calls);
    const executor: CommandExecutor = async (invocation) => {
      if (invocation.command === "ffmpeg" && invocation.args.includes("-frames:v")) {
        calls.push(invocation);
        return {
          ...commandResult(invocation),
          exitCode: 8,
          stderr: "No such filter: 'zscale'"
        };
      }
      return baseExecutor(invocation);
    };

    const outputs = await new PhaseRunner().runPreparationToReview(
      createPhaseContext(
        "job-screenshot-fail",
        {
          candidate,
          mediaPath,
          workingDirectory: tempDir,
          outputDirectory: path.join(tempDir, "screens")
        },
        {
          runExternalTools: true,
          commandExecutor: executor
        }
      )
    );

    expect(outputs.screenshots?.status).toBe("failed");
    expect(outputs.screenshots?.message).toContain("Screenshot capture failed");
    expect(outputs.screenshots?.ffmpeg[0]?.result?.stderr).toContain("No such filter");
    expect(outputs["image-host-upload"]).toBeUndefined();
    expect(outputs.preflight).toBeUndefined();
    expect(outputs.review).toBeUndefined();
  });

  it("retries image hosting for existing local screenshot files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-worker-image-retry-"));
    const screenshotPath = path.join(tempDir, "shot-1.png");
    await writeFile(screenshotPath, "png");
    const imageHostUpload = createDefaultPhaseHandlers().find((handler): handler is PhaseHandler<"image-host-upload"> => handler.phase === "image-host-upload");
    if (!imageHostUpload) throw new Error("Missing image-host-upload handler");
    const store = new MemoryPhaseOutputStore({
      screenshots: {
        status: "completed",
        message: "Stored screenshots reused.",
        producedAt: "2026-05-08T00:00:00.000Z",
        mediaPath: null,
        outputDirectory: tempDir,
        plan: buildUploadPlan({ candidate }).screenshots,
        tools: {
          ffmpeg: { tool: "ffmpeg", command: "ffmpeg", available: true, version: null, location: null, error: null },
          mpv: { tool: "mpv", command: "mpv", available: true, version: null, location: null, error: null },
          oxipng: { tool: "oxipng", command: "oxipng", available: true, version: null, location: null, error: null },
          "xvfb-run": { tool: "xvfb-run", command: "xvfb-run", available: true, version: null, location: null, error: null }
        },
        requiredTools: ["ffmpeg", "oxipng"],
        ffmpeg: [],
        optimizer: [],
        uploads: [{ filePath: screenshotPath, host: null, skippedReason: "Stored local screenshot is pending image host upload." }],
        files: [screenshotPath]
      }
    });

    const output = await imageHostUpload.run(
      createPhaseContext(
        "job-image-retry",
        { candidate, workingDirectory: tempDir },
        {
          outputStore: store,
          runExternalTools: true,
          imageUploader: {
            name: "imgbb",
            async uploadImage(filePath) {
              return {
                host: "imgbb",
                url: `https://i.ibb.co/${path.basename(filePath)}`,
                viewerUrl: `https://ibb.co/${path.basename(filePath)}`,
                deleteUrl: null,
                mediumUrl: null,
                width: 1920,
                height: 1080
              };
            }
          }
        }
      )
    );

    expect(output.uploads[0]?.result?.url).toBe("https://i.ibb.co/shot-1.png");
    expect(output.hostedJsonPath).toBe(path.join(tempDir, "hosted.json"));
  });

  it("fails the upload phase cleanly when no PTP submitter is configured", async () => {
    const calls: CommandInvocation[] = [];
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-worker-no-submit-"));
    await mkdir(path.join(tempDir, "torrent"), { recursive: true });
    await writeFile(path.join(tempDir, "torrent", "upload.torrent"), "torrent");
    const context = createPhaseContext(
      "job-3",
      { candidate, workingDirectory: tempDir, reviewDraft },
      {
        runExternalTools: false,
        commandExecutor: fakeExecutor(calls)
      }
    );

    const outputs = await new PhaseRunner().runFrom("intake", context);

    expect(outputs.intake?.status).toBe("completed");
    expect(outputs.screenshots?.ffmpeg[0]?.skippedReason).toBe("External tool execution is disabled.");
    expect(outputs.upload?.status).toBe("failed");
    expect(outputs.upload?.message).toMatch(/PTP submitter/i);
    expect(outputs.done).toBeUndefined();
  });

  it("runs upload tail through an injected PTP submitter", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-worker-submit-"));
    const torrentPath = path.join(tempDir, "torrent", "upload.torrent");
    await mkdir(path.dirname(torrentPath), { recursive: true });
    await writeFile(torrentPath, "torrent");
    const submitted: Array<{ draft: ReviewDraft; torrentPath: string; nfoText?: string | null }> = [];
    const context = createPhaseContext(
      "job-submit",
      {
        candidate,
        workingDirectory: tempDir,
        reviewDraft
      },
      {
        ptpSubmitter: {
          async submit(input) {
            submitted.push(input);
            return {
              groupId: "123",
              torrentId: "456",
              ptpUrl: "https://passthepopcorn.me/torrents.php?id=123&torrentid=456"
            };
          }
        }
      }
    );

    const outputs = await new PhaseRunner().runUploadTail(context);

    expect(submitted).toEqual([{ draft: reviewDraft, torrentPath, nfoText: null }]);
    expect(outputs.upload).toMatchObject({
      status: "completed",
      ptpUrl: "https://passthepopcorn.me/torrents.php?id=123&torrentid=456",
      draftOnly: false,
      result: { groupId: "123", torrentId: "456" }
    });
    expect(outputs.done?.completed).toBe(true);
  });

  it("creates the PTP upload torrent from final media with the PTP announce URL", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-ptp-torrent-"));
    const sourceTorrent = path.join(tempDir, "torrent", "source.torrent");
    const mediaPath = path.join(tempDir, "media", "upload", "Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
    await mkdir(path.dirname(sourceTorrent), { recursive: true });
    await mkdir(path.dirname(mediaPath), { recursive: true });
    await writeFile(sourceTorrent, "source torrent from another tracker");
    await writeFile(mediaPath, Buffer.from("final upload media bytes"));
    const torrentCreate = createDefaultPhaseHandlers().find((handler): handler is PhaseHandler<"torrent-create"> => handler.phase === "torrent-create");
    if (!torrentCreate) throw new Error("Missing torrent-create handler");

    const output = await torrentCreate.run(
      createPhaseContext(
        "job-ptp-torrent",
        {
          candidate,
          sourceTorrentPath: sourceTorrent,
          workingDirectory: tempDir
        },
        {
          outputStore: new MemoryPhaseOutputStore({
            "prepare-media": {
              status: "completed",
              message: "Upload media prepared.",
              producedAt: "2026-05-08T00:00:00.000Z",
              inputPath: mediaPath,
              outputPath: mediaPath,
              mode: "hardlink",
              remuxed: false
            }
          }),
          ptpAnnounceUrl: "https://please.passthepopcorn.me/passkey/announce"
        }
      )
    );

    expect(output.status).toBe("completed");
    expect(output.uploadTorrentPath).toBe(path.join(tempDir, "torrent", "upload.torrent"));
    const torrent = await readFile(output.uploadTorrentPath!);
    const torrentText = torrent.toString("binary");
    expect(torrentText).toContain("https://please.passthepopcorn.me/passkey/announce");
    expect(torrentText).toContain("Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
    expect(torrentText).toContain("private");
    expect(torrentText).not.toContain("source torrent from another tracker");
  });

  it("hands the PTP upload torrent to qBittorrent with skip hash after upload succeeds", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-qb-handoff-"));
    const torrentPath = path.join(tempDir, "torrent", "upload.torrent");
    const mediaPath = path.join(tempDir, "media", "upload", "Movie.mkv");
    await mkdir(path.dirname(torrentPath), { recursive: true });
    await mkdir(path.dirname(mediaPath), { recursive: true });
    await writeFile(torrentPath, "torrent");
    await writeFile(mediaPath, "mkv");
    const addCalls: Array<{ torrentPath: string; downloadPath: string; category?: string; tags?: string[]; skipHashCheck?: boolean }> = [];
    const context = createPhaseContext(
      "job-qb-handoff",
      {
        candidate,
        workingDirectory: tempDir,
        reviewDraft
      },
      {
        outputStore: new MemoryPhaseOutputStore({
          "prepare-media": {
            status: "completed",
            message: "Upload media prepared.",
            producedAt: "2026-05-08T00:00:00.000Z",
            inputPath: mediaPath,
            outputPath: mediaPath,
            mode: "hardlink",
            remuxed: false
          }
        }),
        torrentClientOptions: { category: "ptp", tags: ["ptp_upload"] },
        torrentClient: {
          name: "mock-qb",
          async addTorrent(options) {
            addCalls.push(options);
            return { infoHash: "ABC123" };
          },
          async getStatus() {
            throw new Error("getStatus should not run during upload handoff.");
          },
          async isComplete() {
            return true;
          },
          async listFiles() {
            return [];
          }
        },
        ptpSubmitter: {
          async submit() {
            return {
              groupId: "123",
              torrentId: "456",
              ptpUrl: "https://passthepopcorn.me/torrents.php?id=123&torrentid=456"
            };
          }
        }
      }
    );

    const outputs = await new PhaseRunner().runUploadTail(context);

    expect(outputs.upload?.status).toBe("completed");
    expect(outputs["post-hook"]).toMatchObject({
      status: "completed",
      hooksRun: ["qbittorrent-seed-handoff"]
    });
    expect(addCalls).toEqual([
      {
        torrentPath,
        downloadPath: path.join(tempDir, "media", "upload"),
        category: "ptp",
        tags: ["ptp_upload"],
        skipHashCheck: true
      }
    ]);
  });

  it("regenerates an existing upload torrent with the PTP announce before submitting", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-upload-regenerate-"));
    const torrentPath = path.join(tempDir, "torrent", "upload.torrent");
    const mediaPath = path.join(tempDir, "media", "upload", "Existing.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
    await mkdir(path.dirname(torrentPath), { recursive: true });
    await mkdir(path.dirname(mediaPath), { recursive: true });
    await writeFile(torrentPath, "source tracker torrent");
    await writeFile(mediaPath, "final media");
    const submitted: Array<{ torrentPath: string }> = [];
    const context = createPhaseContext(
      "job-upload-regenerate",
      {
        candidate,
        workingDirectory: tempDir,
        mediaPath,
        reviewDraft
      },
      {
        ptpAnnounceUrl: "https://please.passthepopcorn.me/passkey/announce",
        ptpSubmitter: {
          async submit(input) {
            submitted.push({ torrentPath: input.torrentPath });
            return {
              groupId: "123",
              torrentId: "456",
              ptpUrl: "https://passthepopcorn.me/torrents.php?id=123&torrentid=456"
            };
          }
        }
      }
    );

    const outputs = await new PhaseRunner().runUploadTail(context);

    expect(outputs.upload?.status).toBe("completed");
    expect(submitted).toEqual([{ torrentPath }]);
    const torrent = (await readFile(torrentPath)).toString("binary");
    expect(torrent).toContain("https://please.passthepopcorn.me/passkey/announce");
    expect(torrent).toContain("Existing.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
    expect(torrent).not.toContain("source tracker torrent");
  });

  it("runs preparation to review without running upload", async () => {
    const calls: CommandInvocation[] = [];
    const context = createPhaseContext(
      "job-review",
      { candidate },
      {
        runExternalTools: false,
        commandExecutor: fakeExecutor(calls)
      }
    );

    const outputs = await new PhaseRunner().runPreparationToReview(context);

    expect(outputs.review?.status).toBe("completed");
    expect(outputs.upload).toBeUndefined();
    expect(outputs.done).toBeUndefined();
  });

  it("runs preparation through review when preflight is blocked", async () => {
    const calls: CommandInvocation[] = [];
    const blockedCandidate: TorrentCandidate = {
      ...candidate,
      title: "Perfect.Days.2023.1080p.BluRay.FLAC.x264-GROUP.MP4"
    };
    const context = createPhaseContext(
      "job-blocked-review",
      {
        candidate: blockedCandidate
      },
      {
        runExternalTools: false,
        commandExecutor: fakeExecutor(calls)
      }
    );

    const outputs = await new PhaseRunner().runPreparationToReview(context);

    expect(outputs.preflight?.status).toBe("blocked");
    expect(outputs.review?.readyForHumanReview).toBe(true);
    expect(outputs.upload).toBeUndefined();
    expect(outputs.done).toBeUndefined();
  });

  it("reports qBittorrent download progress while waiting for completion", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-worker-qb-status-"));
    const torrentPath = path.join(tempDir, "source.torrent");
    const downloadDir = path.join(tempDir, "download");
    const mediaPath = path.join(downloadDir, "Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
    await mkdir(downloadDir, { recursive: true });
    await writeFile(torrentPath, "source torrent");
    await writeFile(mediaPath, "movie");
    const reported: Array<{ state: string; progress: number | null }> = [];
    const statuses = [
      { state: "downloading", progress: 0, downloaded: 0, size: 5, amountLeft: 5 },
      { state: "downloading", progress: 0.5, downloaded: 3, size: 5, amountLeft: 2 },
      { state: "uploading", progress: 1, downloaded: 5, size: 5, amountLeft: 0 }
    ];
    const download = createDefaultPhaseHandlers().find((handler): handler is PhaseHandler<"download-or-locate"> => handler.phase === "download-or-locate");
    if (!download) throw new Error("Missing download-or-locate handler");

    const context = createPhaseContext(
      "job-qb-status",
      {
        candidate,
        sourceTorrentPath: torrentPath,
        workingDirectory: tempDir
      },
      {
        torrentClientOptions: { waitTimeoutMs: 500, waitIntervalMs: 1 },
        torrentClient: {
          name: "mock-qb",
          async addTorrent() {
            return { infoHash: "ABC123" };
          },
          async getStatus(infoHash) {
            const next = statuses.shift() ?? { state: "uploading", progress: 1, downloaded: 5, size: 5, amountLeft: 0 };
            return {
              client: "mock-qb",
              infoHash,
              state: next.state,
              progress: next.progress,
              downloaded: next.downloaded,
              size: next.size,
              amountLeft: next.amountLeft,
              downloadSpeed: next.progress === 1 ? 0 : 1024,
              uploadSpeed: 0,
              eta: next.progress === 1 ? 0 : 10,
              seeds: 2,
              peers: 1,
              savePath: downloadDir,
              contentPath: mediaPath,
              lastUpdatedAt: "2026-05-08T00:00:00.000Z",
              error: null
            };
          },
          async isComplete() {
            throw new Error("isComplete should be implemented through getStatus in the worker wait loop.");
          },
          async listFiles() {
            return [{ name: path.basename(mediaPath), size: 5, progress: 1 }];
          }
        },
        reportDownloadStatus: async (status) => {
          reported.push({ state: status.state, progress: status.progress });
        }
      }
    );

    const output = await download.run(context);

    expect(output.status).toBe("completed");
    expect(output.infoHash).toBe("ABC123");
    expect(reported).toEqual([
      { state: "downloading", progress: 0 },
      { state: "downloading", progress: 0.5 },
      { state: "uploading", progress: 1 }
    ]);
  });

  it("uses an already completed qBittorrent content path outside the job download directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-worker-qb-existing-"));
    const torrentPath = path.join(tempDir, "source.torrent");
    const qbDownloadDir = path.join(tempDir, "qb-downloads", "Take.Off.2026.2160p.WEB.x265.DV-UBWEB");
    const mediaPath = path.join(qbDownloadDir, "Take.Off.2026.2160p.WEB.x265.DV-UBWEB.mkv");
    await mkdir(qbDownloadDir, { recursive: true });
    await writeFile(torrentPath, "source torrent");
    await writeFile(mediaPath, "movie");
    const download = createDefaultPhaseHandlers().find((handler): handler is PhaseHandler<"download-or-locate"> => handler.phase === "download-or-locate");
    if (!download) throw new Error("Missing download-or-locate handler");

    const context = createPhaseContext(
      "job-qb-existing-download",
      {
        candidate: {
          ...candidate,
          title: "Take.Off.2026.2160p.WEB.x265.DV-UBWEB"
        },
        sourceTorrentPath: torrentPath,
        workingDirectory: path.join(tempDir, "job")
      },
      {
        torrentClientOptions: { waitTimeoutMs: 0, waitIntervalMs: 1 },
        torrentClient: {
          name: "mock-qb",
          async addTorrent() {
            return { infoHash: "TAKEOFFHASH" };
          },
          async getStatus(infoHash) {
            return {
              client: "mock-qb",
              infoHash,
              state: "uploading",
              progress: 1,
              downloaded: 5,
              size: 5,
              amountLeft: 0,
              downloadSpeed: 0,
              uploadSpeed: 0,
              eta: 0,
              seeds: 2,
              peers: 1,
              savePath: qbDownloadDir,
              contentPath: mediaPath,
              lastUpdatedAt: "2026-05-08T00:00:00.000Z",
              error: null
            };
          },
          async isComplete() {
            throw new Error("isComplete should be implemented through getStatus in the worker wait loop.");
          },
          async listFiles() {
            return [{ name: path.basename(mediaPath), size: 5, progress: 1 }];
          }
        }
      }
    );

    const output = await download.run(context);

    expect(output.status).toBe("completed");
    expect(output.filePath).toBe(mediaPath);
  });

  it("does not prepare media into cwd when working directory is missing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-no-workspace-"));
    const source = path.join(tempDir, `NoWorkspace-${Date.now()}.mkv`);
    await writeFile(source, "mkv");
    const cwdOutput = path.join(process.cwd(), "media", "upload", path.basename(source));
    const prepareMedia = createDefaultPhaseHandlers().find((handler): handler is PhaseHandler<"prepare-media"> => handler.phase === "prepare-media");
    if (!prepareMedia) throw new Error("Missing prepare-media handler");

    try {
      const output = await prepareMedia.run(
        createPhaseContext(
          "job-no-workspace",
          {
            candidate,
            mediaPath: source
          },
          {
            runExternalTools: false,
            commandExecutor: fakeExecutor([])
          }
        )
      );

      expect(output.status).toBe("skipped");
      expect(output.outputPath).toBeNull();
      expect(output.mode).toBe("skipped");
      expect(output.message).toMatch(/working directory/i);
      expect(await pathExists(cwdOutput)).toBe(false);
    } finally {
      await rm(cwdOutput, { force: true });
    }
  });

  it("stops preparation before review when a pre-review phase fails", async () => {
    const handlers = createDefaultPhaseHandlers().map((handler) => {
      if (handler.phase !== "preflight") return handler;
      return {
        phase: "preflight",
        async run() {
          return {
            status: "failed",
            message: "Injected preflight failure.",
            producedAt: new Date().toISOString(),
            openGates: [],
            missingTools: [],
            uploadDraft: {
              releaseName: "Injected",
              ptpUrl: null,
              duplicateResult: null,
              screenshots: [],
              mediaInfo: null,
              torrentPath: null,
              description: "Injected",
              descriptionPath: null
            }
          };
        }
      } satisfies PhaseHandler<"preflight">;
    });
    const context = createPhaseContext(
      "job-failed-review",
      { candidate },
      {
        runExternalTools: false,
        commandExecutor: fakeExecutor([])
      }
    );

    const outputs = await new PhaseRunner(handlers).runPreparationToReview(context);

    expect(outputs.preflight?.status).toBe("failed");
    expect(outputs.review).toBeUndefined();
    expect(outputs.upload).toBeUndefined();
  });

  it("uses final upload media for inspection and screenshots", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-final-media-"));
    const source = path.join(tempDir, "source", "Movie.mkv");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "mkv");

    const context = createPhaseContext(
      "job-final-media",
      {
        candidate,
        mediaPath: source,
        workingDirectory: tempDir,
        outputDirectory: path.join(tempDir, "screens")
      },
      {
        runExternalTools: false,
        commandExecutor: fakeExecutor([])
      }
    );

    const outputs = await new PhaseRunner().runPreparationToReview(context);

    expect(outputs["prepare-media"]?.outputPath).toMatch(/media[/\\]upload[/\\]Movie\.mkv$/);
    expect(outputs["inspect-media"]?.mediaPath).toBe(outputs["prepare-media"]?.outputPath);
    expect(outputs.screenshots?.mediaPath).toBe(outputs["prepare-media"]?.outputPath);
  });

  it("prepares the largest media file when manual media path is a directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-directory-media-"));
    const sourceDir = path.join(tempDir, "download", "Directory.Movie.2024.1080p.WEB-DL.x265-GROUP");
    await mkdir(path.join(sourceDir, "Extras"), { recursive: true });
    await writeFile(path.join(sourceDir, "sample.mkv"), Buffer.alloc(10));
    await writeFile(path.join(sourceDir, "Extras", "trailer.mp4"), Buffer.alloc(20));
    await writeFile(path.join(sourceDir, "Directory.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv"), Buffer.alloc(128));

    const context = createPhaseContext(
      "job-directory-media",
      {
        candidate,
        mediaPath: sourceDir,
        workingDirectory: tempDir,
        outputDirectory: path.join(tempDir, "screens")
      },
      {
        runExternalTools: false,
        commandExecutor: fakeExecutor([])
      }
    );

    const outputs = await new PhaseRunner().runPreparationToReview(context);

    expect(outputs["prepare-media"]?.inputPath).toBe(path.join(sourceDir, "Directory.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv"));
    expect(outputs["prepare-media"]?.outputPath).toMatch(/media[/\\]upload[/\\]Directory\.Movie\.2024\.1080p\.WEB-DL\.x265-GROUP\.mkv$/);
    expect(outputs["inspect-media"]?.mediaPath).toBe(outputs["prepare-media"]?.outputPath);
  });

  it("runs screenshot extraction with noninteractive overwrite flags", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-screenshot-flags-"));
    const source = path.join(tempDir, "source", "Movie.mkv");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "mkv");
    const calls: CommandInvocation[] = [];

    const context = createPhaseContext(
      "job-screenshot-flags",
      {
        candidate,
        mediaPath: source,
        workingDirectory: tempDir,
        outputDirectory: path.join(tempDir, "screens")
      },
      {
        runExternalTools: true,
        commandExecutor: fakeExecutor(calls)
      }
    );

    await new PhaseRunner().runPreparationToReview(context);
    const screenshotCalls = calls.filter((call) => call.command === "ffmpeg" && call.args.includes("-frames:v"));

    expect(screenshotCalls).not.toHaveLength(0);
    expect(screenshotCalls.every((call) => call.args.includes("-nostdin"))).toBe(true);
    expect(screenshotCalls.every((call) => call.args.includes("-y"))).toBe(true);
  });

  it("uses upsies-style colorspace filters for HDR screenshots", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-screenshot-colorspace-"));
    const source = path.join(tempDir, "source", "Movie.2024.2160p.WEB-DL.HDR10.x265-GROUP.mkv");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "mkv");
    const calls: CommandInvocation[] = [];
    const screenshots = createDefaultPhaseHandlers().find((handler): handler is PhaseHandler<"screenshots"> => handler.phase === "screenshots");
    if (!screenshots) throw new Error("Missing screenshots handler");

    await screenshots.run(
      createPhaseContext(
        "job-screenshot-colorspace",
        {
          candidate: {
            ...candidate,
            title: "Movie.2024.2160p.WEB-DL.HDR10.x265-GROUP",
            resolution: "2160p"
          },
          mediaPath: source,
          workingDirectory: tempDir,
          outputDirectory: path.join(tempDir, "screens")
        },
        {
          runExternalTools: true,
          commandExecutor: fakeExecutor(calls)
        }
      )
    );

    const screenshotCall = calls.find((call) => call.command === "ffmpeg" && call.args.includes("-frames:v"));
    expect(screenshotCall).toBeDefined();
    const args = screenshotCall?.args ?? [];
    const vf = args[args.indexOf("-vf") + 1] ?? "";
    expect(vf).toContain("scale='max(sar,1)*iw':'max(1/sar,1)*ih'");
    expect(vf).toContain("in_color_matrix=bt2020");
    expect(vf).toContain("flags=full_chroma_int+full_chroma_inp+accurate_rnd+spline");
    expect(vf).toContain("zscale=t=linear,tonemap=hable,zscale=t=bt709,format=rgb24");
    expect(args).toContain("-pix_fmt");
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("rgb24");
  });

  it("uses mpv gpu-next under xvfb for Dolby Vision screenshots", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-screenshot-dv-"));
    const source = path.join(tempDir, "source", "Take.Off.2026.2160p.WEB.x265.DV-UBWEB.mp4");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "mp4");
    const calls: CommandInvocation[] = [];
    const screenshots = createDefaultPhaseHandlers().find((handler): handler is PhaseHandler<"screenshots"> => handler.phase === "screenshots");
    if (!screenshots) throw new Error("Missing screenshots handler");

    const output = await screenshots.run(
      createPhaseContext(
        "job-screenshot-dv",
        {
          candidate: {
            ...candidate,
            title: "Take.Off.2026.2160p.WEB.x265.DV-UBWEB",
            resolution: "2160p"
          },
          mediaPath: source,
          workingDirectory: tempDir,
          outputDirectory: path.join(tempDir, "screens")
        },
        {
          runExternalTools: true,
          toolCommands: {
            mpv: "/opt/bin/mpv",
            "xvfb-run": "/opt/bin/xvfb-run"
          },
          commandExecutor: fakeExecutor(calls)
        }
      )
    );

    const ffmpegScreenshotCalls = calls.filter((call) => call.command === "ffmpeg" && call.args.includes("-frames:v"));
    const mpvScreenshotCalls = calls.filter((call) => call.command === "/opt/bin/xvfb-run" && call.args.some((arg) => arg.includes("screenshot-to-file")));

    expect(ffmpegScreenshotCalls).toHaveLength(0);
    expect(mpvScreenshotCalls).toHaveLength(output.plan.count);
    expect(output.requiredTools).toEqual(["mpv", "xvfb-run", "oxipng"]);
    for (const call of mpvScreenshotCalls) {
      expect(call.args).toContain("/opt/bin/mpv");
      expect(call.args).toContain("--vo=gpu-next");
      expect(call.args).toContain("--gpu-context=x11egl");
      expect(call.args).toContain("--gpu-sw=yes");
      expect(call.args).toContain("--tone-mapping=hable");
      expect(call.args).toContain("--target-trc=srgb");
      expect(call.args.some((arg) => arg.startsWith("--input-commands=screenshot-to-file "))).toBe(true);
    }
  });

  it("emits preparation phase lifecycle callbacks", async () => {
    const events: string[] = [];
    const context = createPhaseContext(
      "job-phase-lifecycle",
      { candidate },
      {
        runExternalTools: false,
        commandExecutor: fakeExecutor([]),
        ...({
          onPhaseStarted: async (phase: string) => {
            events.push(`start:${phase}`);
          },
          onPhaseFinished: async (phase: string, output: { status: string }) => {
            events.push(`finish:${phase}:${output.status}`);
          }
        } as object)
      }
    );

    await new PhaseRunner().runPreparationToReview(context);

    expect(events).toContain("start:screenshots");
    expect(events).toContain("finish:screenshots:completed");
    expect(events.indexOf("start:screenshots")).toBeLessThan(events.indexOf("finish:screenshots:completed"));
  });
});
