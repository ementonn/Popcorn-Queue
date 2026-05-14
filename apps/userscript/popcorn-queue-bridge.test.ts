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

function userscriptInternals() {
  const text = userscriptText().replace(
    "  registerSettings();",
    "  globalThis.__pqTest = { hasUnsupportedFrameRate, shouldOfferUpload };\n  registerSettings();"
  );
  const sandbox = {
    GM_registerMenuCommand: () => undefined,
    GM_getValue: () => undefined,
    GM_setValue: () => undefined,
    window: { location: { hostname: "example.test" } },
    document: {}
  };
  vm.createContext(sandbox);
  vm.runInContext(text, sandbox);
  return (sandbox as { __pqTest: { hasUnsupportedFrameRate(name: string): boolean; shouldOfferUpload(torrent: { title?: string }, status: string): boolean } }).__pqTest;
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
