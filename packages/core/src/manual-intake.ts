/// <reference types="node" />

import path from "node:path";
import type { PtpMovie } from "./types.js";

export interface MediaPathValidationResult {
  ok: boolean;
  mediaPath: string;
  basename: string;
  kind: "file" | "directory" | "missing" | "relative" | "unsupported" | "unreadable";
  size: number | null;
  error: string | null;
  warning: string | null;
}

export interface ManualIntakePtpTarget {
  groupId: string;
  displayTitle: string;
  year: string | null;
  imdbId: string | null;
  ptpUrl: string;
}

export interface PtpMovieSearchCandidate extends ManualIntakePtpTarget {
  title: string;
  raw: PtpMovie;
}

export interface PtpMovieSearchResponse {
  query: string;
  parsedYear: string | null;
  results: PtpMovieSearchCandidate[];
}

export const VIDEO_FILE_EXTENSIONS = new Set([".mkv", ".mp4", ".m2ts", ".ts", ".mov", ".avi"]);

export function mediaTitleFromPath(mediaPath: string): string {
  const basename = path.basename(mediaPath);
  const extension = path.extname(basename).toLowerCase();
  return VIDEO_FILE_EXTENSIONS.has(extension) ? basename.slice(0, -extension.length) : basename;
}

export function buildPtpGroupUrl(groupId: string): string {
  return `https://passthepopcorn.me/torrents.php?id=${encodeURIComponent(groupId)}`;
}

export function formatPtpMovieTitle(movie: PtpMovie): string {
  const primary = (movie.Title || movie.Name || "").trim();
  const aka = movie.Name && movie.Title && movie.Name !== movie.Title ? ` AKA ${movie.Name}` : "";
  const year = movie.Year ? ` [${movie.Year}]` : "";
  return `${primary}${aka}${year}`.trim();
}

export function ptpTargetFromMovie(movie: PtpMovie): PtpMovieSearchCandidate | null {
  if (!movie.GroupId) return null;
  const displayTitle = formatPtpMovieTitle(movie);
  return {
    groupId: movie.GroupId,
    title: movie.Title || movie.Name || displayTitle,
    displayTitle,
    year: movie.Year || null,
    imdbId: movie.ImdbId || null,
    ptpUrl: buildPtpGroupUrl(movie.GroupId),
    raw: movie
  };
}
