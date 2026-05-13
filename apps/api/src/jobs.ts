import { randomUUID } from "node:crypto";
import {
  UPLOAD_PHASES,
  buildReviewDraft,
  buildUploadPlan,
  mergeSlashSeparated,
  mergeReviewDraft,
  parseTorrentTitle,
  type BrowserCheckResult,
  type DownloadStatus,
  type JobManifest,
  type ManualIntakePtpTarget,
  type PtpUploadResult,
  type ReviewDraft,
  type ReviewDraftPatch,
  type ReviewGate,
  type TorrentCandidate,
  type UploadReadiness,
  type UploadPhase,
  type UploadPlan
} from "@popcorn-queue/core";

export const JOB_PHASES = UPLOAD_PHASES;

export type JobPhase = UploadPhase;
export type JobState = "created" | "preparing" | "review" | "uploading" | "paused" | "failed" | "done" | "needs_reseed" | "seeding";
export type PhaseState = "pending" | "running" | "done" | "warning" | "failed" | "skipped";

export interface PhaseRun {
  phase: JobPhase;
  state: PhaseState;
  startedAt?: string;
  finishedAt?: string;
  retryCount: number;
  message: string;
}

export interface JobEvent {
  id: string;
  at: string;
  level: "info" | "warn" | "error";
  message: string;
  payload?: unknown;
}

export interface Job {
  id: string;
  state: JobState;
  phase: JobPhase;
  createdAt: string;
  updatedAt: string;
  source: {
    site?: string;
    url?: string;
    title?: string;
    mediaPath?: string;
    torrentUrl?: string;
    ptpTarget?: ManualIntakePtpTarget;
  };
  candidate?: TorrentCandidate;
  checkResult?: BrowserCheckResult;
  torrent?: {
    filename: string;
    bytes: number;
    contentType?: string;
    filePath?: string;
  };
  uploadReadiness: UploadReadiness;
  humanStep: string;
  artifacts: {
    mediaFiles?: string[];
    screenshots?: string[];
    screenshotPreviews?: string[];
    mediainfo?: string;
    mediaInfoText?: string;
    mediaInfoJson?: string;
    bdinfo?: string;
    releaseName?: string;
    description?: string;
    duplicateResult?: string;
    uploadTorrent?: string;
    qbReady?: boolean;
    reviewBlockers?: string[];
    reviewWarnings?: string[];
    mediaFeatureSuggestions?: string[];
    ptpUrl?: string;
    ptpGroupId?: string;
    ptpTorrentId?: string;
  };
  reviewDraft?: ReviewDraft;
  workspace?: {
    dataRoot: string;
    jobRoot: string;
    manifest: string;
  };
  downloadStatus?: DownloadStatus;
  uploadPlan: UploadPlan;
  phases: PhaseRun[];
  events: JobEvent[];
}

export interface CreateJobInput {
  candidate: TorrentCandidate;
  checkResult?: BrowserCheckResult;
  torrent?: Job["torrent"];
  sourceUrl?: string;
  sourceSite?: string;
  title?: string;
}

export interface JobRepositoryOptions {
  imageHosts?: string[];
  screenshotCount?: number;
}

export interface ImportRestoredJobInput {
  jobPath: string;
  manifest: JobManifest;
}

export interface AttachWorkspaceInput {
  workspace: Job["workspace"];
  torrentFilePath?: string;
  source?: Partial<Job["source"]>;
}

export interface PreparationResultInput {
  state: JobState;
  phase: JobPhase;
  uploadReadiness: UploadReadiness;
  humanStep: string;
  artifacts: Job["artifacts"];
  phases: PhaseRun[];
  eventLevel: JobEvent["level"];
  eventMessage: string;
  workspace?: Job["workspace"];
}

export interface PreparationPhaseFinishedInput {
  phase: JobPhase;
  state: PhaseState;
  message: string;
}

export const RETRYABLE_COMPLETED_PHASES = new Set<JobPhase>([
  "metadata",
  "duplicate-check",
  "inspect-media",
  "screenshots",
  "image-host-upload",
  "torrent-create",
  "preflight",
  "post-hook"
]);

