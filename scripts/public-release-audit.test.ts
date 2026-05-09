import { describe, expect, it } from "vitest";
import { findPublicIpv4TextMatch, findSensitivePathMatch, findSecretTextMatch } from "./public-release-audit.js";

describe("public release audit helpers", () => {
  it("allows tracked templates and source files", () => {
    expect(findSensitivePathMatch(".env.example")).toBeNull();
    expect(findSensitivePathMatch("logs/.gitkeep")).toBeNull();
    expect(findSensitivePathMatch("packages/integrations/src/torrent-clients.ts")).toBeNull();
  });

  it("flags runtime and private paths", () => {
    expect(findSensitivePathMatch(".env")).toBe(".env");
    expect(findSensitivePathMatch(".env.backup")).toBe(".env");
    expect(findSensitivePathMatch(".env.backup.20260509-070000")).toBe(".env");
    expect(findSensitivePathMatch("data/jobs/job-1/movie.mkv")).toBe("data/");
    expect(findSensitivePathMatch("logs/api.log")).toBe("logs/");
    expect(findSensitivePathMatch("popcorn-queue.db")).toBe("*.db");
    expect(findSensitivePathMatch("cookies/ptp-cookies.txt")).toBe("cookie");
    expect(findSensitivePathMatch("upload/source.torrent")).toBe("*.torrent");
  });

  it("allows empty example settings", () => {
    expect(findSecretTextMatch(".env.example", "PTP_API_KEY=")).toBeNull();
    expect(findSecretTextMatch(".env.example", "QBITTORRENT_PASSWORD=")).toBeNull();
    expect(findSecretTextMatch("README.md", "PTP_API_KEY=your-key")).toBeNull();
    expect(findSecretTextMatch("apps/api/src/config.test.ts", 'PTP_USERNAME: "ptp-username",')).toBeNull();
    expect(findSecretTextMatch("packages/core/src/log-redaction.test.ts", "authorization: REDACTED_TEXT,")).toBeNull();
    expect(findSecretTextMatch("packages/core/src/log-redaction.test.ts", 'Cookie: "session=secret",')).toBeNull();
    expect(findSecretTextMatch("apps/userscript/popcorn-queue-bridge.user.js", 'const auth = localStorage.getItem("auth") || "";')).toBeNull();
    expect(findSecretTextMatch("apps/worker/src/torrent-create.ts", "announce: options.announceUrl,")).toBeNull();
    expect(findSecretTextMatch("packages/integrations/src/ptp/submitter.ts", "passkey: passkeyFromAnnounceUrl(this.config.announceUrl),")).toBeNull();
  });

  it("allows explicit audit fixture files", () => {
    const fakeKey = "abc123".repeat(3);
    expect(findSecretTextMatch("scripts/public-release-audit.test.ts", `PTP_API_KEY=${fakeKey}`)).toBeNull();
    expect(findSecretTextMatch("README.md", `expect(findSecretTextMatch(".env", "PTP_API_KEY=${fakeKey}")).toContain("PTP_API_KEY");`)).toBeNull();
  });

  it("flags likely committed secrets", () => {
    expect(findSecretTextMatch(".env", `PTP_API_KEY=${"abc123".repeat(3)}`)).toContain("PTP_API_KEY");
    expect(findSecretTextMatch(".env", "PTP_PASSWORD=not-a-real-password-but-secret")).toContain("PTP_PASSWORD");
    expect(findSecretTextMatch(".env", "IMGBB_API_KEY=0123456789abcdef0123456789abcdef")).toContain("IMGBB_API_KEY");
    expect(findSecretTextMatch("config.yml", "passkey: 0123456789abcdef0123456789abcdef")).toContain("passkey");
  });

  it("flags public IP addresses while allowing local and documentation addresses", () => {
    const publicIp = ["8", "8", "8", "8"].join(".");
    expect(findPublicIpv4TextMatch("README.md", `API: http://${publicIp}:3500`)).toContain(publicIp);
    expect(findPublicIpv4TextMatch("README.md", "API: http://127.0.0.1:3500")).toBeNull();
    expect(findPublicIpv4TextMatch("README.md", "API: http://0.0.0.0:3500")).toBeNull();
    expect(findPublicIpv4TextMatch("README.md", "API: http://192.168.1.10:3500")).toBeNull();
    expect(findPublicIpv4TextMatch("README.md", "API: http://203.0.113.10:3500")).toBeNull();
  });
});
