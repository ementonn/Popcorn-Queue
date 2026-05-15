import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../api-context.js";
import { createManualIntakeJob, IntakeError, readManualIntakeRequest, resolveManualPtpTarget, searchPtpMovies, validateMediaPath } from "../intake.js";

export function registerIntakeRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  app.post<{ Body: { mediaPath?: string } }>("/api/intake/media-path/validate", async (request) => {
    return validateMediaPath(request.body?.mediaPath ?? "");
  });

  app.post<{ Body: { title?: string; mediaPath?: string } }>("/api/intake/ptp-search", async (request) => {
    return searchPtpMovies(request.body ?? {}, context.getPtpClient());
  });

  app.post<{ Body: { ptpUrl?: string; imdbUrl?: string } }>("/api/intake/ptp-target/resolve", async (request, reply) => {
    try {
      const target = await resolveManualPtpTarget(request.body ?? {}, context.getPtpClient());
      return { target };
    } catch (error) {
      if (error instanceof IntakeError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post("/api/intake/jobs", async (request, reply) => {
    try {
      const input = await readManualIntakeRequest(request, context.options.fetchImpl ?? fetch);
      if (input.mediaPath) {
        const media = await validateMediaPath(input.mediaPath);
        if (!media.ok) return reply.code(400).send({ error: media.error ?? "invalid_media_path", media });
      }
      const job = await createManualIntakeJob({
        dataRoot: context.config().paths.dataRoot,
        jobRepository: context.jobRepository,
        releaseName: input.releaseName,
        ptpTarget: input.ptpTarget,
        ptpClient: context.getPtpClient(),
        ...(input.mediaPath ? { mediaPath: input.mediaPath } : {}),
        ...(input.torrent ? { torrent: input.torrent } : {})
      });
      context.enqueuePreparation(job.id);
      return reply.code(201).send({ job });
    } catch (error) {
      if (error instanceof IntakeError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