export const PHASE_RETRY_DEPENDENCIES: Partial<Record<JobPhase, JobPhase[]>> = {
  metadata: ["metadata", "preflight", "review"],
  "duplicate-check": ["duplicate-check", "preflight", "review"],
  "inspect-media": ["inspect-media", "preflight", "review"],
  screenshots: ["screenshots", "image-host-upload", "preflight", "review"],
  "image-host-upload": ["image-host-upload", "preflight", "review"],
  "torrent-create": ["torrent-create", "preflight", "review"],
  preflight: ["preflight", "review"],
  "post-hook": ["post-hook"]
};

export interface RestoreValidationFailureInput {
  message: string;
  missingFiles: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function hasOpenGate(job: Pick<Job, "uploadPlan">, severity?: ReviewGate["severity"]): boolean {
  return job.uploadPlan.reviewGates.some((gate) => gate.status === "open" && (!severity || gate.severity === severity));
}

function canEnterUpload(job: Pick<Job, "uploadReadiness" | "uploadPlan">): boolean {
  return job.uploadReadiness === "ready" && !hasOpenGate(job, "blocker");
}

function makePhases(startPhase: JobPhase): PhaseRun[] {
  return JOB_PHASES.map((phase) => ({
    phase,
    state: phase === startPhase ? "pending" : "pending",
    retryCount: 0,
    message: phase === startPhase ? "Ready." : "Waiting."
  }));
}

function phaseIndex(phase: JobPhase): number {
  return JOB_PHASES.findIndex((item) => item === phase);
}

function mergeGateStatus(nextPlan: UploadPlan, previous?: UploadPlan): UploadPlan {
  if (!previous) return nextPlan;
  const previousStatus = new Map(previous.reviewGates.map((gate) => [gate.id, gate.status]));
  return {
    ...nextPlan,
    reviewGates: nextPlan.reviewGates.map((gate) => ({
      ...gate,
      status: previousStatus.get(gate.id) ?? gate.status
    }))
  };
}

function buildJobReviewDraft(job: Pick<Job, "candidate" | "uploadPlan" | "artifacts" | "checkResult">): ReviewDraft | undefined {
  if (!job.candidate) return undefined;
  const artifacts: Parameters<typeof buildReviewDraft>[0]["artifacts"] = {};
  if (job.artifacts.releaseName !== undefined) artifacts.releaseName = job.artifacts.releaseName;
  if (job.artifacts.description !== undefined) artifacts.description = job.artifacts.description;
  if (job.artifacts.mediainfo !== undefined) artifacts.mediainfo = job.artifacts.mediainfo;
  if (job.artifacts.mediaFeatureSuggestions !== undefined) artifacts.mediaFeatureSuggestions = job.artifacts.mediaFeatureSuggestions;
  const input: Parameters<typeof buildReviewDraft>[0] = {
    candidate: job.candidate,
    uploadPlan: job.uploadPlan,
    artifacts
  };
  if (job.checkResult) input.checkResult = job.checkResult;
  return buildReviewDraft(input);
}

function reviewDraftFieldWasEdited(job: Job, field: keyof ReviewDraft): boolean {
  return job.events.some((event) => {
    if (event.message !== "Review draft updated.") return false;
    const fields = (event.payload as { fields?: unknown } | undefined)?.fields;
    return Array.isArray(fields) && fields.includes(field);
  });
}

function ensureReviewDraft(job: Job): void {
  const draft = buildJobReviewDraft(job);
  if (!draft) return;
  if (!job.reviewDraft) {
    job.reviewDraft = draft;
    return;
  }
  const draftWasEdited = job.events.some((event) => event.message === "Review draft updated.");
  const shouldMergeEditionSuggestions = !draftWasEdited || job.reviewDraft.remaster || Boolean(job.reviewDraft.remasterTitle);
  const shouldRefreshGeneratedDescription = !reviewDraftFieldWasEdited(job, "description") && Boolean(draft.description);
  job.reviewDraft = {
    ...draft,
    ...job.reviewDraft,
    releaseName: job.reviewDraft.releaseName || draft.releaseName,
    description: shouldRefreshGeneratedDescription ? draft.description : job.reviewDraft.description || draft.description,
    groupId: job.reviewDraft.groupId ?? draft.groupId,
    type: job.reviewDraft.type || draft.type,
    codec: job.reviewDraft.codec || draft.codec,
    container: job.reviewDraft.container || draft.container,
    resolution: job.reviewDraft.resolution || draft.resolution,
    source: job.reviewDraft.source || draft.source,
    imdb: job.reviewDraft.imdb || draft.imdb || "",
    title: job.reviewDraft.title || draft.title || "",
    year: job.reviewDraft.year || draft.year || "",
    remaster: shouldMergeEditionSuggestions ? job.reviewDraft.remaster || Boolean(draft.remasterTitle) : Boolean(job.reviewDraft.remaster),
    remasterTitle: shouldMergeEditionSuggestions ? mergeSlashSeparated(job.reviewDraft.remasterTitle, draft.remasterTitle) : job.reviewDraft.remasterTitle,
    subtitles: job.reviewDraft.subtitles.length ? job.reviewDraft.subtitles : draft.subtitles,
    trumpable: job.reviewDraft.trumpable.length ? job.reviewDraft.trumpable : draft.trumpable,
    artists: job.reviewDraft.artists?.length ? job.reviewDraft.artists : draft.artists ?? []
  };
}

export function repairJobRuntimeState(job: Job): Job {
  const postHook = job.phases.find((phase) => phase.phase === "post-hook");
  if (postHook?.state === "failed" && (job.state === "done" || job.phase === "done")) {
    job.state = "needs_reseed";
    job.phase = "post-hook";
    job.humanStep = "Needs reseed";
    const done = job.phases.find((phase) => phase.phase === "done");
    if (done) {
      done.state = "pending";
      done.message = "Waiting for seed handoff.";
      delete done.finishedAt;
    }
  }
  if (job.state === "needs_reseed") {
    job.phase = "post-hook";
    job.humanStep = "Needs reseed";
  }
  return job;
}

export class JobRepository {
  private readonly jobs = new Map<string, Job>();

