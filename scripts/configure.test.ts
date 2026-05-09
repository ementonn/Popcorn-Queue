import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configureEnvFile, type ConfigurePromptField } from "./configure.js";

function exampleEnv(): string {
  return [
    "POPCORN_QUEUE_PUBLIC_HOST=localhost",
    "POPCORN_QUEUE_PUBLIC_SCHEME=http",
    "POPCORN_QUEUE_PORT=3500",
    "POPCORN_QUEUE_WEB_PORT=5173",
    "POPCORN_QUEUE_BROWSER_TOKEN=change-me",
    "POPCORN_QUEUE_WEB_AUTH=true",
    "PTP_API_USER=",
    "PTP_API_KEY=",
    "PTP_USERNAME=",
    "PTP_PASSWORD=",
    "PTP_ANNOUNCE_URL=",
    "PTP_COOKIE_FILE=./data/ptp-cookies.txt",
    "POPCORN_QUEUE_IMAGE_HOST=imgbb",
    "IMGBB_API_KEY=",
    "PTPIMG_API_KEY=",
    "QBITTORRENT_URL=",
    "QBITTORRENT_USERNAME=",
    "QBITTORRENT_PASSWORD="
  ].join("\n");
}

describe("configure CLI helpers", () => {
  it("writes a new .env with a generated browser token and masked secret prompts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "popcorn-configure-"));
    const envPath = path.join(directory, ".env");
    const exampleEnvPath = path.join(directory, ".env.example");
    await writeFile(exampleEnvPath, exampleEnv());
    const prompted: Array<{ key: string; secret: boolean; defaultValue: string }> = [];
    const answers: Record<string, string> = {
      PTP_API_USER: "api-user",
      PTP_API_KEY: "api-key",
      PTP_USERNAME: "ptp-user",
      PTP_PASSWORD: "pass with # hash",
      PTP_ANNOUNCE_URL: "https://please.passthepopcorn.me/passkey/announce",
      IMGBB_API_KEY: "imgbb-key"
    };

    const result = await configureEnvFile({
      envPath,
      exampleEnvPath,
      generateToken: () => "generated-browser-token",
      prompt: async (field: ConfigurePromptField) => {
        prompted.push({ key: field.key, secret: field.secret, defaultValue: field.defaultValue });
        return answers[field.key] ?? "";
      }
    });

    const text = await readFile(envPath, "utf8");
    expect(result.backupPath).toBeNull();
    expect(text).toContain("POPCORN_QUEUE_PUBLIC_HOST=localhost");
    expect(text).toContain("POPCORN_QUEUE_PORT=3500");
    expect(text).toContain("POPCORN_QUEUE_BROWSER_TOKEN=generated-browser-token");
    expect(text).toContain("POPCORN_QUEUE_WEB_AUTH=true");
    expect(text).toContain("PTP_API_USER=api-user");
    expect(text).toContain("PTP_USERNAME=ptp-user");
    expect(text).toContain('PTP_PASSWORD="pass with # hash"');
    expect(text).toContain("IMGBB_API_KEY=imgbb-key");
    expect(prompted.find((field) => field.key === "PTP_PASSWORD")).toMatchObject({ secret: true, defaultValue: "" });
    expect(prompted.find((field) => field.key === "POPCORN_QUEUE_BROWSER_TOKEN")).toMatchObject({ secret: true, defaultValue: "generated-browser-token" });
    expect(prompted.find((field) => field.key === "POPCORN_QUEUE_WEB_AUTH")).toMatchObject({ secret: false, defaultValue: "true" });
    expect(prompted.find((field) => field.key === "POPCORN_QUEUE_PUBLIC_HOST")).toMatchObject({ secret: false, defaultValue: "localhost" });
  });

  it("backs up an existing .env and keeps existing values when the user presses enter", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "popcorn-configure-"));
    const envPath = path.join(directory, ".env");
    const exampleEnvPath = path.join(directory, ".env.example");
    await writeFile(exampleEnvPath, exampleEnv());
    await writeFile(envPath, "CUSTOM_VALUE=keep\nPTP_USERNAME=old-user\nPOPCORN_QUEUE_BROWSER_TOKEN=old-token\n");

    const result = await configureEnvFile({
      envPath,
      exampleEnvPath,
      generateToken: () => "new-token",
      now: () => new Date("2026-05-09T07:00:00.000Z"),
      prompt: async () => ""
    });

    const text = await readFile(envPath, "utf8");
    expect(result.backupPath).toBe(path.join(directory, ".env.backup.20260509-070000"));
    expect(await readFile(result.backupPath!, "utf8")).toContain("PTP_USERNAME=old-user");
    expect(text).toContain("CUSTOM_VALUE=keep");
    expect(text).toContain("PTP_USERNAME=old-user");
    expect(text).toContain("POPCORN_QUEUE_BROWSER_TOKEN=old-token");
  });
});
