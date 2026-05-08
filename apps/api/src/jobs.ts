import { randomUUID } from "node:crypto";
import {
  UPLOAD_PHASES,
  buildUploadPlan,
  parseTorrentTitle,
  type BrowserCheckResult,
  type JobManifest,
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
    mediainfo?: string;
    bdinfo?: string;
    releaseName?: string;
    description?: string;
    duplicateResult?: string;
    uploadTorrent?: string;
    qbReady?: boolean;
  };
  workspace?: {
    dataRoot: string;
    jobRoot: string;
    manifest: string;
  };
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

export class JobRepository {
  private readonly jobs = new Map<string, Job>();

  constructor(
    initialJobs: Job[] = [],
    private readonly options: JobRepositoryOptions = {}
  ) {
    for (const job of initialJobs) this.jobs.set(job.id, job);
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
      humanStep: state === "done" ? "Upload workflow complete" : "Review upload package",
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
    this.jobs.set(job.id, job);
    return job;
  }

  start(id: string): Job | null {
    return this.startUpload(id);
  }

  pause(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.state = "paused";
    this.setPhaseState(job, job.phase, "pending", "Paused.");
    return this.record(job, "info", "Job paused.", { phase: job.phase });
  }

  retry(id: string): Job | null {
    return this.retryFailed(id);
  }

  markPreparedForReview(id: string, input: { uploadReadiness: UploadReadiness; artifacts: Job["artifacts"] }): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.state = "review";
    job.phase = "review";
    job.uploadReadiness = input.uploadReadiness;
    job.artifacts = input.artifacts;
    job.humanStep = "Review upload package";
    this.setPhaseState(job, "review", input.uploadReadiness === "ready" ? "pending" : "warning", "Review upload package.");
    return this.record(job, input.uploadReadiness === "ready" ? "info" : "warn", "Upload package ready for review.", {
      uploadReadiness: input.uploadReadiness
    });
  }

  attachWorkspace(id: string, input: AttachWorkspaceInput): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
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

  retryFailed(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.state !== "failed" && !job.phases.some((item) => item.state === "failed")) {
      return this.record(job, "warn", "Retry is only available for failed jobs.", { phase: job.phase });
    }
    const run = job.phases.find((item) => item.phase === job.phase);
    if (run) {
      run.retryCount += 1;
      run.state = "pending";
      run.message = "Retry queued.";
      delete run.startedAt;
      delete run.finishedAt;
    }
    job.state = "preparing";
    job.humanStep = "Preparing upload package";
    return this.record(job, "info", "Retry queued.", { phase: job.phase });
  }

  markNeedsReseed(id: string, message: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.state = "needs_reseed";
    job.humanStep = "Needs reseed";
    return this.record(job, "warn", message);
  }

  markReseeded(id: string, infoHash: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.state = "seeding";
    job.humanStep = "Seeding";
    return this.record(job, "info", "Reseed complete.", { infoHash });
  }

  advance(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (hasOpenGate(job, "blocker")) {
      this.setPhaseState(job, job.phase, "warning", "Blocked by review gate.");
      job.state = "review";
      job.humanStep = "Review upload package";
      return this.record(job, "warn", "Advance blocked by open review gate.", { phase: job.phase });
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
      job.humanStep = "Upload workflow complete";
      this.setPhaseState(job, "done", "done", "Upload workflow complete.");
      return this.record(job, "info", "Job completed.");
    }

    job.phase = next;
    job.state = next === "upload" ? "uploading" : "preparing";
    job.humanStep = next === "upload" ? "Uploading to tracker" : "Preparing upload package";
    this.setPhaseState(job, next, "running", "Running.");
    return this.record(job, "info", "Advanced to next phase.", { phase: next });
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
    if (state === "done" || state === "failed" || state === "warning") run.finishedAt = now;
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
