import { PrismaClient } from "@prisma/client";
import type { CacheEntry, CacheStore, DownloadStatus, NormalizedPtpResponse, UploadReadiness } from "@popcorn-queue/core";
import {
  JobRepository,
  type AttachWorkspaceInput,
  type CreateJobInput,
  type ImportRestoredJobInput,
  type Job,
  type JobPhase,
  type PreparationResultInput,
  type JobRepositoryOptions,
  type JobState,
  type PhaseState
} from "./jobs.js";

const DEFAULT_DATABASE_URL = "file:./popcorn-queue.db";

interface JobRow {
  id: string;
  state: string;
  phase: string;
  sourceJson: string;
  candidateJson: string | null;
  checkResultJson: string | null;
  torrentJson: string | null;
  uploadReadiness: string | null;
  humanStep: string | null;
  artifactsJson: string | null;
  reviewDraftJson: string | null;
  workspaceJson: string | null;
  downloadStatusJson: string | null;
  uploadPlanJson: string;
  phasesJson: string;
  eventsJson: string;
  createdAt: Date;
  updatedAt: Date;
}

interface PtpCacheRow {
  key: string;
  dataJson: string;
  createdAt: Date;
  updatedAt: Date;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function parseOptionalJson<T>(value: string | null): T | undefined {
  return value === null ? undefined : parseJson<T>(value);
}

function stringifyOptional(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function normalizeLegacyJobState(state: string, phase: string): JobState {
  if (state === "waiting" || state === "queued") return "preparing";
  if (state === "running") return phase === "upload" ? "uploading" : "preparing";
  return state as JobState;
}

export function normalizeLegacyPhaseState(state: string): PhaseState {
  if (state === "blocked") return "warning";
  return state as PhaseState;
}

function createPrismaClient(): PrismaClient {
  process.env.DATABASE_URL ??= DEFAULT_DATABASE_URL;
  return new PrismaClient();
}

function serializeJob(job: Job) {
  return {
    id: job.id,
    state: job.state,
    phase: job.phase,
    sourceJson: JSON.stringify(job.source),
    candidateJson: stringifyOptional(job.candidate),
    checkResultJson: stringifyOptional(job.checkResult),
    torrentJson: stringifyOptional(job.torrent),
    uploadReadiness: job.uploadReadiness,
    humanStep: job.humanStep,
    artifactsJson: JSON.stringify(job.artifacts),
    reviewDraftJson: stringifyOptional(job.reviewDraft),
    workspaceJson: stringifyOptional(job.workspace),
    downloadStatusJson: stringifyOptional(job.downloadStatus),
    uploadPlanJson: JSON.stringify(job.uploadPlan),
    phasesJson: JSON.stringify(job.phases),
    eventsJson: JSON.stringify(job.events),
    createdAt: new Date(job.createdAt),
    updatedAt: new Date(job.updatedAt)
  };
}

function deserializeJob(row: JobRow): Job {
  const phases = parseJson<Job["phases"]>(row.phasesJson).map((phase) => ({
    ...phase,
    state: normalizeLegacyPhaseState(phase.state)
  }));
  const job: Job = {
    id: row.id,
    state: normalizeLegacyJobState(row.state, row.phase),
    phase: row.phase as JobPhase,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    source: parseJson<Job["source"]>(row.sourceJson),
    uploadReadiness: (row.uploadReadiness ?? "missing_evidence") as UploadReadiness,
    humanStep: row.humanStep ?? "Preparing upload package",
    artifacts: parseOptionalJson<Job["artifacts"]>(row.artifactsJson) ?? {},
    uploadPlan: parseJson<Job["uploadPlan"]>(row.uploadPlanJson),
    phases,
    events: parseJson<Job["events"]>(row.eventsJson)
  };

  const workspace = parseOptionalJson<Job["workspace"]>(row.workspaceJson);
  if (workspace !== undefined) job.workspace = workspace;
  const reviewDraft = parseOptionalJson<Job["reviewDraft"]>(row.reviewDraftJson);
  if (reviewDraft !== undefined) job.reviewDraft = reviewDraft;
  const downloadStatus = parseOptionalJson<Job["downloadStatus"]>(row.downloadStatusJson);
  if (downloadStatus !== undefined) job.downloadStatus = downloadStatus;
  const candidate = parseOptionalJson<Job["candidate"]>(row.candidateJson);
  if (candidate !== undefined) job.candidate = candidate;
  const checkResult = parseOptionalJson<Job["checkResult"]>(row.checkResultJson);
  if (checkResult !== undefined) job.checkResult = checkResult;
  const torrent = parseOptionalJson<Job["torrent"]>(row.torrentJson);
  if (torrent !== undefined) job.torrent = torrent;

  return job;
}

export class PrismaPersistence {
  readonly prisma = createPrismaClient();
  private ensurePromise: Promise<void> | null = null;

  readonly jobs = new PrismaJobRepository(this);
  readonly ptpCache = new PrismaPtpCacheStore<NormalizedPtpResponse>(this);

  constructor(readonly options: { jobs?: JobRepositoryOptions } = {}) {}

  async ensure(): Promise<void> {
    this.ensurePromise ??= this.createTables();
    return this.ensurePromise;
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  private async createTables(): Promise<void> {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Job" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "state" TEXT NOT NULL,
        "phase" TEXT NOT NULL,
        "source" TEXT NOT NULL,
        "candidate" TEXT,
        "check_result" TEXT,
        "torrent" TEXT,
        "upload_readiness" TEXT NOT NULL DEFAULT 'missing_evidence',
        "human_step" TEXT NOT NULL DEFAULT 'Preparing upload package',
        "artifacts" TEXT NOT NULL DEFAULT '{}',
        "review_draft" TEXT,
        "workspace" TEXT,
        "download_status" TEXT,
        "upload_plan" TEXT NOT NULL,
        "phases" TEXT NOT NULL,
        "events" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )
    `);
    await this.addColumnIfMissing("Job", "upload_readiness", "TEXT NOT NULL DEFAULT 'missing_evidence'");
    await this.addColumnIfMissing("Job", "human_step", "TEXT NOT NULL DEFAULT 'Preparing upload package'");
    await this.addColumnIfMissing("Job", "artifacts", "TEXT NOT NULL DEFAULT '{}'");
    await this.addColumnIfMissing("Job", "review_draft", "TEXT");
    await this.addColumnIfMissing("Job", "workspace", "TEXT");
    await this.addColumnIfMissing("Job", "download_status", "TEXT");
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "Job_createdAt_idx" ON "Job"("createdAt")
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "PtpCacheEntry" (
        "key" TEXT NOT NULL PRIMARY KEY,
        "data" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )
    `);
  }

  private async addColumnIfMissing(table: string, column: string, definition: string): Promise<void> {
    const columns = await this.prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("${table}")`);
    if (columns.some((item) => item.name === column)) return;
    await this.prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
  }
}

export class PrismaJobRepository {
  constructor(private readonly persistence: PrismaPersistence) {}

  async createFromBrowser(input: Parameters<JobRepository["createFromBrowser"]>[0]): Promise<Job> {
    const job = new JobRepository([], this.persistence.options.jobs).createFromBrowser(input);
    await this.save(job);
    return job;
  }

  async create(input: CreateJobInput): Promise<Job> {
    const job = new JobRepository([], this.persistence.options.jobs).create(input);
    await this.save(job);
    return job;
  }

  async list(): Promise<Job[]> {
    await this.persistence.ensure();
    const rows = await this.persistence.prisma.job.findMany({ orderBy: { createdAt: "desc" } });
    return rows.map((row) => deserializeJob(row));
  }

  async get(id: string): Promise<Job | null> {
    await this.persistence.ensure();
    const row = await this.persistence.prisma.job.findUnique({ where: { id } });
    return row ? deserializeJob(row) : null;
  }

  async importRestored(input: ImportRestoredJobInput): Promise<Job> {
    const job = new JobRepository([], this.persistence.options.jobs).importRestored(input);
    await this.save(job);
    return job;
  }

  async start(id: string): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.start(id));
  }

  async startUpload(id: string): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.startUpload(id));
  }

  async pause(id: string): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.pause(id));
  }

  async retry(id: string): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.retry(id));
  }

  async retryFailed(id: string): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.retryFailed(id));
  }

  async updateDownloadStatus(id: string, status: DownloadStatus): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.updateDownloadStatus(id, status));
  }

  async markPreparedForReview(id: string, input: Parameters<JobRepository["markPreparedForReview"]>[1]): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.markPreparedForReview(id, input));
  }

  async attachWorkspace(id: string, input: AttachWorkspaceInput): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.attachWorkspace(id, input));
  }

  async markPreparationResult(id: string, input: PreparationResultInput): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.markPreparationResult(id, input));
  }

  async updateReviewDraft(id: string, patch: Parameters<JobRepository["updateReviewDraft"]>[1]): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.updateReviewDraft(id, patch));
  }

  async markUploadResult(id: string, result: Parameters<JobRepository["markUploadResult"]>[1], phases?: Parameters<JobRepository["markUploadResult"]>[2]): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.markUploadResult(id, result, phases));
  }

  async markUploadFailed(id: string, message: string, phases?: Parameters<JobRepository["markUploadFailed"]>[2]): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.markUploadFailed(id, message, phases));
  }

  async markRestoreBlocked(id: string, input: Parameters<JobRepository["markRestoreBlocked"]>[1]): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.markRestoreBlocked(id, input));
  }

  async markNeedsReseed(id: string, message: string): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.markNeedsReseed(id, message));
  }

  async markReseeded(id: string, infoHash: string): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.markReseeded(id, infoHash));
  }

  async advance(id: string): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.advance(id));
  }

  async resolveGate(id: string, gateId: string): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.resolveGate(id, gateId));
  }

  async refreshPlan(id: string): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.refreshPlan(id));
  }

  private async withJob(id: string, update: (repo: JobRepository) => Job | null): Promise<Job | null> {
    const job = await this.get(id);
    if (!job) return null;
    const updated = update(new JobRepository([job], this.persistence.options.jobs));
    if (updated) await this.save(updated);
    return updated;
  }

  private async save(job: Job): Promise<void> {
    await this.persistence.ensure();
    const data = serializeJob(job);
    await this.persistence.prisma.job.upsert({
      where: { id: job.id },
      create: data,
      update: data
    });
  }
}

export class PrismaPtpCacheStore<T> implements CacheStore<T> {
  constructor(private readonly persistence: PrismaPersistence) {}

  async get(key: string): Promise<CacheEntry<T> | null> {
    await this.persistence.ensure();
    const row = await this.persistence.prisma.ptpCacheEntry.findUnique({ where: { key } });
    return row ? this.deserialize(row) : null;
  }

  async set(key: string, data: T): Promise<CacheEntry<T>> {
    await this.persistence.ensure();
    const now = new Date();
    const dataJson = JSON.stringify(data);
    const row = await this.persistence.prisma.ptpCacheEntry.upsert({
      where: { key },
      create: { key, dataJson, createdAt: now, updatedAt: now },
      update: { dataJson, updatedAt: now }
    });
    return this.deserialize(row);
  }

  async delete(key: string): Promise<void> {
    await this.persistence.ensure();
    await this.persistence.prisma.ptpCacheEntry.deleteMany({ where: { key } });
  }

  private deserialize(row: PtpCacheRow): CacheEntry<T> {
    return {
      key: row.key,
      data: parseJson<T>(row.dataJson),
      createdAt: row.updatedAt.getTime()
    };
  }
}
