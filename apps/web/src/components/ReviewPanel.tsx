import { useEffect, useMemo, useState } from "react";
import { downloadedBytesLabel, downloadDetail, downloadProgress, downloadSummary } from "../download-status.js";
import { phaseLabel, phaseStateLabel, phaseStateTone } from "../job-display.js";
import type { ApiJob, JobLogResponse, PtpMovieSummary, ReviewDraft, ReviewDraftPatch, ReviewGate } from "../types.js";
import { DraftEditor } from "./DraftEditor.js";

interface ReviewPanelProps {
  job: ApiJob | null;
  jobLogs: JobLogResponse;
  onSaveReviewDraft(jobId: string, patch: ReviewDraftPatch): Promise<void> | void;
  onRegisterDraftFlush?(jobId: string, flush: (() => Promise<void>) | null): void;
  onRetryPhase?(jobId: string, phase: string): void;
}

const RETRYABLE_COMPLETED_PHASES = new Set([
  "metadata",
  "duplicate-check",
  "inspect-media",
  "screenshots",
  "image-host-upload",
  "torrent-create",
  "preflight",
  "post-hook"
]);

function openGates(job: ApiJob, severity: ReviewGate["severity"]): ReviewGate[] {
  return job.uploadPlan?.reviewGates.filter((gate) => gate.status === "open" && gate.severity === severity) ?? [];
}

function allWarnings(job: ApiJob): string[] {
  const releaseWarnings = job.uploadPlan?.releaseName?.warnings ?? [];
  const gateWarnings = openGates(job, "warning").map((gate) => `${gate.title}: ${gate.detail}`);
  return [...(job.artifacts?.reviewWarnings ?? []), ...gateWarnings, ...releaseWarnings];
}

function linesFromText(value?: string, limit = 16): string[] {
  if (!value) return [];
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return limit > 0 ? lines.slice(0, limit) : lines;
}

function empty(value: string) {
  return <p className="muted">{value}</p>;
}

function isPublicImageUrl(value: string | null | undefined): value is string {
  return /^https?:\/\//i.test(value ?? "");
}

function publicScreenshotLinks(screenshots: string[], previews: string[]): Array<{ url: string; previewUrl: string }> {
  return screenshots.flatMap((screenshot, index) => {
    if (!isPublicImageUrl(screenshot)) return [];
    const preview = previews[index];
    return [{ url: screenshot, previewUrl: isPublicImageUrl(preview) ? preview : screenshot }];
  });
}

function groupIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).searchParams.get("id");
  } catch {
    return url.match(/[?&]id=(\d+)/)?.[1] ?? null;
  }
}

function fallbackReviewDraft(job: ApiJob): ReviewDraft {
  return {
    releaseName: job.artifacts?.releaseName ?? job.uploadPlan?.releaseName?.generated ?? job.candidate?.title ?? job.source.title ?? "",
    description: job.artifacts?.description ?? "",
    groupId: groupIdFromUrl(job.checkResult?.decision?.ptpUrl),
    type: "Feature Film",
    codec: "Other",
    container: job.uploadPlan?.media?.container?.toUpperCase() ?? "MKV",
    resolution: "1080p",
    source: "Other",
    imdb: job.candidate?.imdbId ?? "",
    title: job.candidate?.title ?? job.source.title ?? "",
    year: "",
    image: "",
    trailer: "",
    tags: "",
    synopsis: "",
    remaster: false,
    remasterYear: "",
    remasterTitle: "",
    special: "",
    subtitles: job.uploadPlan?.media?.subtitles.languages ?? [],
    trumpable: [],
    scene: false,
    personalRip: false,
    internal: false,
    uploadToken: "",
    artists: []
  };
}

function isAbsoluteFilePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function jobWorkspacePath(job: ApiJob, value: string | null | undefined): string | null {
  if (!value) return null;
  if (isAbsoluteFilePath(value)) return value;
  const jobRoot = job.workspace?.jobRoot;
  if (!jobRoot) return value;
  return `${jobRoot.replace(/[\\/]+$/, "")}/${value.replace(/^[\\/]+/, "")}`;
}

function sourceTorrentPath(job: ApiJob): string {
  if (job.torrent?.filePath) return job.torrent.filePath;
  if (job.torrent && job.workspace?.jobRoot) return jobWorkspacePath(job, "torrent/source.torrent") ?? "pending";
  return job.torrent?.filename ?? "pending";
}

function uploadTorrentPath(job: ApiJob): string {
  return jobWorkspacePath(job, job.artifacts?.uploadTorrent) ?? "pending";
}

