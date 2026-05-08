/// <reference types="node" />

import { describe, expect, it } from "vitest";
import path from "node:path";
import { buildJobWorkspacePaths, createJobManifest } from "./workspace.js";

describe("workspace paths", () => {
  it("uses download for disposable source downloads and upload for copyable job media", () => {
    const paths = buildJobWorkspacePaths("/srv/popcorn/data", "job-123");

    expect(paths.sourceDownloadDir).toBe(path.join("/srv/popcorn/data", "jobs", "job-123", "download"));
    expect(paths.sourceTorrent).toBe(path.join("/srv/popcorn/data", "jobs", "job-123", "torrent", "source.torrent"));
    expect(paths.jobRoot).toBe(path.join("/srv/popcorn/data", "jobs", "job-123"));
    expect(paths.mediaUploadDir).toBe(path.join(paths.jobRoot, "media", "upload"));
    expect(paths.logs.jobLog).toBe(path.join(paths.jobRoot, "logs", "job.log"));
    expect(paths.manifest).toBe(path.join(paths.jobRoot, "manifest.json"));
  });

  it("creates a copyable manifest without requiring original downloads", () => {
    const paths = buildJobWorkspacePaths("/srv/popcorn/data", "job-123");
    const manifest = createJobManifest({
      jobId: "job-123",
      createdAt: "2026-05-08T00:00:00.000Z",
      state: "review",
      source: { title: "Movie.2024.1080p.BluRay.x264-GROUP" },
      paths,
      uploadFiles: ["media/upload/Movie.2024.1080p.BluRay.x264-GROUP.mkv"],
      torrentFile: "torrent/upload.torrent",
      sourceRef: { sourceId: "source-1", originalDownloadPresent: false }
    });

    expect(manifest.version).toBe(1);
    expect(manifest.sourceRef.originalDownloadPresent).toBe(false);
    expect(manifest.uploadFiles).toEqual(["media/upload/Movie.2024.1080p.BluRay.x264-GROUP.mkv"]);
  });
});
