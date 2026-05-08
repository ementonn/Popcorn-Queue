import { expect, test } from "@playwright/test";

test.describe("Popcorn Queue UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/jobs", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fulfill({ status: 201, json: { job: apiJobs[0] } });
        return;
      }
      await route.fulfill({ json: { jobs: apiJobs } });
    });
    await page.route("**/api/health", async (route) => {
      await route.fulfill({
        json: {
          ok: true,
          ptpConfigured: true,
          browserTokenConfigured: true,
          publicWebUrl: "http://127.0.0.1:5173",
          publicApiUrl: "http://127.0.0.1:3500",
          external: {
            imageHost: "imgbb",
            imgbbConfigured: true,
            torrentClientConfigured: true,
            externalToolsEnabled: false
          }
        }
      });
    });
    await page.route("**/api/logs/global", async (route) => {
      await route.fulfill({ json: { api: ["api booted", "job updated"], worker: ["worker standby"] } });
    });
    await page.route("**/api/jobs/job-athena/logs", async (route) => {
      await route.fulfill({ json: { lines: ["prepare-media done", "review ready"] } });
    });
    await page.route("**/api/jobs/job-home/logs", async (route) => {
      await route.fulfill({ json: { lines: ["waiting for media"] } });
    });
    await page.route("**/api/jobs/*/pause", async (route) => {
      await route.fulfill({ json: { job: apiJobs[0] } });
    });
    await page.route("**/api/jobs/*/retry-failed", async (route) => {
      await route.fulfill({ json: { job: apiJobs[0] } });
    });
    await page.route("**/api/jobs/*/debug/advance", async (route) => {
      await route.fulfill({ json: { job: apiJobs[0] } });
    });
    await page.route("**/api/jobs/*/debug/skip", async (route) => {
      await route.fulfill({ json: { job: apiJobs[0] } });
    });
    await page.route("**/api/jobs/*/debug/force-state", async (route) => {
      await route.fulfill({ json: { job: apiJobs[0] } });
    });
    await page.route("**/api/jobs/*/review-gates/*/resolve", async (route) => {
      await route.fulfill({ json: { job: apiJobs[0] } });
    });
    await page.route("**/api/jobs/*/review-draft", async (route) => {
      const patch = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ json: { job: { ...apiJobs[0], reviewDraft: { ...apiJobs[0].reviewDraft, ...patch } } } });
    });
    await page.route("**/api/jobs/*/start-upload", async (route) => {
      await route.fulfill({ json: { job: { ...apiJobs[0], state: "uploading", phase: "upload" } } });
    });
  });

  test("renders the desktop review workspace without development status noise", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only layout assertion.");
    await page.goto("/");

    await expect(page.locator(".brand").getByText("Popcorn Queue")).toBeVisible();
    await expect(page.getByRole("link", { name: /Jobs/i })).toBeVisible();
    await expect(page.getByPlaceholder("Search jobs, IMDb, source")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start Upload" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry failed steps" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Diagnostics" })).toBeVisible();

    await expect(page.getByRole("button", { name: "Advance phase" })).toHaveCount(0);
    await expect(page.getByText(/PTP cache/i)).toHaveCount(0);
    await expect(page.getByText(/Permanent/i)).toHaveCount(0);
    await expect(page.getByText(/Upsies features/i)).toHaveCount(0);
    await expect(page.getByText(/Feature status/i)).toHaveCount(0);

    await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Release" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Step" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Download" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Blockers" })).toBeVisible();
    await expect(page.getByLabel("Upload queue").getByRole("link", { name: "ATHENA.2022.1080p.WEB.x265-SMURF" })).toBeVisible();
    await expect(page.getByLabel("Upload queue")).toContainText("Downloaded");
    await expect(page.getByLabel("Upload queue")).toContainText("Downloading (42%)");
    await expect(page.getByLabel("Upload queue")).toContainText("42% - 8.0 MB/s - 12m");
    await expect(page.locator(".job-link").first()).toHaveAttribute("href", "/jobs/job-athena");
  });

  test("uses the QUI-style light utility shell", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only style assertion.");
    await page.goto("/");

    await expect(page.locator(".shell")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(page.locator(".sidebar")).toHaveCSS("background-color", "rgb(250, 250, 250)");
    await expect(page.locator(".sidebar nav a.active")).toHaveCSS("background-color", "rgb(36, 36, 36)");
    await expect(page.locator(".table-wrap")).toBeVisible();
  });

  test("keeps review sections in upload decision order", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only review assertion.");
    await page.goto("/");
    await page.getByRole("link", { name: "ATHENA.2022.1080p.WEB.x265-SMURF" }).click();

    await expect(page.locator('[data-testid="review-panel"] h3').first()).toBeVisible();
    const headings = await page.locator('[data-testid="review-panel"] h3').allTextContents();
    expect(headings).toEqual([
      "Blockers",
      "Warnings",
      "Duplicate/PTP Result",
      "Download",
      "Screenshots",
      "MediaInfo / BDInfo",
      "Upload Draft",
      "Torrent / qB Readiness",
      "Recent Job Log"
    ]);
  });

  test("edits upload draft fields and shows source torrent display names", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only review assertion.");
    let savedPatch: Record<string, unknown> | null = null;
    await page.route("**/api/jobs/job-athena/review-draft", async (route) => {
      const patch = route.request().postDataJSON() as Record<string, unknown>;
      savedPatch = patch;
      await route.fulfill({ json: { job: { ...apiJobs[0], reviewDraft: { ...apiJobs[0].reviewDraft, ...patch } } } });
    });
    await page.goto("/");
    await page.getByRole("link", { name: "ATHENA.2022.1080p.WEB.x265-SMURF" }).click();

    const reviewPanel = page.getByTestId("review-panel");
    await expect(reviewPanel).toContainText("Source torrent");
    await expect(reviewPanel).toContainText("ATHENA.2022.PTer.source.torrent");
    await expect(reviewPanel).toContainText("PTP upload torrent");
    await expect(reviewPanel).toContainText("torrent/upload.torrent");

    await reviewPanel.getByLabel("Description").fill("Edited release description");
    await reviewPanel.getByLabel("PTP group").fill("456");
    await reviewPanel.getByRole("button", { name: "Save draft" }).click();

    expect(savedPatch).toMatchObject({ description: "Edited release description", groupId: "456" });
    await expect(reviewPanel).toContainText("Draft saved");
  });

  test("shows selected job download progress in the review pane", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only review assertion.");
    await page.goto("/");

    await page.getByRole("link", { name: "Home.Sweet.Home.2021.1080p.WEB.x265-TJUPT" }).click();
    const reviewPanel = page.getByTestId("review-panel");

    await expect(reviewPanel.getByRole("heading", { name: "Download" })).toBeVisible();
    await expect(reviewPanel).toContainText("Downloading (42%)");
    await expect(reviewPanel).toContainText("42% - 8.0 MB/s - 12m");
    await expect(reviewPanel).toContainText("4.0 MB / 10.0 MB");
    await expect(reviewPanel).toContainText("HOMEHASH");
  });

  test("keeps diagnostics hidden until requested", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByTestId("diagnostics-panel")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Advance phase" })).toHaveCount(0);

    await page.getByRole("button", { name: "Diagnostics" }).click();
    await expect(page.getByTestId("diagnostics-panel")).toBeVisible();
    await expect(page.getByRole("button", { name: "Advance phase" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Skip" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Force state" })).toBeVisible();
    await expect(page.getByText("Global logs")).toBeVisible();
    await expect(page.getByText("Job logs")).toBeVisible();
  });

  test("keeps primary controls inside the viewport", async ({ page }, testInfo) => {
    await page.goto("/");

    const toolbar = page.locator(".toolbar");
    const queue = page.locator(".queue");
    const toolbarBox = await toolbar.boundingBox();
    const queueBox = await queue.boundingBox();

    expect(toolbarBox).not.toBeNull();
    expect(queueBox).not.toBeNull();
    const viewportWidth = testInfo.project.name === "chromium-mobile" ? 412 : 1366;
    expect(toolbarBox!.x).toBeGreaterThanOrEqual(0);
    expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(viewportWidth);
    expect(queueBox!.x).toBeGreaterThanOrEqual(0);
    expect(queueBox!.x + queueBox!.width).toBeLessThanOrEqual(viewportWidth);
  });

  test("collapses navigation and hides review details on mobile", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "Mobile-only layout assertion.");
    await page.goto("/");

    await expect(page.locator(".brand")).toBeHidden();
    await expect(page.getByTestId("review-panel")).toBeHidden();
    await expect(page.getByPlaceholder("Search jobs, IMDb, source")).toBeVisible();
    await expect(page.getByText("Home.Sweet.Home.2021.1080p.WEB.x265-TJUPT")).toBeVisible();
  });

  test("surfaces API error details on upload actions", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only interaction assertion.");
    await page.route("**/api/jobs/job-athena/start-upload", async (route) => {
      await route.fulfill({ status: 409, json: { error: "blocker_review_gate_open" } });
    });
    await page.goto("/");
    await page.getByRole("link", { name: "ATHENA.2022.1080p.WEB.x265-SMURF" }).click();

    await page.getByTestId("job-drawer").getByRole("button", { name: "Start Upload" }).click();
    await expect(page.locator(".status-banner.error")).toContainText(
      "/api/jobs/job-athena/start-upload failed with HTTP 409: blocker_review_gate_open"
    );
  });
});

