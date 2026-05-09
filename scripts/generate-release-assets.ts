import { chromium, type Browser, type Page, type Route } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173";
const assetsDir = path.join(rootDir, "docs", "assets");
const webIconPath = path.join(rootDir, "apps", "web", "public", "icon.svg");

const longMediaInfo = Array.from({ length: 26 }, (_, index) => (index === 0 ? "General" : `MediaInfo line ${index}`)).join("\n");
const shotUrls = [
  "https://assets.popcorn.test/shot-1.svg",
  "https://assets.popcorn.test/shot-2.svg",
  "https://assets.popcorn.test/shot-3.svg"
];

const reviewJob = {
  id: "job-athena",
  state: "review",
  phase: "review",
  uploadReadiness: "ready",
  humanStep: "Review screenshots and metadata",
  updatedAt: "2026-05-09T00:00:00.000Z",
  source: { site: "PTer", title: "ATHENA.2022.1080p.WEB-DL.x265-SMURF" },
  candidate: { site: "pter", title: "ATHENA.2022.1080p.WEB-DL.x265-SMURF", imdbId: "tt1234567" },
  checkResult: { decision: { status: "open", reason: "1080p HDR x265 slot is open.", ptpUrl: "https://passthepopcorn.me/torrents.php?id=123456" } },
  torrent: { filename: "ATHENA.2022.PTer.source.torrent", bytes: 6_871_947_673, filePath: "/data/torrents/ATHENA.2022.PTer.source.torrent" },
  downloadStatus: {
    client: "qbittorrent",
    infoHash: "ATHENA1234567890",
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
    contentPath: "/downloads/ATHENA.2022.1080p.WEB-DL.x265-SMURF.mkv",
    lastUpdatedAt: "2026-05-09T00:00:00.000Z",
    error: null
  },
  artifacts: {
    mediaFiles: ["media/upload/ATHENA.2022.1080p.WEB.x265-SMURF.mkv"],
    screenshots: shotUrls,
    mediainfo: longMediaInfo,
    mediaInfoText: longMediaInfo,
    releaseName: "ATHENA.2022.1080p.WEB.x265-SMURF",
    description: `${longMediaInfo}\n\n${shotUrls.map((url) => `[img]${url}[/img]`).join("\n")}`,
    uploadTorrent: "torrent/upload.torrent",
    qbReady: true
  },
  reviewDraft: {
    releaseName: "ATHENA.2022.1080p.WEB.x265-SMURF",
    description: `${longMediaInfo}\n\n${shotUrls.map((url) => `[img]${url}[/img]`).join("\n")}`,
    groupId: "123456",
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
    releaseName: { generated: "ATHENA.2022.1080p.WEB.x265-SMURF", group: "SMURF", container: "mkv", warnings: [] },
    screenshots: { count: 6, imageHosts: ["imgbb"], toneMapHint: "bt709" },
    torrentReuse: { strategy: "source", preservePieceHashes: true, reason: "Source torrent can be reused." },
    metadata: { imdbId: "tt1234567", providers: [], tags: ["web-dl", "hdr"] },
    media: {
      container: "mkv",
      discType: "file",
      audio: { codecs: ["E-AC-3"], languages: ["English"], commentaryLikely: false },
      subtitles: { languages: ["English"], embeddedLikely: true },
      trumpableChecks: []
    },
    reviewGates: []
  },
  phases: [
    { phase: "intake", state: "done", retryCount: 0, message: "Torrent metadata received." },
    { phase: "download", state: "done", retryCount: 0, message: "qBittorrent download complete." },
    { phase: "prepare-media", state: "done", retryCount: 0, message: "Media prepared for upload." },
    { phase: "review", state: "blocked", retryCount: 0, message: "Ready for operator review." }
  ]
};

