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

  it("redacts common secret keys regardless of casing", () => {
    const redacted = redactForLog({
      ApiKey: "ptp-key",
      Authorization: "Bearer browser-secret",
      Cookie: "session=secret",
      safe: "visible"
    });

    expect(redacted).toEqual({
      ApiKey: REDACTED_TEXT,
      Authorization: REDACTED_TEXT,
      Cookie: REDACTED_TEXT,
      safe: "visible"
    });
  });

  it("redacts cookie-bearing key variants", () => {
    const redacted = redactForLog({
      "Set-Cookie": "session=secret",
      sessionCookie: "session-secret",
      safe: "visible"
    });

    expect(redacted).toEqual({
      "Set-Cookie": REDACTED_TEXT,
      sessionCookie: REDACTED_TEXT,
      safe: "visible"
    });
  });

  it("redacts arrays recursively", () => {
    const redacted = redactForLog([
      { Authorization: "Bearer browser-secret" },
      { nested: [{ ApiKey: "ptp-key" }, { safe: "visible" }] }
    ]);

    expect(redacted).toEqual([
      { Authorization: REDACTED_TEXT },
      { nested: [{ ApiKey: REDACTED_TEXT }, { safe: "visible" }] }
    ]);
  });

  it("does not mutate input objects", () => {
    const input = {
      ApiKey: "ptp-key",
      nested: [{ Authorization: "Bearer browser-secret" }]
    };

    const redacted = redactForLog(input);

    expect(redacted).toEqual({
      ApiKey: REDACTED_TEXT,
      nested: [{ Authorization: REDACTED_TEXT }]
    });
    expect(input).toEqual({
      ApiKey: "ptp-key",
      nested: [{ Authorization: "Bearer browser-secret" }]
    });
  });

  it("redacts secret query parameters inside URL strings", () => {
    const redacted = redactForLog({
      feedUrl: "https://zmpt.cc/torrentrss.php?passkey=feed-secret&rows=10",
      nested: {
        downloadUrl: "https://zmpt.cc/download.php?downhash=download-secret"
      }
    });

    expect(JSON.stringify(redacted)).not.toContain("feed-secret");
    expect(JSON.stringify(redacted)).not.toContain("download-secret");
    expect(redacted).toMatchObject({
      feedUrl: "https://zmpt.cc/torrentrss.php?passkey=%5Bredacted%5D&rows=10",
      nested: {
        downloadUrl: "https://zmpt.cc/download.php?downhash=%5Bredacted%5D"
      }
    });
  });
});
