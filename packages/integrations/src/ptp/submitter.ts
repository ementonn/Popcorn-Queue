import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ptpFormFieldsFromDraft, type PtpArtistDraft, type PtpUploadResult, type ReviewDraft } from "@popcorn-queue/core";

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
  tfaCodeProvider?: () => Promise<string>;
}

export interface PtpAuthResult {
  csrfToken: string;
  source: "cookie" | "login";
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

interface PtpTorrentInfoMovie {
  title?: unknown;
  year?: unknown;
  art?: unknown;
  plot?: unknown;
  tags?: unknown;
  director?: unknown;
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

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeImdbForPtpAjax(value: string | null | undefined): string | null {
  const match = value?.match(/(?:tt)?(\d+)/i);
  return match?.[1] ? match[1].padStart(7, "0") : null;
}

function maybeMaximizedPosterUrl(value: unknown): string {
  const url = stringValue(value);
  if (!url) return "";
  const match = url.match(/(.+?\._V1).*\.jpg/i);
  return match?.[1] ? `${match[1]}_SY768_.jpg` : url;
}

function ptpArtistDrafts(value: unknown): PtpArtistDraft[] {
  if (!Array.isArray(value)) return [];
  const artists: PtpArtistDraft[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const name = stringValue((item as { name?: unknown }).name);
    if (name) artists.push({ name, importance: "1" });
  }
  return artists;
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
    const { csrfToken } = await this.authenticate();
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

  async authenticate(): Promise<PtpAuthResult> {
    const uploadResponse = await this.fetchImpl(this.uploadUrl(null).toString(), {
      method: "GET",
      headers: await this.requestHeaders("text/html,application/xhtml+xml")
    });
    const html = await uploadResponse.text();
    const token = csrfFromHtml(html);
    if (token) return { csrfToken: token, source: "cookie" };
    return this.login();
  }

  private async login(): Promise<PtpAuthResult> {
    const body = new URLSearchParams({
      username: this.config.username,
      password: this.config.password,
      passkey: passkeyFromAnnounceUrl(this.config.announceUrl),
      keeplogged: "1"
    });
    let response = await this.fetchImpl(new URL("/ajax.php?action=login", this.baseUrl).toString(), {
      method: "POST",
      headers: this.loginHeaders(),
      body
    });
    let data = await this.parseLoginResponse(response);

    if (data.Result === "TfaRequired") {
      if (!this.config.tfaCodeProvider) {
        throw new PtpSubmitError("PTP two-factor authentication is required. Run `npm run ptp:login` to create a reusable cookie file before using automatic upload.", response.status, false);
      }
      const tfaCode = (await this.config.tfaCodeProvider()).trim();
      if (!tfaCode) throw new PtpSubmitError("PTP two-factor authentication code was empty.", response.status, false);
      body.set("TfaCode", tfaCode);
      body.set("TfaType", "normal");
      response = await this.fetchImpl(new URL("/ajax.php?action=login", this.baseUrl).toString(), {
        method: "POST",
        headers: this.loginHeaders(),
        body
      });
      data = await this.parseLoginResponse(response);
    }
    if (data.Result !== "Ok" || !data.AntiCsrfToken) {
      throw new PtpSubmitError("PTP login failed; check username, password, passkey, or cookie configuration.", response.status, false);
    }

    await this.persistCookies(response.headers);
    return { csrfToken: data.AntiCsrfToken, source: "login" };
  }

  private loginHeaders(): Record<string, string> {
    return {
      "User-Agent": this.userAgent,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    };
  }

  private async parseLoginResponse(response: Response): Promise<LoginResponse> {
    const text = await response.text();
    if (text.includes("Intermission") || text.includes("We are in maintenance")) {
      throw new PtpSubmitError("PTP is currently in maintenance mode.", response.status, true);
    }

    try {
      return JSON.parse(text) as LoginResponse;
    } catch (error) {
      throw new PtpSubmitError(`PTP login returned non-JSON response: ${(error as Error).message}`, response.status, false);
    }
  }

  private async buildUploadForm(input: PtpSubmitInput, csrfToken: string): Promise<FormData> {
    const form = new FormData();
    const draft = await this.draftWithPtpImdbInfo(input.draft);
    const { fields, missing } = ptpFormFieldsFromDraft(draft);
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

  private async draftWithPtpImdbInfo(draft: ReviewDraft): Promise<ReviewDraft> {
    if (draft.groupId) return draft;
    const imdb = normalizeImdbForPtpAjax(draft.imdb);
    if (!imdb) return draft;

    const needsLookup = !draft.title?.trim()
      || !draft.year?.trim()
      || !draft.tags?.trim()
      || !draft.synopsis?.trim()
      || !draft.image?.trim()
      || !(draft.artists?.length);
    if (!needsLookup) return draft;

    const info = await this.fetchPtpTorrentInfo(imdb);
    if (!info) return draft;
    const artists = draft.artists?.length ? draft.artists : ptpArtistDrafts(info.director);
    return {
      ...draft,
      title: draft.title?.trim() || stringValue(info.title),
      year: draft.year?.trim() || stringValue(info.year),
      image: draft.image?.trim() || maybeMaximizedPosterUrl(info.art),
      tags: draft.tags?.trim() || stringValue(info.tags),
      synopsis: draft.synopsis?.trim() || stringValue(info.plot),
      artists
    };
  }

  private async fetchPtpTorrentInfo(imdb: string): Promise<PtpTorrentInfoMovie | null> {
    const url = new URL("/ajax.php", this.baseUrl);
    url.searchParams.set("action", "torrent_info");
    url.searchParams.set("imdb", imdb);
    const response = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: await this.requestHeaders("application/json")
    });
    const text = await response.text();
    if (text.includes("Intermission") || text.includes("We are in maintenance")) {
      throw new PtpSubmitError("PTP is currently in maintenance mode.", response.status, true);
    }
    if (!response.ok) {
      throw new PtpSubmitError(`Could not load PTP IMDb metadata; HTTP ${response.status}.`, response.status, response.status >= 500);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new PtpSubmitError(`Could not parse PTP IMDb metadata: ${(error as Error).message}`, response.status, false);
    }
    if (!Array.isArray(data) || data.length !== 1) {
      throw new PtpSubmitError("Could not load PTP IMDb metadata; unexpected response shape.", response.status, false);
    }
    const movie = data[0];
    if (!movie || typeof movie !== "object") {
      throw new PtpSubmitError("Could not load PTP IMDb metadata; no movie info was returned.", response.status, false);
    }
    return movie as PtpTorrentInfoMovie;
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