const jobs = [
  reviewJob,
  {
    ...reviewJob,
    id: "job-home",
    state: "paused",
    phase: "download",
    uploadReadiness: "missing_evidence",
    humanStep: "Downloading source media",
    source: { site: "M-Team", title: "Home.Sweet.Home.2021.1080p.WEB-DL.HDR.H265-TJUPT" },
    candidate: { site: "mteam", title: "Home.Sweet.Home.2021.1080p.WEB-DL.HDR.H265-TJUPT", imdbId: "tt7654321" },
    downloadStatus: {
      ...reviewJob.downloadStatus,
      infoHash: "HOME1234567890",
      state: "downloading",
      progress: 0.42,
      downloaded: 4_194_304_000,
      size: 10_485_760_000,
      amountLeft: 6_291_456_000,
      downloadSpeed: 8_388_608,
      uploadSpeed: 0,
      eta: 720,
      seeds: 12,
      peers: 3,
      contentPath: "/downloads/Home.Sweet.Home.2021.1080p.WEB-DL.HDR.H265-TJUPT.mkv"
    },
    artifacts: {
      mediaFiles: [],
      screenshots: [],
      releaseName: "Home.Sweet.Home.2021.1080p.WEB.x265-TJUPT",
      qbReady: false
    },
    reviewDraft: undefined,
    phases: [{ phase: "download", state: "running", retryCount: 0, message: "Downloading from qBittorrent." }]
  },
  {
    ...reviewJob,
    id: "job-white-fox",
    state: "done",
    phase: "done",
    uploadReadiness: "ready",
    humanStep: "Complete",
    source: { site: "PTer", title: "White.Fox.2023.1080p.WEB.x265.HDR-PTerWEB" },
    candidate: { site: "pter", title: "White.Fox.2023.1080p.WEB.x265.HDR-PTerWEB", imdbId: "tt2345678" },
    artifacts: {
      ...reviewJob.artifacts,
      releaseName: "White.Fox.2023.1080p.WEB.x265.HDR-PTerWEB",
      ptpUrl: "https://passthepopcorn.me/torrents.php?id=322761&torrentid=1515743"
    },
    reviewDraft: {
      ...reviewJob.reviewDraft,
      releaseName: "White.Fox.2023.1080p.WEB.x265.HDR-PTerWEB"
    },
    phases: [...reviewJob.phases, { phase: "done", state: "done", retryCount: 0, message: "Complete." }]
  }
];

const health = {
  ok: true,
  ptpConfigured: true,
  browserTokenConfigured: true,
  publicWebUrl: baseUrl,
  publicApiUrl: "http://127.0.0.1:3500",
  external: {
    imageHost: "imgbb",
    imgbbConfigured: true,
    torrentClientConfigured: true,
    externalToolsEnabled: true
  }
};

const diagnostics = {
  system: {
    api: "online",
    persistence: "sqlite",
    publicWebUrl: baseUrl,
    publicApiUrl: "http://127.0.0.1:3500",
    browserBridgeConfigured: true,
    ptpApiConfigured: true,
    externalToolsEnabled: true
  },
  integrations: {
    qbittorrent: { configured: true, status: "ok", detail: "qBittorrent responded." },
    ptp: { configured: true, status: "ok", detail: "PTP API credentials are configured." },
    imageHost: { configured: true, status: "ok", detail: "Image host is configured." },
    tools: { configured: true, status: "ok", detail: "External tools are enabled." }
  },
  queue: {
    total: 3,
    preparing: 0,
    review: 1,
    failed: 0,
    done: 1,
    paused: 1,
    uploading: 0,
    seeding: 1,
    needsReseed: 0,
    stuck: [],
    recentFailures: []
  },
  storage: {
    dataRoot: "/home/emt/ptp/popcorn-queue/data",
    databasePath: "/home/emt/ptp/popcorn-queue/popcorn-queue.db",
    jobCount: 3,
    cacheEntries: 128,
    databaseBytes: 1_048_576,
    dataRootFreeBytes: 512_000_000_000
  },
  tools: {
    ffmpeg: { tool: "ffmpeg", command: "ffmpeg", available: true, version: "ffmpeg version 6.1", location: "/usr/bin/ffmpeg", error: null },
    mediainfo: { tool: "mediainfo", command: "mediainfo", available: true, version: "MediaInfoLib - v24.01", location: "/usr/bin/mediainfo", error: null },
    mkvmerge: { tool: "mkvmerge", command: "mkvmerge", available: true, version: "mkvmerge v82.0", location: "/usr/bin/mkvmerge", error: null },
    oxipng: { tool: "oxipng", command: "oxipng", available: true, version: "oxipng 9.1.2", location: "/usr/bin/oxipng", error: null }
  },
  logs: {
    api: ["api booted", "loaded persistent queue", "browser bridge ready", "review draft autosaved"]
  }
};

function screenshotSvg(index: number): string {
  const colors = [
    ["#f8d06b", "#2b3443"],
    ["#d74a3f", "#f6efe2"],
    ["#7f9bb7", "#fff6d7"]
  ][index % 3] ?? ["#f8d06b", "#2b3443"];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540">
    <defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient></defs>
    <rect width="960" height="540" fill="url(#g)"/>
    <rect x="54" y="52" width="852" height="436" rx="28" fill="#fffdf7" opacity=".16"/>
    <circle cx="${260 + index * 70}" cy="${180 + index * 34}" r="72" fill="#fffdf7" opacity=".18"/>
    <rect x="112" y="376" width="${620 - index * 70}" height="22" rx="11" fill="#fffdf7" opacity=".24"/>
    <rect x="112" y="420" width="${430 + index * 90}" height="18" rx="9" fill="#fffdf7" opacity=".18"/>
  </svg>`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function isServerReady(): Promise<boolean> {
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await isServerReady()) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${baseUrl}`);
}

