import type { ReviewDraft } from "./review-draft.js";
import { PTP_CODECS, PTP_CONTAINERS, PTP_RESOLUTIONS, PTP_SOURCES } from "./ptp-options.js";

export interface PtpFieldResult {
  fields: Array<[string, string]>;
  missing: string[];
}

export function missingPtpDraftFields(draft: ReviewDraft): string[] {
  const missing: string[] = [];
  const requireField = (key: string, value: string | null | undefined) => {
    if (!value?.trim()) missing.push(key);
  };

  requireField("releaseName", draft.releaseName);
  requireField("description", draft.description);
  requireField("type", draft.type);
  requireField("source", draft.source);
  requireField("codec", draft.codec);
  requireField("container", draft.container);
  requireField("resolution", draft.resolution);

  const source = selectOrOther(draft.source, PTP_SOURCES, draft.otherSource);
  if (source.selected === "Other" && !source.other) missing.push("otherSource");
  const codec = selectOrOther(draft.codec, PTP_CODECS, draft.otherCodec);
  if (codec.selected === "Other" && !codec.other) missing.push("otherCodec");
  const container = selectOrOther(draft.container, PTP_CONTAINERS, draft.otherContainer);
  if (container.selected === "Other" && !container.other) missing.push("otherContainer");

  const resolution = resolutionFields(draft);
  if (resolution.selected === "Other") {
    if (!resolution.width) missing.push("otherResolutionWidth");
    if (!resolution.height) missing.push("otherResolutionHeight");
  }

  if (!draft.groupId) {
    requireField("imdb", draft.imdb);
    requireField("title", draft.title);
    requireField("year", draft.year);
  }

  return [...new Set(missing)];
}

export function ptpFormFieldsFromDraft(draft: ReviewDraft): PtpFieldResult {
  const fields: Array<[string, string]> = [];
  const append = (key: string, value: string | number | boolean | null | undefined) => {
    if (value === null || value === undefined || value === "") return;
    fields.push([key, String(value)]);
  };

  append("type", draft.type);
  const source = selectOrOther(draft.source, PTP_SOURCES, draft.otherSource);
  append("source", source.selected);
  append("other_source", source.other);
  const codec = selectOrOther(draft.codec, PTP_CODECS, draft.otherCodec);
  append("codec", codec.selected);
  append("other_codec", codec.other);
  const container = selectOrOther(draft.container, PTP_CONTAINERS, draft.otherContainer);
  append("container", container.selected);
  append("other_container", container.other);
  const resolution = resolutionFields(draft);
  append("resolution", resolution.selected);
  append("other_resolution_width", resolution.width);
  append("other_resolution_height", resolution.height);

  append("release_desc", draft.description);
  append("groupid", draft.groupId);
  append("imdb", draft.imdb);
  append("title", draft.title);
  append("year", draft.year);
  append("image", draft.image);
  append("trailer", draft.trailer);
  append("tags", draft.tags);
  append("album_desc", draft.synopsis);
  append("special", draft.special);
  append("uploadtoken", draft.uploadToken);
  append("remaster_year", draft.remasterYear);
  append("remaster_title", draft.remasterTitle);
  if (draft.scene) append("scene", "on");
  if (draft.personalRip || draft.internal) append("internalrip", "on");
  if (draft.remaster || draft.remasterYear || draft.remasterTitle) append("remaster", "on");

  for (const artist of draft.artists ?? []) {
    append("artist[]", artist.name);
    append("importance[]", artist.importance);
  }
  for (const subtitle of draft.subtitles) append("subtitles[]", subtitle);
  for (const trumpable of draft.trumpable) append("trumpable[]", trumpable);

  return { fields, missing: missingPtpDraftFields(draft) };
}

function selectOrOther<T extends readonly string[]>(value: string | null | undefined, options: T, otherValue: string | null | undefined): { selected: string; other: string } {
  const normalized = value?.trim() ?? "";
  if (normalized && options.includes(normalized)) return { selected: normalized, other: "" };
  return { selected: "Other", other: otherValue?.trim() || normalized };
}

function resolutionFields(draft: ReviewDraft): { selected: string; width: string; height: string } {
  const resolution = draft.resolution?.trim() ?? "";
  if (resolution && (PTP_RESOLUTIONS as readonly string[]).includes(resolution)) {
    return { selected: resolution, width: "", height: "" };
  }
  const match = resolution.match(/^(\d{3,5})\s*x\s*(\d{3,5})$/i);
  return {
    selected: "Other",
    width: draft.otherResolutionWidth?.trim() || match?.[1] || "",
    height: draft.otherResolutionHeight?.trim() || match?.[2] || ""
  };
}
