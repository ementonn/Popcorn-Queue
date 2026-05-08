import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface TorrentClientAddOptions {
  torrentPath: string;
  downloadPath: string;
  skipHashCheck?: boolean;
  category?: string;
  tags?: string[];
}

export interface TorrentClientFile {
  name: string;
  size: number;
  progress?: number;
}

export interface TorrentClient {
  readonly name: string;
  addTorrent(options: TorrentClientAddOptions): Promise<{ infoHash: string }>;
  isComplete(infoHash: string): Promise<boolean>;
  listFiles(infoHash: string): Promise<TorrentClientFile[]>;
  removeTorrent(infoHash: string, options?: { deleteData?: boolean }): Promise<void>;
}

export class NotConfiguredTorrentClient implements TorrentClient {
  readonly name = "not-configured";

  async addTorrent(): Promise<{ infoHash: string }> {
    throw new Error("Torrent client is not configured.");
  }

  async isComplete(): Promise<boolean> {
    return false;
  }

  async listFiles(): Promise<TorrentClientFile[]> {
    return [];
  }

  async removeTorrent(): Promise<void> {
    return;
  }
}

export interface QBittorrentClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  fetchImpl?: typeof fetch;
}

interface QBittorrentTorrentInfo {
  hash?: string;
  progress?: number;
}

interface QBittorrentTorrentFile {
  name?: string;
  size?: number;
  progress?: number;
}

function readByteString(buffer: Buffer, offset: number): { value: string; start: number; end: number } {
  let colon = offset;
  while (colon < buffer.length && buffer[colon] !== 58) colon += 1;
  if (colon >= buffer.length) throw new Error("Invalid torrent: unterminated byte string length.");
  const length = Number.parseInt(buffer.subarray(offset, colon).toString("ascii"), 10);
  if (!Number.isFinite(length) || length < 0) throw new Error("Invalid torrent: bad byte string length.");
  const start = colon + 1;
  const end = start + length;
  if (end > buffer.length) throw new Error("Invalid torrent: byte string exceeds buffer length.");
  return { value: buffer.subarray(start, end).toString("utf8"), start, end };
}

function skipBencodedValue(buffer: Buffer, offset: number): number {
  const marker = buffer[offset];
  if (marker === undefined) throw new Error("Invalid torrent: unexpected end of buffer.");
  if (marker === 105) {
    const end = buffer.indexOf(101, offset + 1);
    if (end < 0) throw new Error("Invalid torrent: unterminated integer.");
    return end + 1;
  }
  if (marker === 108 || marker === 100) {
    let cursor = offset + 1;
    while (cursor < buffer.length && buffer[cursor] !== 101) cursor = skipBencodedValue(buffer, cursor);
    if (cursor >= buffer.length) throw new Error("Invalid torrent: unterminated collection.");
    return cursor + 1;
  }
  if (marker >= 48 && marker <= 57) return readByteString(buffer, offset).end;
  throw new Error("Invalid torrent: unknown bencode marker.");
}

export function computeTorrentInfoHash(torrent: Buffer): string {
  if (torrent[0] !== 100) throw new Error("Invalid torrent: root value is not a dictionary.");
  let cursor = 1;
  while (cursor < torrent.length && torrent[cursor] !== 101) {
    const key = readByteString(torrent, cursor);
    const valueStart = key.end;
    const valueEnd = skipBencodedValue(torrent, valueStart);
    if (key.value === "info") {
      return createHash("sha1").update(torrent.subarray(valueStart, valueEnd)).digest("hex").toUpperCase();
    }
    cursor = valueEnd;
  }
  throw new Error("Invalid torrent: missing info dictionary.");
}

