import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { QBittorrentClient, computeTorrentInfoHash } from "./torrent-clients.js";

describe("QBittorrentClient", () => {
  it("logs in and adds a torrent with a save path", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "popcorn-qb-"));
    const torrentPath = path.join(directory, "upload.torrent");
    await writeFile(torrentPath, "d4:infod6:lengthi5e4:name9:movie.mkvee");
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const call: { url: string; method?: string } = { url: String(input) };
      if (init?.method) call.method = init.method;
      calls.push(call);
      if (String(input).endsWith("/api/v2/auth/login")) return new Response("Ok.", { status: 200, headers: { "set-cookie": "SID=abc" } });
      if (String(input).endsWith("/api/v2/torrents/add")) return new Response("Ok.", { status: 200 });
      return new Response("Not found", { status: 404 });
    };

    const client = new QBittorrentClient({
      baseUrl: "http://127.0.0.1:8080",
      username: "user",
      password: "pass",
      fetchImpl
    });

    await expect(
      client.addTorrent({
        torrentPath,
        downloadPath: "/tmp/media",
        category: "ptp",
        tags: ["ptp", "upload"]
      })
    ).resolves.toMatchObject({ infoHash: expect.stringMatching(/^[A-F0-9]{40}$/) });

    expect(calls.map((call) => call.url)).toEqual(["http://127.0.0.1:8080/api/v2/auth/login", "http://127.0.0.1:8080/api/v2/torrents/add"]);
  });

  it("accepts qBittorrent URLs without an explicit scheme", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      if (String(input).includes("/api/v2/torrents/info")) return Response.json([]);
      return new Response("Ok.", { status: 200, headers: { "set-cookie": "SID=abc" } });
    };

    const client = new QBittorrentClient({
      baseUrl: "127.0.0.1:10049",
      username: "user",
      password: "pass",
      fetchImpl
    });

    await expect(client.hasTorrent("abc")).resolves.toBe(false);
    expect(calls[0]).toBe("http://127.0.0.1:10049/api/v2/auth/login");
    expect(calls[1]).toBe("http://127.0.0.1:10049/api/v2/torrents/info?hashes=abc");
  });

  it("computes torrent info hashes and lists qBittorrent files without external network", async () => {
    const torrent = Buffer.from("d4:infod6:lengthi5e4:name9:movie.mkvee");
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      if (String(input).includes("/api/v2/auth/login")) return new Response("Ok.", { status: 200, headers: { "set-cookie": "SID=abc" } });
      if (String(input).includes("/api/v2/torrents/files")) return Response.json([{ name: "movie.mkv", size: 5, progress: 1 }]);
      return new Response("Not found", { status: 404 });
    };

    const client = new QBittorrentClient({
      baseUrl: "127.0.0.1:10049",
      username: "user",
      password: "pass",
      fetchImpl
    });

    expect(computeTorrentInfoHash(torrent)).toMatch(/^[A-F0-9]{40}$/);
    await expect(client.listFiles("ABC123")).resolves.toEqual([{ name: "movie.mkv", size: 5, progress: 1 }]);
    expect(calls[1]).toBe("http://127.0.0.1:10049/api/v2/torrents/files?hash=ABC123");
  });
});
