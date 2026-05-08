import type { ParsedTorrentCandidate, TorrentCandidate } from "./types.js";
import { normalizeImdbId } from "./parse.js";

export interface MetadataProviderPlan {
  provider: "imdb" | "tmdb" | "tvmaze";
  status: "ready" | "pending" | "skipped";
  reason: string;
}

export interface MetadataPlan {
  title: string;
  year: string | null;
  imdbId: string | null;
  type: "movie" | "episode" | "unknown";
  providers: MetadataProviderPlan[];
  tags: string[];
}

function inferContentType(title: string): MetadataPlan["type"] {
  if (/\bS\d{2}E\d{2}\b/i.test(title)) return "episode";
  if (/\b(?:19|20)\d{2}\b/.test(title)) return "movie";
  return "unknown";
}

export function buildMetadataPlan(candidate: TorrentCandidate, parsed: ParsedTorrentCandidate): MetadataPlan {
  const imdbId = normalizeImdbId(candidate.imdbId);
  const type = inferContentType(candidate.title);
  const providers: MetadataProviderPlan[] = [
    {
      provider: "imdb",
      status: imdbId ? "ready" : "pending",
      reason: imdbId ? "IMDb ID was detected." : "Needs IMDb lookup or manual entry."
    },
    {
      provider: "tmdb",
      status: parsed.searchName ? "pending" : "skipped",
      reason: parsed.searchName ? "Can enrich movie metadata from normalized title/year." : "No usable search title."
    },
    {
      provider: "tvmaze",
      status: type === "episode" ? "pending" : "skipped",
      reason: type === "episode" ? "Episode naming detected." : "Movie workflow does not need TVmaze by default."
    }
  ];
  const tags = [
    parsed.qualityType.toLowerCase(),
    parsed.source?.toLowerCase(),
    parsed.resolution,
    ...parsed.hdr.map((item) => item.toLowerCase())
  ].filter((item): item is string => Boolean(item));

  return {
    title: parsed.searchName,
    year: parsed.year ?? null,
    imdbId,
    type,
    providers,
    tags
  };
}
