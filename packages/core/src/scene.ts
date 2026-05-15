import type { TorrentCandidate } from "./types.js";
import { extractReleaseGroup } from "./release.js";
import { knownSceneGroups } from "./generated/known-scene-groups.js";

export type SceneCheckStatus = "not_scene" | "needs_verification" | "likely_scene";

export interface SceneCheckPlan {
  status: SceneCheckStatus;
  releaseGroup: string | null;
  query: string;
  providers: Array<"predbnet" | "srrdb">;
  evidence: string[];
}

const knownSceneGroupSet = new Set(knownSceneGroups.map((group) => group.toUpperCase()));

export function isKnownSceneGroup(group: string | null | undefined): boolean {
  return Boolean(group && knownSceneGroupSet.has(group.toUpperCase()));
}

export function buildSceneCheckPlan(candidate: TorrentCandidate): SceneCheckPlan {
  const group = extractReleaseGroup(candidate.title);
  const evidence: string[] = [];
  const status: SceneCheckStatus = isKnownSceneGroup(group) ? "likely_scene" : "not_scene";
  if (!group) evidence.push("Release group suffix was not detected.");
  else if (status === "likely_scene") evidence.push("Release group is in the known scene group cache.");
  else evidence.push("Release group is not in the known scene group cache.");

  return {
    status,
    releaseGroup: group,
    query: candidate.title.replace(/\.(mkv|mp4|avi|m2ts)$/i, ""),
    providers: [],
    evidence
  };
}

export { knownSceneGroups };
