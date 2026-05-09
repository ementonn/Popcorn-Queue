import { access, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyRequest } from "fastify";
import {
  buildJobWorkspacePaths,
  normalizeImdbId,
  mediaTitleFromPath,
  parseTorrentTitle,
  ptpTargetFromMovie,
  VIDEO_FILE_EXTENSIONS,
  type BrowserCheckResult,
  type ManualIntakePtpTarget,
  type MediaPathValidationResult,
  type PtpMovieSearchResponse,
  type TorrentCandidate
} from "@popcorn-queue/core";
import type { PtpClient } from "@popcorn-queue/integrations";
import type { AttachWorkspaceInput, Job } from "./jobs.js";

type MaybePromise<T> = T | Promise<T>;

export interface IntakeTorrentInput {
  filename: string;
  bytes: Buffer;
  contentType?: string;
  sourceUrl?: string;
}

export interface ManualIntakeInput {
  mediaPath?: string;
  releaseName: string;
  ptpTarget: ManualIntakePtpTarget;
  torrent?: IntakeTorrentInput;
}

export interface ManualPtpTargetResolveInput {
  ptpUrl?: string;
  imdbUrl?: string;
}

interface ManualIntakeJobRepository {
  createFromBrowser(input: {
    candidate?: TorrentCandidate;
    checkResult?: BrowserCheckResult;
    torrent?: Job["torrent"];
    sourceUrl?: string;
    sourceSite?: string;
    title?: string;
  }): MaybePromise<Job>;
  attachWorkspace(id: string, input: AttachWorkspaceInput): MaybePromise<Job | null>;
}

interface MultipartPart {
  type: "file" | "field";
  fieldname: string;
  filename?: string;
  mimetype?: string;
  value?: unknown;
  file?: AsyncIterable<Buffer | Uint8Array>;
}

type MultipartRequest = FastifyRequest & {
  isMultipart?: () => boolean;
  parts: () => AsyncIterable<MultipartPart>;
};

export class IntakeError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}

export async function validateMediaPath(mediaPath: string): Promise<MediaPathValidationResult> {
  const basename = mediaPath ? path.basename(mediaPath) : "";
  if (!mediaPath) return { ok: false, mediaPath, basename, kind: "missing", size: null, error: "media_path_required", warning: null };
  if (!path.isAbsolute(mediaPath)) {
    return { ok: false, mediaPath, basename, kind: "relative", size: null, error: "absolute_media_path_required", warning: null };
  }

  try {
    await access(mediaPath);
    const info = await stat(mediaPath);
    if (info.isDirectory()) {
      return { ok: true, mediaPath, basename, kind: "directory", size: null, error: null, warning: "media_path_is_directory" };
    }
    if (!info.isFile()) return { ok: false, mediaPath, basename, kind: "unsupported", size: null, error: "media_path_must_be_file", warning: null };
    if (!VIDEO_FILE_EXTENSIONS.has(path.extname(mediaPath).toLowerCase())) {
      return { ok: false, mediaPath, basename, kind: "unsupported", size: info.size, error: "unsupported_media_extension", warning: null };
    }
    return { ok: true, mediaPath, basename, kind: "file", size: info.size, error: null, warning: null };
  } catch {
    return { ok: false, mediaPath, basename, kind: "unreadable", size: null, error: "media_path_unreadable", warning: null };
  }
}

export async function searchPtpMovies(input: { title?: string; mediaPath?: string }, ptpClient: PtpClient): Promise<PtpMovieSearchResponse> {
  const title = (input.title?.trim() || (input.mediaPath ? mediaTitleFromPath(input.mediaPath) : "")).trim();
  if (!title) return { query: "", parsedYear: null, results: [] };

  const parsed = parseTorrentTitle(title);
  const response = await ptpClient.searchByCandidate({
    title,
    searchName: parsed.searchName,
    ...(parsed.year ? { year: parsed.year } : {})
  });

  return {
    query: parsed.searchName,
    parsedYear: parsed.year ?? null,
    results: response.movies.flatMap((movie) => {
      const target = ptpTargetFromMovie(movie);
      return target ? [target] : [];
    })
  };
}

function extractPtpMovieId(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    return url.searchParams.get("id")?.match(/^\d+$/)?.[0] ?? null;
  } catch {
    return trimmed.match(/[?&]id=(\d+)/i)?.[1] ?? null;
  }
}

