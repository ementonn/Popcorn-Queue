import { expect, test } from "@playwright/test";

test.describe("job review drawer", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/auth/session", async (route) => {
      await route.fulfill({ json: { authRequired: false, authenticated: true, username: null } });
    });
    await page.route("**/api/jobs", async (route) => {
      await route.fulfill({ json: { jobs: drawerJobs } });
    });
    await page.route("**/api/health", async (route) => {
      await route.fulfill({
        json: {
          ok: true,
          ptpConfigured: true,
          browserTokenConfigured: true,
          external: { torrentClientConfigured: true, externalToolsEnabled: false }
        }
      });
    });
    await page.route("**/api/logs/global", async (route) => {
      await route.fulfill({ json: { api: [], worker: [] } });
    });
    await page.route("**/api/jobs/*/logs", async (route) => {
      await route.fulfill({ json: { lines: [] } });
    });
    await page.route("**/api/jobs/*/review-draft", async (route) => {
      const patch = route.request().postDataJSON() as Record<string, unknown>;
      const job = drawerJobs.find((item) => route.request().url().includes(item.id)) ?? drawerJobs[0]!;
      await route.fulfill({ json: { job: { ...job, reviewDraft: { ...job.reviewDraft, ...patch } } } });
    });
    await page.route("**/api/jobs/*/start-upload", async (route) => {
      await route.fulfill({ json: { job: drawerJobs[0] } });
    });
    await page.route("**/api/jobs/*/pause", async (route) => {
      await route.fulfill({ json: { job: drawerJobs[0] } });
    });
    await page.route("**/api/jobs/*/retry-failed", async (route) => {
      await route.fulfill({ json: { job: drawerJobs[0] } });
    });
  });

  test("opens job drawer over the table", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only drawer assertion.");
    await page.goto("/");

    await expect(page.getByRole("dialog", { name: /job review/i })).toHaveCount(0);
    await page.getByRole("link", { name: "Drawer.Movie.2026.1080p.WEB.x265-GROUP" }).click();

    await expect(page.getByRole("dialog", { name: /job review/i })).toBeVisible();
    await expect(page.getByTestId("job-drawer")).toHaveCSS("position", "fixed");
    await expect(page.getByLabel("Upload queue")).toBeVisible();
    await expect(page.getByTestId("job-drawer")).toContainText("Drawer.Movie.2026.1080p.WEB.x265-GROUP");
  });

  test("resizes drawer with drag handle", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only drawer assertion.");
    await page.goto("/");
    await page.getByRole("link", { name: "Drawer.Movie.2026.1080p.WEB.x265-GROUP" }).click();

    const drawer = page.getByTestId("job-drawer");
    const handle = page.getByTestId("job-drawer-resizer");
    const before = await drawer.boundingBox();
    const handleBox = await handle.boundingBox();
    expect(before).not.toBeNull();
    expect(handleBox).not.toBeNull();

    await page.mouse.move(handleBox!.x + 2, handleBox!.y + 20);
    await page.mouse.down();
    await page.mouse.move(handleBox!.x - 140, handleBox!.y + 20);
    await page.mouse.up();

    const after = await drawer.boundingBox();
    expect(after).not.toBeNull();
    expect(after!.width).toBeGreaterThan(before!.width);
    expect(await page.evaluate(() => localStorage.getItem("popcorn.drawer.width"))).toBeTruthy();
  });

  test("closes drawer and preserves selected table", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only drawer assertion.");
    await page.goto("/");
    await page.getByRole("link", { name: "Drawer.Movie.2026.1080p.WEB.x265-GROUP" }).click();
    const drawer = page.getByTestId("job-drawer");
    await expect(page.getByRole("dialog", { name: /job review/i })).toBeVisible();
    await expect(drawer.locator(".readiness")).toHaveCount(0);
    const drawerBox = await drawer.boundingBox();
    const closeBox = await drawer.getByRole("button", { name: "Close job review" }).boundingBox();
    expect(drawerBox).not.toBeNull();
    expect(closeBox).not.toBeNull();
    expect(closeBox!.x - drawerBox!.x).toBeLessThan(32);

    await drawer.getByRole("button", { name: "Close job review" }).click();

    await expect(page.getByRole("dialog", { name: /job review/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Drawer.Movie.2026.1080p.WEB.x265-GROUP" })).toBeVisible();
  });

  test("switches drawer content when another job row is selected", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only drawer assertion.");
    await page.goto("/");
    await page.getByRole("link", { name: "Drawer.Movie.2026.1080p.WEB.x265-GROUP" }).click();
    await expect(page.getByTestId("job-drawer")).toContainText("Drawer.Movie.2026.1080p.WEB.x265-GROUP");

    await page.getByRole("link", { name: "Second.Movie.2025.1080p.BluRay.x264-GROUP" }).click();

    await expect(page.getByTestId("job-drawer")).toContainText("Second.Movie.2025.1080p.BluRay.x264-GROUP");
  });

  test("shows required PTP draft fields by default", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only drawer assertion.");
    await page.goto("/");
    await page.getByRole("link", { name: "Drawer.Movie.2026.1080p.WEB.x265-GROUP" }).click();

    await expect(page.getByLabel("Type")).toHaveValue("Feature Film");
    await expect(page.getByLabel("Source")).toHaveValue("WEB");
    await expect(page.getByLabel("Codec")).toHaveValue("H.265");
    await expect(page.getByLabel("Container")).toHaveValue("MKV");
    await expect(page.getByLabel("Resolution")).toHaveValue("1080p");
    await expect(page.getByRole("button", { name: "Advanced PTP fields" })).toBeVisible();
    await expect(page.getByLabel("IMDb")).toHaveCount(0);
  });

  test("matches PTP subtitle choices and keeps trumpable below description", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only drawer assertion.");
    await page.goto("/");
    await page.getByRole("link", { name: "Drawer.Movie.2026.1080p.WEB.x265-GROUP" }).click();

    const reviewPanel = page.getByTestId("review-panel");
    const subtitleLabels = await reviewPanel.evaluate((panel) => {
      const field = Array.from(panel.querySelectorAll(".draft-field")).find(
        (item) => item.querySelector(":scope > span")?.textContent?.trim() === "Subtitles"
      );
      return Array.from(field?.querySelectorAll(".draft-checkbox-row label span") ?? []).map((item) => item.textContent?.trim());
    });
    expect(subtitleLabels).toEqual([
      "No Subtitles",
      "English",
      "English - Forced",
      "English Intertitles",
      "Spanish",
      "French",
      "Arabic",
      "Brazilian Port.",
      "Bulgarian",
      "Chinese",
      "Croatian",
      "Czech",
      "Danish",
      "Dutch",
      "Estonian",
      "Finnish",
      "German",
      "Greek",
      "Hebrew",
      "Hindi",
      "Hungarian",
      "Icelandic",
      "Indonesian",
      "Italian",
      "Japanese",
      "Korean",
      "Latvian",
      "Lithuanian",
      "Malay",
      "Norwegian",
      "Persian",
      "Polish",
      "Portuguese",
      "Romanian",
      "Russian",
      "Serbian",
      "Slovak",
      "Slovenian",
      "Swedish",
      "Thai",
      "Turkish",
      "Ukrainian",
      "Vietnamese",
      "Welsh"
    ]);

    const fieldOrder = await reviewPanel.locator(".draft-field > span").evaluateAll((items) => items.map((item) => item.textContent?.trim()));
    expect(fieldOrder.indexOf("Description")).toBeGreaterThanOrEqual(0);
    expect(fieldOrder.indexOf("Trumpable")).toBeGreaterThanOrEqual(0);
    expect(fieldOrder.indexOf("Description")).toBeLessThan(fieldOrder.indexOf("Trumpable"));

    const draftOrder = await reviewPanel.evaluate((panel) => {
      const labelTop = (text: string) =>
        Array.from(panel.querySelectorAll("label")).find((label) => label.textContent?.trim() === text)?.getBoundingClientRect().top ?? 0;
      const fieldTop = (text: string) =>
        Array.from(panel.querySelectorAll(".draft-field > span")).find((label) => label.textContent?.trim() === text)?.getBoundingClientRect().top ?? 0;
      return {
        scene: labelTop("Scene"),
        personalRip: labelTop("Personal rip"),
        internal: labelTop("Internal"),
        editionInformation: labelTop("Edition Information"),
        subtitles: fieldTop("Subtitles")
      };
    });
    expect(draftOrder.scene).toBeLessThan(draftOrder.subtitles);
    expect(draftOrder.personalRip).toBeLessThan(draftOrder.subtitles);
    expect(draftOrder.internal).toBeLessThan(draftOrder.subtitles);
    expect(draftOrder.editionInformation).toBeLessThan(draftOrder.subtitles);

    const checkboxWidths = await reviewPanel.evaluate((panel) => {
      const field = Array.from(panel.querySelectorAll(".draft-field")).find(
        (item) => item.querySelector(":scope > span")?.textContent?.trim() === "Subtitles"
      );
      return Array.from(field?.querySelectorAll('input[type="checkbox"]') ?? []).map((input) => input.getBoundingClientRect().width);
    });
    expect(Math.max(...checkboxWidths)).toBeLessThanOrEqual(18);
  });

  test("autosaves advanced PTP field edits without a save button", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only drawer assertion.");
    let savedPatch: Record<string, unknown> | null = null;
    await page.route("**/api/jobs/job-drawer/review-draft", async (route) => {
      const patch = route.request().postDataJSON() as Record<string, unknown>;
      savedPatch = patch;
      await route.fulfill({ json: { job: { ...drawerJobs[0], reviewDraft: { ...drawerJobs[0]!.reviewDraft, ...patch } } } });
    });
    await page.goto("/");
    await page.getByRole("link", { name: "Drawer.Movie.2026.1080p.WEB.x265-GROUP" }).click();

    await page.getByRole("button", { name: "Advanced PTP fields" }).click();
    await page.getByLabel("IMDb").fill("tt7654321");
    await page.getByLabel("Tags").fill("drama, mystery");

    await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
    await expect
      .poll(() => savedPatch, { timeout: 2500 })
      .toMatchObject({ imdb: "tt7654321", tags: "drama, mystery" });
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  });

  test("autosaves default PTP edition information fields and keeps edits across refresh", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only drawer assertion.");
    let savedPatch: Record<string, unknown> | null = null;
    await page.route("**/api/jobs/job-drawer/review-draft", async (route) => {
      const patch = route.request().postDataJSON() as Record<string, unknown>;
      savedPatch = patch;
      await route.fulfill({ json: { job: { ...drawerJobs[0], reviewDraft: { ...drawerJobs[0]!.reviewDraft, ...patch } } } });
    });
    await page.goto("/");
    await page.getByRole("link", { name: "Drawer.Movie.2026.1080p.WEB.x265-GROUP" }).click();

    await expect(page.getByText(/^Remaster/)).toHaveCount(0);
    await page.getByLabel("Edition Information").check();
    await page.getByRole("button", { name: "Director's Cut" }).click();
    await page.getByRole("button", { name: "HDR10", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Information", exact: true })).toHaveValue("Director's Cut / HDR10");
    await page.getByLabel("Edition year").fill("2023");
    await page.waitForTimeout(3500);
    await expect(page.getByLabel("Edition Information")).toBeChecked();
    await expect(page.getByRole("textbox", { name: "Information", exact: true })).toHaveValue("Director's Cut / HDR10");
    await expect(page.getByLabel("Edition year")).toHaveValue("2023");

    await expect
      .poll(() => savedPatch, { timeout: 2500 })
      .toMatchObject({ remaster: true, remasterTitle: "Director's Cut / HDR10", remasterYear: "2023" });
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  });

  test("keeps mediainfo in description instead of a separate review section", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only drawer assertion.");
    await page.goto("/");
    await page.getByRole("link", { name: "Drawer.Movie.2026.1080p.WEB.x265-GROUP" }).click();

    await expect(page.getByTestId("review-panel").getByRole("heading", { name: "MediaInfo / BDInfo" })).toHaveCount(0);
    await expect(page.getByLabel("Description")).toHaveValue(/General[\s\S]*Format\s*: Matroska/);
  });
});