const apiJobs = [
  {
    id: "job-athena",
    state: "review",
    phase: "review",
    uploadReadiness: "ready",
    humanStep: "Review screenshots and metadata",
    updatedAt: "2026-05-08T00:00:00.000Z",
    source: { site: "M-Team", title: "ATHENA.2022.FRENCH.1080p.NF.WEB-DL.x265-SMURF" },
    candidate: { site: "mteam", title: "ATHENA.2022.FRENCH.1080p.NF.WEB-DL.x265-SMURF", imdbId: "tt1234567" },
    checkResult: { decision: { status: "review", reason: "IMDb + resolution match" } },
    torrent: { filename: "ATHENA.2022.PTer.source.torrent", bytes: 6871947673 },
    downloadStatus: {
      client: "qbittorrent",
      infoHash: "ATHENAHASH",
      state: "uploading",
      progress: 1,
      downloaded: 6_871_947_673,
      size: 6_871_947_673,
      amountLeft: 0,
      downloadSpeed: 0,
      uploadSpeed: 1_048_576,
      eta: 0,
      seeds: 4,
      peers: 0,
      savePath: "/downloads",
      contentPath: "/downloads/ATHENA.mkv",
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
      error: null
    },
    artifacts: {
      mediaFiles: ["media/upload/ATHENA.2022.1080p.WEB.x265-SMURF.mkv"],
      screenshots: ["https://example.test/shot1.png", "https://example.test/shot2.png"],
      mediainfo: "General\nComplete name: ATHENA.mkv\nFormat: Matroska",
      releaseName: "ATHENA.2022.1080p.WEB.x265-SMURF",
      description: "ATHENA release draft\nSource: WEB",
      uploadTorrent: "torrent/upload.torrent",
      qbReady: true
    },
    reviewDraft: {
      releaseName: "ATHENA.2022.1080p.WEB.x265-SMURF",
      description: "ATHENA release draft\nSource: WEB",
      groupId: "123",
      type: "Feature Film",
      codec: "H.265",
      container: "MKV",
      resolution: "1080p",
      source: "WEB-DL",
      remasterYear: "",
      remasterTitle: "",
      subtitles: ["English"],
      trumpable: [],
      scene: false,
      personalRip: false,
      internal: false
    },
    uploadPlan: {
      releaseName: { generated: "ATHENA.2022.1080p.WEB.x265-SMURF", group: "SMURF", container: "mkv", warnings: [] },
      screenshots: { count: 6, imageHosts: ["imgbb", "imgbox"], toneMapHint: "bt709" },
      torrentReuse: { strategy: "search-generic-cache", preservePieceHashes: true, reason: "A source .torrent was uploaded." },
      metadata: { imdbId: "tt1234567", providers: [], tags: ["web-dl"] },
      media: { container: "mkv", discType: "file", audio: { codecs: [], languages: ["French"], commentaryLikely: false }, subtitles: { languages: [], embeddedLikely: false }, trumpableChecks: [] },
      reviewGates: [{ id: "duplicate:review", severity: "warning", status: "open", title: "Duplicate review", detail: "IMDb + resolution match" }]
    },
    phases: [
      { phase: "intake", state: "done", retryCount: 0, message: "Finished." },
      { phase: "prepare-media", state: "done", retryCount: 0, message: "Finished." },
      { phase: "review", state: "blocked", retryCount: 0, message: "Review required." }
    ]
  },
  {
    id: "job-home",
    state: "preparing",
    phase: "prepare-media",
    uploadReadiness: "missing_evidence",
    humanStep: "Preparing upload media",
    updatedAt: "2026-05-08T00:00:00.000Z",
    source: { site: "TJUPT", title: "Home.Sweet.Home.2021.1080p.WEB-DL.HDR.H265-TJUPT" },
    candidate: { site: "tjupt", title: "Home.Sweet.Home.2021.1080p.WEB-DL.HDR.H265-TJUPT" },
    downloadStatus: {
      client: "qbittorrent",
      infoHash: "HOMEHASH",
      state: "downloading",
      progress: 0.42,
      downloaded: 4_194_304,
      size: 10_485_760,
      amountLeft: 6_291_456,
      downloadSpeed: 8_388_608,
      uploadSpeed: 0,
      eta: 720,
      seeds: 12,
      peers: 3,
      savePath: "/downloads",
      contentPath: "/downloads/Home.Sweet.Home.2021.1080p.WEB-DL.HDR.H265-TJUPT.mkv",
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
      error: null
    },
    uploadPlan: {
      releaseName: { generated: "Home.Sweet.Home.2021.1080p.WEB.x265-TJUPT", group: "TJUPT", container: "mkv", warnings: [] },
      screenshots: { count: 6, imageHosts: ["imgbb"], toneMapHint: "bt2020" },
      torrentReuse: { strategy: "hash-from-content", preservePieceHashes: false, reason: "No reusable source torrent is available yet." },
      metadata: { imdbId: null, providers: [], tags: ["web-dl"] },
      media: { container: "mkv", discType: "file", audio: { codecs: [], languages: ["English"], commentaryLikely: false }, subtitles: { languages: [], embeddedLikely: false }, trumpableChecks: [] },
      reviewGates: []
    },
    phases: []
  }
];
