import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ReviewDraft, TorrentCandidate } from "@popcorn-queue/core";
import type { CommandExecutor, CommandInvocation, CommandResult } from "./commands.js";
import { PhaseRunner, createDefaultPhaseHandlers, createPhaseContext, parseMediaInfoSummary, type PhaseHandler } from "./phases.js";

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

    expect(output.plan.count).toBe(6);
    expect(output.ffmpeg).toHaveLength(6);
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
              width: 1920,
              height: 1080
            };
          }
        }
      }
    );

    const output = await screenshots.run(context);

    expect(calls.some((call) => call.command === "ffmpeg")).toBe(true);
    expect(uploaded).toHaveLength(6);
    expect(output.uploads.every((attempt) => attempt.result?.host === "imgbb")).toBe(true);
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
