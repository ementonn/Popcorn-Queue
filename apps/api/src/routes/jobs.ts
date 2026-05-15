import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildJobWorkspacePaths, type JobManifest, type ReviewDraftPatch, type TorrentCandidate, type UploadPhase } from "@popcorn-queue/core";
import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../api-context.js";
import { readLogTail } from "../job-logs.js";
import { JOB_PHASES, RETRYABLE_COMPLETED_PHASES } from "../jobs.js";
import { deleteJob, type DeleteJobBody } from "../services/job-delete.js";
import { reseedJob, resumeJob, retryCompletedPhaseJob, retryFailedJob, skipJob, startUploadJob, type JobActionContext } from "../services/job-upload.js";
import { missingRestoredFiles } from "../services/restore.js";

interface CreateManualJobBody extends Partial<TorrentCandidate> {
  title: string;
}

interface ImportJobBody {
  jobPath: string;
  manifest?: JobManifest;
}

export function registerJobRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  const actionContext: JobActionContext = {
    config: context.config,
    jobs: context.jobRepository,
    cache: context.cache,
    getTorrentClient: context.getTorrentClient,
    getPtpSubmitter: context.getPtpSubmitter,
    getPreparation: context.getPreparation,
    enqueuePreparation: context.enqueuePreparation
  };

  app.get("/api/jobs", async () => ({ jobs: await context.jobRepository.list() }));

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = await context.jobRepository.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/download-status", async (request, reply) => {
    const job = await context.jobRepository.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { downloadStatus: job.downloadStatus ?? null };
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/logs", async (request, reply) => {
    const job = await context.jobRepository.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { lines: await readLogTail(buildJobWorkspacePaths(context.config().paths.dataRoot, request.params.id).logs.jobLog, 200) };
  });

  app.post<{ Body: CreateManualJobBody }>("/api/jobs", async (request, reply) => {
    const body = request.body;
    if (!body?.title) return reply.code(400).send({ error: "title_required" });

    const candidate: TorrentCandidate = {
      site: body.site ?? "unknown",
      title: body.title
    };
    if (body.imdbId !== undefined) candidate.imdbId = body.imdbId;
    if (body.resolution !== undefined) candidate.resolution = body.resolution;
    if (body.sourceUrl !== undefined) candidate.sourceUrl = body.sourceUrl;
    if (body.downloadUrl !== undefined) candidate.downloadUrl = body.downloadUrl;
    if (body.sourceTorrentId !== undefined) candidate.sourceTorrentId = body.sourceTorrentId;

    const job = await context.jobRepository.create({ candidate });
    context.enqueuePreparation(job.id);
    return reply.code(201).send({ job });
  });

  app.post<{ Body: ImportJobBody }>("/api/jobs/import", async (request, reply) => {
    const body = request.body;
    if (!body?.jobPath) return reply.code(400).send({ error: "job_path_required" });
    const manifest =
      body.manifest ??
      (JSON.parse(await readFile(path.join(body.jobPath, "manifest.json"), "utf8")) as JobManifest);

    const imported = await context.jobRepository.importRestored({ jobPath: body.jobPath, manifest });
    const missingFiles = await missingRestoredFiles(body.jobPath, manifest);
    if (missingFiles.length > 0) {
      const job =
        (await context.jobRepository.markRestoreBlocked(imported.id, {
          message: "Restored job is missing upload files.",
          missingFiles
        })) ?? imported;
      return reply.code(201).send({ job });
    }
    let job = imported;
    if (manifest.state === "done") {
      const torrentClient = context.getTorrentClient();
      job =
        (await context.jobRepository.markNeedsReseed(
          imported.id,
          torrentClient ? "Restored done job needs qBittorrent reseed verification." : "qBittorrent is not configured for automatic reseed."
        )) ?? imported;
    }
    return reply.code(201).send({ job });
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/start-upload", async (request, reply) => {
    const job = await startUploadJob(actionContext, request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/start", async (request, reply) => {
    const job = await startUploadJob(actionContext, request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.patch<{ Params: { id: string }; Body: ReviewDraftPatch }>("/api/jobs/:id/review-draft", async (request, reply) => {
    const job = await context.jobRepository.updateReviewDraft(request.params.id, request.body ?? {});
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/pause", async (request, reply) => {
    const job = await context.jobRepository.pause(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/resume", async (request, reply) => {
    const job = await resumeJob(actionContext, request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry-failed", async (request, reply) => {
    const job = await retryFailedJob(actionContext, request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string; phase: string } }>("/api/jobs/:id/phases/:phase/retry", async (request, reply) => {
    const phase = request.params.phase as UploadPhase;
    if (!JOB_PHASES.includes(phase)) return reply.code(400).send({ error: "unknown_phase" });
    if (!RETRYABLE_COMPLETED_PHASES.has(phase)) return reply.code(400).send({ error: "phase_retry_not_available" });
    const job = await retryCompletedPhaseJob(actionContext, request.params.id, phase);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (request, reply) => {
    const job = await retryFailedJob(actionContext, request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/reseed", async (request, reply) => {
    const job = await reseedJob(actionContext, request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/debug/skip", async (request, reply) => {
    const job = await skipJob(actionContext, request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string }; Body: DeleteJobBody }>("/api/jobs/:id/delete", async (request, reply) => {
    const result = await deleteJob({
      config: context.config(),
      jobs: context.jobRepository,
      torrentClient: context.getTorrentClient(),
      id: request.params.id,
      body: request.body
    });
    return reply.code(result.status).send(result.body);
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/plan/refresh", async (request, reply) => {
    const job = await context.jobRepository.refreshPlan(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });

  app.post<{ Params: { id: string; gateId: string } }>("/api/jobs/:id/review-gates/:gateId/resolve", async (request, reply) => {
    const job = await context.jobRepository.resolveGate(request.params.id, request.params.gateId);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { job };
  });
}
