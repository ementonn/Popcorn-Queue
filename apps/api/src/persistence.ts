import { PrismaClient } from "@prisma/client";
import type { CacheEntry, CacheStore, NormalizedPtpResponse } from "@popcorn-queue/core";
import { JobRepository, type CreateJobInput, type Job, type JobPhase, type JobRepositoryOptions, type JobState } from "./jobs.js";

const DEFAULT_DATABASE_URL = "file:./popcorn-queue.db";

interface JobRow {
  id: string;
  state: string;
  phase: string;
  sourceJson: string;
  candidateJson: string | null;
  checkResultJson: string | null;
  torrentJson: string | null;
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
    uploadPlanJson: JSON.stringify(job.uploadPlan),
    phasesJson: JSON.stringify(job.phases),
    eventsJson: JSON.stringify(job.events),
    createdAt: new Date(job.createdAt),
    updatedAt: new Date(job.updatedAt)
  };
}

function deserializeJob(row: JobRow): Job {
  const job: Job = {
    id: row.id,
    state: row.state as JobState,
    phase: row.phase as JobPhase,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    source: parseJson<Job["source"]>(row.sourceJson),
    uploadPlan: parseJson<Job["uploadPlan"]>(row.uploadPlanJson),
    phases: parseJson<Job["phases"]>(row.phasesJson),
    events: parseJson<Job["events"]>(row.eventsJson)
  };

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
        "upload_plan" TEXT NOT NULL,
        "phases" TEXT NOT NULL,
        "events" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )
    `);
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

  async start(id: string): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.start(id));
  }

  async pause(id: string): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.pause(id));
  }

  async retry(id: string): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.retry(id));
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