const mediaInfoDescription = "General\nFormat                                   : Matroska";

const baseJob = {
  state: "review",
  phase: "review",
  uploadReadiness: "ready",
  humanStep: "Review upload package",
  updatedAt: "2026-05-08T00:00:00.000Z",
  checkResult: { decision: { status: "open", reason: "slot open", ptpUrl: "https://passthepopcorn.me/torrents.php?id=123" } },
  artifacts: {
    mediaFiles: ["media/upload/movie.mkv"],
    screenshots: ["https://img.example/1.png", "https://img.example/2.png", "https://img.example/3.png"],
    mediaInfoText: "General\nFormat                                   : Matroska",
    mediaInfoJson: "{\"media\":{\"track\":[{\"@type\":\"General\",\"Format\":\"Matroska\"}]}}",
    releaseName: "Drawer.Movie.2026.1080p.WEB.x265-GROUP",
    description: mediaInfoDescription,
    uploadTorrent: "torrent/upload.torrent",
    qbReady: true
  },
  reviewDraft: {
    releaseName: "Drawer.Movie.2026.1080p.WEB.x265-GROUP",
    description: mediaInfoDescription,
    groupId: "123",
    type: "Feature Film",
    codec: "H.265",
    container: "MKV",
    resolution: "1080p",
    source: "WEB",
    remasterYear: "",
    remasterTitle: "",
    subtitles: ["3"],
    trumpable: [],
    scene: false,
    personalRip: false,
    internal: false
  },
  uploadPlan: {
    releaseName: { generated: "Drawer.Movie.2026.1080p.WEB.x265-GROUP", group: "GROUP", container: "mkv", warnings: [] },
    screenshots: { count: 6, imageHosts: ["imgbb"], toneMapHint: "bt709" },
    torrentReuse: { strategy: "source", preservePieceHashes: true, reason: "source torrent" },
    metadata: { imdbId: "tt1234567", providers: [], tags: ["web-dl"] },
    media: { container: "mkv", discType: "file", audio: { codecs: [], languages: ["English"], commentaryLikely: false }, subtitles: { languages: [], embeddedLikely: false }, trumpableChecks: [] },
    reviewGates: []
  },
  phases: []
};