function downloadMediaPath(job: ApiJob): string {
  return job.downloadStatus?.contentPath ?? job.source.mediaPath ?? "pending";
}

function uploadMediaPath(job: ApiJob): string {
  return jobWorkspacePath(job, job.artifacts?.mediaFiles?.[0]) ?? "pending";
}

function formatPtpMovieTitle(movie: PtpMovieSummary): string {
  const primary = (movie.Title || movie.Name || "").trim();
  const aka = movie.Name && movie.Title && movie.Name !== movie.Title ? ` AKA ${movie.Name}` : "";
  const year = movie.Year ? ` [${movie.Year}]` : "";
  return `${primary}${aka}${year}`.trim();
}

function matchedPtpMovie(job: ApiJob): { url: string; label: string } | null {
  const url = job.checkResult?.decision?.ptpUrl ?? job.source.ptpTarget?.ptpUrl ?? null;
  if (!url) return null;
  const label =
    (job.checkResult?.decision?.movie ? formatPtpMovieTitle(job.checkResult.decision.movie) : "") ||
    job.source.ptpTarget?.displayTitle ||
    job.candidate?.title ||
    job.source.title ||
    url;
  return { url, label };
}

function sourceSubtitle(job: ApiJob): string | null {
  const subtitle = job.source.subtitle ?? job.candidate?.subtitle ?? null;
  const trimmed = subtitle?.trim();
  return trimmed || null;
}

function qbittorrentSeedStatus(job: ApiJob): string {
  const qbState = job.downloadStatus?.state;
  const postHookDone = job.phases?.some((phase) => phase.phase === "post-hook" && phase.state === "done");
  if (job.state === "needs_reseed") return "Needs reseed";
  if (qbState === "pausedUP") return "Paused in qBittorrent";
  if (job.state === "seeding" || postHookDone || (job.state === "done" && qbState && ["uploading", "stalledUP", "queuedUP", "forcedUP"].includes(qbState))) return "Seeding";
  return job.artifacts?.qbReady ? "Ready to seed" : "Waiting";
}

