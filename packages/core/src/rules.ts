import type {
  ClassifiedPtpTorrent,
  NormalizedPtpResponse,
  ParsedTorrentCandidate,
  PtpMovie,
  PtpTorrent,
  RuleDecision
} from "./types.js";
import { getHdrType, normalizeResolution } from "./parse.js";

function truthyTrumpable(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") return value !== "" && value !== "0" && value.toLowerCase() !== "false";
  return false;
}

export function getPtpTorrentHdrType(torrent: PtpTorrent): ClassifiedPtpTorrent["hdrType"] {
  const remaster = String(torrent.RemasterTitle ?? "").toLowerCase();
  const name = String(torrent.ReleaseName ?? "").toUpperCase();
  const hasDV = /dolby.vision|dovi|\bDV\b/i.test(name) || /dolby.vision/i.test(remaster);
  const hasHDR = /\bHDR\b|HDR10|HLG/i.test(name) || /\bhdr\b|hdr10|hlg/i.test(remaster);
  if (hasDV && hasHDR) return "dv+hdr";
  if (hasDV) return "dv";
  if (hasHDR) return "hdr";
  if (/\b10[\s._-]?BIT\b/.test(name) || /10-?bit/i.test(remaster)) return "10bit";
  return "sdr";
}

export function classifyPtpTorrent(torrent: PtpTorrent): ClassifiedPtpTorrent {
  const quality = String(torrent.Quality ?? "").toLowerCase();
  const codec = String(torrent.Codec ?? "").toLowerCase();
  const source = String(torrent.Source ?? "").toLowerCase();
  const remaster = String(torrent.RemasterTitle ?? "").toLowerCase();
  const releaseName = String(torrent.ReleaseName ?? "");
  const upperName = releaseName.toUpperCase();
  const hasHDR = /hdr|dolby.vision|dovi|hlg/i.test(upperName) || /hdr|dolby.vision|hlg/i.test(remaster);
  const hasDV = /dolby.vision|dovi|\bDV\b/i.test(upperName) || /dolby.vision/i.test(remaster);
  const isRemux = quality.includes("remux");
  const isUntouched = quality.includes("untouched") || /bd50|bd25|bd66|bd100|dvd[59]|full.?disc|bdmv/i.test(quality);
  const isWebDL = source.includes("web") && !quality.includes("encode") && !quality.includes("rip");
  const isEncode = !isRemux && !isUntouched && !isWebDL;

  const classified: ClassifiedPtpTorrent = {
    res: normalizeResolution(torrent.Resolution) ?? null,
    quality,
    codec,
    source,
    hasHDR,
    hasDV,
    isRemux,
    isUntouched,
    isWebDL,
    isEncode,
    isBluray: source.includes("blu-ray") || source.includes("blu_ray") || source.includes("bluray"),
    hdrType: getPtpTorrentHdrType(torrent),
    remaster,
    trumpable: truthyTrumpable(torrent.Trumpable),
    seeders: Number(torrent.Seeders ?? 0) || 0,
    size: Number(torrent.Size ?? 0) || 0,
    releaseName
  };
  if (torrent.LastActive) classified.lastActive = torrent.LastActive;
  return classified;
}

function makeDecision(params: Omit<RuleDecision, "confidence" | "reason"> & Partial<Pick<RuleDecision, "confidence" | "reason">>): RuleDecision {
  return {
    confidence: params.confidence ?? "high",
    reason: params.reason ?? params.status,
    ...params
  };
}

function withMovie(base: RuleDecision, movie: PtpMovie): RuleDecision {
  const groupId = movie.GroupId;
  return {
    ...base,
    movie,
    movieFound: true,
    ptpUrl: groupId ? `https://passthepopcorn.me/torrents.php?id=${groupId}` : null
  };
}