export class QBittorrentClient implements TorrentClient {
  readonly name = "qbittorrent";
  private cookie: string | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: QBittorrentClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async addTorrent(options: TorrentClientAddOptions): Promise<{ infoHash: string }> {
    await this.login();
    const torrentBytes = await readFile(options.torrentPath);
    const infoHash = computeTorrentInfoHash(torrentBytes);
    const form = new FormData();
    const torrentBuffer = torrentBytes.buffer.slice(torrentBytes.byteOffset, torrentBytes.byteOffset + torrentBytes.byteLength) as ArrayBuffer;
    form.set("torrents", new Blob([torrentBuffer]), path.basename(options.torrentPath));
    form.set("savepath", options.downloadPath);
    if (options.category) form.set("category", options.category);
    if (options.tags?.length) form.set("tags", options.tags.join(","));
    if (options.skipHashCheck !== undefined) form.set("skip_checking", options.skipHashCheck ? "true" : "false");

    const init: RequestInit = {
      method: "POST",
      body: form
    };
    if (this.cookie) init.headers = { cookie: this.cookie };
    const response = await this.fetchImpl(this.url("/api/v2/torrents/add"), init);
    if (!response.ok) throw new Error(`qBittorrent add torrent failed with HTTP ${response.status}.`);
    return { infoHash };
  }

  async hasTorrent(infoHash: string): Promise<boolean> {
    if (!infoHash) return false;
    await this.login();
    const response = await this.fetchImpl(this.url(`/api/v2/torrents/info?hashes=${encodeURIComponent(infoHash)}`), this.cookie ? { headers: { cookie: this.cookie } } : undefined);
    if (!response.ok) throw new Error(`qBittorrent torrent lookup failed with HTTP ${response.status}.`);
    const torrents = (await response.json()) as QBittorrentTorrentInfo[];
    return Array.isArray(torrents) && torrents.length > 0;
  }

  async isComplete(infoHash: string): Promise<boolean> {
    if (!infoHash) return false;
    await this.login();
    const response = await this.fetchImpl(this.url(`/api/v2/torrents/info?hashes=${encodeURIComponent(infoHash)}`), this.cookie ? { headers: { cookie: this.cookie } } : undefined);
    if (!response.ok) throw new Error(`qBittorrent torrent lookup failed with HTTP ${response.status}.`);
    const torrents = (await response.json()) as QBittorrentTorrentInfo[];
    return Array.isArray(torrents) && torrents.some((torrent) => torrent.progress === 1);
  }

  async listFiles(infoHash: string): Promise<TorrentClientFile[]> {
    if (!infoHash) return [];
    await this.login();
    const response = await this.fetchImpl(this.url(`/api/v2/torrents/files?hash=${encodeURIComponent(infoHash)}`), this.cookie ? { headers: { cookie: this.cookie } } : undefined);
    if (!response.ok) throw new Error(`qBittorrent torrent files lookup failed with HTTP ${response.status}.`);
    const files = (await response.json()) as QBittorrentTorrentFile[];
    if (!Array.isArray(files)) return [];
    return files
      .filter((file): file is Required<Pick<QBittorrentTorrentFile, "name" | "size">> & QBittorrentTorrentFile => typeof file.name === "string" && typeof file.size === "number")
      .map((file) => ({
        name: file.name,
        size: file.size,
        ...(typeof file.progress === "number" ? { progress: file.progress } : {})
      }));
  }

  async removeTorrent(infoHash: string, options: { deleteData?: boolean } = {}): Promise<void> {
    if (!infoHash) return;
    await this.login();
    const form = new URLSearchParams();
    form.set("hashes", infoHash);
    form.set("deleteFiles", options.deleteData ? "true" : "false");
    const response = await this.fetchImpl(this.url("/api/v2/torrents/delete"), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(this.cookie ? { cookie: this.cookie } : {})
      },
      body: form
    });
    if (!response.ok) throw new Error(`qBittorrent torrent removal failed with HTTP ${response.status}.`);
  }

  private async login(): Promise<void> {
    if (this.cookie) return;
    if (!this.options.baseUrl) throw new Error("qBittorrent URL is not configured.");
    const form = new URLSearchParams();
    form.set("username", this.options.username);
    form.set("password", this.options.password);
    const response = await this.fetchImpl(this.url("/api/v2/auth/login"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form
    });
    const text = await response.text();
    if (!response.ok || !/ok/i.test(text)) throw new Error(`qBittorrent login failed with HTTP ${response.status}.`);
    this.cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  }

  private url(pathname: string): string {
    const baseUrl = this.options.baseUrl.trim();
    const normalized = /^[a-z][a-z\d+\-.]*:\/\//i.test(baseUrl) ? baseUrl : `http://${baseUrl}`;
    return new URL(pathname, normalized.replace(/\/+$/, "")).toString();
  }
}