async function ensureWebServer(): Promise<ChildProcess | null> {
  if (await isServerReady()) return null;
  const child = spawn("npm", ["--workspace", "@popcorn-queue/web", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"], {
    cwd: rootDir,
    stdio: "inherit",
    env: { ...process.env, BROWSER: "none" }
  });
  await waitForServer();
  return child;
}

async function routeMocks(page: Page): Promise<void> {
  await page.route("**/api/jobs", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fulfill({ json: { job: reviewJob } });
      return;
    }
    await route.fulfill({ json: { jobs } });
  });
  await page.route("**/api/health", async (route) => route.fulfill({ json: health }));
  await page.route("**/api/logs/global", async (route) => route.fulfill({ json: { api: diagnostics.logs.api } }));
  await page.route("**/api/diagnostics", async (route) => route.fulfill({ json: diagnostics }));
  await page.route("**/api/diagnostics/check/*", async (route) => route.fulfill({ json: { target: "tools", configured: true, status: "ok", detail: "OK", tools: diagnostics.tools } }));
  await page.route("**/api/jobs/*/logs", async (route) => route.fulfill({ json: { lines: ["download complete", "media prepared", "review package ready"] } }));
  await page.route("**/api/jobs/*/review-draft", async (route) => {
    const patch = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: { job: { ...reviewJob, reviewDraft: { ...reviewJob.reviewDraft, ...patch } } } });
  });
  await page.route("https://assets.popcorn.test/**", async (route: Route) => {
    const match = route.request().url().match(/shot-(\d+)/);
    const index = Number(match?.[1] ?? 1) - 1;
    await route.fulfill({ contentType: "image/svg+xml", body: screenshotSvg(index) });
  });
}

async function captureAppScreenshots(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await routeMocks(page);

  await page.goto(baseUrl);
  await page.getByRole("columnheader", { name: "Release" }).waitFor();
  await page.screenshot({ path: path.join(assetsDir, "screenshot-dashboard.png") });

  await page.getByRole("link", { name: "ATHENA.2022.1080p.WEB.x265-SMURF" }).click();
  await page.getByTestId("job-drawer").waitFor();
  await page.screenshot({ path: path.join(assetsDir, "screenshot-job-review.png") });

  await page.getByRole("button", { name: "Close job review" }).click();
  await page.getByRole("link", { name: "Diagnostics" }).first().click();
  await page.getByTestId("diagnostics-panel").waitFor();
  await page.screenshot({ path: path.join(assetsDir, "screenshot-diagnostics.png") });

  await context.close();
}

async function captureSocialPreview(browser: Browser): Promise<void> {
  const icon = Buffer.from(await readFile(webIconPath)).toString("base64");
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0;
            width: 1280px;
            height: 640px;
            display: grid;
            place-items: center;
            background: #f4f1ea;
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            color: #202020;
          }
          .frame {
            width: 1180px;
            height: 540px;
            display: grid;
            grid-template-columns: 330px 1fr;
            align-items: center;
            gap: 54px;
            border: 1px solid #ded8cd;
            border-radius: 34px;
            background: #fffefa;
            box-shadow: 0 24px 70px rgb(35 35 35 / 14%);
            padding: 64px 78px;
          }
          img {
            width: 280px;
            height: 280px;
            border-radius: 58px;
            box-shadow: 0 18px 40px rgb(35 35 35 / 16%);
          }
          h1 {
            margin: 0;
            color: #1e1e1e;
            font-size: 86px;
            font-weight: 780;
            line-height: .95;
            letter-spacing: 0;
          }
          p {
            max-width: 680px;
            margin: 28px 0 0;
            color: #5f656c;
            font-size: 34px;
            line-height: 1.22;
            font-weight: 520;
          }
          .chips {
            display: flex;
            gap: 14px;
            margin-top: 42px;
          }
          .chip {
            border: 1px solid #d8d2c8;
            border-radius: 999px;
            background: #faf7ef;
            padding: 12px 18px;
            color: #2c3440;
            font-size: 22px;
            font-weight: 700;
          }
        </style>
      </head>
      <body>
        <div class="frame">
          <img src="data:image/svg+xml;base64,${icon}" alt="" />
          <main>
            <h1>Popcorn Queue</h1>
            <p>A focused PTP upload queue for review, screenshots, MediaInfo, and qBittorrent handoff.</p>
            <div class="chips">
              <span class="chip">PTP workflow</span>
              <span class="chip">Operator review</span>
              <span class="chip">TypeScript</span>
            </div>
          </main>
        </div>
      </body>
    </html>`);
  await page.screenshot({ path: path.join(assetsDir, "social-preview.png") });
  await page.close();
}

async function main(): Promise<void> {
  await mkdir(assetsDir, { recursive: true });
  const server = await ensureWebServer();
  const browser = await chromium.launch();
  try {
    await captureAppScreenshots(browser);
    await captureSocialPreview(browser);
  } finally {
    await browser.close();
    if (server) server.kill("SIGTERM");
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
