import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const PTP_MIN_PIECE_LENGTH = 512 * 1024;
const PTP_MAX_PIECE_LENGTH = 4 * 1024 * 1024;

type BencodeValue = string | number | Buffer | BencodeValue[] | { [key: string]: BencodeValue };

export interface CreateSingleFileTorrentOptions {
  inputPath: string;
  outputPath: string;
  announceUrl: string;
  pieceLength?: number;
  createdBy?: string;
}

export function selectPtpPieceLength(totalSize: number): number {
  const target = 2 ** (Math.floor(Math.log2(Math.max(1, totalSize))) - 9);
  return Math.min(PTP_MAX_PIECE_LENGTH, Math.max(PTP_MIN_PIECE_LENGTH, target));
}

function encodeBencode(value: BencodeValue): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`, "ascii"), value]);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([Buffer.from(`${bytes.length}:`, "ascii"), bytes]);
  }
  if (typeof value === "number") return Buffer.from(`i${Math.trunc(value)}e`, "ascii");
  if (Array.isArray(value)) return Buffer.concat([Buffer.from("l", "ascii"), ...value.map(encodeBencode), Buffer.from("e", "ascii")]);

  const keys = Object.keys(value).sort((a, b) => Buffer.from(a, "utf8").compare(Buffer.from(b, "utf8")));
  const parts: Buffer[] = [Buffer.from("d", "ascii")];
  for (const key of keys) {
    parts.push(encodeBencode(key), encodeBencode(value[key]!));
  }
  parts.push(Buffer.from("e", "ascii"));
  return Buffer.concat(parts);
}

async function hashTorrentPieces(inputPath: string, pieceLength: number): Promise<Buffer> {
  const hashes: Buffer[] = [];
  let pending = Buffer.alloc(0);

  for await (const chunk of createReadStream(inputPath, { highWaterMark: pieceLength })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;

    while (pending.length >= pieceLength) {
      hashes.push(createHash("sha1").update(pending.subarray(0, pieceLength)).digest());
      pending = pending.subarray(pieceLength);
    }
  }

  if (pending.length > 0) hashes.push(createHash("sha1").update(pending).digest());
  return Buffer.concat(hashes);
}

export async function createSingleFileTorrent(options: CreateSingleFileTorrentOptions): Promise<void> {
  const file = await stat(options.inputPath);
  const pieceLength = options.pieceLength ?? selectPtpPieceLength(file.size);
  const torrent = encodeBencode({
    announce: options.announceUrl,
    "created by": options.createdBy ?? "Popcorn Queue/0.1",
    "creation date": Math.floor(Date.now() / 1000),
    info: {
      length: file.size,
      name: path.basename(options.inputPath),
      "piece length": pieceLength,
      pieces: await hashTorrentPieces(options.inputPath, pieceLength),
      private: 1,
      source: "PTP"
    }
  });

  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, torrent);
}
