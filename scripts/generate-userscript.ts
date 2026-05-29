import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../apps/api/src/config.js";

export const SOURCE_CONNECT_HOSTS = [
  "tjupt.org",
  "pterclub.net",
  "zmpt.cc",
  "hdbits.org",
  "hhanclub.net",
  "hhan.club",
  "api.m-team.cc",
  "api.m-team.io",
  "kp.m-team.cc",
  "*.m-team.cc",
  "*.m-team.io"
];

export interface GenerateLocalUserscriptOptions {
  sourceText: string;
  publicApiUrl: string;
  publicWebUrl: string;
}

export function connectHostFromUrl(value: string): string {
  return new URL(value).hostname;
}

export function generateLocalUserscript(options: GenerateLocalUserscriptOptions): string {
  const connectHosts = unique([connectHostFromUrl(options.publicApiUrl), ...SOURCE_CONNECT_HOSTS]);
  const connectMetadata = connectHosts.map((host) => `// @connect      ${host}`).join("\n");

  return replaceDefaultUrl(
    replaceDefaultUrl(
      removeRuntimeUrlMenus(replaceConnectMetadata(options.sourceText, connectMetadata)),
      "DEFAULT_SERVICE_URL",
      options.publicApiUrl
    ),
    "DEFAULT_WEB_URL",
    options.publicWebUrl
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function replaceConnectMetadata(text: string, connectMetadata: string): string {
  return text.replace(/(?:\/\/ @connect\s+.+\n)+(?=\/\/ ==\/UserScript==)/, `${connectMetadata}\n`);
}

function replaceDefaultUrl(text: string, constantName: string, value: string): string {
  const pattern = new RegExp(`const ${constantName} = ".*?";`);
  return text.replace(pattern, `const ${constantName} = ${JSON.stringify(value.replace(/\/+$/, ""))};`);
}

function removeRuntimeUrlMenus(text: string): string {
  return text
    .replace(/    GM_registerMenuCommand\("Set Popcorn Queue API URL"[\s\S]*?    \}\);\n/g, "")
    .replace(/    GM_registerMenuCommand\("Set Popcorn Queue Web URL"[\s\S]*?    \}\);\n/g, "")
    .split("\n")
    .filter((line) => !line.includes("Set Popcorn Queue API URL") && !line.includes("Set Popcorn Queue Web URL"))
    .join("\n");
}

async function main(): Promise<void> {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const sourcePath = path.join(root, "apps/userscript/popcorn-queue-bridge.user.js");
  const outputPath = path.join(root, "apps/userscript/popcorn-queue-bridge.local.user.js");
  const config = loadConfig();
  const sourceText = await readFile(sourcePath, "utf8");
  const localText = generateLocalUserscript({
    sourceText,
    publicApiUrl: config.publicApiUrl,
    publicWebUrl: config.publicWebUrl
  });
  await writeFile(outputPath, localText, "utf8");
  console.log(`Wrote ${outputPath}`);
  console.log(`API URL: ${config.publicApiUrl}`);
  console.log(`Web URL: ${config.publicWebUrl}`);
}

const entrypoint = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === entrypoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
