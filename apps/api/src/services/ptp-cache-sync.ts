import {
  makePtpCacheKey,
  type CacheStore,
  type NormalizedPtpResponse,
  type PtpMovie,
  type PtpTorrent
} from "@popcorn-queue/core";
import type { PtpCacheSyncInput, PtpCacheSyncer } from "@popcorn-queue/worker";

function optionalString(value: string | null | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

function uploadedPtpTorrent(input: PtpCacheSyncInput): PtpTorrent {
  const torrent: PtpTorrent = {
    Id: input.uploadResult.torrentId,
    Quality: input.parsed.qualityType,
    ReleaseName: input.releaseName,
    Trumpable: false,
    Seeders: 1
  };
  const source = optionalString(input.reviewDraft?.source) ?? optionalString(input.parsed.source);
  const codec = optionalString(input.reviewDraft?.codec) ?? optionalString(input.parsed.codec);
  const resolution = optionalString(input.reviewDraft?.resolution) ?? optionalString(input.parsed.resolution);
  const remasterTitle = optionalString(input.reviewDraft?.remasterTitle);
  if (source) torrent.Source = source;
  if (codec) torrent.Codec = codec;
  if (resolution) torrent.Resolution = resolution;
  if (remasterTitle) torrent.RemasterTitle = remasterTitle;
  return torrent;
}

function fallbackPtpMovie(input: PtpCacheSyncInput): PtpMovie {
  const movie = input.checkResult?.decision.movie;
  const fallback: PtpMovie = {
    ...(movie ?? {}),
    GroupId: input.uploadResult.groupId,
    Title: movie?.Title ?? input.parsed.searchName,
    Name: movie?.Name ?? movie?.Title ?? input.parsed.searchName,
    Torrents: movie?.Torrents ?? []
  };
  const year = movie?.Year ?? input.parsed.year;
  const imdbId = movie?.ImdbId ?? input.candidate.imdbId ?? null;
  if (year) fallback.Year = year;
  if (imdbId) fallback.ImdbId = imdbId;
  return fallback;
}

function withUploadedTorrent(movie: PtpMovie, torrent: PtpTorrent): PtpMovie {
  const torrents = (movie.Torrents ?? []).filter((item) => item.Id !== torrent.Id && item.ReleaseName !== torrent.ReleaseName);
  return {
    ...movie,
    Torrents: [...torrents, torrent]
  };
}

function syncUploadedTorrentData(data: NormalizedPtpResponse, input: PtpCacheSyncInput): { data: NormalizedPtpResponse; torrentCount: number } {
  const torrent = uploadedPtpTorrent(input);
  const groupId = input.uploadResult.groupId;
  const fallbackMovie = fallbackPtpMovie(input);
  let matched = false;
  let torrentCount = 1;
  const sourceMovies = data.movies.length ? data.movies : [fallbackMovie];
  const movies = sourceMovies.map((movie) => {
    if (movie.GroupId !== groupId) return movie;
    matched = true;
    const next = withUploadedTorrent(movie, torrent);
    torrentCount = next.Torrents?.length ?? 1;
    return next;
  });

  if (!matched) {
    const next = withUploadedTorrent(fallbackMovie, torrent);
    torrentCount = next.Torrents?.length ?? 1;
    movies.push(next);
  }

  return {
    data: {
      ...data,
      totalResults: data.totalResults ?? movies.length,
      movies
    },
    torrentCount
  };
}

export function createPtpCacheSyncer(cache: CacheStore<NormalizedPtpResponse>): PtpCacheSyncer {
  return {
    async syncUpload(input) {
      const cacheKey = input.checkResult?.cache.key ?? makePtpCacheKey(input.candidate);
      const entry = await cache.get(cacheKey);
      const baseData = entry?.data ?? { movies: [] };
      const synced = syncUploadedTorrentData(baseData, input);
      await cache.set(cacheKey, synced.data);
      return {
        cacheKey,
        groupId: input.uploadResult.groupId,
        torrentId: input.uploadResult.torrentId,
        torrentCount: synced.torrentCount
      };
    }
  };
}