export function evaluatePtpCoexistence(ptpData: NormalizedPtpResponse, candidate: ParsedTorrentCandidate, imdbId?: string | null): RuleDecision {
  if (!ptpData.movies.length) {
    if (!imdbId) {
      return makeDecision({
        status: "skip",
        movieFound: false,
        ptpUrl: null,
        confidence: "medium",
        reason: "Movie was not found on PTP and no IMDb ID is available."
      });
    }
    return makeDecision({
      status: "not_found",
      movieFound: false,
      ptpUrl: `https://www.imdb.com/title/${imdbId}`,
      reason: "Movie was not found on PTP."
    });
  }

  const movie = ptpData.movies[0];
  if (!movie) {
    return makeDecision({
      status: "error",
      movieFound: false,
      reason: "PTP response did not include a usable movie object.",
      confidence: "low"
    });
  }

  if (!movie.Torrents?.length) {
    return withMovie(
      makeDecision({
        status: "no_torrents",
        movieFound: true,
        used: 0,
        max: 1,
        reason: "Movie exists on PTP but has no torrents."
      }),
      movie
    );
  }

  if (!candidate.resolution) {
    return withMovie(
      makeDecision({
        status: "review",
        movieFound: true,
        confidence: "low",
        reason: "Candidate resolution could not be detected."
      }),
      movie
    );
  }

  const existing = movie.Torrents.map(classifyPtpTorrent);
  const decision =
    candidate.qualityType === "Remux"
      ? checkRemuxSlots(existing, candidate)
      : candidate.qualityType === "Untouched"
        ? checkUntouchedSlots(existing, candidate)
        : checkEncodeSlots(existing, candidate);

  return withMovie(decision, movie);
}

function statusFromOccupied(relevant: ClassifiedPtpTorrent[], slotType: string, max: number): RuleDecision {
  const trumpable = relevant.filter((item) => item.trumpable);
  return makeDecision({
    status: trumpable.length ? "trumpable" : "full",
    movieFound: true,
    slotType,
    used: relevant.length,
    max,
    existing: relevant,
    reason: trumpable.length ? `${slotType} is full, but at least one existing torrent is trumpable.` : `${slotType} is full.`
  });
}

function sameResolutionSlot(existing: ClassifiedPtpTorrent, candidateResolution: string | null): boolean {
  if (!candidateResolution) return false;
  if (existing.res === candidateResolution) return true;
  return (candidateResolution === "1080p" || candidateResolution === "1080i") && (existing.res === "1080p" || existing.res === "1080i");
}

function checkEncodeSlots(existing: ClassifiedPtpTorrent[], candidate: ParsedTorrentCandidate): RuleDecision {
  const res = candidate.resolution;
  const sameRes = existing.filter((item) => sameResolutionSlot(item, res) && (item.isEncode || item.isWebDL));

  if (res === "2160p") {
    const candHdrType = getHdrType(candidate.hdr, candidate.title);
    const candIsBluray = candidate.source === "Blu-ray";
    const relevant = sameRes.filter((item) => item.hdrType === candHdrType);
    const slotType = `2160p ${candHdrType} encode`;

    if (candHdrType === "sdr") {
      if (relevant.length === 0) {
        return makeDecision({ status: "open", movieFound: true, slotType, used: 0, max: 2, reason: `${slotType} has an open slot.` });
      }
      if (relevant.length === 1) {
        return makeDecision({
          status: "coexist",
          movieFound: true,
          slotType: `${slotType} size-difference slot`,
          used: 1,
          max: 2,
          existing: relevant,
          confidence: "medium",
          reason: "One 2160p SDR encode exists; candidate may coexist if the size-difference rule is satisfied."
        });
      }
      return statusFromOccupied(relevant, slotType, 2);
    }

    if (relevant.length === 0) {
      return makeDecision({ status: "open", movieFound: true, slotType, used: 0, max: 1, reason: `${slotType} has an open slot.` });
    }

    const hasBlurayInSlot = relevant.some((item) => item.isBluray);
    if (candIsBluray && !hasBlurayInSlot) {
      return makeDecision({
        status: "trumpable",
        movieFound: true,
        slotType: `${slotType} source-priority slot`,
        used: relevant.length,
        max: 1,
        existing: relevant,
        reason: "Candidate is Blu-ray sourced and the occupied slot only has WEB-sourced torrents."
      });
    }

    return statusFromOccupied(relevant, slotType, 1);
  }

  const candIsHDR = candidate.hdr.length > 0;
  const candHasDV = candidate.hdr.includes("DV");
  const codec = candidate.codec;

  if (res === "1080p" && candIsHDR && (codec === "x265" || codec === "AV1") && !candHasDV) {
    const hdrX265 = existing.filter(
      (item) => sameResolutionSlot(item, res) && item.hasHDR && (item.codec.includes("265") || item.codec.includes("hevc") || item.codec.includes("av1")) && !item.isRemux && !item.isUntouched
    );
    if (hdrX265.length) return statusFromOccupied(hdrX265, "1080p HDR x265", 1);
    return makeDecision({ status: "open", movieFound: true, slotType: "1080p HDR x265", used: 0, max: 1, reason: "1080p HDR x265 slot is open." });
  }

  if (res === "1080p" && candHasDV) {
    const dvSlot = sameRes.filter((item) => item.hasDV);
    if (dvSlot.length) return statusFromOccupied(dvSlot, "1080p DV P5", 1);
    return makeDecision({ status: "open", movieFound: true, slotType: "1080p DV P5", used: 0, max: 1, reason: "1080p DV P5 slot is open." });
  }

  const relevant = sameRes.filter((item) => !item.hasDV && !item.hasHDR);
  const slotType = `${res} encode`;
  if (relevant.length) return statusFromOccupied(relevant, slotType, 1);
  return makeDecision({ status: "open", movieFound: true, slotType, used: 0, max: 1, reason: `${slotType} has an open slot.` });
}

