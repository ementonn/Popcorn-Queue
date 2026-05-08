import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ptpFormFieldsFromDraft, type PtpUploadResult, type ReviewDraft } from "@popcorn-queue/core";

export interface PtpSubmitInput {
  draft: ReviewDraft;
  torrentPath: string;
  nfoText?: string | null;
}

export interface PtpSubmitter {
  submit(input: PtpSubmitInput): Promise<PtpUploadResult>;
}

export interface PtpFormSubmitterConfig {
  username: string;
  password: string;
  announceUrl: string;
  cookieFile?: string;
  baseUrl?: string;
  userAgent?: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

export class PtpSubmitError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
    public readonly retryable = false
  ) {
    super(message);
  }
}

interface LoginResponse {
  Result?: string;
  AntiCsrfToken?: string;
}

const DEFAULT_BASE_URL = "https://passthepopcorn.me";

function csrfFromHtml(html: string): string | null {
  return html.match(/data-AntiCsrfToken=["']([^"']+)["']/i)?.[1] ?? null;
}

function passkeyFromAnnounceUrl(announceUrl: string): string {
  const match = announceUrl.match(/^https?:\/\/please\.passthepopcorn\.me:?\d*\/([^/]+)\/announce/i);
  if (!match?.[1]) {
    throw new PtpSubmitError("Could not extract the PTP passkey from PTP_ANNOUNCE_URL.", null, false);
  }
  return match[1];
}

function splitSetCookieHeader(value: string): string[] {
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g).map((part) => part.trim()).filter(Boolean);
}

function getSetCookies(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const values = withGetSetCookie.getSetCookie?.();
  if (values?.length) return values;
  const combined = headers.get("set-cookie");
  return combined ? splitSetCookieHeader(combined) : [];
}

function cookieHeaderFromSetCookie(values: string[]): string {
  return values.map((value) => value.split(";")[0]?.trim()).filter(Boolean).join("; ");
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function uploadErrorFromHtml(html: string): string | null {
  const alert = html.match(/<div class=["'][^"']*alert--error[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
  return alert ? stripHtml(alert) : null;
}

function parseUploadResult(url: string): PtpUploadResult | null {
  if (!url) return null;
  const match = url.match(/\/torrents\.php\?[^#]*\bid=(\d+)[^#]*\btorrentid=(\d+)/i);
  if (!match?.[1] || !match[2]) return null;
  return {
    groupId: match[1],
    torrentId: match[2],
    ptpUrl: url
  };
}

function appendText(form: FormData, key: string, value: string | null | undefined): void {
  if (value === null || value === undefined || value === "") return;
  form.append(key, value);
}

export class PtpFormSubmitter implements PtpSubmitter {
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(private readonly config: PtpFormSubmitterConfig) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.userAgent = config.userAgent ?? "Popcorn Queue/0.1";
    this.fetchImpl = config.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async submit(input: PtpSubmitInput): Promise<PtpUploadResult> {
    const csrfToken = await this.getCsrfToken();
    const body = await this.buildUploadForm(input, csrfToken);
    const url = this.uploadUrl(input.draft.groupId);
    const response = await this.fetchImpl(url.toString(), {
      method: "POST",
      headers: await this.requestHeaders("text/html,application/xhtml+xml"),
      body
    });
    const responseText = await response.text();

    if (responseText.includes(this.config.announceUrl) || response.url.includes("/upload.php")) {
      const error = uploadErrorFromHtml(responseText) ?? "PTP returned the upload page after submit.";
      throw new PtpSubmitError(`Upload to PTP failed: ${error}`, response.status, response.status >= 500);
    }
    if (!response.ok) {
      throw new PtpSubmitError(`Upload to PTP failed with HTTP ${response.status}.`, response.status, response.status >= 500);
    }

    const result = parseUploadResult(response.url);
    if (!result) {
      throw new PtpSubmitError(`Upload to PTP failed: result URL '${response.url}' is not a PTP torrent URL.`, response.status, false);
    }
    return result;
  }

  private async getCsrfToken(): Promise<string> {
    const uploadResponse = await this.fetchImpl(this.uploadUrl(null).toString(), {
      method: "GET",
      headers: await this.requestHeaders("text/html,application/xhtml+xml")
    });
    const html = await uploadResponse.text();
    const token = csrfFromHtml(html);
    if (token) return token;
    return this.login();
  }

  private async login(): Promise<string> {
    const body = new URLSearchParams({
      username: this.config.username,
      password: this.config.password,
      passkey: passkeyFromAnnounceUrl(this.config.announceUrl),
      keeplogged: "1"
    });
    const response = await this.fetchImpl(new URL("/ajax.php?action=login", this.baseUrl).toString(), {
      method: "POST",
      headers: {
        "User-Agent": this.userAgent,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    const text = await response.text();
    if (text.includes("Intermission") || text.includes("We are in maintenance")) {
      throw new PtpSubmitError("PTP is currently in maintenance mode.", response.status, true);
    }

    let data: LoginResponse;
    try {
      data = JSON.parse(text) as LoginResponse;
    } catch (error) {
      throw new PtpSubmitError(`PTP login returned non-JSON response: ${(error as Error).message}`, response.status, false);
    }

    if (data.Result === "TfaRequired") {
      throw new PtpSubmitError("PTP two-factor authentication is required. Provide a valid cookie file before using automatic upload.", response.status, false);
    }
    if (data.Result !== "Ok" || !data.AntiCsrfToken) {
      throw new PtpSubmitError("PTP login failed; check username, password, passkey, or cookie configuration.", response.status, false);
    }

    await this.persistCookies(response.headers);
    return data.AntiCsrfToken;
  }

  private async buildUploadForm(input: PtpSubmitInput, csrfToken: string): Promise<FormData> {
    const form = new FormData();
    const { fields, missing } = ptpFormFieldsFromDraft(input.draft);
    if (missing.length) {
      throw new PtpSubmitError(`Cannot submit PTP upload draft; missing fields: ${missing.join(", ")}`, null, false);
    }
    for (const [key, value] of fields) appendText(form, key, value);
    appendText(form, "nfo_text", input.nfoText ?? "");
    appendText(form, "AntiCsrfToken", csrfToken);
    const torrent = await readFile(input.torrentPath);
    form.append("file_input", new Blob([torrent], { type: "application/x-bittorrent" }), "placeholder.torrent");
    return form;
  }

  private uploadUrl(groupId: string | null): URL {
    const url = new URL("/upload.php", this.baseUrl);
    if (groupId) url.searchParams.set("groupid", groupId);
    return url;
  }

  private async requestHeaders(accept: string): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      Accept: accept
    };
    const cookie = await this.readCookieHeader();
    if (cookie) headers.Cookie = cookie;
    return headers;
  }

  private async readCookieHeader(): Promise<string | null> {
    if (!this.config.cookieFile) return null;
    try {
      const value = await readFile(this.config.cookieFile, "utf8");
      return value.trim() || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async persistCookies(headers: Headers): Promise<void> {
    if (!this.config.cookieFile) return;
    const cookieHeader = cookieHeaderFromSetCookie(getSetCookies(headers));
    if (!cookieHeader) return;
    await mkdir(path.dirname(this.config.cookieFile), { recursive: true });
    await writeFile(this.config.cookieFile, cookieHeader);
  }
}
