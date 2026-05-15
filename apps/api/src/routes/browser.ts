import { mkdir, writeFile } from "node:fs/promises";
import { buildJobWorkspacePaths, type BrowserCheckResult, type TorrentCandidate } from "@popcorn-queue/core";
import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../api-context.js";
import { normalizeUploadedFilename } from "../filenames.js";

type BrowserAuthHookArgs = Parameters<ReturnType<ApiRouteContext["getBrowserAuthHook"]>>;

export function registerBrowserRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  const browserAuth = async (...args: BrowserAuthHookArgs) => context.getBrowserAuthHook()(...args);

  app.post<{ Body: { candidates: TorrentCandidate[]; bypassCache?: boolean } }>(
    "/api/browser/check/batch",
    { preHandler: browserAuth },
    async (request) => {
      const candidates = request.body?.candidates ?? [];
      const options: { bypassCache?: boolean } = {};
      if (request.body?.bypassCache !== undefined) options.bypassCache = request.body.bypassCache;
      request.log.info({ candidateCount: candidates.length, bypassCache: Boolean(options.bypassCache) }, "browser check batch started");
      const results = await context.getBrowserChecks().checkBatch(candidates, options);
      const cacheHits = results.filter((result) => result.cache.hit).length;
      request.log.info({ candidateCount: candidates.length, resultCount: results.length, cacheHits }, "browser check batch completed");
      return { results };
    }
  );

  app.post<{ Body: TorrentCandidate & { bypassCache?: boolean } }>(
    "/api/browser/check",
    { preHandler: browserAuth },
    async (request) => {
      const body = request.body;
      const options: { bypassCache?: boolean } = {};
      if (body.bypassCache !== undefined) options.bypassCache = body.bypassCache;
      const result = await context.getBrowserChecks().check(body, options);
      return { result };
    }
  );

  app.post<{ Body: Pick<TorrentCandidate, "title" | "imdbId"> }>(
    "/api/browser/cache/invalidate",
    { preHandler: browserAuth },
    async (request) => {
      const key = await context.getBrowserChecks().invalidate(request.body);
      return { ok: true, key };
    }
  );

  app.post("/api/browser/jobs", { preHandler: browserAuth }, async (request, reply) => {
    const parts = request.parts();
    let torrentBytes = 0;
    let torrentBuffer: Buffer | null = null;
    let torrentFilename = "source.torrent";
    let torrentContentType: string | undefined;
    let candidate: TorrentCandidate | undefined;
    let checkResult: BrowserCheckResult | undefined;

    for await (const part of parts) {
      if (part.type === "file") {
        torrentFilename = part.filename ? normalizeUploadedFilename(part.filename, torrentFilename) : torrentFilename;
        torrentContentType = part.mimetype;
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(chunk as Buffer);
        torrentBuffer = Buffer.concat(chunks);
        torrentBytes = torrentBuffer.byteLength;
      } else if (part.fieldname === "candidate") {
        candidate = JSON.parse(String(part.value)) as TorrentCandidate;
      } else if (part.fieldname === "checkResult") {
        checkResult = JSON.parse(String(part.value)) as BrowserCheckResult;
      }
    }

    if (!torrentBytes) {
      return reply.code(400).send({ error: "torrent_file_required" });
    }

    const torrent = { filename: torrentFilename, bytes: torrentBytes };
    if (torrentContentType) Object.assign(torrent, { contentType: torrentContentType });

    const createInput: Parameters<typeof context.jobRepository.createFromBrowser>[0] = { torrent };
    if (candidate) {
      createInput.candidate = candidate;
      if (candidate.sourceUrl) createInput.sourceUrl = candidate.sourceUrl;
      if (candidate.site) createInput.sourceSite = candidate.site;
      if (candidate.title) createInput.title = candidate.title;
    }
    if (checkResult) createInput.checkResult = checkResult;

    let job = await context.jobRepository.createFromBrowser(createInput);
    if (torrentBuffer) {
      const paths = buildJobWorkspacePaths(context.config().paths.dataRoot, job.id);
      await Promise.all([
        mkdir(paths.inputDir, { recursive: true }),
        mkdir(paths.torrentDir, { recursive: true }),
        mkdir(paths.sourceDownloadDir, { recursive: true }),
        mkdir(paths.logs.dir, { recursive: true })
      ]);
      await writeFile(paths.sourceTorrent, torrentBuffer);
      await writeFile(
        paths.sourceJson,
        `${JSON.stringify({ candidate, checkResult, torrent: { filename: torrentFilename, bytes: torrentBytes, contentType: torrentContentType } }, null, 2)}\n`,
        "utf8"
      );
      job =
        (await context.jobRepository.attachWorkspace(job.id, {
          workspace: {
            dataRoot: paths.dataRoot,
            jobRoot: paths.jobRoot,
            manifest: paths.manifest
          },
          torrentFilePath: paths.sourceTorrent
        })) ?? job;
    }
    context.enqueuePreparation(job.id);
    return reply.code(201).send({ job });
  });
}
