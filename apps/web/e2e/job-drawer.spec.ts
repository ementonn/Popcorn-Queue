import { expect, test } from "@playwright/test";

test.describe("job review drawer", () => {
  test.beforeEach(async ({ page }) => {
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
    await expect(page.getByRole("dialog", { name: /job review/i })).toBeVisible();

    await page.getByRole("button", { name: "Close job review" }).click();

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

  test("edits advanced PTP fields in collapsible section", async ({ page }, testInfo) => {
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
    await page.getByRole("button", { name: "Save draft" }).click();

    expect(savedPatch).toMatchObject({ imdb: "tt7654321", tags: "drama, mystery" });
    await expect(page.getByTestId("review-panel").getByText("Draft saved")).toBeVisible();
  });

  test("shows text mediainfo artifact", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only drawer assertion.");
    await page.goto("/");
    await page.getByRole("link", { name: "Drawer.Movie.2026.1080p.WEB.x265-GROUP" }).click();

    await expect(page.getByText("General")).toBeVisible();
    await expect(page.getByText("Format                                   : Matroska")).toBeVisible();
  });
});

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
    description: "Description",
    uploadTorrent: "torrent/upload.torrent",
    qbReady: true
  },
  reviewDraft: {
    releaseName: "Drawer.Movie.2026.1080p.WEB.x265-GROUP",
    description: "Description",
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
