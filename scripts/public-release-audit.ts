import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const secretValuePattern = String.raw`["']?([A-Za-z0-9_./:+@%=-]{12,})["']?`;

const secretPatterns = [
  new RegExp(String.raw`\b(PTP_API_KEY|PTP_PASSWORD|PTP_USERNAME|IMGBB_API_KEY|TMDB_API_KEY|PTPIMG_API_KEY|QBITTORRENT_PASSWORD|POPCORN_QUEUE_BROWSER_TOKEN)\s*[:=]\s*${secretValuePattern}`, "i"),
  new RegExp(String.raw`\b(passkey|announce|cookie|session|auth|authorization)\s*[:=]\s*${secretValuePattern}`, "i")
];

const safeValuePattern = /^(|change-me|your-[a-z-]+|redacted|redacted_text|ptp-username|ptp-password|ptp-api-key|qb-password|imgbb-key|tmdb-key)$/i;

const textAuditFixturePaths = new Set([
  "scripts/public-release-audit.test.ts",
  "packages/core/src/log-redaction.test.ts",
  "docs/superpowers/plans/2026-05-09-public-github-release.md"
]);

const binaryExtensions = new Set([
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".webp"
]);

const sensitivePathRules: Array<{ label: string; test: (filePath: string) => boolean }> = [
  { label: ".env", test: (filePath) => filePath === ".env" || filePath.endsWith("/.env") },
  { label: "data/", test: (filePath) => filePath === "data" || filePath.startsWith("data/") },
  { label: "logs/", test: (filePath) => filePath.startsWith("logs/") && filePath !== "logs/.gitkeep" },
  { label: "node_modules/", test: (filePath) => filePath === "node_modules" || filePath.includes("/node_modules/") || filePath.startsWith("node_modules/") },
  { label: "test-results/", test: (filePath) => filePath === "test-results" || filePath.startsWith("test-results/") },
  { label: "*.db", test: (filePath) => /\.db(-.+)?$/i.test(filePath) },
  { label: "*.torrent", test: (filePath) => /\.torrent$/i.test(filePath) },
  { label: "cookie", test: (filePath) => /cookie|cookies/i.test(filePath) },
  { label: "config.yml", test: (filePath) => /(^|\/)config\.ya?ml$/i.test(filePath) }
];

function normalizeFilePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function runGit(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
}

function trackedFilesAtRevision(revision: string): string[] {
  return runGit(["ls-tree", "-r", "--name-only", revision]).split("\n").filter(Boolean);
}

function currentTrackedFiles(): string[] {
  return runGit(["ls-files"]).split("\n").filter(Boolean);
}

function allRevisions(): string[] {
  return runGit(["rev-list", "--all"]).split("\n").filter(Boolean);
}

function shouldSkipTextAudit(filePath: string): boolean {
  const normalized = normalizeFilePath(filePath);
  return textAuditFixturePaths.has(normalized) || binaryExtensions.has(path.extname(normalized).toLowerCase());
}

export function findSensitivePathMatch(filePath: string): string | null {
  const normalized = normalizeFilePath(filePath);
  if (normalized === ".env.example") return null;
  for (const rule of sensitivePathRules) {
    if (rule.test(normalized)) return rule.label;
  }
  return null;
}

export function findSecretTextMatch(filePath: string, text: string): string | null {
  const normalized = normalizeFilePath(filePath);
  if (shouldSkipTextAudit(normalized)) return null;

  const unsafeLine = text.split(/\r?\n/).find((line) => lineHasUnsafeSecret(line));
  return unsafeLine ? unsafeLine.trim() : null;
}

function lineHasUnsafeSecret(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;

  for (const pattern of secretPatterns) {
    const match = pattern.exec(trimmed);
    if (!match) continue;
    const value = (match[2] ?? "").replace(/["',]+$/g, "");
    if (isSafeSecretValue(value, trimmed)) return false;
    return true;
  }

  return false;
}

function isSafeSecretValue(value: string, line: string): boolean {
  const trimmed = value.trim();
  if (safeValuePattern.test(trimmed)) return true;
  if (line.includes(`${trimmed}(`)) return true;
  if (/[()]/.test(trimmed)) return true;
  if (/^(localStorage|options|this|response|config|process|request|headers)\./i.test(trimmed)) return true;
  return false;
}

function auditCurrentFiles(): string[] {
  const findings: string[] = [];
  for (const filePath of currentTrackedFiles()) {
    const pathMatch = findSensitivePathMatch(filePath);
    if (pathMatch) findings.push(`tracked path ${filePath} matches ${pathMatch}`);

    try {
      const text = readFileSync(filePath, "utf8");
      const secretMatch = findSecretTextMatch(filePath, text);
      if (secretMatch) findings.push(`tracked text ${filePath} contains ${secretMatch}`);
    } catch {
      continue;
    }
  }
  return findings;
}

function auditHistoryPaths(): string[] {
  const findings = new Set<string>();
  for (const revision of allRevisions()) {
    for (const filePath of trackedFilesAtRevision(revision)) {
      const pathMatch = findSensitivePathMatch(filePath);
      if (pathMatch) findings.add(`history path ${filePath} matches ${pathMatch}`);
    }
  }
  return [...findings];
}

function fileTextAtRevision(revision: string, filePath: string): string | null {
  try {
    return runGit(["show", `${revision}:${filePath}`]);
  } catch {
    return null;
  }
}

function auditHistoryText(): string[] {
  const findings = new Set<string>();
  for (const revision of allRevisions()) {
    for (const filePath of trackedFilesAtRevision(revision)) {
      const text = fileTextAtRevision(revision, filePath);
      if (!text) continue;
      const secretMatch = findSecretTextMatch(filePath, text);
      if (secretMatch) findings.add(`history text ${filePath} contains ${secretMatch}`);
    }
  }
  return [...findings];
}

function main(): void {
  const findings = [...auditCurrentFiles(), ...auditHistoryPaths(), ...auditHistoryText()];
  if (findings.length) {
    console.error("Public release audit failed:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log("Public release audit passed.");
}

const entrypoint = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === entrypoint) main();