const drawerJobs = [
  {
    ...baseJob,
    id: "job-drawer",
    source: { site: "PTer", title: "Drawer.Movie.2026.1080p.WEB-DL.x265-GROUP" },
    candidate: { site: "pter", title: "Drawer.Movie.2026.1080p.WEB-DL.x265-GROUP", imdbId: "tt1234567" },
    torrent: { filename: "drawer.source.torrent", bytes: 1000 }
  },
  {
    ...baseJob,
    id: "job-second",
    source: { site: "M-Team", title: "Second.Movie.2025.1080p.BluRay.x264-GROUP" },
    candidate: { site: "mteam", title: "Second.Movie.2025.1080p.BluRay.x264-GROUP", imdbId: "tt7654321" },
    artifacts: {
      ...baseJob.artifacts,
      releaseName: "Second.Movie.2025.1080p.BluRay.x264-GROUP"
    },
    reviewDraft: {
      ...baseJob.reviewDraft,
      releaseName: "Second.Movie.2025.1080p.BluRay.x264-GROUP"
    },
    uploadPlan: {
      ...baseJob.uploadPlan,
      releaseName: { generated: "Second.Movie.2025.1080p.BluRay.x264-GROUP", group: "GROUP", container: "mkv", warnings: [] }
    },
    torrent: { filename: "second.source.torrent", bytes: 1000 }
  }
];