  constructor(
    initialJobs: Job[] = [],
    private options: JobRepositoryOptions = {}
  ) {
    for (const job of initialJobs) {
      const repaired = repairJobRuntimeState(job);
      this.jobs.set(repaired.id, repaired);
    }
  }

  setOptions(options: JobRepositoryOptions): void {
    this.options = { ...this.options, ...options };
  }

  createFromBrowser(input: {
    candidate?: TorrentCandidate;
    checkResult?: BrowserCheckResult;
    torrent?: Job["torrent"];
    sourceUrl?: string;
    sourceSite?: string;
    title?: string;
  }): Job {
    const candidate = input.candidate ?? {
      site: (input.sourceSite as TorrentCandidate["site"]) ?? "unknown",
      title: input.title ?? input.torrent?.filename ?? "Untitled upload",
      sourceUrl: input.sourceUrl ?? null
    };
    const createInput: CreateJobInput = { candidate };
    if (input.checkResult) createInput.checkResult = input.checkResult;
    if (input.torrent) createInput.torrent = input.torrent;
    if (input.sourceUrl) createInput.sourceUrl = input.sourceUrl;
    if (input.sourceSite) createInput.sourceSite = input.sourceSite;
    if (input.title) createInput.title = input.title;
    return this.create(createInput);
  }