export async function resolveManualPtpTarget(input: ManualPtpTargetResolveInput, ptpClient: PtpClient): Promise<ManualIntakePtpTarget> {
  const ptpUrl = input.ptpUrl?.trim() ?? "";
  const imdbUrl = input.imdbUrl?.trim() ?? "";
  if (Boolean(ptpUrl) === Boolean(imdbUrl)) throw new IntakeError("choose_one_ptp_or_imdb_url");

  const response = ptpUrl
    ? await ptpClient.getGroup(extractPtpMovieId(ptpUrl) ?? invalidManualTarget("invalid_ptp_movie_url_or_id"))
    : await ptpClient.searchByImdb(normalizeImdbId(imdbUrl) ?? invalidManualTarget("invalid_imdb_url"));

  const target = response.movies.flatMap((movie) => {
    const candidate = ptpTargetFromMovie(movie);
    return candidate ? [candidate] : [];
  })[0];
  if (!target) throw new IntakeError("ptp_target_not_found", 404);
  return target;
}

function invalidManualTarget(message: string): never {
  throw new IntakeError(message);
}

export function looksLikeTorrent(bytes: Buffer): boolean {
  return bytes.length > 0 && bytes[0] === 0x64 && bytes.includes(Buffer.from("4:info"));
}

function safeFilename(value: string | null | undefined, fallback = "source.torrent"): string {
  const basename = path.basename((value ?? "").trim());
  return basename || fallback;
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) return decodeURIComponent(encoded.replace(/^"|"$/g, ""));
  return value.match(/filename="([^"]+)"/i)?.[1] ?? value.match(/filename=([^;]+)/i)?.[1]?.trim() ?? null;
}

function filenameFromTorrentUrl(torrentUrl: string, response: Response): string {
  const headerName = filenameFromContentDisposition(response.headers.get("content-disposition"));
  if (headerName) return safeFilename(headerName);
  const parsed = new URL(torrentUrl);
  return safeFilename(decodeURIComponent(parsed.pathname), "source.torrent");
}

export async function downloadTorrentFromUrl(torrentUrl: string, fetchImpl: typeof fetch): Promise<IntakeTorrentInput> {
  let url: URL;
  try {
    url = new URL(torrentUrl);
  } catch {
    throw new IntakeError("invalid_torrent_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new IntakeError("unsupported_torrent_url_scheme");

  const response = await fetchImpl(url);
  if (!response.ok) throw new IntakeError("torrent_url_download_failed", 502);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!looksLikeTorrent(bytes)) throw new IntakeError("invalid_torrent_file");
  const contentType = response.headers.get("content-type") ?? undefined;
  return {
    filename: filenameFromTorrentUrl(torrentUrl, response),
    bytes,
    ...(contentType ? { contentType } : {}),
    sourceUrl: torrentUrl
  };
}

function parsePtpTarget(value: unknown): ManualIntakePtpTarget {
  const parsed = typeof value === "string" ? JSON.parse(value) as Partial<ManualIntakePtpTarget> : value as Partial<ManualIntakePtpTarget>;
  if (!parsed?.groupId || !parsed.ptpUrl || !parsed.displayTitle) throw new IntakeError("ptp_target_required");
  return {
    groupId: String(parsed.groupId),
    displayTitle: String(parsed.displayTitle),
    year: parsed.year ? String(parsed.year) : null,
    imdbId: parsed.imdbId ? String(parsed.imdbId) : null,
    ptpUrl: String(parsed.ptpUrl)
  };
}

async function torrentFromUploadedPart(part: MultipartPart): Promise<IntakeTorrentInput> {
  const chunks: Buffer[] = [];
  if (!part.file) throw new IntakeError("torrent_file_required");
  for await (const chunk of part.file) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  if (!looksLikeTorrent(bytes)) throw new IntakeError("invalid_torrent_file");
  return {
    filename: safeFilename(part.filename),
    bytes,
    ...(part.mimetype ? { contentType: part.mimetype } : {})
  };
}

async function readMultipartManualIntakeRequest(request: MultipartRequest, fetchImpl: typeof fetch): Promise<ManualIntakeInput> {
  const fields: Record<string, string> = {};
  let torrent: IntakeTorrentInput | null = null;

  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (part.fieldname === "torrent") torrent = await torrentFromUploadedPart(part);
    } else {
      fields[part.fieldname] = String(part.value ?? "");
    }
  }

  if (!torrent && fields.torrentUrl) torrent = await downloadTorrentFromUrl(fields.torrentUrl, fetchImpl);
  return normalizeManualIntakeInput({
    mediaPath: fields.mediaPath ?? "",
    releaseName: fields.releaseName ?? "",
    ptpTarget: fields.ptpTarget,
    torrent
  });
}

async function readJsonManualIntakeRequest(request: FastifyRequest, fetchImpl: typeof fetch): Promise<ManualIntakeInput> {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const torrentUrl = typeof body.torrentUrl === "string" ? body.torrentUrl : "";
  const torrent = torrentUrl ? await downloadTorrentFromUrl(torrentUrl, fetchImpl) : null;
  return normalizeManualIntakeInput({
    mediaPath: typeof body.mediaPath === "string" ? body.mediaPath : "",
    releaseName: typeof body.releaseName === "string" ? body.releaseName : "",
    ptpTarget: body.ptpTarget,
    torrent
  });
}

