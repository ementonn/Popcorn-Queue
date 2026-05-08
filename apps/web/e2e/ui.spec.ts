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
      await route.fulfill({ json: { ok: true, ptpConfigured: false, browserTokenConfigured: true, cachePolicy: "permanent" } });
    });
    await page.route("**/api/features", async (route) => {
      await route.fulfill({
        json: {
          features: [
            {
              id: "upload-plan",
              name: "Upsies-style upload plan",
              status: "implemented",
              detail: "Every job receives metadata, release-name, scene, screenshot, torrent-reuse, media, and review-gate plans."
            }
          ]
        }
      });
    });
  });

  test("renders the desktop queue workspace", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only layout assertion.");
    await page.goto("/");

    await expect(page.locator(".brand").getByText("Popcorn Queue")).toBeVisible();
    await expect(page.getByRole("link", { name: /Jobs/i })).toBeVisible();
    await expect(page.getByPlaceholder("Search jobs, IMDb, PTP ID, source")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Advance", exact: true })).toBeVisible();
    await expect(page.locator(".filter-sidebar")).toBeVisible();

    await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Release" })).toBeVisible();
    await expect(page.getByText("ATHENA.2022.FRENCH.1080p.NF.WEB-DL.x265-SMURF")).toBeVisible();
    await expect(page.locator(".inspector").getByText("PTP cache")).toBeVisible();
    await expect(page.locator(".inspector").getByText("Permanent")).toBeVisible();
    await expect(page.locator(".status-banner.success")).toContainText("API connected");
    await expect(page.locator(".job-link")).toHaveAttribute("href", "/jobs/job-athena");
    await expect(page.locator(".gate-summary")).toContainText("1 warnings");
    await expect(page.locator(".phase-list")).toContainText("duplicate-check");
  });

  test("uses the QUI-style light utility shell", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only style assertion.");
    await page.goto("/");

    await expect(page.locator(".shell")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(page.locator(".sidebar")).toHaveCSS("background-color", "rgb(250, 250, 250)");
    await expect(page.locator(".sidebar nav a.active")).toHaveCSS("background-color", "rgb(36, 36, 36)");
    await expect(page.locator(".table-wrap")).toBeVisible();
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

  test("collapses navigation and hides inspector on mobile", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "Mobile-only layout assertion.");
    await page.goto("/");

    await expect(page.locator(".brand")).toBeHidden();
    await expect(page.locator(".inspector")).toBeHidden();
    await expect(page.getByPlaceholder("Search jobs, IMDb, PTP ID, source")).toBeVisible();
    await expect(page.getByText("Home.Sweet.Home.2021.1080p.WEB-DL.HDR.H265-TJUPT")).toBeVisible();
  });

  test("surfaces API error details on job actions", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only interaction assertion.");
    await page.route("**/api/jobs/job-athena/start", async (route) => {
      await route.fulfill({ status: 409, json: { error: "blocker_review_gate_open" } });
    });
    await page.goto("/");

    await page.getByRole("button", { name: "Start" }).click();
    await expect(page.locator(".status-banner.error")).toContainText("/api/jobs/job-athena/start failed with HTTP 409: blocker_review_gate_open");
  });
});

const apiJobs = [
  {
    id: "job-athena",
    state: "review",
    phase: "duplicate-check",
    updatedAt: "2026-05-08T00:00:00.000Z",
    source: { site: "M-Team", title: "ATHENA.2022.FRENCH.1080p.NF.WEB-DL.x265-SMURF" },
    candidate: { site: "mteam", title: "ATHENA.2022.FRENCH.1080p.NF.WEB-DL.x265-SMURF", imdbId: "tt1234567" },
    checkResult: { cache: { hit: true, policy: "permanent" }, decision: { status: "review", reason: "IMDb + resolution match" } },
    torrent: { filename: "ATHENA.torrent", bytes: 6871947673 },
    uploadPlan: {
      releaseName: { generated: "ATHENA.2022.1080p.WEB.x265-SMURF", group: "SMURF", container: null, warnings: [] },
      scene: { status: "likely_scene", releaseGroup: "SMURF", providers: ["predbnet", "srrdb"], evidence: ["Release group suffix detected."] },
      screenshots: { count: 6, imageHosts: ["ptpimg", "imgbox"], toneMapHint: "bt709" },
      torrentReuse: { strategy: "search-generic-cache", preservePieceHashes: true, reason: "A source .torrent was uploaded." },
      metadata: { imdbId: "tt1234567", providers: [], tags: ["web-dl"] },
      media: { container: null, discType: "file", audio: { codecs: [], languages: ["French"], commentaryLikely: false }, subtitles: { languages: [], embeddedLikely: false }, trumpableChecks: [] },
      reviewGates: [{ id: "duplicate:review", severity: "warning", status: "open", title: "Duplicate review", detail: "IMDb + resolution match" }]
    },
    phases: [
      { phase: "intake", state: "done", retryCount: 0, message: "Finished." },
      { phase: "metadata", state: "done", retryCount: 0, message: "Finished." },
      { phase: "duplicate-check", state: "blocked", retryCount: 0, message: "Review required." }
    ]
  },
  {
    id: "job-home",
    state: "queued",
    phase: "intake",
    updatedAt: "2026-05-08T00:00:00.000Z",
    source: { site: "TJUPT", title: "Home.Sweet.Home.2021.1080p.WEB-DL.HDR.H265-TJUPT" },
    candidate: { site: "tjupt", title: "Home.Sweet.Home.2021.1080p.WEB-DL.HDR.H265-TJUPT" },
    uploadPlan: {
      releaseName: { generated: "Home.Sweet.Home.2021.1080p.WEB.x265-TJUPT", group: "TJUPT", container: null, warnings: [] },
      scene: { status: "needs_verification", releaseGroup: "TJUPT", providers: ["predbnet", "srrdb"], evidence: ["Release group suffix detected."] },
      screenshots: { count: 6, imageHosts: ["ptpimg"], toneMapHint: "bt2020" },
      torrentReuse: { strategy: "hash-from-content", preservePieceHashes: false, reason: "No reusable source torrent is available yet." },
      metadata: { imdbId: null, providers: [], tags: ["web-dl"] },
      media: { container: null, discType: "file", audio: { codecs: [], languages: ["English"], commentaryLikely: false }, subtitles: { languages: [], embeddedLikely: false }, trumpableChecks: [] },
      reviewGates: []
    },
    phases: []
  }
];
