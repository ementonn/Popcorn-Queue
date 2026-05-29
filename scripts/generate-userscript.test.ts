import { describe, expect, it } from "vitest";
import { generateLocalUserscript, connectHostFromUrl } from "./generate-userscript.js";

const sourceText = [
  "// ==UserScript==",
  "// @name         Popcorn Queue Bridge",
  "// @namespace    https://popcorn-queue.local/",
  "// @grant        GM_xmlhttpRequest",
  "// @connect      *",
  "// ==/UserScript==",
  "",
  "(function () {",
  "  const DEFAULT_SERVICE_URL = \"http://localhost:3500\";",
  "  const DEFAULT_WEB_URL = \"http://localhost:5173\";",
  "  GM_registerMenuCommand(\"Set Popcorn Queue API URL\", () => {});",
  "  GM_registerMenuCommand(\"Set Popcorn Queue Web URL\", () => {});",
  "  getSetting(\"browserToken\", \"\");",
  "})();",
  ""
].join("\n");

function connectHosts(text: string): string[] {
  return [...text.matchAll(/^\/\/ @connect\s+(.+)$/gm)].map((match) => match[1].trim());
}

describe("local userscript generation", () => {
  it("uses concrete connect hosts and configured default URLs", () => {
    const text = generateLocalUserscript({
      sourceText,
      publicApiUrl: "http://queue.example.test:3500",
      publicWebUrl: "http://queue.example.test:5173"
    });

    expect(connectHosts(text)).toContain("queue.example.test");
    expect(connectHosts(text)).toContain("tjupt.org");
    expect(connectHosts(text)).toContain("zmpt.cc");
    expect(connectHosts(text)).toContain("api.m-team.io");
    expect(connectHosts(text)).not.toContain("*");
    expect(text).toContain('const DEFAULT_SERVICE_URL = "http://queue.example.test:3500";');
    expect(text).toContain('const DEFAULT_WEB_URL = "http://queue.example.test:5173";');
  });

  it("removes URL menu overrides so generated defaults are authoritative", () => {
    const text = generateLocalUserscript({
      sourceText,
      publicApiUrl: "http://queue.example.test:3500",
      publicWebUrl: "http://queue.example.test:5173"
    });

    expect(text).not.toContain("Set Popcorn Queue API URL");
    expect(text).not.toContain("Set Popcorn Queue Web URL");
    expect(text).toContain('getSetting("browserToken", "")');
  });

  it("deduplicates the API host when it is also a built-in connect host", () => {
    const text = generateLocalUserscript({
      sourceText,
      publicApiUrl: "https://api.m-team.io:3500",
      publicWebUrl: "https://api.m-team.io:5173"
    });

    expect(connectHosts(text).filter((host) => host === "api.m-team.io")).toHaveLength(1);
  });

  it("extracts connect hosts from URLs", () => {
    expect(connectHostFromUrl("http://127.0.0.1:3500")).toBe("127.0.0.1");
    expect(connectHostFromUrl("https://queue.example.test/api")).toBe("queue.example.test");
  });
});
