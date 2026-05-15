import { access } from "node:fs/promises";
import path from "node:path";
import type { JobManifest } from "@popcorn-queue/core";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function missingRestoredFiles(jobPath: string, manifest: JobManifest): Promise<string[]> {
  const relativePaths = [...manifest.uploadFiles];
  if (manifest.torrentFile) relativePaths.push(manifest.torrentFile);
  const missing: string[] = [];
  for (const relativePath of relativePaths) {
    if (!(await pathExists(path.join(jobPath, relativePath)))) missing.push(relativePath);
  }
  return missing;
}
