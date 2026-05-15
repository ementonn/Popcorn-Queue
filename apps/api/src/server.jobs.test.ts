import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PtpClient } from "@popcorn-queue/integrations";
import type { BrowserCheckResult, TorrentCandidate } from "@popcorn-queue/core";
import type { CommandExecutor } from "@popcorn-queue/worker";
import { JobRepository, type Job } from "./jobs.js";
import { authHeaders, multipartBody, pathExists, persistenceState, testConfig, waitForJob, withConfiguredServer, withServer } from "./server-test-utils.js";

describe("API job routes", () => {
  beforeEach(() => {
    persistenceState.initialJobs = [];
    vi.spyOn(PtpClient.prototype, "getGroup").mockResolvedValue({
      totalResults: 1,
      movies: [
        {
          GroupId: "205678",
          Title: "Manual Movie",
          Name: "Manual Movie",
          Year: "2024",
          ImdbId: "tt1234567",
          Torrents: []
        }
      ]
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null download status for jobs without a download snapshot", async () => {
    await withServer(async (app) => {
      const create = await app.inject({
        method: "POST",
        url: "/api/jobs",
        payload: {
          site: "unknown",
          title: "Movie.2024.1080p.WEB-DL.x265-GROUP",
          imdbId: "tt1234567"
        }
      });
      expect(create.statusCode).toBe(201);
      const job = create.json<{ job: Job }>().job;

      const response = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/download-status` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ downloadStatus: null });
    });
  });

  it("resumes paused jobs through the API", async () => {
    await withServer(async (app) => {
      const create = await app.inject({
        method: "POST",
        url: "/api/jobs",
        payload: {
          site: "unknown",
          title: "Movie.2024.1080p.WEB-DL.x265-GROUP",
          imdbId: "tt1234567"
        }
      });
      expect(create.statusCode).toBe(201);
      const job = create.json<{ job: Job }>().job;

      const pause = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/pause` });
      expect(pause.statusCode).toBe(200);
      expect(pause.json<{ job: Job }>().job.state).toBe("paused");

      const resume = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/resume` });
      expect(resume.statusCode).toBe(200);
      expect(resume.json<{ job: Job }>().job).toMatchObject({
        state: "preparing",
        phase: "intake",
        humanStep: "Preparing upload package"
      });
    });
  });

  it("uses intent action routes for upload starts and keeps only skip debug routing", async () => {
    await withServer(async (app) => {
      const create = await app.inject({
        method: "POST",
        url: "/api/jobs",
        payload: {
          site: "unknown",
          title: "Movie.2024.1080p.BluRay.x264-YIFY.mp4",
          imdbId: null
        }
      });
      expect(create.statusCode).toBe(201);
      let job = create.json<{ job: Job }>().job;
      expect(job.state).toBe("preparing");
      expect(job.phase).toBe("intake");

      const legacyDebugAdvance = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/debug/advance` });
      expect(legacyDebugAdvance.statusCode).toBe(404);
      const legacyAdvance = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/advance` });
      expect(legacyAdvance.statusCode).toBe(404);
      const legacyForceState = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/debug/force-state` });
      expect(legacyForceState.statusCode).toBe(404);

      const blocked = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/debug/skip` });
      expect(blocked.statusCode).toBe(200);
      job = blocked.json<{ job: Job }>().job;
      expect(job.state).toBe("review");
      expect(job.phases.find((phase) => phase.phase === "intake")).toMatchObject({ state: "warning" });

      for (const gate of job.uploadPlan.reviewGates) {
        const resolve = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/review-gates/${encodeURIComponent(gate.id)}/resolve` });
        expect(resolve.statusCode).toBe(200);
        job = resolve.json<{ job: Job }>().job;
      }

      expect(job.uploadPlan.reviewGates.every((gate) => gate.status === "resolved")).toBe(true);
      expect(job.state).toBe("review");

      const start = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/start-upload` });
      expect(start.statusCode).toBe(200);
      job = start.json<{ job: Job }>().job;
      expect(job.state).toBe("review");
      expect(job.events.at(0)?.message).toBe("Cannot start upload until blockers and required evidence are resolved.");

      const retry = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/retry-failed` });
      expect(retry.statusCode).toBe(200);
      job = retry.json<{ job: Job }>().job;
      expect(job.state).toBe("review");
      expect(job.events.at(0)?.message).toBe("Retry is only available for failed jobs.");
    });
  });

  it("retries completed evidence phases without rerunning unrelated completed phases", async () => {
    const { JobRepository } = await import("./jobs.js");
    const repo = new JobRepository();
    let seeded = repo.markPreparedForReview(
      repo.create({
        candidate: {
          site: "mteam",
          title: "Movie.2024.1080p.WEB-DL.x265.HDR-GROUP",
          imdbId: "tt1234567"
        }
      }).id,
      {
        uploadReadiness: "ready",
        artifacts: {
          mediaFiles: ["media/upload/movie.mkv"],
          screenshots: ["https://imgbb.test/1.png", "https://imgbb.test/2.png"],
          mediaInfoText: "General\nComplete name : movie.mkv\n",
          mediainfo: "General\nComplete name : movie.mkv\n",
          uploadTorrent: "torrent/upload.torrent"
        }
      }
    )!;
    seeded.phases = seeded.phases.map((phase) => ({ ...phase, state: "done" as const, message: "Done." }));
    persistenceState.initialJobs = [seeded];

    await withServer(async (app) => {
      const response = await app.inject({ method: "POST", url: `/api/jobs/${seeded.id}/phases/inspect-media/retry` });
      expect(response.statusCode).toBe(200);
      const job = response.json<{ job: Job }>().job;

      expect(job.state).toBe("review");
      expect(job.phase).toBe("review");
      expect(job.artifacts.screenshots).toEqual(["https://imgbb.test/1.png", "https://imgbb.test/2.png"]);
      expect(job.artifacts.mediaInfoText).toContain("Complete name");
      expect(job.phases.find((phase) => phase.phase === "inspect-media")).toMatchObject({
        state: "done",
        retryCount: 1,
        message: "Media analysis plan prepared."
      });
      expect(job.phases.find((phase) => phase.phase === "screenshots")).toMatchObject({
        state: "done",
        retryCount: 0,
        message: "Done."
      });

      const unsafe = await app.inject({ method: "POST", url: `/api/jobs/${seeded.id}/phases/upload/retry` });
      expect(unsafe.statusCode).toBe(400);
      expect(unsafe.json()).toEqual({ error: "phase_retry_not_available" });
    });
  });

  it("automatically prepares created jobs to review when enabled", async () => {
    await withServer(
      async (app) => {
        const create = await app.inject({
          method: "POST",
          url: "/api/jobs",
          payload: {
            site: "mteam",
            title: "Movie.2024.1080p.BluRay.x264-GROUP",
            imdbId: "tt1234567"
          }
        });
        expect(create.statusCode).toBe(201);
        const created = create.json<{ job: Job }>().job;

        const prepared = await waitForJob(app, created.id, (job) => job.state === "review");

        expect(prepared.phase).toBe("review");
        expect(prepared.uploadReadiness).toBe("missing_evidence");
        expect(prepared.events.some((event) => event.message === "Upload package ready for review.")).toBe(true);

        const logs = await app.inject({ method: "GET", url: `/api/jobs/${created.id}/logs` });
        expect(logs.statusCode).toBe(200);
        expect(logs.json<{ lines: string[] }>().lines.join("\n")).toContain("Starting phase.");
      },
      { autoPrepare: true }
    );
  });

  it("resumes persisted preparing jobs after API restart", async () => {
    const { JobRepository } = await import("./jobs.js");
    const persisted = new JobRepository().create({
      candidate: {
        site: "mteam",
        title: "Restarted.Movie.2024.1080p.WEB-DL.x265-GROUP",
        imdbId: "tt1234567"
      }
    });
    persistenceState.initialJobs = [persisted];

    await withServer(
      async (app) => {
        const resumed = await waitForJob(app, persisted.id, (job) => job.state === "review");

        expect(resumed.phase).toBe("review");
        expect(resumed.events.some((event) => event.message === "Resuming preparation after API startup.")).toBe(true);
      },
      { autoPrepare: true }
    );
  });

  it("imports a copied done job and marks it for reseed when qBittorrent is missing it", async () => {
    const jobPath = await mkdtemp(path.join(os.tmpdir(), "popcorn-restored-job-"));
    await mkdir(path.join(jobPath, "media", "upload"), { recursive: true });
    await mkdir(path.join(jobPath, "torrent"), { recursive: true });
    await writeFile(path.join(jobPath, "media", "upload", "Restored.Movie.2024.1080p.BluRay.x264-GROUP.mkv"), "mkv");
    await writeFile(path.join(jobPath, "torrent", "upload.torrent"), "torrent");

    await withServer(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/jobs/import",
        payload: {
          jobPath,
          manifest: {
            version: 1,
            jobId: "restored-job",
            createdAt: "2026-05-08T00:00:00.000Z",
            state: "done",
            source: { title: "Restored.Movie.2024.1080p.BluRay.x264-GROUP" },
            uploadFiles: ["media/upload/Restored.Movie.2024.1080p.BluRay.x264-GROUP.mkv"],
            torrentFile: "torrent/upload.torrent",
            sourceRef: { sourceId: "source-1", originalDownloadPresent: false }
          }
        }
      });

      expect(response.statusCode).toBe(201);
      expect(response.json<{ job: Job }>().job.state).toBe("needs_reseed");
    });
  });

  it("retries needs-reseed jobs by handing the upload torrent to qBittorrent", async () => {
    const jobPath = await mkdtemp(path.join(os.tmpdir(), "popcorn-retry-reseed-job-"));
    const torrentPath = path.join(jobPath, "torrent", "upload.torrent");
    await mkdir(path.join(jobPath, "media", "upload"), { recursive: true });
    await mkdir(path.dirname(torrentPath), { recursive: true });
    await writeFile(path.join(jobPath, "media", "upload", "Restored.Movie.2024.1080p.BluRay.x264-GROUP.mkv"), "mkv");
    await writeFile(torrentPath, "torrent");
    const addCalls: Array<{ torrentPath: string; downloadPath: string; skipHashCheck?: boolean }> = [];

    await withServer(
      async (app) => {
        const imported = await app.inject({
          method: "POST",
          url: "/api/jobs/import",
          payload: {
            jobPath,
            manifest: {
              version: 1,
              jobId: "needs-reseed-job",
              createdAt: "2026-05-08T00:00:00.000Z",
              state: "done",
              source: { title: "Restored.Movie.2024.1080p.BluRay.x264-GROUP" },
              uploadFiles: ["media/upload/Restored.Movie.2024.1080p.BluRay.x264-GROUP.mkv"],
              torrentFile: "torrent/upload.torrent",
              sourceRef: { sourceId: "source-1", originalDownloadPresent: false }
            }
          }
        });
        expect(imported.statusCode).toBe(201);
        expect(imported.json<{ job: Job }>().job.state).toBe("needs_reseed");

        const retry = await app.inject({ method: "POST", url: "/api/jobs/needs-reseed-job/retry-failed" });
        expect(retry.statusCode).toBe(200);
        const job = retry.json<{ job: Job }>().job;

        expect(job.state).toBe("seeding");
        expect(job.phase).toBe("done");
        expect(job.artifacts.qbSeedInfoHash).toBe("ABC123");
        expect(job.phases.find((phase) => phase.phase === "post-hook")).toMatchObject({ state: "done" });
        expect(addCalls).toEqual([
          {
            torrentPath,
            downloadPath: path.join(jobPath, "media", "upload"),
            skipHashCheck: true
          }
        ]);
      },
      {
        autoPrepare: false,
        torrentClient: {
          name: "mock-qb",
          async addTorrent(options) {
            addCalls.push(options);
            return { infoHash: "ABC123" };
          },
          async getStatus() {
            throw new Error("getStatus should not run during retry reseed.");
          },
          async isComplete() {
            return true;
          },
          async listFiles() {
            return [];
          }
        }
      }
    );
  });

  it("keeps restored done jobs in review when required upload files are missing", async () => {
    const jobPath = await mkdtemp(path.join(os.tmpdir(), "popcorn-missing-restored-job-"));
    await withServer(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/jobs/import",
        payload: {
          jobPath,
          manifest: {
            version: 1,
            jobId: "missing-restored-job",
            createdAt: "2026-05-08T00:00:00.000Z",
            state: "done",
            source: { title: "Missing.Movie.2024.1080p.BluRay.x264-GROUP" },
            uploadFiles: ["media/upload/Missing.Movie.2024.1080p.BluRay.x264-GROUP.mkv"],
            torrentFile: "torrent/upload.torrent",
            sourceRef: { sourceId: "source-1", originalDownloadPresent: false }
          }
        }
      });

      expect(response.statusCode).toBe(201);
      const job = response.json<{ job: Job }>().job;
      expect(job.state).toBe("review");
      expect(job.uploadReadiness).toBe("missing_evidence");
      expect(job.events.at(0)?.message).toBe("Restored job is missing upload files.");
    });
  });

  it("patches the review draft, runs Start Upload, and hands the upload torrent to qBittorrent", async () => {
    const jobPath = await mkdtemp(path.join(os.tmpdir(), "popcorn-upload-job-"));
    const torrentPath = path.join(jobPath, "torrent", "upload.torrent");
    await mkdir(path.join(jobPath, "media", "upload"), { recursive: true });
    await mkdir(path.dirname(torrentPath), { recursive: true });
    await writeFile(path.join(jobPath, "media", "upload", "Upload.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv"), "mkv");
    await writeFile(torrentPath, "torrent");
    const submitted: Array<{ torrentPath: string; description: string; groupId: string | null }> = [];
    const addCalls: Array<{ torrentPath: string; downloadPath: string; tags?: string[]; skipHashCheck?: boolean }> = [];

    await withServer(
      async (app) => {
        const imported = await app.inject({
          method: "POST",
          url: "/api/jobs/import",
          payload: {
            jobPath,
            manifest: {
              version: 1,
              jobId: "upload-restored-job",
              createdAt: "2026-05-08T00:00:00.000Z",
              state: "review",
              source: { title: "Upload.Movie.2024.1080p.WEB-DL.x265-GROUP" },
              uploadFiles: ["media/upload/Upload.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv"],
              torrentFile: "torrent/upload.torrent",
              sourceRef: { sourceId: "source-1", originalDownloadPresent: false }
            }
          }
        });
        expect(imported.statusCode).toBe(201);
        let job = imported.json<{ job: Job }>().job;
        expect(job.reviewDraft?.releaseName).toContain("Upload.Movie");

        const patch = await app.inject({
          method: "PATCH",
          url: `/api/jobs/${job.id}/review-draft`,
          payload: {
            description: "Edited release description",
            groupId: "123"
          }
        });
        expect(patch.statusCode).toBe(200);
        job = patch.json<{ job: Job }>().job;
        expect(job.reviewDraft).toMatchObject({ description: "Edited release description", groupId: "123" });

        const start = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/start-upload` });
        expect(start.statusCode).toBe(200);
        job = start.json<{ job: Job }>().job;
        expect(job.state).toBe("done");
        expect(job.humanStep).toBe("Complete");
        expect(job.artifacts).toMatchObject({
          ptpUrl: "https://passthepopcorn.me/torrents.php?id=123&torrentid=456",
          ptpGroupId: "123",
          ptpTorrentId: "456",
          qbSeedInfoHash: "ABC123"
        });
        expect(job.phases.find((phase) => phase.phase === "post-hook")).toMatchObject({ state: "done" });
        expect(submitted).toEqual([{ torrentPath, description: "Edited release description", groupId: "123" }]);
        expect(addCalls).toEqual([
          {
            torrentPath,
            downloadPath: path.join(jobPath, "media", "upload"),
            skipHashCheck: true
          }
        ]);
        const uploadTorrent = (await readFile(torrentPath)).toString("binary");
        expect(uploadTorrent).toContain("https://please.passthepopcorn.me/passkey/announce");
        expect(uploadTorrent).toContain("Upload.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
        expect(uploadTorrent).not.toContain("torrent");
      },
      {
        autoPrepare: false,
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
          async submit(input) {
            submitted.push({ torrentPath: input.torrentPath, description: input.draft.description, groupId: input.draft.groupId });
            return {
              groupId: "123",
              torrentId: "456",
              ptpUrl: "https://passthepopcorn.me/torrents.php?id=123&torrentid=456"
            };
          }
        }
      }
    );
  });

  it("syncs the uploaded torrent into the PTP browser check cache before post-hook", async () => {
    const jobPath = await mkdtemp(path.join(os.tmpdir(), "popcorn-upload-cache-sync-"));
    const mediaPath = path.join(jobPath, "media", "upload", "Upload.Movie.2024.1080p.BluRay.x264-GROUP.mkv");
    const torrentPath = path.join(jobPath, "torrent", "upload.torrent");
    await mkdir(path.dirname(mediaPath), { recursive: true });
    await mkdir(path.dirname(torrentPath), { recursive: true });
    await writeFile(mediaPath, "mkv");
    await writeFile(torrentPath, "torrent");

    const candidate: TorrentCandidate = {
      site: "mteam",
      title: "Upload.Movie.2024.1080p.BluRay.x264-GROUP",
      imdbId: "tt1234567",
      resolution: "1080p"
    };
    const checkResult: BrowserCheckResult = {
      candidate,
      parsed: null,
      decision: {
        status: "no_torrents",
        movieFound: true,
        movie: {
          GroupId: "123",
          Title: "Upload Movie",
          Year: "2024",
          ImdbId: "tt1234567",
          Torrents: []
        },
        reason: "Movie exists on PTP but has no torrents.",
        confidence: "high",
        ptpUrl: "https://passthepopcorn.me/torrents.php?id=123"
      },
      cache: {
        key: "ptp:imdb:tt1234567",
        hit: false,
        policy: "permanent"
      }
    };
    const seedRepo = new JobRepository();
    let job = seedRepo.create({ candidate, checkResult });
    job = seedRepo.markPreparedForReview(job.id, {
      uploadReadiness: "ready",
      artifacts: {
        mediaFiles: ["media/upload/Upload.Movie.2024.1080p.BluRay.x264-GROUP.mkv"],
        uploadTorrent: "torrent/upload.torrent"
      }
    })!;
    job = seedRepo.attachWorkspace(job.id, {
      workspace: {
        dataRoot: "",
        jobRoot: jobPath,
        manifest: path.join(jobPath, "manifest.json")
      }
    })!;
    persistenceState.initialJobs = [job];

    const search = vi.spyOn(PtpClient.prototype, "searchByCandidate").mockResolvedValue({
      movies: [
        {
          GroupId: "123",
          Title: "Upload Movie",
          Name: "Upload Movie",
          Year: "2024",
          ImdbId: "tt1234567",
          Torrents: []
        }
      ]
    });

    await withServer(
      async (app) => {
        const before = await app.inject({ method: "POST", url: "/api/browser/check", headers: authHeaders, payload: candidate });
        expect(before.statusCode).toBe(200);
        expect(before.json<{ result: BrowserCheckResult }>().result.decision.status).toBe("no_torrents");

        const start = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/start-upload` });
        expect(start.statusCode).toBe(200);
        const uploaded = start.json<{ job: Job }>().job;
        const phaseNames = uploaded.phases.map((phase) => phase.phase);
        expect(phaseNames.indexOf("sync-ptp-cache")).toBeGreaterThan(phaseNames.indexOf("upload"));
        expect(phaseNames.indexOf("sync-ptp-cache")).toBeLessThan(phaseNames.indexOf("post-hook"));
        expect(uploaded.phases.find((phase) => phase.phase === "sync-ptp-cache")).toMatchObject({ state: "done" });

        const after = await app.inject({ method: "POST", url: "/api/browser/check", headers: authHeaders, payload: candidate });
        expect(after.statusCode).toBe(200);
        const result = after.json<{ result: BrowserCheckResult }>().result;
        expect(result.cache.hit).toBe(true);
        expect(result.decision.status).toBe("full");
        expect(result.decision.existing?.map((torrent) => torrent.releaseName)).toContain("Upload.Movie.2024.1080p.BluRay.x264-GROUP");
        expect(search).toHaveBeenCalledTimes(1);
      },
      {
        autoPrepare: false,
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
  });
});
