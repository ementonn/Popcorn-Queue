import { describe, expect, it } from "vitest";
import { redactForLog, REDACTED_TEXT } from "./log-redaction.js";

describe("log redaction", () => {
  it("redacts nested secrets before logs are written", () => {
    const redacted = redactForLog({
      authorization: "Bearer browser-secret",
      ptp: { apiKey: "ptp-key", password: "ptp-password" },
      integrations: { imgbbApiKey: "imgbb-key", qbittorrentPassword: "qb-password" },
      safe: "visible"
    });

    expect(JSON.stringify(redacted)).not.toContain("browser-secret");
    expect(JSON.stringify(redacted)).not.toContain("ptp-key");
    expect(JSON.stringify(redacted)).not.toContain("imgbb-key");
    expect(redacted).toMatchObject({
      authorization: REDACTED_TEXT,
      ptp: { apiKey: REDACTED_TEXT, password: REDACTED_TEXT },
      integrations: { imgbbApiKey: REDACTED_TEXT, qbittorrentPassword: REDACTED_TEXT },
      safe: "visible"
    });
  });
});
