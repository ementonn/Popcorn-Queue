import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSingleFileTorrent, selectPtpPieceLength } from "./torrent-create.js";

function readBencodedInt(buffer: Buffer, key: string): number {
  const needle = Buffer.from(`${Buffer.byteLength(key)}:${key}i`, "utf8");
  const start = buffer.indexOf(needle);
  if (start < 0) throw new Error(`Missing bencode integer key: ${key}`);
  const valueStart = start + needle.length;
  const valueEnd = buffer.indexOf(101, valueStart);
  if (valueEnd < 0) throw new Error(`Unterminated bencode integer key: ${key}`);
  return Number.parseInt(buffer.subarray(valueStart, valueEnd).toString("ascii"), 10);
}

describe("torrent creation", () => {
  it("selects piece lengths in PTP's accepted range", () => {
    expect(selectPtpPieceLength(128 * 1024)).toBe(512 * 1024);
    expect(selectPtpPieceLength(1.35 * 1024 * 1024 * 1024)).toBe(2 * 1024 * 1024);
    expect(selectPtpPieceLength(12 * 1024 * 1024 * 1024)).toBe(4 * 1024 * 1024);
  });

  it("uses PTP-compatible piece metadata instead of a fixed 16 MiB piece length", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-torrent-create-"));
    const mediaPath = path.join(tempDir, "Movie.mkv");
    const torrentPath = path.join(tempDir, "torrent", "upload.torrent");
    await mkdir(path.dirname(torrentPath), { recursive: true });
    await writeFile(mediaPath, Buffer.alloc(128 * 1024));

    await createSingleFileTorrent({
      inputPath: mediaPath,
      outputPath: torrentPath,
      announceUrl: "https://please.passthepopcorn.me/passkey/announce"
    });

    const torrent = await readFile(torrentPath);
    expect(readBencodedInt(torrent, "piece length")).toBe(512 * 1024);
    expect(torrent.toString("binary")).toContain("6:source3:PTP");
  });
});
