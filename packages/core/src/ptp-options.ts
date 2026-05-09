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
  { id: "44", label: "No Subtitles" },
  { id: "3", label: "English" },
  { id: "50", label: "English - Forced" },
  { id: "51", label: "English Intertitles" },
  { id: "4", label: "Spanish" },
  { id: "5", label: "French" },
  { id: "22", label: "Arabic" },
  { id: "49", label: "Brazilian Port." },
  { id: "29", label: "Bulgarian" },
  { id: "14", label: "Chinese" },
  { id: "23", label: "Croatian" },
  { id: "30", label: "Czech" },
  { id: "10", label: "Danish" },
  { id: "9", label: "Dutch" },
  { id: "38", label: "Estonian" },
  { id: "15", label: "Finnish" },
  { id: "6", label: "German" },
  { id: "26", label: "Greek" },
  { id: "40", label: "Hebrew" },
  { id: "41", label: "Hindi" },
  { id: "24", label: "Hungarian" },
  { id: "28", label: "Icelandic" },
  { id: "47", label: "Indonesian" },
  { id: "16", label: "Italian" },
  { id: "8", label: "Japanese" },
  { id: "19", label: "Korean" },
  { id: "37", label: "Latvian" },
  { id: "39", label: "Lithuanian" },
  { id: "54", label: "Malay" },
  { id: "12", label: "Norwegian" },
  { id: "52", label: "Persian" },
  { id: "17", label: "Polish" },
  { id: "21", label: "Portuguese" },
  { id: "13", label: "Romanian" },
  { id: "7", label: "Russian" },
  { id: "31", label: "Serbian" },
  { id: "42", label: "Slovak" },
  { id: "43", label: "Slovenian" },
  { id: "11", label: "Swedish" },
  { id: "20", label: "Thai" },
  { id: "18", label: "Turkish" },
  { id: "34", label: "Ukrainian" },
  { id: "25", label: "Vietnamese" },
  { id: "55", label: "Welsh" }
] as const;

export const PTP_TRUMPABLE_OPTIONS = [
  { id: "14", label: "No English Subtitles" },
  { id: "4", label: "Hardcoded Subtitles" }
] as const;
