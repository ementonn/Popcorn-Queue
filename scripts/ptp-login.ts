import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { PtpFormSubmitter, type PtpAuthResult, type PtpFormSubmitterConfig } from "../packages/integrations/src/index.js";
import { loadConfig } from "../apps/api/src/config.js";

export interface PtpLoginRunnerConfig {
  ptp: {
    username: string;
    password: string;
    announceUrl: string;
    cookieFile: string;
    baseUrl: string;
    userAgent: string;
  };
}

export interface PtpLoginRunnerOptions {
  config: PtpLoginRunnerConfig;
  output?: (line: string) => void;
  promptTfaCode?: () => Promise<string>;
  createSubmitter?: (config: PtpFormSubmitterConfig) => { authenticate(): Promise<PtpAuthResult> };
}

export function missingPtpLoginConfig(config: PtpLoginRunnerConfig): string[] {
  const missing: string[] = [];
  if (!config.ptp.username) missing.push("PTP_USERNAME");
  if (!config.ptp.password) missing.push("PTP_PASSWORD");
  if (!config.ptp.announceUrl) missing.push("PTP_ANNOUNCE_URL");
  return missing;
}

async function promptTfaCode(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question("PTP 2FA code: ");
  } finally {
    rl.close();
  }
}

export async function runPtpLogin(options: PtpLoginRunnerOptions): Promise<PtpAuthResult> {
  const output = options.output ?? ((line: string) => console.log(line));
  const missing = missingPtpLoginConfig(options.config);
  if (missing.length) throw new Error(`Missing required PTP login settings: ${missing.join(", ")}`);

  const submitterConfig: PtpFormSubmitterConfig = {
    username: options.config.ptp.username,
    password: options.config.ptp.password,
    announceUrl: options.config.ptp.announceUrl,
    baseUrl: options.config.ptp.baseUrl,
    userAgent: options.config.ptp.userAgent,
    tfaCodeProvider: options.promptTfaCode ?? promptTfaCode
  };
  if (options.config.ptp.cookieFile) submitterConfig.cookieFile = options.config.ptp.cookieFile;
  const submitter = options.createSubmitter ? options.createSubmitter(submitterConfig) : new PtpFormSubmitter(submitterConfig);
  const result = await submitter.authenticate();

  output(`PTP login OK (${result.source === "cookie" ? "existing cookie reused" : "session refreshed"}).`);
  output(`Cookie file: ${options.config.ptp.cookieFile || "not configured"}`);
  return result;
}

async function main(): Promise<void> {
  await runPtpLogin({ config: loadConfig(), promptTfaCode });
}

const entrypoint = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === entrypoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
