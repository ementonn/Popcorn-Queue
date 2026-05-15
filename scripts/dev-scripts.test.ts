import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

function readPackage(relativePath: string): { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

describe("development scripts", () => {
  it("generates Prisma client before starting the API dev server", () => {
    const apiPackage = readPackage("apps/api/package.json");

    expect(apiPackage.scripts?.dev).toBe("npm run prisma:generate && tsx watch --conditions development src/index.ts");
  });

  it("exposes a command for refreshing the known scene group cache", () => {
    const rootPackage = readPackage("package.json");

    expect(rootPackage.scripts?.["scene-groups:update"]).toBe("tsx scripts/update-scene-groups.ts");
  });
});
