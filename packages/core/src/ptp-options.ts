export const PTP_TYPES = [
  "Feature Film",
  "Short Film",
  "Miniseries",
  "Stand-up Comedy",
  "Live Performance",
  "Movie Collection"
] as const;

export const PTP_SOURCES = ["Blu-ray", "DVD", "WEB", "HD-DVD", "HDTV", "TV", "VHS", "Other"] as const;

export const PTP_CODECS = [
  "XviD",
  "DivX",
  "H.264",
  "x264",
  "H.265",
  "x265",
  "DVD5",
  "DVD9",
  "BD25",
  "BD50",
  "BD66",
  "BD100",
  "Other"
] as const;

export const PTP_CONTAINERS = ["AVI", "MPG", "MKV", "MP4", "VOB IFO", "ISO", "m2ts", "Other"] as const;
export const PTP_RESOLUTIONS = ["NTSC", "PAL", "480p", "576p", "720p", "1080i", "1080p", "2160p", "Other"] as const;

export const PTP_SUBTITLE_OPTIONS = [
  { id: "3", label: "English" },
  { id: "14", label: "Chinese" },
  { id: "44", label: "No Subtitles" }
] as const;

export const PTP_TRUMPABLE_OPTIONS = [
  { id: "14", label: "No English Subtitles" },
  { id: "4", label: "Hardcoded Subtitles" }
] as const;

