import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewPanel } from "./ReviewPanel.js";
import type { ApiJob } from "../types.js";

function jobWithSubtitle(subtitle?: string): ApiJob {
  return {
    id: "job-1",
    state: "review",
    phase: "review",
    updatedAt: "2026-05-29T00:00:00.000Z",
    uploadReadiness: "ready",
    humanStep: "Review upload package",
    source: {
      site: "pter",
      title: "Test.Movie.2024.1080p.WEB-DL.x264-GROUP",
      ...(subtitle ? { subtitle } : {})
    },
    candidate: {
      site: "pter",
      title: "Test.Movie.2024.1080p.WEB-DL.x264-GROUP"
    },
    downloadStatus: {
      client: "qbittorrent",
      infoHash: "abc123",
      state: "downloading",
      progress: 0.5,
      downloaded: 50,
      size: 100,
      amountLeft: 50,
      downloadSpeed: 0,
      uploadSpeed: 0,
      eta: null,
      seeds: null,
      peers: null,
      savePath: null,
      contentPath: null,
      lastUpdatedAt: "2026-05-29T00:00:00.000Z",
      error: null
    },
    uploadPlan: {
      reviewGates: [],
      releaseName: { generated: "Test.Movie.2024.1080p.WEB-DL.x264-GROUP", group: "GROUP", container: "mkv", warnings: [] },
      media: {
        container: "mkv",
        discType: "file",
        audio: { codecs: [], languages: [], commentaryLikely: false },
        subtitles: { languages: [], embeddedLikely: false },
        trumpableChecks: []
      },
      screenshots: { count: 4, imageHosts: [], toneMapHint: "none" }
    },
    artifacts: {},
    phases: [],
    events: []
  } as ApiJob;
}

describe("ReviewPanel source metadata", () => {
  it("shows a source subtitle when one was captured from the source tracker", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewPanel, { job: jobWithSubtitle("这是副标题"), jobLogs: { lines: [] }, onSaveReviewDraft: () => undefined })
    );

    expect(html).toContain("<span>Subtitle</span>");
    expect(html).toContain("这是副标题");
  });

  it("does not show a source subtitle row when one was not captured", () => {
    const html = renderToStaticMarkup(createElement(ReviewPanel, { job: jobWithSubtitle(), jobLogs: { lines: [] }, onSaveReviewDraft: () => undefined }));

    expect(html).not.toContain("<span>Subtitle</span>");
  });
});
