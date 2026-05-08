import { randomUUID } from "node:crypto";
import {
  UPLOAD_PHASES,
  buildUploadPlan,
  parseTorrentTitle,
  type BrowserCheckResult,
  type ReviewGate,
  type TorrentCandidate,
  type UploadPhase,
  type UploadPlan
} from "@popcorn-queue/core";

export const JOB_PHASES = UPLOAD_PHASES;

export type JobPhase = UploadPhase;
export type JobState = "waiting" | "review" | "queued" | "running" | "paused" | "failed" | "done";
export type PhaseState = "pending" | "running" | "done" | "blocked" | "failed" | "skipped";

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

function nowIso(): string {
  return new Date().toISOString();
}

function hasOpenGate(job: Pick<Job, "uploadPlan">, severity?: ReviewGate["severity"]): boolean {
  return job.uploadPlan.reviewGates.some((gate) => gate.status === "open" && (!severity || gate.severity === severity));
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
    const state: JobState = hasOpenGate({ uploadPlan }, "blocker") || hasOpenGate({ uploadPlan }, "warning") ? "review" : "queued";
    const phase = state === "review" ? uploadPlan.recommendedStartPhase : "intake";
    const job: Job = {
      id: randomUUID(),
      state,
      phase,
      createdAt,
      updatedAt: createdAt,
      source,
      uploadPlan,
      phases: makePhases(phase),
      events: [
        {
          id: randomUUID(),
          at: createdAt,
          level: state === "review" ? "warn" : "info",
          message: state === "review" ? "Job created with review gates." : "Job queued."
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

  start(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (hasOpenGate(job, "blocker")) {
      return this.record(job, "warn", "Cannot start while blocker review gates are open.");
    }
    job.state = "running";
    this.setPhaseState(job, job.phase, "running", "Running.");
    return this.record(job, "info", "Job started.", { phase: job.phase });
  }

  pause(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.state = "paused";
    this.setPhaseState(job, job.phase, "pending", "Paused.");
    return this.record(job, "info", "Job paused.", { phase: job.phase });
  }

  retry(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    const run = job.phases.find((item) => item.phase === job.phase);
    if (run) {
      run.retryCount += 1;
      run.state = "pending";
      run.message = "Retry queued.";
      delete run.startedAt;
      delete run.finishedAt;
    }
    job.state = hasOpenGate(job, "blocker") || hasOpenGate(job, "warning") ? "review" : "queued";
    return this.record(job, "info", "Retry queued.", { phase: job.phase });
  }

  advance(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (hasOpenGate(job, "blocker")) {
      this.setPhaseState(job, job.phase, "blocked", "Blocked by review gate.");
      return this.record(job, "warn", "Advance blocked by open review gate.", { phase: job.phase });
    }

    this.setPhaseState(job, job.phase, "done", "Finished.");
    const next = JOB_PHASES[phaseIndex(job.phase) + 1];
    if (!next) {
      job.phase = "done";
      job.state = "done";
      this.setPhaseState(job, "done", "done", "Upload workflow complete.");
      return this.record(job, "info", "Job completed.");
    }

    job.phase = next;
    job.state = "running";
    this.setPhaseState(job, next, "running", "Running.");
    return this.record(job, "info", "Advanced to next phase.", { phase: next });
  }

  resolveGate(id: string, gateId: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    const gate = job.uploadPlan.reviewGates.find((item) => item.id === gateId);
    if (!gate) return job;
    gate.status = "resolved";
    job.state = hasOpenGate(job, "blocker") || hasOpenGate(job, "warning") ? "review" : "queued";
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
    job.state = hasOpenGate(job, "blocker") || hasOpenGate(job, "warning") ? "review" : job.state;
    return this.record(job, "info", "Upload plan refreshed.");
  }

  private setPhaseState(job: Job, phase: JobPhase, state: PhaseState, message: string): void {
    const run = job.phases.find((item) => item.phase === phase);
    if (!run) return;
    const now = nowIso();
    run.state = state;
    run.message = message;
    if (state === "running" && !run.startedAt) run.startedAt = now;
    if (state === "done" || state === "failed" || state === "blocked") run.finishedAt = now;
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
}
