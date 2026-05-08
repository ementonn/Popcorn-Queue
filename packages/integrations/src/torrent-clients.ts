import { readFile } from "node:fs/promises";
import path from "node:path";

export interface TorrentClientAddOptions {
  torrentPath: string;
  downloadPath: string;
  skipHashCheck?: boolean;
  category?: string;
  tags?: string[];
}

export interface TorrentClient {
  readonly name: string;
  addTorrent(options: TorrentClientAddOptions): Promise<{ infoHash: string }>;
  isComplete(infoHash: string): Promise<boolean>;
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

export class QBittorrentClient implements TorrentClient {
  readonly name = "qbittorrent";
  private cookie: string | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: QBittorrentClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async addTorrent(options: TorrentClientAddOptions): Promise<{ infoHash: string }> {
    await this.login();
    const form = new FormData();
    const torrentBytes = await readFile(options.torrentPath);
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
    return { infoHash: "" };
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
    return new URL(pathname, this.options.baseUrl.replace(/\/+$/, "")).toString();
  }
}
