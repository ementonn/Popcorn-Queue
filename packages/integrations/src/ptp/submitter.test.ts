import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ReviewDraft } from "@popcorn-queue/core";
import { describe, expect, it } from "vitest";
import { PtpFormSubmitter, PtpSubmitError } from "./submitter.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

const draft: ReviewDraft = {
  releaseName: "Movie.2024.1080p.WEB.x265.HDR-GROUP",
  description: "Release description",
  groupId: "123",
  type: "Feature Film",
  codec: "H.265",
  container: "MKV",
  resolution: "1080p",
  source: "WEB-DL",
  remasterYear: "2024",
  remasterTitle: "Director's Cut",
  subtitles: ["English", "Chinese"],
  trumpable: ["No English subtitles"],
  scene: true,
  personalRip: true,
  internal: false
};

function response(body: string, init: ResponseInit = {}, url = "https://passthepopcorn.me/upload.php"): Response {
  const next = new Response(body, init);
  Object.defineProperty(next, "url", { value: url });
  return next;
}

async function torrentFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ptp-submit-"));
  const torrentPath = path.join(dir, "upload.torrent");
  await writeFile(torrentPath, Buffer.from("d4:infod4:name4:testee"));
  return torrentPath;
}

function createSubmitter(calls: FetchCall[], replies: Response[]) {
  return new PtpFormSubmitter({
    username: "ptp-user",
    password: "ptp-pass",
    announceUrl: "https://please.passthepopcorn.me/passkey/announce",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const reply = replies.shift();
      if (!reply) throw new Error("unexpected fetch");
      return reply;
    }
  });
}

describe("PtpFormSubmitter", () => {
  it("posts an add-format upload with editable review draft fields", async () => {
    const calls: FetchCall[] = [];
    const submitter = createSubmitter(calls, [
      response('<body data-AntiCsrfToken="CSRF"></body>'),
      response("", {}, "https://passthepopcorn.me/torrents.php?id=123&torrentid=456")
    ]);

    const result = await submitter.submit({
      draft,
      torrentPath: await torrentFixture(),
      nfoText: "MediaInfo block"
    });

    expect(result).toEqual({
      groupId: "123",
      torrentId: "456",
      ptpUrl: "https://passthepopcorn.me/torrents.php?id=123&torrentid=456"
    });
    expect(calls[1]?.url).toBe("https://passthepopcorn.me/upload.php?groupid=123");
    const body = calls[1]?.init.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("type")).toBe("Feature Film");
    expect(form.get("groupid")).toBe("123");
    expect(form.get("codec")).toBe("Other");
    expect(form.get("other_codec")).toBe("H.265");
    expect(form.get("container")).toBe("Other");
    expect(form.get("other_container")).toBe("MKV");
    expect(form.get("resolution")).toBe("1080p");
    expect(form.get("source")).toBe("Other");
    expect(form.get("other_source")).toBe("WEB-DL");
    expect(form.get("release_desc")).toBe("Release description");
    expect(form.get("nfo_text")).toBe("MediaInfo block");
    expect(form.get("AntiCsrfToken")).toBe("CSRF");
    expect(form.get("remaster")).toBe("on");
    expect(form.get("remaster_year")).toBe("2024");
    expect(form.get("remaster_title")).toBe("Director's Cut");
    expect(form.get("scene")).toBe("on");
    expect(form.get("internalrip")).toBe("on");
    expect(form.getAll("subtitles[]")).toEqual(["English", "Chinese"]);
    expect(form.getAll("trumpable[]")).toEqual(["No English subtitles"]);
    expect(form.get("file_input")).toBeInstanceOf(Blob);
  });

  it("logs in when no reusable CSRF token is available and persists cookies", async () => {
    const calls: FetchCall[] = [];
    const cookieFile = path.join(await mkdtemp(path.join(os.tmpdir(), "ptp-submit-cookie-")), "cookies.txt");
    const submitter = new PtpFormSubmitter({
      username: "ptp-user",
      password: "ptp-pass",
      announceUrl: "https://please.passthepopcorn.me/passkey/announce",
      cookieFile,
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        if (calls.length === 1) return response("<html>login</html>");
        if (calls.length === 2) {
          return response(JSON.stringify({ Result: "Ok", AntiCsrfToken: "LOGIN-CSRF" }), {
            headers: { "set-cookie": "session=abc; Path=/; HttpOnly" }
          }, "https://passthepopcorn.me/ajax.php?action=login");
        }
        return response("", {}, "https://passthepopcorn.me/torrents.php?id=123&torrentid=456");
      }
    });

    await submitter.submit({ draft, torrentPath: await torrentFixture() });

    expect(calls[1]?.url).toBe("https://passthepopcorn.me/ajax.php?action=login");
    const loginBody = calls[1]?.init.body as URLSearchParams;
    expect(loginBody.get("username")).toBe("ptp-user");
    expect(loginBody.get("password")).toBe("ptp-pass");
    expect(loginBody.get("passkey")).toBe("passkey");
    const uploadBody = calls[2]?.init.body as FormData;
    expect(uploadBody.get("AntiCsrfToken")).toBe("LOGIN-CSRF");
    expect(await readFile(cookieFile, "utf8")).toBe("session=abc");
  });

  it("surfaces PTP upload-page errors without retrying against the real site", async () => {
    const calls: FetchCall[] = [];
    const submitter = createSubmitter(calls, [
      response('<body data-AntiCsrfToken="CSRF"></body>'),
      response(
        '<div class="alert alert--error text--center">No torrent file uploaded.</div> https://please.passthepopcorn.me/passkey/announce',
        { status: 200 }
      )
    ]);

    await expect(submitter.submit({ draft, torrentPath: await torrentFixture() })).rejects.toThrow(PtpSubmitError);
    await expect(submitter.submit({ draft, torrentPath: await torrentFixture() })).rejects.toThrow("unexpected fetch");
  });

  it("fails clearly when PTP asks for two-factor authentication", async () => {
    const calls: FetchCall[] = [];
    const submitter = createSubmitter(calls, [
      response("<html>login</html>"),
      response(JSON.stringify({ Result: "TfaRequired" }), {}, "https://passthepopcorn.me/ajax.php?action=login")
    ]);

    await expect(submitter.submit({ draft, torrentPath: await torrentFixture() })).rejects.toThrow("two-factor");
  });
});