  create(input: CreateJobInput): Job {
    const createdAt = nowIso();
    const source: Job["source"] = {};
    if (input.sourceSite) source.site = input.sourceSite;
    if (input.sourceUrl) source.url = input.sourceUrl;
    if (input.title ?? input.candidate.title) source.title = input.title ?? input.candidate.title;

    const planInput: Parameters<typeof buildUploadPlan>[0] = { candidate: input.candidate };
    if (input.checkResult) planInput.checkResult = input.checkResult;
    if (input.torrent?.bytes !== undefined) planInput.torrentBytes = input.torrent.bytes;
    if (this.options.imageHosts) planInput.imageHosts = this.options.imageHosts;
    if (this.options.screenshotCount !== undefined) planInput.screenshotCount = this.options.screenshotCount;
    const uploadPlan = buildUploadPlan(planInput);
    const state: JobState = "preparing";
    const phase: JobPhase = "intake";
    const job: Job = {
      id: randomUUID(),
      state,
      phase,
      createdAt,
      updatedAt: createdAt,
      source,
      uploadReadiness: "missing_evidence",
      humanStep: "Preparing upload package",
      artifacts: {},
      uploadPlan,
      phases: makePhases(phase),
      events: [
        {
          id: randomUUID(),
          at: createdAt,
          level: "info",
          message: "Job created and preparing upload package."
        }
      ]
    };

    job.candidate = input.candidate;
    if (input.checkResult) job.checkResult = input.checkResult;
    if (input.torrent) job.torrent = input.torrent;
    ensureReviewDraft(job);
    this.jobs.set(job.id, job);
    return job;
  }

  list(): Job[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Job | null {
    return this.jobs.get(id) ?? null;
  }

  importRestored(input: ImportRestoredJobInput): Job {
    const createdAt = input.manifest.createdAt;
    const title = typeof input.manifest.source.title === "string" ? input.manifest.source.title : input.manifest.jobId;
    const candidate: TorrentCandidate = {
      site: "unknown",
      title
    };
    const uploadPlan = buildUploadPlan({ candidate });
    const state = this.restoreState(input.manifest.state);
    const phase: JobPhase = state === "done" || state === "seeding" || state === "needs_reseed" ? "done" : "review";
    const job: Job = {
      id: input.manifest.jobId,
      state,
      phase,
      createdAt,
      updatedAt: nowIso(),
      source: {
        title
      },
      candidate,
      uploadReadiness: "ready",
      humanStep: state === "done" ? "Complete" : "Review upload package",
      artifacts: {
        mediaFiles: input.manifest.uploadFiles,
        ...(input.manifest.torrentFile ? { uploadTorrent: input.manifest.torrentFile } : {})
      },
      workspace: {
        dataRoot: "",
        jobRoot: input.jobPath,
        manifest: `${input.jobPath}/manifest.json`
      },
      uploadPlan,
      phases: makePhases(phase),
      events: [
        {
          id: randomUUID(),
          at: nowIso(),
          level: "info",
          message: "Restored job imported."
        }
      ]
    };
    ensureReviewDraft(job);
    this.jobs.set(job.id, job);
    return job;
  }

  start(id: string): Job | null {
    return this.startUpload(id);
  }

  markPreparationResumed(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.state = "preparing";
    job.humanStep = "Preparing upload package";
    return this.record(job, "info", "Resuming preparation after API startup.", { phase: job.phase });
  }

  markPreparationPhaseStarted(id: string, phase: JobPhase): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.state = "preparing";
    job.phase = phase;
    job.humanStep = phase === "review" ? "Preparing review package" : "Preparing upload package";
    this.setPhaseState(job, phase, "running", "Running.");
    job.updatedAt = nowIso();
    return job;
  }

  markPreparationPhaseFinished(id: string, input: PreparationPhaseFinishedInput): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    this.setPhaseState(job, input.phase, input.state, input.message);
    job.updatedAt = nowIso();
    return job;
  }

  pause(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.state = "paused";
    this.setPhaseState(job, job.phase, "pending", "Paused.");
    return this.record(job, "info", "Job paused.", { phase: job.phase });
  }

