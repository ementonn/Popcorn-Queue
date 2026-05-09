import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const userscriptPath = fileURLToPath(new URL("./popcorn-queue-bridge.user.js", import.meta.url));

function userscriptMetadata(): string {
  const text = readFileSync(userscriptPath, "utf8");
  const match = text.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/);
  return match?.[0] ?? "";
}

describe("Popcorn Queue userscript metadata", () => {
  it("allows a user-configured remote API host", () => {
    expect(userscriptMetadata()).toMatch(/^\/\/ @connect\s+\*$/m);
  });
});
