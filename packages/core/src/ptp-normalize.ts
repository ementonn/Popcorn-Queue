import type { NormalizedPtpResponse, PtpMovie } from "./types.js";

export function normalizePtpResponse(raw: unknown): NormalizedPtpResponse {
  if (!raw || typeof raw !== "object") {
    return { movies: [], raw };
  }

  const data = raw as Record<string, unknown>;
  const page = typeof data.Page === "string" ? data.Page : undefined;

  if (page === "Details") {
    const movie: PtpMovie = {
      GroupId: String(data.GroupId ?? ""),
      Title: String(data.Name ?? ""),
      Name: String(data.Name ?? ""),
      Year: String(data.Year ?? ""),
      ImdbId: String(data.ImdbId ?? ""),
      Torrents: Array.isArray(data.Torrents) ? data.Torrents : []
    };
    return {
      page,
      totalResults: movie.GroupId ? 1 : 0,
      movies: movie.GroupId ? [movie] : [],
      raw
    };
  }

  const movies = Array.isArray(data.Movies)
    ? data.Movies.map((movie) => {
        const m = movie as PtpMovie;
        return {
          ...m,
          Title: m.Title ?? m.Name ?? "",
          Torrents: Array.isArray(m.Torrents) ? m.Torrents : []
        };
      })
    : [];

  const normalized: NormalizedPtpResponse = {
    totalResults: Number(data.TotalResults ?? movies.length),
    movies,
    raw
  };
  if (page) normalized.page = page;
  return normalized;
}
