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