  resume(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.state !== "paused") return this.record(job, "warn", "Resume is only available for paused jobs.", { phase: job.phase });
    if (job.phase === "review") {
      job.state = "review";
      job.humanStep = "Review upload package";
      this.setPhaseState(job, "review", job.uploadReadiness === "ready" ? "pending" : "warning", "Review upload package.");
    } else if (job.phase === "upload") {
      job.state = "uploading";
      job.humanStep = "Uploading to tracker";
      this.setPhaseState(job, "upload", "running", "Uploading.");
    } else {
      job.state = "preparing";
      job.humanStep = "Preparing upload package";
      this.setPhaseState(job, job.phase, "pending", "Resume queued.");
    }
    return this.record(job, "info", "Job resumed.", { phase: job.phase });
  }

  retry(id: string): Job | null {
    return this.retryFailed(id);
  }

  updateDownloadStatus(id: string, status: DownloadStatus): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.downloadStatus = status;
    job.updatedAt = nowIso();
    return job;
  }

  markPreparedForReview(id: string, input: { uploadReadiness: UploadReadiness; artifacts: Job["artifacts"] }): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.state = "review";
    job.phase = "review";
    job.uploadReadiness = input.uploadReadiness;
    job.artifacts = input.artifacts;
    ensureReviewDraft(job);
    job.humanStep = "Review upload package";
    this.setPhaseState(job, "review", input.uploadReadiness === "ready" ? "pending" : "warning", "Review upload package.");
    return this.record(job, input.uploadReadiness === "ready" ? "info" : "warn", "Upload package ready for review.", {
      uploadReadiness: input.uploadReadiness
    });
  }

  attachWorkspace(id: string, input: AttachWorkspaceInput): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (input.source) job.source = { ...job.source, ...input.source };
    if (input.workspace) job.workspace = input.workspace;
    if (input.torrentFilePath && job.torrent) job.torrent.filePath = input.torrentFilePath;
    return this.record(job, "info", "Job workspace prepared.", { jobRoot: input.workspace?.jobRoot });
  }

  markPreparationResult(id: string, input: PreparationResultInput): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.state = input.state;
    job.phase = input.phase;
    job.uploadReadiness = input.uploadReadiness;
    job.humanStep = input.humanStep;
    job.artifacts = input.artifacts;
    job.phases = input.phases;
    if (input.workspace) job.workspace = input.workspace;
    if (job.state === "review" || job.phase === "review") ensureReviewDraft(job);
    return this.record(job, input.eventLevel, input.eventMessage, {
      phase: input.phase,
      uploadReadiness: input.uploadReadiness
    });
  }

  startUpload(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (!canEnterUpload(job)) return this.blockUploadStart(job);
    job.state = "uploading";
    job.phase = "upload";
    job.humanStep = "Uploading to tracker";
    this.setPhaseState(job, "upload", "running", "Uploading.");
    return this.record(job, "info", "Upload started.", { phase: job.phase });
  }

  updateReviewDraft(id: string, patch: ReviewDraftPatch): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    const current = job.reviewDraft ?? buildJobReviewDraft(job);
    if (!current) return this.record(job, "warn", "Review draft is not available yet.");
    job.reviewDraft = mergeReviewDraft(current, patch);
    return this.record(job, "info", "Review draft updated.", { fields: Object.keys(patch).sort() });
  }

  markUploadResult(id: string, result: PtpUploadResult, phases?: PhaseRun[]): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.artifacts = {
      ...job.artifacts,
      ptpUrl: result.ptpUrl,
      ptpGroupId: result.groupId,
      ptpTorrentId: result.torrentId
    };
    if (phases) job.phases = phases;
    this.setPhaseState(job, "upload", "done", "PTP upload submitted.");
    const postHook = job.phases.find((run) => run.phase === "post-hook");
    if (postHook?.state === "failed") {
      job.state = "needs_reseed";
      job.phase = "post-hook";
      job.humanStep = "Needs reseed";
      return this.record(job, "warn", "PTP upload complete but qBittorrent seed handoff failed.", {
        ...result,
        message: postHook.message
      });
    }

    job.state = "done";
    job.phase = "done";
    job.humanStep = "Complete";
    if (!postHook || postHook.state === "pending" || postHook.state === "running") {
      this.setPhaseState(job, "post-hook", "skipped", "No post-upload hooks are configured.");
    }
    this.setPhaseState(job, "done", "done", "Complete.");
    return this.record(job, "info", "PTP upload complete.", result);
  }

  markUploadFailed(id: string, message: string, phases?: PhaseRun[]): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.state = "failed";
    job.phase = "upload";
    job.humanStep = "Upload failed";
    if (phases) job.phases = phases;
    this.setPhaseState(job, "upload", "failed", message);
    return this.record(job, "error", "PTP upload failed.", { message });
  }

  markRestoreBlocked(id: string, input: RestoreValidationFailureInput): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.state = "review";
    job.phase = "review";
    job.uploadReadiness = "missing_evidence";
    job.humanStep = "Restore needs files";
    this.setPhaseState(job, "review", "warning", input.message);
    return this.record(job, "warn", input.message, { missingFiles: input.missingFiles });
  }

  retryFailed(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    const retryPhase = job.phase;
    const run = job.phases.find((item) => item.phase === retryPhase);
    const hasFailedPhase = job.phases.some((item) => item.state === "failed");
    const isQueuedUploadRetry = job.state === "preparing" && retryPhase === "upload" && run?.state === "pending" && job.uploadReadiness === "ready";
    if (job.state !== "failed" && !hasFailedPhase && !isQueuedUploadRetry) {
      return this.record(job, "warn", "Retry is only available for failed jobs.", { phase: job.phase });
    }
    if (run) {
      run.retryCount += 1;
      run.state = "pending";
      run.message = "Retry queued.";
      delete run.startedAt;
      delete run.finishedAt;
    }
    if (retryPhase === "upload") {
      job.state = "review";
      job.phase = "review";
      job.humanStep = "Review upload package";
      this.setPhaseState(job, "review", job.uploadReadiness === "ready" ? "pending" : "warning", "Review upload package.");
      ensureReviewDraft(job);
      return this.record(job, "info", "Retry queued.", { phase: retryPhase });
    }
    job.state = "preparing";
    job.humanStep = "Preparing upload package";
    return this.record(job, "info", "Retry queued.", { phase: retryPhase });
  }

  retryCompletedPhase(id: string, phase: JobPhase): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (!RETRYABLE_COMPLETED_PHASES.has(phase)) {
      return this.record(job, "warn", `Phase retry is not available for ${phase}.`, { phase });
    }
    const run = job.phases.find((item) => item.phase === phase);
    if (!run) return this.record(job, "warn", `Phase retry is not available for ${phase}.`, { phase });
    if (run.state !== "done" && run.state !== "failed" && run.state !== "warning") {
      return this.record(job, "warn", `Phase retry is only available after ${phase} has run.`, { phase, state: run.state });
    }

    const affected = PHASE_RETRY_DEPENDENCIES[phase] ?? [phase];
    for (const affectedPhase of affected) {
      const affectedRun = job.phases.find((item) => item.phase === affectedPhase);
      if (!affectedRun) continue;
      if (affectedPhase === phase) affectedRun.retryCount += 1;
      affectedRun.state = "pending";
      affectedRun.message = affectedPhase === phase ? "Retry queued." : `Waiting for ${phase} retry.`;
      delete affectedRun.startedAt;
      delete affectedRun.finishedAt;
    }

    job.state = phase === "post-hook" ? "needs_reseed" : "preparing";
    job.phase = phase;
    job.humanStep = phase === "post-hook" ? "Needs reseed" : "Preparing upload package";
    return this.record(job, "info", "Phase retry queued.", { phase, affected });
  }

  markNeedsReseed(id: string, message: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.state = "needs_reseed";
    job.phase = "post-hook";
    job.humanStep = "Needs reseed";
    this.setPhaseState(job, "post-hook", "warning", message);
    return this.record(job, "warn", message);
  }

  markReseeded(id: string, infoHash: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.state = "seeding";
    job.phase = "done";
    job.humanStep = "Seeding";
    this.setPhaseState(job, "post-hook", "done", "PTP upload torrent handed to qBittorrent for seeding.");
    this.setPhaseState(job, "done", "done", "Complete.");
    return this.record(job, "info", "Reseed complete.", { infoHash });
  }

  skip(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (hasOpenGate(job, "blocker")) {
      this.setPhaseState(job, job.phase, "warning", "Blocked by review gate.");
      job.state = "review";
      job.humanStep = "Review upload package";
      return this.record(job, "warn", "Skip blocked by open review gate.", { phase: job.phase });
    }

    this.setPhaseState(job, job.phase, "done", "Finished.");
    const next = JOB_PHASES[phaseIndex(job.phase) + 1];
    if (next === "upload" && !canEnterUpload(job)) {
      job.state = "review";
      job.humanStep = "Review upload package";
      return this.blockUploadStart(job);
    }
    if (!next) {
      job.phase = "done";
      job.state = "done";
      job.humanStep = "Complete";
      this.setPhaseState(job, "done", "done", "Complete.");
      return this.record(job, "info", "Job completed.");
    }

    job.phase = next;
    job.state = next === "upload" ? "uploading" : "preparing";
    job.humanStep = next === "upload" ? "Uploading to tracker" : "Preparing upload package";
    this.setPhaseState(job, next, "running", "Running.");
    return this.record(job, "info", "Skipped to next phase.", { phase: next });
  }

  resolveGate(id: string, gateId: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    const gate = job.uploadPlan.reviewGates.find((item) => item.id === gateId);
    if (!gate) return job;
    gate.status = "resolved";
    if (hasOpenGate(job, "blocker") || hasOpenGate(job, "warning")) {
      job.state = "review";
      job.humanStep = "Review upload package";
    }
    return this.record(job, "info", "Review gate resolved.", { gateId });
  }

  refreshPlan(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job?.candidate) return job ?? null;
    const parsed = parseTorrentTitle(job.candidate.title, job.candidate.resolution);
    const planInput: Parameters<typeof buildUploadPlan>[0] = { candidate: job.candidate };
    if (job.checkResult) planInput.checkResult = job.checkResult;
    if (job.torrent?.bytes !== undefined) planInput.torrentBytes = job.torrent.bytes;
    if (this.options.imageHosts) planInput.imageHosts = this.options.imageHosts;
    if (this.options.screenshotCount !== undefined) planInput.screenshotCount = this.options.screenshotCount;
    const nextPlan = buildUploadPlan(planInput);
    job.uploadPlan = mergeGateStatus({ ...nextPlan, parsed }, job.uploadPlan);
    if (hasOpenGate(job, "blocker") || hasOpenGate(job, "warning")) {
      job.state = "review";
      job.humanStep = "Review upload package";
    }
    return this.record(job, "info", "Upload plan refreshed.");
  }

  private setPhaseState(job: Job, phase: JobPhase, state: PhaseState, message: string): void {
    const run = job.phases.find((item) => item.phase === phase);
    if (!run) return;
    const now = nowIso();
    run.state = state;
    run.message = message;
    if (state === "running" && !run.startedAt) run.startedAt = now;
    if (state === "done" || state === "failed" || state === "warning" || state === "skipped") run.finishedAt = now;
  }

  private blockUploadStart(job: Job): Job {
    job.state = "review";
    job.phase = "review";
    job.humanStep = "Review upload package";
    this.setPhaseState(job, "review", "warning", "Blocked until upload readiness is ready.");
    return this.record(job, "warn", "Cannot start upload until blockers and required evidence are resolved.");
  }

  private record(job: Job, level: JobEvent["level"], message: string, payload?: unknown): Job {
    job.updatedAt = nowIso();
    const event: JobEvent = {
      id: randomUUID(),
      at: job.updatedAt,
      level,
      message
    };
    if (payload !== undefined) event.payload = payload;
    job.events.unshift(event);
    job.events = job.events.slice(0, 100);
    return job;
  }

  private restoreState(state: string): JobState {
    if (state === "done" || state === "seeding" || state === "needs_reseed" || state === "review" || state === "failed") return state;
    return "review";
  }
}
