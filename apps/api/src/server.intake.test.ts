import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PtpClient } from "@popcorn-queue/integrations";
import type { BrowserCheckResult, TorrentCandidate } from "@popcorn-queue/core";
import type { CommandExecutor } from "@popcorn-queue/worker";
import { JobRepository, type Job } from "./jobs.js";
import { authHeaders, multipartBody, pathExists, persistenceState, testConfig, waitForJob, withConfiguredServer, withServer } from "./server-test-utils.js";

describe("API intake routes", () => {
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

  it("validates manual intake media paths from arbitrary absolute locations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-media-root-"));
    const movie = path.join(root, "Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p.mkv");
    await writeFile(movie, "movie");
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), "popcorn-anywhere-media-"));
    const otherMovie = path.join(otherRoot, "Anywhere.Movie.2024.1080p.WEB-DL.x265-GROUP.mp4");
    await writeFile(otherMovie, "movie");

    await withConfiguredServer(testConfig(), { autoPrepare: false }, async (app) => {
      const ok = await app.inject({
        method: "POST",
        url: "/api/intake/media-path/validate",
        payload: { mediaPath: movie }
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ ok: true, basename: path.basename(movie), kind: "file", error: null });

      const anywhere = await app.inject({
        method: "POST",
        url: "/api/intake/media-path/validate",
        payload: { mediaPath: otherMovie }
      });
      expect(anywhere.statusCode).toBe(200);
      expect(anywhere.json()).toMatchObject({ ok: true, basename: path.basename(otherMovie), kind: "file", error: null });
    });
  });

  it("accepts directory media paths with a warning", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-media-directory-"));
    await writeFile(path.join(root, "Directory.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv"), "movie");

    await withConfiguredServer(testConfig(), { autoPrepare: false }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/media-path/validate",
        payload: { mediaPath: root }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        mediaPath: root,
        basename: path.basename(root),
        kind: "directory",
        size: null,
        error: null,
        warning: "media_path_is_directory"
      });
    });
  });

  it("searches PTP movies from a manual release name without creating a job", async () => {
    const search = vi.spyOn(PtpClient.prototype, "searchByCandidate").mockResolvedValue({
      totalResults: 1,
      movies: [
        {
          GroupId: "205678",
          Title: "Skaz pro to, kak tsar Pyotr arapa zhenil",
          Name: "How Czar Peter the Great Married Off His Moor",
          Year: "1976",
          ImdbId: "tt0075169",
          Torrents: []
        }
      ]
    });

    await withServer(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/ptp-search",
        payload: { title: "Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p.WEB-DL.x265-GROUP" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        query: "Skaz pro to kak tsar Pyotr arapa zhenil",
        parsedYear: "1976",
        results: [
          {
            groupId: "205678",
            displayTitle: "Skaz pro to, kak tsar Pyotr arapa zhenil AKA How Czar Peter the Great Married Off His Moor [1976]",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
          }
        ]
      });
      expect(search).toHaveBeenCalledTimes(1);
    });
  });

  it("resolves a manual PTP target from a PTP movie URL", async () => {
    const getGroup = vi.spyOn(PtpClient.prototype, "getGroup").mockResolvedValue({
      totalResults: 1,
      movies: [
        {
          GroupId: "205678",
          Title: "Skaz pro to, kak tsar Pyotr arapa zhenil",
          Name: "How Czar Peter the Great Married Off His Moor",
          Year: "1976",
          ImdbId: "tt0075169",
          Torrents: []
        }
      ]
    });

    await withServer(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/ptp-target/resolve",
        payload: { ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678&torrentid=1515743" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        target: {
          groupId: "205678",
          displayTitle: "Skaz pro to, kak tsar Pyotr arapa zhenil AKA How Czar Peter the Great Married Off His Moor [1976]",
          imdbId: "tt0075169",
          ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
        }
      });
      expect(getGroup).toHaveBeenCalledWith("205678");
    });
  });

  it("resolves a manual PTP target from an IMDb URL", async () => {
    const searchByImdb = vi.spyOn(PtpClient.prototype, "searchByImdb").mockResolvedValue({
      totalResults: 1,
      movies: [
        {
          GroupId: "205678",
          Title: "Skaz pro to, kak tsar Pyotr arapa zhenil",
          Name: "How Czar Peter the Great Married Off His Moor",
          Year: "1976",
          ImdbId: "tt0075169",
          Torrents: []
        }
      ]
    });

    await withServer(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/ptp-target/resolve",
        payload: { imdbUrl: "https://www.imdb.com/title/tt0075169/" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        target: {
          groupId: "205678",
          displayTitle: "Skaz pro to, kak tsar Pyotr arapa zhenil AKA How Czar Peter the Great Married Off His Moor [1976]",
          imdbId: "tt0075169",
          ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
        }
      });
      expect(searchByImdb).toHaveBeenCalledWith("tt0075169");
    });
  });

  it("creates manual intake jobs from server media and uploaded torrent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-intake-upload-"));
    const mediaPath = path.join(root, "Manual.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
    await writeFile(mediaPath, "movie");
    const config = testConfig();
    const boundary = "popcorn-manual-intake-upload";

    await withConfiguredServer(config, { autoPrepare: false }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/jobs",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(
          boundary,
          {
            mediaPath,
            releaseName: "Manual.Movie.2024.1080p.WEB-DL.x265-GROUP",
            ptpTarget: JSON.stringify({
              groupId: "205678",
              displayTitle: "Manual Movie [2024]",
              year: "2024",
              imdbId: "tt1234567",
              ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
            })
          },
          {
            name: "torrent",
            filename: "Manual.Movie.source.torrent",
            contentType: "application/x-bittorrent",
            value: "d4:infod6:lengthi1eee"
          }
        )
      });

      expect(response.statusCode).toBe(201);
      const job = response.json<{ job: Job }>().job;
      expect(job.source).toMatchObject({
        site: "unknown",
        title: "Manual.Movie.2024.1080p.WEB-DL.x265-GROUP",
        mediaPath,
        ptpTarget: { groupId: "205678", ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678" }
      });
      expect(job.reviewDraft).toMatchObject({ groupId: "205678", imdb: "tt1234567" });
      expect(job.torrent).toMatchObject({ filename: "Manual.Movie.source.torrent" });
      await expect(access(job.torrent!.filePath!)).resolves.toBeUndefined();
    });
  });

  it("runs duplicate checks for manual intake jobs against the confirmed PTP group", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-intake-manual-duplicate-"));
    const mediaPath = path.join(root, "Manual.Movie.2024.1080p.WEB-DL.x265.HDR-GROUP.mkv");
    await writeFile(mediaPath, "movie");
    const getGroup = vi.spyOn(PtpClient.prototype, "getGroup").mockResolvedValue({
      totalResults: 1,
      movies: [
        {
          GroupId: "205678",
          Title: "Manual Movie",
          Name: "Manual Movie",
          Year: "2024",
          ImdbId: "tt1234567",
          Torrents: [
            {
              Id: "1",
              Quality: "High Definition",
              Source: "WEB",
              Codec: "H.265",
              Resolution: "1080p",
              Size: "1000",
              Seeders: "1",
              ReleaseName: "Manual.Movie.2024.1080p.WEB-DL.H265.HDR-EXISTING"
            }
          ]
        }
      ]
    });
    const config = testConfig();

    await withConfiguredServer(config, { autoPrepare: false }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/jobs",
        payload: {
          mediaPath,
          releaseName: "Manual.Movie.2024.1080p.WEB-DL.x265.HDR-GROUP",
          ptpTarget: {
            groupId: "205678",
            displayTitle: "Manual Movie [2024]",
            year: "2024",
            imdbId: "tt1234567",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
          }
        }
      });

      expect(response.statusCode).toBe(201);
      const job = response.json<{ job: Job }>().job;
      expect(getGroup).toHaveBeenCalledWith("205678");
      expect(job.checkResult?.decision).toMatchObject({
        status: "full",
        reason: "1080p HDR x265 is full."
      });
      expect(job.uploadPlan.reviewGates).toContainEqual(
        expect.objectContaining({
          id: "duplicate:slot-full",
          severity: "blocker",
          status: "open"
        })
      );
      expect(job.uploadPlan.reviewGates).not.toContainEqual(
        expect.objectContaining({
          detail: "Manual PTP target confirmed."
        })
      );
    });
  });

  it("creates manual intake jobs from server media without a source torrent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-intake-media-only-"));
    const mediaPath = path.join(root, "Media.Only.2024.1080p.WEB-DL.x265-GROUP.mkv");
    await writeFile(mediaPath, "movie");
    const config = testConfig();

    await withConfiguredServer(config, { autoPrepare: false }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/jobs",
        payload: {
          mediaPath,
          releaseName: "Media.Only.2024.1080p.WEB-DL.x265-GROUP",
          ptpTarget: {
            groupId: "205678",
            displayTitle: "Media Only [2024]",
            year: "2024",
            imdbId: "tt1234567",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
          }
        }
      });

      expect(response.statusCode).toBe(201);
      const job = response.json<{ job: Job }>().job;
      expect(job.source).toMatchObject({ mediaPath, ptpTarget: { groupId: "205678" } });
      expect(job.torrent).toBeUndefined();
    });
  });

  it("creates manual intake jobs from a torrent URL without real network", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-intake-url-"));
    const mediaPath = path.join(root, "Url.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
    await writeFile(mediaPath, "movie");
    const config = testConfig();
    const fetchImpl: typeof fetch = async () =>
      new Response("d4:infod6:lengthi1eee", {
        status: 200,
        headers: { "content-type": "application/x-bittorrent", "content-disposition": 'attachment; filename="Url.Movie.source.torrent"' }
      });

    await withConfiguredServer(config, { autoPrepare: false, fetchImpl }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/jobs",
        payload: {
          mediaPath,
          releaseName: "Url.Movie.2024.1080p.WEB-DL.x265-GROUP",
          torrentUrl: "https://tracker.example/download/1.torrent",
          ptpTarget: {
            groupId: "300",
            displayTitle: "Url Movie [2024]",
            year: "2024",
            imdbId: "tt7654321",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=300"
          }
        }
      });

      expect(response.statusCode).toBe(201);
      const job = response.json<{ job: Job }>().job;
      expect(job.source).toMatchObject({ mediaPath, torrentUrl: "https://tracker.example/download/1.torrent" });
      expect(job.torrent).toMatchObject({ filename: "Url.Movie.source.torrent", contentType: "application/x-bittorrent" });
    });
  });

  it("decodes percent-encoded torrent URL filenames from content disposition", async () => {
    const config = testConfig();
    const encodedFilename = "%5BHHC%5D.%E5%AE%87%E5%AE%99%E6%8A%A4%E5%8D%AB%E9%98%9F%EF%BC%9A%E7%99%BE%E5%8F%98%E6%B5%81%E6%98%9F.Cosmicrew.Ice.torrent";
    const fetchImpl: typeof fetch = async () =>
      new Response("d4:infod6:lengthi1eee", {
        status: 200,
        headers: { "content-type": "application/x-bittorrent", "content-disposition": `attachment; filename="${encodedFilename}"` }
      });

    await withConfiguredServer(config, { autoPrepare: false, fetchImpl }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/jobs",
        payload: {
          torrentUrl: `https://tracker.example/download/${encodedFilename}`,
          ptpTarget: {
            groupId: "302",
            displayTitle: "Cosmicrew Ice [2024]",
            year: "2024",
            imdbId: "tt7654323",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=302"
          }
        }
      });

      expect(response.statusCode).toBe(201);
      const job = response.json<{ job: Job }>().job;
      expect(job.torrent?.filename).toBe("[HHC].宇宙护卫队：百变流星.Cosmicrew.Ice.torrent");
      expect(job.source.title).toBe("[HHC].宇宙护卫队：百变流星.Cosmicrew.Ice");
    });
  });

  it("creates manual intake jobs from a torrent URL without a server media path", async () => {
    const config = testConfig();
    const fetchImpl: typeof fetch = async () =>
      new Response("d4:infod6:lengthi1eee", {
        status: 200,
        headers: { "content-type": "application/x-bittorrent", "content-disposition": 'attachment; filename="Torrent.Only.source.torrent"' }
      });

    await withConfiguredServer(config, { autoPrepare: false, fetchImpl }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/jobs",
        payload: {
          releaseName: "Torrent.Only.2024.1080p.WEB-DL.x265-GROUP",
          torrentUrl: "https://tracker.example/download/2.torrent",
          ptpTarget: {
            groupId: "301",
            displayTitle: "Torrent Only [2024]",
            year: "2024",
            imdbId: "tt7654322",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=301"
          }
        }
      });

      expect(response.statusCode).toBe(201);
      const job = response.json<{ job: Job }>().job;
      expect(job.source).toMatchObject({ torrentUrl: "https://tracker.example/download/2.torrent", ptpTarget: { groupId: "301" } });
      expect(job.source.mediaPath).toBeUndefined();
      expect(job.torrent).toMatchObject({ filename: "Torrent.Only.source.torrent", contentType: "application/x-bittorrent" });
    });
  });

  it("derives manual intake release names when no override is supplied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-intake-derived-release-"));
    const mediaPath = path.join(root, "Derived.Media.2024.1080p.WEB-DL.x265-GROUP.mkv");
    await writeFile(mediaPath, "movie");
    const config = testConfig();
    const fetchImpl: typeof fetch = async () =>
      new Response("d4:infod6:lengthi1eee", {
        status: 200,
        headers: { "content-type": "application/x-bittorrent", "content-disposition": 'attachment; filename="Derived.Torrent.2025.1080p.WEB-DL.x265-GROUP.torrent"' }
      });

    await withConfiguredServer(config, { autoPrepare: false, fetchImpl }, async (app) => {
      const mediaResponse = await app.inject({
        method: "POST",
        url: "/api/intake/jobs",
        payload: {
          mediaPath,
          ptpTarget: {
            groupId: "401",
            displayTitle: "Derived Media [2024]",
            year: "2024",
            imdbId: "tt1111111",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=401"
          }
        }
      });
      expect(mediaResponse.statusCode).toBe(201);
      expect(mediaResponse.json<{ job: Job }>().job.source.title).toBe("Derived.Media.2024.1080p.WEB-DL.x265-GROUP");

      const torrentResponse = await app.inject({
        method: "POST",
        url: "/api/intake/jobs",
        payload: {
          torrentUrl: "https://tracker.example/download/derived.torrent",
          ptpTarget: {
            groupId: "402",
            displayTitle: "Derived Torrent [2025]",
            year: "2025",
            imdbId: "tt2222222",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=402"
          }
        }
      });
      expect(torrentResponse.statusCode).toBe(201);
      expect(torrentResponse.json<{ job: Job }>().job.source.title).toBe("Derived.Torrent.2025.1080p.WEB-DL.x265-GROUP");
    });
  });
});
