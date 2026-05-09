import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

function withCleanWorkspacePackages(run: () => void): void {
  const suffix = `dev-resolution-${process.pid}-${randomUUID()}`;
  const backups = [
    "packages/core/dist",
    "packages/integrations/dist",
    "apps/worker/dist"
  ].flatMap((relativePath) => {
    const original = path.join(root, relativePath);
    if (!existsSync(original)) return [];
    const backup = `${original}.${suffix}`;
    renameSync(original, backup);
    return [{ original, backup }];
  });

  try {
    run();
  } finally {
    for (const { original, backup } of backups.reverse()) {
      if (existsSync(backup)) renameSync(backup, original);
    }
  }
}

describe("development package resolution", () => {
  it("passes the development condition through tsx watch scripts", () => {
    const apiPackage = JSON.parse(readFileSync(path.join(root, "apps/api/package.json"), "utf8"));
    const workerPackage = JSON.parse(readFileSync(path.join(root, "apps/worker/package.json"), "utf8"));

    expect(apiPackage.scripts.dev).toBe("tsx watch --conditions development src/index.ts");
    expect(workerPackage.scripts.dev).toBe("tsx watch --conditions development src/index.ts");
  });

  it("loads workspace TypeScript sources without prebuilt dist output", () => {
    withCleanWorkspacePackages(() => {
      const result = spawnSync(
        path.join(root, "node_modules/.bin/tsx"),
        [
          "--conditions",
          "development",
          "-e",
          "await import('@popcorn-queue/integrations'); await import('@popcorn-queue/worker');"
        ],
        {
          cwd: root,
          encoding: "utf8"
        }
      );

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });
  });
});
