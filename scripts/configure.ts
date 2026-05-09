import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

export interface ConfigurePromptField {
  key: string;
  label: string;
  secret: boolean;
  defaultValue: string;
}

export interface ConfigureEnvFileOptions {
  envPath: string;
  exampleEnvPath?: string;
  prompt: (field: ConfigurePromptField) => Promise<string>;
  generateToken?: () => string;
  now?: () => Date;
}

export interface ConfigureEnvFileResult {
  envPath: string;
  backupPath: string | null;
}

interface ConfigureField {
  key: string;
  label: string;
  secret?: boolean;
  fallback?: string;
}

const configureFields: ConfigureField[] = [
  { key: "POPCORN_QUEUE_PUBLIC_HOST", label: "Public host", fallback: "localhost" },
  { key: "POPCORN_QUEUE_PUBLIC_SCHEME", label: "Public scheme", fallback: "http" },
  { key: "POPCORN_QUEUE_PORT", label: "API port", fallback: "3500" },
  { key: "POPCORN_QUEUE_WEB_PORT", label: "Web port", fallback: "5173" },
  { key: "POPCORN_QUEUE_BROWSER_TOKEN", label: "Browser token", secret: true },
  { key: "POPCORN_QUEUE_WEB_AUTH", label: "Require web login", fallback: "true" },
  { key: "PTP_API_USER", label: "PTP API user" },
  { key: "PTP_API_KEY", label: "PTP API key", secret: true },
  { key: "PTP_USERNAME", label: "PTP username" },
  { key: "PTP_PASSWORD", label: "PTP password", secret: true },
  { key: "PTP_ANNOUNCE_URL", label: "PTP announce URL", secret: true },
  { key: "PTP_COOKIE_FILE", label: "PTP cookie file", fallback: "./data/ptp-cookies.txt" },
  { key: "POPCORN_QUEUE_IMAGE_HOST", label: "Image host", fallback: "imgbb" },
  { key: "IMGBB_API_KEY", label: "imgbb API key", secret: true },
  { key: "PTPIMG_API_KEY", label: "PTPimg API key", secret: true },
  { key: "QBITTORRENT_URL", label: "qBittorrent URL" },
  { key: "QBITTORRENT_USERNAME", label: "qBittorrent username" },
  { key: "QBITTORRENT_PASSWORD", label: "qBittorrent password", secret: true },
  { key: "QBITTORRENT_TAGS", label: "qBittorrent tags", fallback: "ptp,upload" },
  { key: "QBITTORRENT_CATEGORY", label: "qBittorrent category" }
];

function decodeEnvValue(rawValue: string): string {
  let value = rawValue.trim();
  if (!value) return "";

  const quote = value[0];
  const last = value[value.length - 1];
  if ((quote === "\"" || quote === "'") && last === quote) {
    value = value.slice(1, -1);
    return quote === "\"" ? value.replace(/\\n/g, "\n").replace(/\\"/g, "\"").replace(/\\\\/g, "\\") : value;
  }

  const commentIndex = value.indexOf(" #");
  return (commentIndex >= 0 ? value.slice(0, commentIndex) : value).trim();
}

function parseEnvValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = normalized.slice(0, equalsIndex).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) values.set(key, decodeEnvValue(normalized.slice(equalsIndex + 1)));
  }
  return values;
}

function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, "\\\"")}"`;
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function defaultForField(field: ConfigureField, existing: Map<string, string>, example: Map<string, string>, token: string): string {
  const current = existing.get(field.key);
  if (field.key === "POPCORN_QUEUE_BROWSER_TOKEN") return current && current !== "change-me" ? current : token;
  return current ?? example.get(field.key) ?? field.fallback ?? "";
}

function mergeEnvText(baseText: string, values: Map<string, string>): string {
  const seen = new Set<string>();
  const lines = baseText.split(/\r?\n/).map((rawLine) => {
    const normalized = rawLine.trim().startsWith("export ") ? rawLine.trim().slice(7).trim() : rawLine.trim();
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) return rawLine;
    const key = normalized.slice(0, equalsIndex).trim();
    if (!values.has(key)) return rawLine;
    seen.add(key);
    return `${key}=${formatEnvValue(values.get(key) ?? "")}`;
  });

  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const field of configureFields) {
    if (!seen.has(field.key)) lines.push(`${field.key}=${formatEnvValue(values.get(field.key) ?? "")}`);
  }
  return `${lines.join("\n")}\n`;
}

async function readTextIfExists(filePath: string | undefined): Promise<string> {
  if (!filePath || !existsSync(filePath)) return "";
  return readFile(filePath, "utf8");
}

export async function configureEnvFile(options: ConfigureEnvFileOptions): Promise<ConfigureEnvFileResult> {
  const generateToken = options.generateToken ?? (() => crypto.randomBytes(24).toString("base64url"));
  const now = options.now ?? (() => new Date());
  const existingText = await readTextIfExists(options.envPath);
  const exampleText = await readTextIfExists(options.exampleEnvPath);
  const existing = parseEnvValues(existingText);
  const example = parseEnvValues(exampleText);
  const token = generateToken();
  const nextValues = new Map(existing);

  for (const field of configureFields) {
    const defaultValue = defaultForField(field, existing, example, token);
    const answer = await options.prompt({
      key: field.key,
      label: field.label,
      secret: field.secret ?? false,
      defaultValue
    });
    nextValues.set(field.key, answer.trim() ? answer : defaultValue);
  }

  const backupPath = existingText ? path.join(path.dirname(options.envPath), `.env.backup.${timestamp(now())}`) : null;
  await mkdir(path.dirname(options.envPath), { recursive: true });
  if (backupPath) await copyFile(options.envPath, backupPath);
  await writeFile(options.envPath, mergeEnvText(existingText || exampleText, nextValues), "utf8");
  return { envPath: options.envPath, backupPath };
}

async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  }

  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Interrupted."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          return;
        }
        value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function interactivePrompt(field: ConfigurePromptField): Promise<string> {
  const hint = field.defaultValue ? (field.secret ? " [press Enter to keep/use default]" : ` [${field.defaultValue}]`) : "";
  const question = `${field.label} (${field.key})${hint}: `;
  if (field.secret) return promptHidden(question);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const result = await configureEnvFile({
    envPath: path.resolve(process.cwd(), ".env"),
    exampleEnvPath: path.resolve(process.cwd(), ".env.example"),
    prompt: interactivePrompt
  });
  if (result.backupPath) console.log(`Backed up existing .env to ${result.backupPath}`);
  console.log(`Wrote ${result.envPath}`);
  console.log("Run `npm run ptp:login` to validate PTP login and save a reusable cookie.");
}

const entrypoint = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === entrypoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