function normalizeManualIntakeInput(input: { mediaPath?: string; releaseName?: string; ptpTarget: unknown; torrent: IntakeTorrentInput | null }): ManualIntakeInput {
  const mediaPath = (input.mediaPath ?? "").trim();
  if (!mediaPath && !input.torrent) throw new IntakeError("media_or_torrent_source_required");
  const fallbackTitle = mediaPath ? mediaTitleFromPath(mediaPath) : input.torrent ? mediaTitleFromPath(input.torrent.filename) : "";
  const releaseName = (input.releaseName?.trim() || fallbackTitle).trim();
  if (!releaseName) throw new IntakeError("release_name_required");

  return {
    releaseName,
    ptpTarget: parsePtpTarget(input.ptpTarget),
    ...(mediaPath ? { mediaPath } : {}),
    ...(input.torrent ? { torrent: input.torrent } : {})
  };
}

export async function readManualIntakeRequest(request: FastifyRequest, fetchImpl: typeof fetch): Promise<ManualIntakeInput> {
  const maybeMultipart = request as MultipartRequest;
  if (maybeMultipart.isMultipart?.()) return readMultipartManualIntakeRequest(maybeMultipart, fetchImpl);
  return readJsonManualIntakeRequest(request, fetchImpl);
}

function manualCheckResult(candidate: TorrentCandidate, target: ManualIntakePtpTarget): BrowserCheckResult {
  return {
    candidate,
    parsed: parseTorrentTitle(candidate.title, candidate.resolution),
    decision: {
      status: "review",
      movieFound: true,
      movie: {
        GroupId: target.groupId,
        Title: target.displayTitle,
        Name: target.displayTitle,
        Year: target.year ?? "",
        ImdbId: target.imdbId ?? "",
        Torrents: []
      },
      ptpUrl: target.ptpUrl,
      reason: "Manual PTP target confirmed.",
      confidence: "high"
    },
    cache: { key: `ptp:group:${target.groupId}`, hit: false, policy: "permanent" }
  };
}

export async function createManualIntakeJob(input: {
  dataRoot: string;
  jobRepository: ManualIntakeJobRepository;
  mediaPath?: string;
  releaseName: string;
  ptpTarget: ManualIntakePtpTarget;
  torrent?: IntakeTorrentInput;
}): Promise<Job> {
  const candidate: TorrentCandidate = {
    site: "unknown",
    title: input.releaseName,
    imdbId: input.ptpTarget.imdbId
  };
  const torrent = input.torrent
    ? {
        filename: input.torrent.filename,
        bytes: input.torrent.bytes.byteLength,
        ...(input.torrent.contentType ? { contentType: input.torrent.contentType } : {})
      }
    : null;
  const job = await input.jobRepository.createFromBrowser({
    candidate,
    checkResult: manualCheckResult(candidate, input.ptpTarget),
    ...(torrent ? { torrent } : {}),
    sourceSite: "unknown",
    title: input.releaseName
  });
  const paths = buildJobWorkspacePaths(input.dataRoot, job.id);
  await Promise.all([
    mkdir(paths.inputDir, { recursive: true }),
    mkdir(paths.torrentDir, { recursive: true }),
    mkdir(paths.sourceDownloadDir, { recursive: true }),
    mkdir(paths.logs.dir, { recursive: true })
  ]);
  if (input.torrent) await writeFile(paths.sourceTorrent, input.torrent.bytes);
  const source = {
    site: "unknown",
    title: input.releaseName,
    ...(input.mediaPath ? { mediaPath: input.mediaPath } : {}),
    ...(input.torrent?.sourceUrl ? { torrentUrl: input.torrent.sourceUrl } : {}),
    ptpTarget: input.ptpTarget
  };
  await writeFile(
    paths.sourceJson,
    `${JSON.stringify({ candidate, checkResult: manualCheckResult(candidate, input.ptpTarget), torrent, source }, null, 2)}\n`,
    "utf8"
  );
  const workspace = {
    dataRoot: paths.dataRoot,
    jobRoot: paths.jobRoot,
    manifest: paths.manifest
  };
  const attached = await input.jobRepository.attachWorkspace(job.id, {
    workspace,
    ...(input.torrent ? { torrentFilePath: paths.sourceTorrent } : {}),
    source
  });
  return attached ?? {
    ...job,
    source,
    ...(torrent ? { torrent: { ...torrent, filePath: paths.sourceTorrent } } : {}),
    workspace
  };
}
