import { expect, test } from "@playwright/test";

const longMediaInfo = Array.from({ length: 24 }, (_, index) => (index === 0 ? "General" : `MediaInfo line ${index}`)).join("\n");

test.describe("Popcorn Queue UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/auth/session", async (route) => {
      await route.fulfill({ json: { authRequired: false, authenticated: true, username: null } });
    });
    await page.route("**/api/auth/login", async (route) => {
      await route.fulfill({ json: { authRequired: true, authenticated: true, username: "ptp-user" } });
    });
    await page.route("**/api/auth/logout", async (route) => {
      await route.fulfill({ json: { authRequired: true, authenticated: false, username: null } });
    });
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
      await route.fulfill({ json: { api: ["api booted", "job updated"] } });
    });
    await page.route("**/api/diagnostics", async (route) => {
      await route.fulfill({
        json: {
          system: {
            api: "online",
            persistence: "sqlite",
            publicWebUrl: "http://127.0.0.1:5173",
            publicApiUrl: "http://127.0.0.1:3500",
            browserBridgeConfigured: true,
            ptpApiConfigured: true,
            externalToolsEnabled: false
          },
          integrations: {
            qbittorrent: { configured: true, status: "not_checked", detail: "qBittorrent is configured." },
            ptp: { configured: true, status: "not_checked", detail: "PTP API credentials are configured." },
            imageHost: { configured: true, status: "not_checked", detail: "imgbb is configured." },
            tools: { configured: false, status: "not_checked", detail: "External tools are disabled." }
          },
          queue: {
            total: 2,
            preparing: 0,
            review: 1,
            failed: 0,
            done: 0,
            paused: 1,
            uploading: 0,
            seeding: 0,
            needsReseed: 0,
            stuck: [],
            recentFailures: []
          },
          storage: {
            dataRoot: "/var/lib/popcorn-queue/data",
            databasePath: "/var/lib/popcorn-queue/popcorn-queue.db",
            jobCount: 2,
            cacheEntries: 12,
            databaseBytes: 4096,
            dataRootFreeBytes: 1000000
          },
          tools: {
            ffmpeg: { tool: "ffmpeg", command: "ffmpeg", available: true, version: "ffmpeg version 6.1", location: "/usr/bin/ffmpeg", error: null },
            mediainfo: { tool: "mediainfo", command: "mediainfo", available: true, version: "MediaInfoLib - v24.01", location: "/usr/bin/mediainfo", error: null },
            mkvmerge: { tool: "mkvmerge", command: "mkvmerge", available: true, version: "mkvmerge v82.0", location: "/usr/bin/mkvmerge", error: null },
            mpv: { tool: "mpv", command: "mpv", available: true, version: "mpv 0.41.0", location: "/usr/bin/mpv", error: null },
            oxipng: { tool: "oxipng", command: "oxipng", available: false, version: null, location: null, error: "not found" },
            "xvfb-run": { tool: "xvfb-run", command: "xvfb-run", available: true, version: "Usage: xvfb-run", location: "/usr/bin/xvfb-run", error: null }
          },
          logs: { api: ["api booted", "job updated"] }
        }
      });
    });
    await page.route("**/api/diagnostics/check/qbittorrent", async (route) => {
      await route.fulfill({
        json: {
          target: "qbittorrent",
          configured: true,
          status: "ok",
          detail: "qBittorrent responded.",
          checkedAt: "2026-05-09T00:00:00.000Z"
        }
      });
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
    await page.route("**/api/jobs/*/resume", async (route) => {
      await route.fulfill({ json: { job: { ...apiJobs[1], state: "preparing", humanStep: "Preparing upload media" } } });
    });
    await page.route("**/api/jobs/*/retry-failed", async (route) => {
      await route.fulfill({ json: { job: apiJobs[0] } });
    });
    await page.route("**/api/jobs/*/debug/skip", async (route) => {
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
    await expect(page.getByRole("button", { name: "Logout" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Jobs/i })).toBeVisible();
    await expect(page.getByPlaceholder("Search jobs, IMDb, source")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start Upload" })).toHaveCount(0);
    await expect(page.locator(".toolbar").getByRole("button", { name: "Upload" })).toHaveCount(0);
    await page.getByRole("link", { name: "ATHENA.2022.1080p.WEB.x265-SMURF" }).click();
    await expect(page.locator(".toolbar").getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry failed steps" })).toBeVisible();
    await expect(page.locator(".toolbar").getByRole("button", { name: "Diagnostics" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Diagnostics/i })).toBeVisible();

    await expect(page.getByRole("button", { name: "Advance phase" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Force state" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Skip" })).toHaveCount(0);
    await expect(page.getByText(/PTP cache/i)).toHaveCount(0);
    await expect(page.getByText(/Permanent/i)).toHaveCount(0);
    await expect(page.getByText(/Upsies features/i)).toHaveCount(0);
    await expect(page.getByText(/Feature status/i)).toHaveCount(0);

    await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Release" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Step" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Download" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Blockers" })).toHaveCount(0);
    await expect(page.getByLabel("Upload queue").getByRole("link", { name: "ATHENA.2022.1080p.WEB.x265-SMURF" })).toBeVisible();
    await expect(page.getByLabel("Upload queue").locator("tbody tr").filter({ hasText: "ATHENA.2022.1080p.WEB.x265-SMURF" }).locator('[data-label="Step"]')).toHaveText("Review");
    await expect(page.getByLabel("Upload queue").locator("tbody tr").filter({ hasText: "Home.Sweet.Home.2021.1080p.WEB.x265-TJUPT" }).locator('[data-label="Step"]')).toHaveText("Prepare media");
    await expect(page.getByLabel("Upload queue")).toContainText("Downloaded");
    await expect(page.getByLabel("Upload queue")).toContainText("Downloading (42%)");
    await expect(page.getByLabel("Upload queue")).toContainText("42% - 8.0 MB/s - 12m");
    await expect(page.locator(".job-link").first()).toHaveAttribute("href", "/jobs/job-athena");
    await expect(page.getByLabel("Upload queue").getByRole("button", { name: "Upload", exact: true }).first()).toBeVisible();
    await expect(page.getByLabel("Upload queue").getByRole("button", { name: "Details" })).toHaveCount(0);
  });

  test("requires local PTP credentials before showing the queue", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only auth assertion.");
    let authenticated = false;
    const loginRequests: Array<Record<string, unknown>> = [];
    await page.route("**/api/auth/session", async (route) => {
      await route.fulfill({ json: { authRequired: true, authenticated, username: authenticated ? "ptp-user" : null } });
    });
    await page.route("**/api/auth/login", async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      loginRequests.push(body);
      authenticated = body.username === "ptp-user" && body.password === "ptp-pass";
      await route.fulfill({
        status: authenticated ? 200 : 401,
        json: authenticated ? { authRequired: true, authenticated: true, username: "ptp-user" } : { error: "invalid_credentials" }
      });
    });

    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("PTP username")).toBeVisible();
    await expect(page.getByLabel("PTP password")).toBeVisible();
    await expect(page.getByLabel("Upload queue")).toHaveCount(0);

    await page.getByLabel("PTP username").fill("ptp-user");
    await page.getByLabel("PTP password").fill("wrong");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(/invalid_credentials/i)).toBeVisible();

    await page.getByLabel("PTP password").fill("ptp-pass");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByLabel("Upload queue")).toBeVisible();
    await expect(page.getByRole("button", { name: "Logout" })).toBeVisible();
    expect(loginRequests.at(-1)).toMatchObject({ username: "ptp-user", password: "ptp-pass" });
  });

  test("keeps the login form hidden while checking an existing session", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only auth assertion.");
    await page.unroute("**/api/auth/session");
    let releaseSession!: () => void;
    const sessionReady = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    await page.route("**/api/auth/session", async (route) => {
      await sessionReady;
      await route.fulfill({ json: { authRequired: true, authenticated: true, username: "ptp-user" } });
    });

    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
    await expect(page.getByText("Checking session")).toBeVisible();

    releaseSession();
    await expect(page.getByLabel("Upload queue")).toBeVisible();
  });

  test("creates a manual job from server media path, uploaded torrent, and confirmed PTP target", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only intake assertion.");
    const requests: Array<{ url: string; method: string; body: string | null }> = [];

    await page.route("**/api/intake/media-path/validate", async (route) => {
      requests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() });
      await route.fulfill({
        json: {
          ok: true,
          mediaPath: "/media/movies/Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p.mkv",
          basename: "Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p.mkv",
          kind: "file",
          size: 1234,
          error: null
        }
      });
    });
    await page.route("**/api/intake/ptp-search", async (route) => {
      requests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() });
      await route.fulfill({
        json: {
          query: "Skaz pro to kak tsar Pyotr arapa zhenil",
          parsedYear: "1976",
          results: [
            {
              groupId: "205678",
              title: "Skaz pro to, kak tsar Pyotr arapa zhenil",
              displayTitle: "Skaz pro to, kak tsar Pyotr arapa zhenil AKA How Czar Peter the Great Married Off His Moor [1976]",
              year: "1976",
              imdbId: "tt0075169",
              ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678",
              raw: {}
            }
          ]
        }
      });
    });
    await page.route("**/api/intake/jobs", async (route) => {
      requests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() });
      await route.fulfill({
        status: 201,
        json: {
          job: {
            ...apiJobs[0],
            id: "job-manual",
            candidate: { ...apiJobs[0].candidate!, site: "unknown", title: "Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p" },
            source: {
              site: "unknown",
              title: "Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p",
              mediaPath: "/media/movies/Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p.mkv",
              ptpTarget: {
                groupId: "205678",
                displayTitle: "Skaz pro to, kak tsar Pyotr arapa zhenil AKA How Czar Peter the Great Married Off His Moor [1976]",
                year: "1976",
                imdbId: "tt0075169",
                ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
              }
            },
            artifacts: {
              ...apiJobs[0].artifacts,
              releaseName: "Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p"
            },
            uploadPlan: {
              ...apiJobs[0].uploadPlan,
              releaseName: { ...apiJobs[0].uploadPlan.releaseName, generated: "Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p" }
            }
          }
        }
      });
    });

    await page.goto("/");
    await page.getByRole("link", { name: /New Job/i }).click();
    await expect(page.getByRole("heading", { name: "New Job" })).toBeVisible();

    await page.getByLabel("Server media path").fill("/media/movies/Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p.mkv");
    await page.getByRole("button", { name: "Validate path" }).click();
    await expect(page.getByText("Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p.mkv")).toBeVisible();

    await page.setInputFiles('input[type="file"][name="torrent"]', {
      name: "source.torrent",
      mimeType: "application/x-bittorrent",
      buffer: Buffer.from("d4:infod6:lengthi1eee")
    });
    await page.getByRole("button", { name: "Search PTP Movie" }).click();

    const movieLink = page.getByRole("link", {
      name: "Skaz pro to, kak tsar Pyotr arapa zhenil AKA How Czar Peter the Great Married Off His Moor [1976]"
    });
    await expect(movieLink).toHaveAttribute("href", "https://passthepopcorn.me/torrents.php?id=205678");
    await page.locator(".ptp-result").filter({ has: movieLink }).getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByText("PTP Target")).toBeVisible();
    await expect(page.getByText("Confirmed")).toBeVisible();

    await page.getByRole("button", { name: "Create Job" }).click();
    await expect(page.getByLabel("Upload queue")).toContainText("Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p");
    expect(requests.find((request) => request.url.includes("/api/intake/ptp-search"))?.body).toContain(
      '"title":"Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p"'
    );
    const createRequest = requests.find((request) => request.url.includes("/api/intake/jobs") && request.method === "POST");
    expect(createRequest?.body).not.toContain('name="releaseName"');
  });

  test("warns when a manual media path is a directory", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only intake assertion.");

    await page.route("**/api/intake/media-path/validate", async (route) => {
      await route.fulfill({
        json: {
          ok: true,
          mediaPath: "/media/movies/Directory.Movie.2024.1080p.WEB-DL.x265-GROUP",
          basename: "Directory.Movie.2024.1080p.WEB-DL.x265-GROUP",
          kind: "directory",
          size: null,
          error: null,
          warning: "media_path_is_directory"
        }
      });
    });

    await page.goto("/");
    await page.getByRole("link", { name: /New Job/i }).click();
    await page.getByLabel("Server media path").fill("/media/movies/Directory.Movie.2024.1080p.WEB-DL.x265-GROUP");
    await page.getByRole("button", { name: "Validate path" }).click();

    await expect(page.getByLabel("Media", { exact: true }).getByText("Warning: selected path is a folder, not a file.")).toBeVisible();
    await expect(page.getByLabel("Release", { exact: true }).getByText("Optional")).toBeVisible();
    await expect(page.getByLabel("Release name override")).toHaveValue("");
  });

  test("creates a manual job with a manually resolved PTP movie target", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only intake assertion.");
    const requests: Array<{ url: string; method: string; body: string | null }> = [];

    await page.route("**/api/intake/media-path/validate", async (route) => {
      await route.fulfill({
        json: {
          ok: true,
          mediaPath: "/media/movies/Manual.Target.1976.1080p.WEB-DL.x265-GROUP.mkv",
          basename: "Manual.Target.1976.1080p.WEB-DL.x265-GROUP.mkv",
          kind: "file",
          size: 1234,
          error: null,
          warning: null
        }
      });
    });
    await page.route("**/api/intake/ptp-search", async (route) => {
      requests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() });
      await route.fulfill({ json: { query: "", parsedYear: null, results: [] } });
    });
    await page.route("**/api/intake/ptp-target/resolve", async (route) => {
      requests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() });
      await route.fulfill({
        json: {
          target: {
            groupId: "205678",
            displayTitle: "Manual Target Movie [1976]",
            year: "1976",
            imdbId: "tt0075169",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
          }
        }
      });
    });
    await page.route("**/api/intake/jobs", async (route) => {
      requests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() });
      await route.fulfill({
        status: 201,
        json: {
          job: {
            ...apiJobs[0],
            id: "job-manual-target",
            candidate: { ...apiJobs[0].candidate!, site: "unknown", title: "Manual.Target.1976.1080p.WEB-DL.x265-GROUP" },
            source: {
              site: "unknown",
              title: "Manual.Target.1976.1080p.WEB-DL.x265-GROUP",
              mediaPath: "/media/movies/Manual.Target.1976.1080p.WEB-DL.x265-GROUP.mkv",
              ptpTarget: {
                groupId: "205678",
                displayTitle: "Manual Target Movie [1976]",
                year: "1976",
                imdbId: "tt0075169",
                ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
              }
            }
          }
        }
      });
    });

    await page.goto("/");
    await page.getByRole("link", { name: /New Job/i }).click();
    await page.getByLabel("Server media path").fill("/media/movies/Manual.Target.1976.1080p.WEB-DL.x265-GROUP.mkv");
    await page.setInputFiles('input[type="file"][name="torrent"]', {
      name: "source.torrent",
      mimeType: "application/x-bittorrent",
      buffer: Buffer.from("d4:infod6:lengthi1eee")
    });
    await page.getByLabel("Release name").fill("Manual.Target.1976.1080p.WEB-DL.x265-GROUP");
    await page.getByRole("button", { name: "Search PTP Movie" }).click();
    await expect(page.getByLabel("PTP Target").getByText("No PTP movies found")).toBeVisible();
    await expect(page.getByLabel("Manual PTP target")).not.toContainText("Group ID");
    await expect(page.getByRole("button", { name: "Confirm Manual Target" })).toHaveCount(0);
    await expect(page.getByLabel("Target display title")).toHaveCount(0);
    await expect(page.getByLabel("Target year")).toHaveCount(0);
    await page.getByLabel("PTP URL or Movie ID").fill("https://passthepopcorn.me/torrents.php?id=205678&torrentid=1515743");
    await page.getByLabel("Manual PTP target").getByRole("button", { name: "Confirm", exact: true }).click();

    await expect(page.getByRole("link", { name: "Manual Target Movie [1976]" })).toHaveAttribute("href", "https://passthepopcorn.me/torrents.php?id=205678");
    await expect(page.getByLabel("PTP Target").getByText("No PTP movies found")).toHaveCount(0);
    await expect(page.getByText("Missing: Validate media path")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create Job" })).toBeEnabled();
    await page.getByRole("button", { name: "Create Job" }).click();

    const createRequest = requests.find((request) => request.url.includes("/api/intake/jobs"));
    expect(createRequest?.body).toContain('"groupId":"205678"');
    expect(createRequest?.body).toContain('"displayTitle":"Manual Target Movie [1976]"');
    expect(createRequest?.body).toContain('"imdbId":"tt0075169"');
    expect(requests.find((request) => request.url.includes("/api/intake/ptp-target/resolve"))?.body).toContain(
      '"ptpUrl":"https://passthepopcorn.me/torrents.php?id=205678&torrentid=1515743"'
    );
    expect(requests.some((request) => request.url.includes("/api/intake/ptp-search"))).toBe(true);
  });

  test("creates a manual job from a validated server media path without a source torrent", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only intake assertion.");
    const requests: Array<{ url: string; method: string; body: string | null }> = [];

    await page.route("**/api/intake/media-path/validate", async (route) => {
      await route.fulfill({
        json: {
          ok: true,
          mediaPath: "/media/movies/Media.Only.2024.1080p.WEB-DL.x265-GROUP.mkv",
          basename: "Media.Only.2024.1080p.WEB-DL.x265-GROUP.mkv",
          kind: "file",
          size: 1234,
          error: null,
          warning: null
        }
      });
    });
    await page.route("**/api/intake/ptp-target/resolve", async (route) => {
      await route.fulfill({
        json: {
          target: {
            groupId: "205678",
            displayTitle: "Media Only [2024]",
            year: "2024",
            imdbId: "tt1234567",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
          }
        }
      });
    });
    await page.route("**/api/intake/jobs", async (route) => {
      requests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() });
      await route.fulfill({
        status: 201,
        json: {
          job: {
            ...apiJobs[0],
            id: "job-media-only",
            candidate: { ...apiJobs[0].candidate!, site: "unknown", title: "Media.Only.2024.1080p.WEB-DL.x265-GROUP" },
            source: {
              site: "unknown",
              title: "Media.Only.2024.1080p.WEB-DL.x265-GROUP",
              mediaPath: "/media/movies/Media.Only.2024.1080p.WEB-DL.x265-GROUP.mkv",
              ptpTarget: {
                groupId: "205678",
                displayTitle: "Media Only [2024]",
                year: "2024",
                imdbId: "tt1234567",
                ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
              }
            }
          }
        }
      });
    });

    await page.goto("/");
    await page.getByRole("link", { name: /New Job/i }).click();
    await page.getByLabel("Server media path").fill("/media/movies/Media.Only.2024.1080p.WEB-DL.x265-GROUP.mkv");
    await page.getByRole("button", { name: "Validate path" }).click();
    await page.getByLabel("PTP URL or Movie ID").fill("https://passthepopcorn.me/torrents.php?id=205678");
    await page.getByLabel("Manual PTP target").getByRole("button", { name: "Confirm", exact: true }).click();

    await expect(page.getByRole("button", { name: "Create Job" })).toBeEnabled();
    await page.getByRole("button", { name: "Create Job" }).click();

    const createRequest = requests.find((request) => request.url.includes("/api/intake/jobs"));
    expect(createRequest?.body).toContain('name="mediaPath"');
    expect(createRequest?.body).not.toContain('name="releaseName"');
    expect(createRequest?.body).not.toContain('name="torrent"');
  });

  test("uses the QUI-style light utility shell", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only style assertion.");
    await page.goto("/");

    await expect(page.locator(".shell")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(page.locator(".sidebar")).toHaveCSS("background-color", "rgb(250, 250, 250)");
    await expect(page.locator(".sidebar nav a.active")).toHaveCSS("background-color", "rgb(36, 36, 36)");
    await expect(page.locator(".table-wrap")).toBeVisible();
  });

  test("colors queue status pills by workflow state", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only style assertion.");
    await page.route("**/api/jobs", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        json: {
          jobs: [
            apiJobs[0],
            { ...apiJobs[1], id: "job-done", state: "done", humanStep: "Upload workflow complete" },
            { ...apiJobs[1], id: "job-preparing", state: "preparing", humanStep: "Preparing upload media" }
          ]
        }
      });
    });
    await page.goto("/");

    await expect(page.locator(".state-pill.review").first()).toHaveCSS("background-color", "rgb(243, 248, 252)");
    await expect(page.locator(".state-pill.done").first()).toHaveCSS("background-color", "rgb(242, 250, 245)");
    await expect(page.locator(".state-pill.preparing").first()).toHaveCSS("background-color", "rgb(255, 248, 239)");
  });

  test("uses compact complete copy and hides complete job actions", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only interaction assertion.");
    const completeJob = {
      ...apiJobs[0],
      id: "job-complete",
      state: "done",
      phase: "done",
      humanStep: "Upload workflow complete",
      uploadReadiness: "ready"
    };
    await page.route("**/api/jobs", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({ json: { jobs: [completeJob, apiJobs[0]] } });
    });

    await page.goto("/");
    const completeRow = page.getByRole("row", { name: /done ATHENA\.2022\.1080p\.WEB\.x265-SMURF/i }).first();
    await expect(completeRow).toContainText("Complete");
    await expect(completeRow.getByRole("button", { name: "Upload", exact: true })).toHaveCount(0);

    await completeRow.click();
    const drawer = page.getByTestId("job-drawer");
    await expect(drawer).toContainText("Complete");
    await expect(drawer.getByRole("button", { name: "Upload", exact: true })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Pause" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(page.locator(".toolbar").getByRole("button", { name: "Pause" })).toHaveCount(0);
    await expect(page.locator(".toolbar").getByRole("button", { name: "Retry failed steps" })).toHaveCount(0);
  });

  test("maps queue action buttons to job state", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only interaction assertion.");
    const reviewJob = { ...apiJobs[0], id: "job-review", artifacts: { ...apiJobs[0].artifacts, releaseName: "REVIEW.2024.1080p.WEB.x265-GROUP" } };
    const failedJob = { ...apiJobs[0], id: "job-failed", state: "failed", phase: "upload", humanStep: "Upload failed", artifacts: { ...apiJobs[0].artifacts, releaseName: "FAILED.2024.1080p.WEB.x265-GROUP" } };
    const preparingJob = { ...apiJobs[1], id: "job-preparing", state: "preparing", humanStep: "Preparing upload media", artifacts: { releaseName: "PREPARING.2024.1080p.WEB.x265-GROUP" } };
    const pausedJob = { ...apiJobs[1], id: "job-paused", state: "paused", humanStep: "Preparing upload media", artifacts: { releaseName: "PAUSED.2024.1080p.WEB.x265-GROUP" } };
    const doneJob = { ...apiJobs[0], id: "job-done", state: "done", phase: "done", humanStep: "Complete", artifacts: { ...apiJobs[0].artifacts, releaseName: "DONE.2024.1080p.WEB.x265-GROUP" } };
    const needsReseedJob = {
      ...apiJobs[0],
      id: "job-needs-reseed",
      state: "needs_reseed",
      phase: "post-hook",
      humanStep: "Needs reseed",
      artifacts: { ...apiJobs[0].artifacts, releaseName: "NEEDS.RESEED.2024.1080p.WEB.x265-GROUP" }
    };
    let retryCalled = false;
    let reseedRetryCalled = false;
    let pauseCalled = false;
    let resumeCalled = false;
    let reviewStartedUpload = false;

    await page.route("**/api/jobs", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({ json: { jobs: [reviewJob, failedJob, needsReseedJob, preparingJob, pausedJob, doneJob] } });
    });
    await page.route("**/api/jobs/job-review/start-upload", async (route) => {
      reviewStartedUpload = true;
      await route.fulfill({ json: { job: reviewJob } });
    });
    await page.route("**/api/jobs/job-failed/retry-failed", async (route) => {
      retryCalled = true;
      await route.fulfill({ json: { job: { ...failedJob, state: "preparing", humanStep: "Preparing upload package" } } });
    });
    await page.route("**/api/jobs/job-needs-reseed/retry-failed", async (route) => {
      reseedRetryCalled = true;
      await route.fulfill({ json: { job: { ...needsReseedJob, state: "seeding", phase: "done", humanStep: "Seeding" } } });
    });
    await page.route("**/api/jobs/job-preparing/pause", async (route) => {
      pauseCalled = true;
      await route.fulfill({ json: { job: { ...preparingJob, state: "paused" } } });
    });
    await page.route("**/api/jobs/job-paused/resume", async (route) => {
      resumeCalled = true;
      await route.fulfill({ json: { job: { ...pausedJob, state: "preparing" } } });
    });

    await page.goto("/");
    const reviewRow = page.getByRole("row", { name: /REVIEW\.2024/ });
    const failedRow = page.getByRole("row", { name: /FAILED\.2024/ });
    const needsReseedRow = page.getByRole("row", { name: /NEEDS\.RESEED\.2024/ });
    const preparingRow = page.getByRole("row", { name: /PREPARING\.2024/ });
    const pausedRow = page.getByRole("row", { name: /PAUSED\.2024/ });
    const doneRow = page.getByRole("row", { name: /DONE\.2024/ });

    await expect(reviewRow.getByRole("button", { name: "Upload", exact: true })).toBeVisible();
    await expect(failedRow.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(needsReseedRow.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(preparingRow.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await expect(pausedRow.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    await expect(doneRow.getByRole("button")).toHaveCount(0);

    await needsReseedRow.click();
    const reseedDrawer = page.getByTestId("job-drawer");
    await expect(reseedDrawer).toContainText("Needs reseed");
    await expect(reseedDrawer.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(reseedDrawer.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
    await expect(page.locator(".toolbar").getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Close job review" }).click();
    await expect(page.getByTestId("job-drawer")).toHaveCount(0);

    await reviewRow.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(page.getByTestId("job-drawer")).toContainText("REVIEW.2024.1080p.WEB.x265-GROUP");
    expect(reviewStartedUpload).toBe(false);
    await page.getByRole("button", { name: "Close job review" }).click();
    await expect(page.getByTestId("job-drawer")).toHaveCount(0);

    await failedRow.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(() => retryCalled).toBe(true);
    await page.getByRole("button", { name: "Close job review" }).click();
    await expect(page.getByTestId("job-drawer")).toHaveCount(0);
    await needsReseedRow.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(() => reseedRetryCalled).toBe(true);
    await page.getByRole("button", { name: "Close job review" }).click();
    await expect(page.getByTestId("job-drawer")).toHaveCount(0);
    await preparingRow.getByRole("button", { name: "Pause", exact: true }).click();
    await expect.poll(() => pauseCalled).toBe(true);
    await page.getByRole("button", { name: "Close job review" }).click();
    await expect(page.getByTestId("job-drawer")).toHaveCount(0);
    await pausedRow.getByRole("button", { name: "Resume", exact: true }).click();
    await expect.poll(() => resumeCalled).toBe(true);
  });

  test("keeps review sections in upload decision order", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only review assertion.");
    await page.goto("/");
    await page.getByRole("link", { name: "ATHENA.2022.1080p.WEB.x265-SMURF" }).click();

    await expect(page.locator('[data-testid="review-panel"] h3').first()).toBeVisible();
    const headings = await page.locator('[data-testid="review-panel"] h3').allTextContents();
    expect(headings).toEqual([
      "Warnings",
      "Duplicate/PTP Result",
      "Source",
      "Screenshots",
      "Upload Draft",
      "Torrent / qB Readiness",
      "Phase Timeline",
      "Recent Job Log"
    ]);
    const drawer = page.getByTestId("job-drawer");
    await expect(drawer.locator(".readiness")).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Close job review" })).toBeVisible();
    await expect(drawer.locator(".job-drawer__title")).toContainText("Review");
    await expect(drawer.getByText("Review screenshots and metadata")).toHaveCount(0);
    await expect(drawer.getByText("Prepare media")).toBeVisible();
    await expect(drawer.getByText("Review required.")).toBeVisible();
    await expect(page.getByTestId("review-panel")).toContainText("Matched PTP movie");
    await expect(page.getByTestId("review-panel").getByRole("link", { name: "Athena AKA Athene [2022]" })).toHaveAttribute("href", "https://passthepopcorn.me/torrents.php?id=123");
    const timelineTop = await page.getByTestId("review-panel").getByRole("heading", { name: "Phase Timeline" }).evaluate((element) => element.getBoundingClientRect().top);
    const logTop = await page.getByTestId("review-panel").getByRole("heading", { name: "Recent Job Log" }).evaluate((element) => element.getBoundingClientRect().top);
    expect(timelineTop).toBeLessThan(logTop);
    const screenshotLink = page.getByTestId("review-panel").getByRole("link", { name: "Shot 1" });
    await expect(screenshotLink).toHaveAttribute("href", "https://example.test/shot1.png");
    await expect(screenshotLink.getByRole("img", { name: "Shot 1" })).toHaveAttribute("src", "https://example.test/medium/shot1.png");
  });

  test("does not render internal screenshot artifact paths as browser image URLs", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only review assertion.");
    await page.unroute("**/api/jobs");
    await page.route("**/api/jobs", async (route) => {
      await route.fulfill({
        json: {
          jobs: [
            {
              ...apiJobs[0],
              artifacts: {
                ...apiJobs[0].artifacts,
                screenshots: ["screenshots/raw/screenshot-01.png"],
                screenshotPreviews: ["screenshots/raw/screenshot-01.png"]
              }
            }
          ]
        }
      });
    });

    await page.goto("/");
    await page.getByRole("link", { name: "ATHENA.2022.1080p.WEB.x265-SMURF" }).click();

    const reviewPanel = page.getByTestId("review-panel");
    await expect(reviewPanel.getByRole("link", { name: "Shot 1" })).toHaveCount(0);
    await expect(reviewPanel.locator('img[src*="screenshots/raw/screenshot-01.png"]')).toHaveCount(0);
    await expect(reviewPanel).toContainText("Screenshots captured locally, waiting for image host upload.");
  });

  test("autosaves upload draft fields and shows source torrent display names", async ({ page }, testInfo) => {
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
    await expect(page.getByTestId("job-drawer").getByRole("button", { name: "Upload", exact: true })).toBeVisible();
    await expect(page.getByTestId("job-drawer").getByRole("button", { name: "Start Upload" })).toHaveCount(0);

    await reviewPanel.getByLabel("Description").fill("Edited release description");
    await reviewPanel.getByLabel("PTP group").fill("456");

    await expect(reviewPanel.getByRole("button", { name: "Save draft" })).toHaveCount(0);
    await expect
      .poll(() => savedPatch, { timeout: 2500 })
      .toMatchObject({ description: "Edited release description", groupId: "456" });
    await expect(reviewPanel.getByText("Saved", { exact: true })).toBeVisible();
  });

  test("uses friendly torrent readiness labels and links the PTP result", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only review assertion.");
    const ptpUrl = "https://passthepopcorn.me/torrents.php?id=322761&torrentid=1515743";
    const sourceTorrentPath = "/var/lib/popcorn-queue/data/jobs/job-white/torrent/source.torrent";
    await page.route("**/api/jobs", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        json: {
          jobs: [
            {
              ...apiJobs[0],
              source: { ...apiJobs[0].source, title: "White.Fox.2023.1080p.WEB.x265.HDR-PTerWEB" },
              candidate: { ...apiJobs[0].candidate!, title: "White.Fox.2023.1080p.WEB.x265.HDR-PTerWEB" },
              torrent: { ...apiJobs[0].torrent!, filename: "source.torrent", filePath: sourceTorrentPath },
              artifacts: {
                ...apiJobs[0].artifacts,
                releaseName: "White.Fox.2023.1080p.WEB.x265.HDR-PTerWEB",
                ptpUrl,
                qbReady: true
              }
            }
          ]
        }
      });
    });

    await page.goto("/");
    await page.getByRole("link", { name: "White.Fox.2023.1080p.WEB.x265.HDR-PTerWEB" }).click();
    const reviewPanel = page.getByTestId("review-panel");

    await expect(reviewPanel).toContainText(sourceTorrentPath);
    await expect(reviewPanel).toContainText("qBittorrent seeding");
    await expect(reviewPanel).toContainText("Ready to seed");
    await expect(reviewPanel).not.toContainText("qB handoff");
    await expect(reviewPanel.getByRole("link", { name: ptpUrl })).toHaveAttribute("href", ptpUrl);
  });

  test("shows seeding after qBittorrent handoff completes", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only review assertion.");
    const doneJob = {
      ...apiJobs[0],
      state: "done",
      phase: "done",
      humanStep: "Complete",
      artifacts: {
        ...apiJobs[0].artifacts,
        ptpUrl: "https://passthepopcorn.me/torrents.php?id=322761&torrentid=1515743",
        qbReady: true
      },
      downloadStatus: {
        ...apiJobs[0].downloadStatus!,
        state: "stalledUP",
        progress: 1,
        amountLeft: 0,
        uploadSpeed: 0
      },
      phases: [
        ...apiJobs[0].phases,
        { phase: "upload", state: "done", retryCount: 0, message: "PTP upload submitted." },
        { phase: "post-hook", state: "done", retryCount: 0, message: "PTP upload torrent handed to qBittorrent for seeding." },
        { phase: "done", state: "done", retryCount: 0, message: "Complete." }
      ]
    };
    await page.route("**/api/jobs", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({ json: { jobs: [doneJob] } });
    });

    await page.goto("/");
    await page.getByRole("link", { name: "ATHENA.2022.1080p.WEB.x265-SMURF" }).click();
    const reviewPanel = page.getByTestId("review-panel");

    await expect(reviewPanel).toContainText("qBittorrent seeding");
    await expect(reviewPanel).toContainText("Seeding");
    await expect(reviewPanel).not.toContainText("Ready to seed");
  });

  test("flushes pending draft edits before upload", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only review assertion.");
    let savedPatch: Record<string, unknown> | null = null;
    let uploadSawSavedDraft = false;
    await page.route("**/api/jobs/job-athena/review-draft", async (route) => {
      const patch = route.request().postDataJSON() as Record<string, unknown>;
      savedPatch = patch;
      await route.fulfill({ json: { job: { ...apiJobs[0], reviewDraft: { ...apiJobs[0].reviewDraft, ...patch } } } });
    });
    await page.route("**/api/jobs/job-athena/start-upload", async (route) => {
      uploadSawSavedDraft = savedPatch?.description === "Edited immediately before upload";
      await route.fulfill({ json: { job: { ...apiJobs[0], state: "uploading", phase: "upload" } } });
    });
    await page.goto("/");
    await page.getByRole("link", { name: "ATHENA.2022.1080p.WEB.x265-SMURF" }).click();

    await page.getByTestId("review-panel").getByLabel("Description").fill("Edited immediately before upload");
    await page.getByTestId("job-drawer").getByRole("button", { name: "Upload", exact: true }).click();

    await expect.poll(() => uploadSawSavedDraft, { timeout: 2500 }).toBe(true);
  });

  test("shows uploading feedback while PTP upload is pending", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only upload feedback assertion.");
    let releaseUpload!: () => void;
    const uploadPending = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    await page.route("**/api/jobs/job-athena/start-upload", async (route) => {
      await uploadPending;
      await route.fulfill({ json: { job: { ...apiJobs[0], state: "uploading", phase: "upload", humanStep: "Uploading to PTP" } } });
    });

    await page.goto("/");
    await page.getByRole("link", { name: "ATHENA.2022.1080p.WEB.x265-SMURF" }).click();
    await page.getByTestId("job-drawer").getByRole("button", { name: "Upload", exact: true }).click();

    await expect(page.getByTestId("job-drawer").getByRole("button", { name: "Uploading..." })).toBeDisabled();
    await expect(page.getByRole("row", { name: /ATHENA\.2022/ }).getByRole("button", { name: "Uploading..." })).toBeDisabled();
    await expect(page.getByText("Uploading to PTP: ATHENA.2022.1080p.WEB.x265-SMURF")).toBeVisible();

    releaseUpload();
    await expect(page.getByText("Upload: job-athena")).toBeVisible();
  });

  test("shows resume instead of pause for paused jobs", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only review assertion.");
    let resumeCalled = false;
    await page.route("**/api/jobs/job-home/resume", async (route) => {
      resumeCalled = true;
      await route.fulfill({ json: { job: { ...apiJobs[1], state: "preparing", humanStep: "Preparing upload media" } } });
    });
    await page.goto("/");
    await page.getByRole("link", { name: "Home.Sweet.Home.2021.1080p.WEB.x265-TJUPT" }).click();

    await expect(page.getByTestId("job-drawer").getByRole("button", { name: "Start Upload" })).toHaveCount(0);
    await expect(page.getByTestId("job-drawer").getByRole("button", { name: "Pause" })).toHaveCount(0);
    await page.getByTestId("job-drawer").getByRole("button", { name: "Resume" }).click();

    await expect.poll(() => resumeCalled, { timeout: 2500 }).toBe(true);
  });

  test("shows selected job download progress in the review pane", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only review assertion.");
    await page.goto("/");

    await page.getByRole("link", { name: "Home.Sweet.Home.2021.1080p.WEB.x265-TJUPT" }).click();
    const reviewPanel = page.getByTestId("review-panel");

    await expect(reviewPanel.getByRole("heading", { name: "Source" })).toBeVisible();
    await expect(reviewPanel).toContainText("Downloading (42%)");
    await expect(reviewPanel).toContainText("42% - 8.0 MB/s - 12m");
    await expect(reviewPanel).toContainText("4.0 MB / 10.0 MB");
    await expect(reviewPanel).toContainText("HOMEHASH");
  });

  test("keeps mediainfo in the description instead of a separate review section", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only review assertion.");
    await page.goto("/");
    await page.getByRole("link", { name: "ATHENA.2022.1080p.WEB.x265-SMURF" }).click();

    const reviewPanel = page.getByTestId("review-panel");
    await expect(reviewPanel.getByRole("heading", { name: "MediaInfo / BDInfo" })).toHaveCount(0);
    await expect(reviewPanel.getByLabel("Description")).toHaveValue(/General[\s\S]*MediaInfo line 23/);
  });

  test("shows only global diagnostics from the sidebar", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByTestId("diagnostics-panel")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Advance phase" })).toHaveCount(0);

    await page.getByRole("link", { name: /Diagnostics/i }).click();
    await expect(page.getByTestId("diagnostics-panel")).toBeVisible();
    await expect(page.getByRole("button", { name: "Advance phase" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Skip" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Force state" })).toHaveCount(0);
    await expect(page.getByText("Phase list")).toHaveCount(0);
    await expect(page.getByText("System Health")).toBeVisible();
    await expect(page.getByText("Integration Checks")).toBeVisible();
    await expect(page.getByText("Queue Health")).toBeVisible();
    await expect(page.getByText("Storage / Cache")).toBeVisible();
    await expect(page.getByText("API Log")).toBeVisible();
    await expect(page.getByTestId("diagnostic-system-ptp-api")).toHaveText("OK");
    await expect(page.getByTestId("diagnostic-system-ptp-api")).toHaveCSS("color", "rgb(47, 125, 80)");
    await expect(page.getByTestId("diagnostic-system-external-tools")).toHaveText("Disabled");
    await expect(page.getByTestId("diagnostic-system-external-tools")).toHaveCSS("color", "rgb(186, 59, 54)");
    await expect(page.getByText("qB", { exact: true })).toBeVisible();
    await expect(page.getByTestId("diagnostic-check-image-host-status")).toHaveText("OK");
    await expect(page.getByText("imgbb is configured.")).toHaveCount(0);
    await expect(page.getByText("Tool Versions")).toBeVisible();
    await expect(page.getByTestId("diagnostic-tool-ffmpeg")).toContainText("ffmpeg version 6.1");
    await expect(page.getByTestId("diagnostic-tool-mediainfo")).toContainText("/usr/bin/mediainfo");
    await expect(page.getByTestId("diagnostic-tool-mkvmerge")).toContainText("mkvmerge v82.0");
    await expect(page.getByTestId("diagnostic-tool-oxipng-status")).toHaveText("Failed");
    await expect(page.getByTestId("diagnostic-tool-oxipng-status")).toHaveCSS("color", "rgb(186, 59, 54)");
    await expect(page.getByText("Cache entries")).toBeVisible();
    await expect(page.getByText("12", { exact: true })).toBeVisible();
    await expect(page.getByText("api booted")).toBeVisible();
    await expect(page.getByText("worker standby")).toHaveCount(0);
    await expect(page.getByText("Job logs")).toHaveCount(0);

    await page.getByRole("button", { name: "Check qB" }).click();
    await expect(page.getByText("qBittorrent responded.")).toBeVisible();
    await expect(page.getByTestId("diagnostic-check-qbittorrent-status")).toHaveText("OK");
    await expect(page.getByTestId("diagnostic-check-qbittorrent-status")).toHaveCSS("color", "rgb(47, 125, 80)");
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

  test("opens job details on mobile after selecting a job", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "Mobile-only layout assertion.");
    await page.goto("/");

    await expect(page.locator(".brand")).toBeHidden();
    await expect(page.getByTestId("review-panel")).toBeHidden();
    await expect(page.getByPlaceholder("Search jobs, IMDb, source")).toBeVisible();
    await expect(page.getByText("Home.Sweet.Home.2021.1080p.WEB.x265-TJUPT")).toBeVisible();

    await page.getByRole("link", { name: "ATHENA.2022.1080p.WEB.x265-SMURF" }).click();

    await expect(page.getByTestId("job-drawer")).toBeVisible();
    await expect(page.getByTestId("review-panel")).toBeVisible();
    await expect(page.getByTestId("review-panel").getByRole("heading", { name: "Upload Draft" })).toBeVisible();
    await expect(page.getByTestId("review-panel").getByLabel("Description")).toBeVisible();
  });

  test("uses the state-specific mobile row action", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "Mobile-only layout assertion.");
    await page.goto("/");

    const homeRow = page.getByRole("row", { name: /Home\.Sweet\.Home\.2021\.1080p\.WEB\.x265-TJUPT/ });
    await expect(homeRow.getByRole("button", { name: "Details" })).toHaveCount(0);
    const resumeButton = homeRow.getByRole("button", { name: "Resume", exact: true });
    await expect(resumeButton).toBeEnabled();
    const resumeBox = await resumeButton.boundingBox();
    expect(resumeBox).not.toBeNull();
    expect(resumeBox!.x).toBeGreaterThanOrEqual(0);
    expect(resumeBox!.x + resumeBox!.width).toBeLessThanOrEqual(412);
    await resumeButton.click();

    await expect(page.getByTestId("job-drawer")).toBeVisible();
    await expect(page.getByTestId("job-drawer")).toContainText("Home.Sweet.Home.2021.1080p.WEB.x265-TJUPT");
    await expect(page.getByTestId("review-panel").getByRole("heading", { name: "Source" })).toBeVisible();
  });

  test("surfaces API error details on pause actions", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only interaction assertion.");
    await page.route("**/api/jobs/job-athena/pause", async (route) => {
      await route.fulfill({ status: 409, json: { error: "pause_failed" } });
    });
    await page.goto("/");
    await page.getByRole("link", { name: "ATHENA.2022.1080p.WEB.x265-SMURF" }).click();

    await page.getByTestId("job-drawer").getByRole("button", { name: "Pause" }).click();
    await expect(page.locator(".status-banner.error")).toContainText(
      "/api/jobs/job-athena/pause failed with HTTP 409: pause_failed"
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
    checkResult: {
      decision: {
        status: "review",
        reason: "IMDb + resolution match",
        ptpUrl: "https://passthepopcorn.me/torrents.php?id=123",
        movie: { GroupId: "123", Title: "Athena", Name: "Athene", Year: "2022", ImdbId: "tt1234567" }
      }
    },
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
      screenshotPreviews: ["https://example.test/medium/shot1.png", "https://example.test/medium/shot2.png"],
      mediainfo: longMediaInfo,
      releaseName: "ATHENA.2022.1080p.WEB.x265-SMURF",
      description: `${longMediaInfo}\n\n[img]https://example.test/shot1.png[/img]`,
      uploadTorrent: "torrent/upload.torrent",
      qbReady: true
    },
    reviewDraft: {
      releaseName: "ATHENA.2022.1080p.WEB.x265-SMURF",
      description: `${longMediaInfo}\n\n[img]https://example.test/shot1.png[/img]`,
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
      screenshots: { count: 4, imageHosts: ["imgbb", "imgbox"], toneMapHint: "bt709" },
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
    state: "paused",
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
      screenshots: { count: 4, imageHosts: ["imgbb"], toneMapHint: "bt2020" },
      torrentReuse: { strategy: "hash-from-content", preservePieceHashes: false, reason: "No reusable source torrent is available yet." },
      metadata: { imdbId: null, providers: [], tags: ["web-dl"] },
      media: { container: "mkv", discType: "file", audio: { codecs: [], languages: ["English"], commentaryLikely: false }, subtitles: { languages: [], embeddedLikely: false }, trumpableChecks: [] },
      reviewGates: []
    },
    phases: []
  }
];