export function ReviewPanel({ job, jobLogs, onSaveReviewDraft, onRegisterDraftFlush, onRetryPhase }: ReviewPanelProps) {
  const draft = useMemo(() => (job ? job.reviewDraft ?? fallbackReviewDraft(job) : null), [job]);
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  useEffect(() => {
    setDraftError(null);
  }, [draft]);

  if (!job) {
    return (
      <aside className="review-pane" data-testid="review-panel">
        <p className="muted">No job selected.</p>
      </aside>
    );
  }

  const warnings = allWarnings(job);
  const screenshotArtifacts = job.artifacts?.screenshots ?? [];
  const screenshotPreviews = job.artifacts?.screenshotPreviews ?? [];
  const screenshots = publicScreenshotLinks(screenshotArtifacts, screenshotPreviews);
  const hasInternalScreenshotArtifacts = screenshotArtifacts.some((screenshot) => !isPublicImageUrl(screenshot));
  const draftLines = linesFromText(job.artifacts?.description);
  const recentLogs = jobLogs.lines.length ? jobLogs.lines.slice(-8) : (job.events ?? []).slice(-8).map((event) => event.message);
  const phases = job.phases ?? [];
  const matchedMovie = matchedPtpMovie(job);
  const download = job.downloadStatus;
  const downloadProgressValue = downloadProgress(download);
  const subtitle = sourceSubtitle(job);

  return (
    <aside className="review-pane" data-testid="review-panel">
      <section>
        <h3>Warnings</h3>
        {warnings.length ? (
          <ul className="plain-list">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : (
          empty("No warnings.")
        )}
      </section>

      <section>
        <h3>Duplicate/PTP Result</h3>
        {job.checkResult?.decision || matchedMovie ? (
          <div className="key-value">
            {job.checkResult?.decision ? (
              <>
                <span>Status</span>
                <strong>{job.checkResult.decision.status}</strong>
                <span>Reason</span>
                <strong>{job.checkResult.decision.reason}</strong>
              </>
            ) : null}
            {matchedMovie ? (
              <>
                <span>Matched PTP movie</span>
                <strong>
                  <a href={matchedMovie.url} target="_blank" rel="noreferrer">
                    {matchedMovie.label}
                  </a>
                </strong>
              </>
            ) : null}
          </div>
        ) : (
          empty("No duplicate result yet.")
        )}
      </section>

      <section>
        <h3>Source</h3>
        {download ? (
          <div className="download-review">
            <div className="download-review-head">
              <strong>{downloadSummary(download)}</strong>
              <span>{downloadDetail(download)}</span>
            </div>
            {downloadProgressValue !== null ? (
              <div className="download-progress" aria-label={`Download ${Math.round(downloadProgressValue * 100)}%`}>
                <span style={{ width: `${downloadProgressValue * 100}%` }} />
              </div>
            ) : null}
            <div className="key-value">
              <span>Downloaded</span>
              <strong>{downloadedBytesLabel(download)}</strong>
              <span>Client</span>
              <strong>{download.client}</strong>
              <span>State</span>
              <strong>{download.state}</strong>
              <span>Hash</span>
              <strong>{download.infoHash ?? "pending"}</strong>
              {subtitle ? (
                <>
                  <span>Subtitle</span>
                  <strong>{subtitle}</strong>
                </>
              ) : null}
            </div>
          </div>
        ) : (
          empty("No source status yet.")
        )}
      </section>

      <section>
        <h3>Screenshots</h3>
        {screenshots.length ? (
          <div className="screenshot-grid">
            {screenshots.slice(0, 6).map((screenshot, index) => (
              <a href={screenshot.url} key={screenshot.url} target="_blank" rel="noreferrer">
                <img src={screenshot.previewUrl} alt={`Shot ${index + 1}`} loading="lazy" />
                <span>Shot {index + 1}</span>
              </a>
            ))}
          </div>
        ) : (
          empty(hasInternalScreenshotArtifacts ? "Screenshots captured locally, waiting for image host upload." : `${job.uploadPlan?.screenshots?.count ?? 0} planned shots, waiting for capture.`)
        )}
      </section>

      <section>
        <h3>Upload Draft</h3>
        {draft ? (
          <DraftEditor
            draft={draft}
            draftKey={job.id}
            saving={draftSaving}
            error={draftError}
            onRegisterFlush={(flush) => onRegisterDraftFlush?.(job.id, flush)}
            onSave={async (patch) => {
              setDraftSaving(true);
              setDraftError(null);
              try {
                await onSaveReviewDraft(job.id, patch);
              } catch (error) {
                const message = error instanceof Error ? error.message : "Draft save failed";
                setDraftError(message);
                throw error;
              } finally {
                setDraftSaving(false);
              }
            }}
          />
        ) : (
          <div className="release-draft">
            <strong>{job.artifacts?.releaseName ?? job.uploadPlan?.releaseName?.generated ?? job.candidate?.title ?? job.source.title}</strong>
            {draftLines.length ? <pre>{draftLines.join("\n")}</pre> : empty("Description draft pending.")}
          </div>
        )}
      </section>

      <section>
        <h3>Torrent / qB Readiness</h3>
        <div className="key-value">
          <span>Source torrent</span>
          <strong>{sourceTorrentPath(job)}</strong>
          <span>PTP upload torrent</span>
          <strong>{uploadTorrentPath(job)}</strong>
          <span>Download media</span>
          <strong>{downloadMediaPath(job)}</strong>
          <span>Upload media</span>
          <strong>{uploadMediaPath(job)}</strong>
          <span>qBittorrent seeding</span>
          <strong>{qbittorrentSeedStatus(job)}</strong>
          {job.artifacts?.ptpUrl ? (
            <>
              <span>PTP result</span>
              <strong>
                <a href={job.artifacts.ptpUrl} target="_blank" rel="noreferrer">
                  {job.artifacts.ptpUrl}
                </a>
              </strong>
            </>
          ) : null}
        </div>
      </section>

      <section>
        <h3>Phase Timeline</h3>
        {phases.length ? (
          <ol className="phase-timeline" aria-label="Phase timeline">
            {phases.map((phase) => (
              <li className={`phase-timeline__item ${phaseStateTone(phase.state)}`} key={phase.phase}>
                <span className="phase-timeline__dot" aria-hidden="true" />
                <div className="phase-timeline__body">
                  <div className="phase-timeline__head">
                    <strong>{phaseLabel(phase.phase)}</strong>
                    <div className="phase-timeline__actions">
                      <span>{phaseStateLabel(phase.state)}</span>
                      {onRetryPhase && phase.state === "done" && RETRYABLE_COMPLETED_PHASES.has(phase.phase) ? (
                        <button
                          type="button"
                          className="phase-timeline__retry"
                          onClick={() => onRetryPhase(job.id, phase.phase)}
                          disabled={job.state === "preparing" || job.state === "uploading"}
                        >
                          Retry
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {phase.message ? <p>{phase.message}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          empty("No phase timeline yet.")
        )}
      </section>

      <section>
        <h3>Recent Job Log</h3>
        {recentLogs.length ? (
          <pre>{recentLogs.join("\n")}</pre>
        ) : (
          empty("No job log lines yet.")
        )}
      </section>
    </aside>
  );
}
