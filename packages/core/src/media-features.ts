export interface MediaFeatureDetection {
  hdrFormats: string[];
  editionFeatures: string[];
}

interface MediaInfoTrack {
  "@type"?: string;
  [key: string]: unknown;
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+]/g, "");
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function field(track: MediaInfoTrack | undefined, ...keys: string[]): string {
  if (!track) return "";
  for (const key of keys) {
    const direct = text(track[key]);
    if (direct) return direct;
    const found = Object.entries(track).find(([candidate]) => compact(candidate) === compact(key));
    if (found) return text(found[1]);
  }
  return "";
}

function parseTracks(mediaInfoJson: string | null | undefined): MediaInfoTrack[] {
  if (!mediaInfoJson?.trim()) return [];
  try {
    const parsed = JSON.parse(mediaInfoJson) as { media?: { track?: unknown[] } };
    return Array.isArray(parsed.media?.track) ? parsed.media.track.filter((track): track is MediaInfoTrack => Boolean(track) && typeof track === "object") : [];
  } catch {
    return [];
  }
}

function detectHdrFormats(video: MediaInfoTrack | undefined, releaseName: string): string[] {
  const formats: string[] = [];
  const hdrFormat = field(video, "HDR_Format");
  const compatibility = field(video, "HDR_Format_Compatibility");
  const primaries = field(video, "colour_primaries", "Color primaries", "ColorPrimaries");
  const profile = field(video, "HDR_Format_Profile");
  const name = releaseName;

  if (/^Dolby Vision/i.test(hdrFormat) || /\b(?:DOVI|DV|Dolby[ ._-]?Vision)\b/i.test(name)) formats.push("DV");
  if (/HDR10\+/i.test(compatibility) || /\bHDR10\+\b|HDR10PLUS/i.test(name)) {
    formats.push("HDR10+");
  } else if ((/HDR10(?!\+)/i.test(compatibility) || /BT\.?2020/i.test(primaries) || /\bHDR10\b/i.test(name)) && !/dvhe\.05/i.test(profile)) {
    formats.push("HDR10");
  } else if (/HDR(?!10)/i.test(compatibility) || /HDR(?!10)/i.test(hdrFormat) || /\bHDR\b/i.test(name)) {
    formats.push("HDR");
  }

  return [...new Set(formats)];
}

function detect3dFeatures(releaseName: string): string[] {
  const normalized = releaseName.replace(/[._-]+/g, " ");
  const compactName = compact(releaseName);
  const features: string[] = [];
  if (/\b(?:3D )?Full SBS\b/i.test(normalized) || /\bFSBS\b/i.test(normalized) || compactName.includes("3dfullsbs")) features.push("3D Full SBS");
  if (/\b(?:3D )?Half SBS\b/i.test(normalized) || /\bHSBS\b/i.test(normalized) || compactName.includes("3dhalfsbs")) features.push("3D Half SBS");
  if (/\b(?:3D )?Half OU\b/i.test(normalized) || /\bHOU\b/i.test(normalized) || /\bHalf Over Under\b/i.test(normalized) || compactName.includes("3dhalfou")) {
    features.push("3D Half OU");
  }
  if (/\bAnaglyph\b/i.test(normalized)) features.push("3D Anaglyph");
  if (/\b2D 3D\b/i.test(normalized) || /\b2D3D\b/i.test(normalized) || compactName.includes("2d3d")) features.push("2D/3D Edition");
  return features;
}

function detectAudioFeatures(audioTracks: MediaInfoTrack[]): string[] {
  const features: string[] = [];
  const languages = new Set<string>();
  for (const track of audioTracks) {
    const haystack = [
      field(track, "Format"),
      field(track, "Format_Commercial_IfAny"),
      field(track, "Format_AdditionalFeatures"),
      field(track, "Title")
    ].join(" ");
    const language = field(track, "Language").trim().toLowerCase();
    if (language && language !== "und") languages.add(language);
    if (/DTS\s*:?\s*X/i.test(haystack)) features.push("DTS:X");
    if (/Atmos/i.test(haystack)) features.push("Dolby Atmos");
    if (/commentary/i.test(haystack)) features.push("With Commentary");
  }
  if (languages.size > 1) features.push("Dual Audio");
  return features;
}

export function detectMediaFeatures(input: { mediaInfoJson?: string | null; releaseName?: string | null }): MediaFeatureDetection {
  const releaseName = input.releaseName ?? "";
  const tracks = parseTracks(input.mediaInfoJson);
  const video = tracks.find((track) => track["@type"] === "Video");
  const audioTracks = tracks.filter((track) => track["@type"] === "Audio");
  const hdrFormats = detectHdrFormats(video, releaseName);
  const editionFeatures: string[] = [];

  if (hdrFormats.includes("DV")) editionFeatures.push("Dolby Vision");
  if (hdrFormats.includes("HDR10+")) editionFeatures.push("HDR10+");
  if (hdrFormats.includes("HDR10")) editionFeatures.push("HDR10");

  const bitDepth = Number.parseInt(field(video, "BitDepth", "Bit depth"), 10);
  if (bitDepth === 10 && !hdrFormats.some((format) => format === "DV" || format.startsWith("HDR"))) editionFeatures.push("10-bit");

  editionFeatures.push(...detectAudioFeatures(audioTracks));
  editionFeatures.push(...detect3dFeatures(releaseName));

  return {
    hdrFormats,
    editionFeatures: [...new Set(editionFeatures)]
  };
}
