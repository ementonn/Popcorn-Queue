import { describe, expect, it } from "vitest";
import { missingPtpLoginConfig, runPtpLogin, type PtpLoginRunnerConfig } from "./ptp-login.js";

function config(overrides: Partial<PtpLoginRunnerConfig["ptp"]> = {}): PtpLoginRunnerConfig {
  return {
    ptp: {
      username: "ptp-user",
      password: "ptp-password",
      announceUrl: "https://please.passthepopcorn.me/passkey/announce",
      cookieFile: "./data/ptp-cookies.txt",
      baseUrl: "https://passthepopcorn.me/torrents.php",
      userAgent: "Popcorn Queue Test",
      ...overrides
    }
  };
}

describe("ptp login CLI helpers", () => {
  it("reports missing required login settings", () => {
    expect(missingPtpLoginConfig(config({ username: "", password: "", announceUrl: "" }))).toEqual(["PTP_USERNAME", "PTP_PASSWORD", "PTP_ANNOUNCE_URL"]);
  });

  it("authenticates through the submitter without printing sensitive values", async () => {
    const output: string[] = [];
    await runPtpLogin({
      config: config(),
      output: (line) => output.push(line),
      createSubmitter: (submitterConfig) => ({
        async authenticate() {
          expect(submitterConfig.username).toBe("ptp-user");
          expect(submitterConfig.password).toBe("ptp-password");
          expect(submitterConfig.announceUrl).toContain("passkey");
          return { csrfToken: "CSRF", source: "login" as const };
        }
      })
    });

    const text = output.join("\n");
    expect(text).toContain("PTP login OK");
    expect(text).toContain("Cookie file: ./data/ptp-cookies.txt");
    expect(text).not.toContain("ptp-password");
    expect(text).not.toContain("passkey");
    expect(text).not.toContain("CSRF");
  });
});
