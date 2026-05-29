import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const userscriptPath = fileURLToPath(new URL("./popcorn-queue-bridge.user.js", import.meta.url));

function userscriptMetadata(): string {
  const text = readFileSync(userscriptPath, "utf8");
  const match = text.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/);
  return match?.[0] ?? "";
}

function connectHosts(): string[] {
  return [...userscriptMetadata().matchAll(/^\/\/ @connect\s+(.+)$/gm)].map((match) => match[1].trim());
}

function userscriptText(): string {
  return readFileSync(userscriptPath, "utf8");
}

function userscriptInternals(overrides: Record<string, unknown> = {}) {
  const text = userscriptText().replace(
    "  registerSettings();",
    "  globalThis.__pqTest = { LOCAL_CACHE_TTL_MS, hasUnsupportedFrameRate, shouldOfferUpload, localCacheKey, localCacheStorageKey, localCacheSet };\n  registerSettings();"
  );
  const sandbox = {
    GM_registerMenuCommand: () => undefined,
    GM_getValue: () => undefined,
    GM_setValue: () => undefined,
    window: { location: { hostname: "example.test" } },
    document: {},
    ...overrides
  };
  vm.createContext(sandbox);
  vm.runInContext(text, sandbox);
  return (sandbox as {
    __pqTest: {
      LOCAL_CACHE_TTL_MS: number;
      hasUnsupportedFrameRate(name: string): boolean;
      shouldOfferUpload(torrent: { title?: string }, status: string): boolean;
      localCacheKey(torrent: { title: string; imdbId?: string | null }): string;
      localCacheStorageKey(cacheKey: string): string;
      localCacheSet(torrent: { title: string; imdbId?: string | null }, result: { decision?: { status?: string }; cache?: { hit?: boolean; key?: string } }): void;
    };
  }).__pqTest;
}

describe("Popcorn Queue userscript metadata", () => {
  it("keeps the committed userscript as a wildcard template", () => {
    expect(userscriptMetadata()).toMatch(/^\/\/ @connect\s+\*$/m);
  });

  it("does not commit concrete userscript connect hosts", () => {
    expect(connectHosts()).toEqual(["*"]);
  });

  it("does not expose runtime URL menu overrides", () => {
    const text = userscriptText();

    expect(text).not.toContain("Set Popcorn Queue API URL");
    expect(text).not.toContain("Set Popcorn Queue Web URL");
    expect(text).not.toContain("GM_setValue(\"serviceUrl\"");
    expect(text).not.toContain("GM_setValue(\"webUrl\"");
  });
});

describe("Popcorn Queue userscript checks", () => {
  it("rechecks only the right-clicked torrent", () => {
    const text = userscriptText();

    expect(text).toContain("await recheckTorrent(site, status, torrent);");
    expect(text).toContain('apiRequest("POST", "/api/browser/check"');
    expect(text).not.toContain("await runCheck(site, status, { bypassCache: true });");
  });

  it("keeps a 180 day local browser-check cache for page-load badges", () => {
    const internals = userscriptInternals();
    const text = userscriptText();

    expect(internals.LOCAL_CACHE_TTL_MS).toBe(180 * 24 * 60 * 60 * 1000);
    expect(internals.localCacheKey({ title: "Interstellar.2014.1080p.BluRay.x264-GROUP", imdbId: "https://www.imdb.com/title/tt0816692/" })).toBe(
      "ptp:imdb:tt0816692"
    );
    expect(internals.localCacheKey({ title: "Interstellar.2014.1080p.BluRay.x264-GROUP", imdbId: null })).toBe("ptp:search:interstellar|2014");
    expect(internals.localCacheStorageKey("ptp:imdb:tt0816692")).toBe("pq:browser-check:ptp:imdb:tt0816692");
    expect(text).toContain("renderCachedBadges(site, status);");
    expect(text).toContain("localCacheSet(torrent, result);");
  });

  it("does not persist uncached PTP error results in local browser-check cache", () => {
    const writes: Array<{ key: string; value: string }> = [];
    const internals = userscriptInternals({
      GM_setValue: (key: string, value: string) => writes.push({ key, value })
    });

    internals.localCacheSet(
      { title: "Interstellar.2014.1080p.BluRay.x264-GROUP", imdbId: "tt0816692" },
      { decision: { status: "error" }, cache: { hit: false, key: "ptp:imdb:tt0816692" } }
    );
    internals.localCacheSet(
      { title: "Interstellar.2014.1080p.BluRay.x264-GROUP", imdbId: "tt0816692" },
      { decision: { status: "open" }, cache: { hit: false, key: "ptp:imdb:tt0816692" } }
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toBe("pq:browser-check:ptp:imdb:tt0816692");
  });
});

describe("Popcorn Queue userscript upload button", () => {
  it("supports right-click upload without opening Popcorn Queue", () => {
    const text = userscriptText();

    expect(text).toContain("Up without open popcorn queue");
    expect(text).toContain('button.addEventListener("contextmenu"');
    expect(text).toContain("await sendJob(torrent, result, button, badge, { openQueue: false });");
    expect(text).toContain("await sendJob(torrent, result, button, badge);");
    expect(text).toContain("if (options.openQueue !== false) window.open(jobUrl(response.job.id), \"_blank\");");
  });

  it("skips upload buttons for release names above 50 fps", () => {
    const internals = userscriptInternals();

    expect(internals.hasUnsupportedFrameRate("Bystander 2025 2160p WEB-DL 60Fps HDRVivid H.265 10bit AAC 2.0-UBWEB")).toBe(true);
    expect(internals.hasUnsupportedFrameRate("Movie 2025 1080p WEB-DL 59.94 FPS H.264-GROUP")).toBe(true);
    expect(internals.hasUnsupportedFrameRate("Movie 2025 1080p WEB-DL 50fps H.264-GROUP")).toBe(false);
    expect(internals.hasUnsupportedFrameRate("Movie 2025 2160p WEB-DL H.265 10bit AAC 2.0-GROUP")).toBe(false);
    expect(internals.shouldOfferUpload({ title: "Bystander 2025 2160p WEB-DL 60Fps HDRVivid H.265 10bit AAC 2.0-UBWEB" }, "open")).toBe(false);
    expect(internals.shouldOfferUpload({ title: "Movie 2025 2160p WEB-DL H.265 10bit AAC 2.0-GROUP" }, "open")).toBe(true);
  });
});