function checkRemuxSlots(existing: ClassifiedPtpTorrent[], candidate: ParsedTorrentCandidate): RuleDecision {
  const remuxes = existing.filter((item) => item.isRemux);
  const res = candidate.resolution;

  if (res === "2160p") {
    const candIsHDR = candidate.hdr.length > 0;
    const relevant = remuxes.filter((item) => item.res === "2160p" && (candIsHDR ? item.hasHDR : !item.hasHDR));
    const slotType = candIsHDR ? "UHD HDR Remux" : "UHD SDR Remux";
    if (relevant.length) return statusFromOccupied(relevant, slotType, 1);
    return makeDecision({ status: "open", movieFound: true, slotType, used: 0, max: 1, reason: `${slotType} slot is open.` });
  }

  const hdRemux = remuxes.filter((item) => item.res === "1080p" || item.res === "720p");
  if (hdRemux.length) return statusFromOccupied(hdRemux, "HD Remux", 1);
  return makeDecision({ status: "open", movieFound: true, slotType: "HD Remux", used: 0, max: 1, reason: "HD Remux slot is open." });
}

function checkUntouchedSlots(existing: ClassifiedPtpTorrent[], candidate: ParsedTorrentCandidate): RuleDecision {
  const untouched = existing.filter((item) => item.isUntouched);
  const res = candidate.resolution;

  if (res && ["480p", "480i", "576p", "576i", "NTSC", "PAL"].includes(res)) {
    const dvds = untouched.filter((item) => item.res && ["480p", "480i", "576p", "576i", "NTSC", "PAL"].includes(item.res));
    if (dvds.length >= 2) return statusFromOccupied(dvds, "DVD Untouched", 2);
    return makeDecision({ status: "open", movieFound: true, slotType: "DVD Untouched", used: dvds.length, max: 2, reason: "DVD untouched slot is open." });
  }

  if (res === "2160p") {
    const uhdDisc = untouched.filter((item) => item.res === "2160p");
    if (uhdDisc.length) return statusFromOccupied(uhdDisc, "UHD Disc", 1);
    return makeDecision({ status: "open", movieFound: true, slotType: "UHD Disc", used: 0, max: 1, reason: "UHD disc slot is open." });
  }

  const hdDisc = untouched.filter((item) => item.res === "1080p" || item.res === "720p" || item.res === "1080i");
  if (hdDisc.length) return statusFromOccupied(hdDisc, "HD Disc", 1);
  return makeDecision({ status: "open", movieFound: true, slotType: "HD Disc", used: 0, max: 1, reason: "HD disc slot is open." });
}
