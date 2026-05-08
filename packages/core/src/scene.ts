import type { TorrentCandidate } from "./types.js";
import { extractReleaseGroup } from "./release.js";

export type SceneCheckStatus = "not_scene" | "needs_verification" | "likely_scene";

export interface SceneCheckPlan {
  status: SceneCheckStatus;
  releaseGroup: string | null;
  query: string;
  providers: Array<"predbnet" | "srrdb">;
  evidence: string[];
}

const NON_SCENE_GROUPS = new Set(["NOGROUP", "NO-GROUP", "UNKNOWN", "INTERNAL"]);

function looksLikeAbbreviatedSceneFilename(title: string): boolean {
  const filename = title.split(/[\\/]/).at(-1) ?? title;
  return /^[a-z0-9]{2,8}-[a-z0-9][a-z0-9._-]+\.(mkv|mp4|avi|m2ts)$/i.test(filename);
}

export function buildSceneCheckPlan(candidate: TorrentCandidate): SceneCheckPlan {
  const group = extractReleaseGroup(candidate.title);
  const evidence: string[] = [];
  let status: SceneCheckStatus = "not_scene";

  if (group && !NON_SCENE_GROUPS.has(group.toUpperCase())) {
    status = "needs_verification";
    evidence.push("Release group suffix detected.");
  }

  if (looksLikeAbbreviatedSceneFilename(candidate.title)) {
    status = "needs_verification";
    evidence.push("Filename looks like an abbreviated scene filename.");
  }

  if (group && /^[A-Z0-9]{2,}$/.test(group) && !candidate.title.includes(" ")) {
    status = "likely_scene";
    evidence.push("Release naming matches common scene punctuation and group casing.");
  }

  if (evidence.length === 0) {
    evidence.push("No strong scene naming signals detected.");
  }

  return {
    status,
    releaseGroup: group,
    query: candidate.title.replace(/\.(mkv|mp4|avi|m2ts)$/i, ""),
    providers: ["predbnet", "srrdb"],
    evidence
  };
}
