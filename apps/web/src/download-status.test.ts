import { describe, expect, it } from "vitest";
import { downloadedBytesLabel, downloadDetail, downloadSummary, formatEta, formatSpeed } from "./download-status.js";
import type { DownloadStatus } from "./types.js";

function status(input: Partial<DownloadStatus>): DownloadStatus {
  return {
    client: "qbittorrent",
    infoHash: "ABC123",
    state: "downloading",
    progress: 0.42,
    downloaded: 4_200_000,
    size: 10_000_000,
    amountLeft: 5_800_000,
    downloadSpeed: 8_388_608,
    uploadSpeed: 0,
    eta: 720,
    seeds: 12,
    peers: 3,
    savePath: "/downloads",
    contentPath: "/downloads/Movie.mkv",
    lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    error: null,
    ...input
  };
}

describe("download status formatting", () => {
  it("formats active download progress for the queue", () => {
    const current = status({});

    expect(downloadSummary(current)).toBe("Downloading (42%)");
    expect(downloadDetail(current)).toContain("42% - 8.0 MB/s - 12m");
  });

  it("formats complete and error states without transient progress copy", () => {
    expect(downloadSummary(status({ state: "uploading", progress: 1 }))).toBe("Downloaded");
    expect(downloadDetail(status({ state: "error", progress: null, error: "unauthorized" }))).toBe("unauthorized");
  });

  it("formats transfer units and byte totals", () => {
    expect(formatSpeed(8_388_608)).toBe("8.0 MB/s");
    expect(formatEta(90)).toBe("2m");
    expect(downloadedBytesLabel(status({ downloaded: 5_242_880, size: 10_485_760 }))).toBe("5.0 MB / 10.0 MB");
  });
});
