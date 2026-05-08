/// <reference types="node" />

import path from "node:path";

export interface JobWorkspacePaths {
  dataRoot: string;
  sourceRoot: string;
  sourceDownloadDir: string;
  sourceTorrent: string;
  sourceJson: string;
  jobRoot: string;
  inputDir: string;
  mediaUploadDir: string;
  mediaIntermediatesDir: string;
  screenshotsRawDir: string;
  screenshotsOptimizedDir: string;
  screenshotsHostedJson: string;
  torrentDir: string;
  uploadTorrent: string;
  metadataDir: string;
  logs: {
    dir: string;
    jobLog: string;
    phasesJsonl: string;
    externalJsonl: string;
  };
  manifest: string;
}

export interface JobManifestInput {
  jobId: string;
  createdAt: string;
  state: string;
  source: Record<string, unknown>;
  paths: JobWorkspacePaths;
  uploadFiles: string[];
  torrentFile: string | null;
  sourceRef: {
    sourceId: string | null;
    originalDownloadPresent: boolean;
  };
}

export interface JobManifest {
  version: 1;
  jobId: string;
  createdAt: string;
  state: string;
  source: Record<string, unknown>;
  uploadFiles: string[];
  torrentFile: string | null;
  sourceRef: {
    sourceId: string | null;
    originalDownloadPresent: boolean;
  };
}

export function buildJobWorkspacePaths(dataRoot: string, jobId: string, sourceId = jobId): JobWorkspacePaths {
  const jobRoot = path.join(dataRoot, "jobs", jobId);
  const sourceRoot = jobRoot;
  return {
    dataRoot,
    sourceRoot,
    sourceDownloadDir: path.join(jobRoot, "download"),
    sourceTorrent: path.join(jobRoot, "torrent", "source.torrent"),
    sourceJson: path.join(jobRoot, "input", "source.json"),
    jobRoot,
    inputDir: path.join(jobRoot, "input"),
    mediaUploadDir: path.join(jobRoot, "media", "upload"),
    mediaIntermediatesDir: path.join(jobRoot, "media", "intermediates"),
    screenshotsRawDir: path.join(jobRoot, "screenshots", "raw"),
    screenshotsOptimizedDir: path.join(jobRoot, "screenshots", "optimized"),
    screenshotsHostedJson: path.join(jobRoot, "screenshots", "hosted.json"),
    torrentDir: path.join(jobRoot, "torrent"),
    uploadTorrent: path.join(jobRoot, "torrent", "upload.torrent"),
    metadataDir: path.join(jobRoot, "metadata"),
    logs: {
      dir: path.join(jobRoot, "logs"),
      jobLog: path.join(jobRoot, "logs", "job.log"),
      phasesJsonl: path.join(jobRoot, "logs", "phases.jsonl"),
      externalJsonl: path.join(jobRoot, "logs", "external.jsonl")
    },
    manifest: path.join(jobRoot, "manifest.json")
  };
}

export function createJobManifest(input: JobManifestInput): JobManifest {
  return {
    version: 1,
    jobId: input.jobId,
    createdAt: input.createdAt,
    state: input.state,
    source: input.source,
    uploadFiles: input.uploadFiles,
    torrentFile: input.torrentFile,
    sourceRef: input.sourceRef
  };
}
