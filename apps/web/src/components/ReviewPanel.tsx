import { useEffect, useMemo, useState } from "react";
import { downloadedBytesLabel, downloadDetail, downloadProgress, downloadSummary } from "../download-status.js";
import { phaseLabel, phaseStateLabel, phaseStateTone } from "../job-display.js";
import type { ApiJob, JobLogResponse, ReviewDraft, ReviewDraftPatch, ReviewGate } from "../types.js";
import { DraftEditor } from "./DraftEditor.js";

interface ReviewPanelProps {
  job: ApiJob | null;
  jobLogs: JobLogResponse;
  onSaveReviewDraft(jobId: string, patch: ReviewDraftPatch): Promise<void> | void;
  onRegisterDraftFlush?(jobId: string, flush: (() => Promise<void>) | null): void;
}

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

function sourceTorrentLabel(job: ApiJob): string {
  const filename = job.torrent?.filename;
  if (filename && filename !== "source.torrent") return filename;
  return job.torrent?.filePath ?? filename ?? "pending";
}

function qbittorrentSeedStatus(job: ApiJob): string {
  const qbState = job.downloadStatus?.state;
  const postHookDone = job.phases?.some((phase) => phase.phase === "post-hook" && phase.state === "done");
  if (job.state === "needs_reseed") return "Needs reseed";
  if (qbState === "pausedUP") return "Paused in qBittorrent";
  if (job.state === "seeding" || postHookDone || (job.state === "done" && qbState && ["uploading", "stalledUP", "queuedUP", "forcedUP"].includes(qbState))) return "Seeding";
  return job.artifacts?.qbReady ? "Ready to seed" : "Waiting";
}

export function ReviewPanel({ job, jobLogs, onSaveReviewDraft, onRegisterDraftFlush }: ReviewPanelProps) {
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
  const screenshots = job.artifacts?.screenshots ?? [];
  const draftLines = linesFromText(job.artifacts?.description);
  const recentLogs = jobLogs.lines.length ? jobLogs.lines.slice(-8) : (job.events ?? []).slice(-8).map((event) => event.message);
  const phases = job.phases ?? [];
  const download = job.downloadStatus;
  const downloadProgressValue = downloadProgress(download);

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
        {job.checkResult?.decision ? (
          <div className="key-value">
            <span>Status</span>
            <strong>{job.checkResult.decision.status}</strong>
            <span>Reason</span>
            <strong>{job.checkResult.decision.reason}</strong>
          </div>
        ) : (
          empty("No duplicate result yet.")
        )}
      </section>

      <section>
        <h3>Download</h3>
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
            </div>
          </div>
        ) : (
          empty("No qB snapshot yet.")
        )}
      </section>

      <section>
        <h3>Screenshots</h3>
        {screenshots.length ? (
          <div className="screenshot-grid">
            {screenshots.slice(0, 6).map((screenshot, index) => (
              <a href={screenshot} key={screenshot} target="_blank" rel="noreferrer">
                <img src={screenshot} alt={`Shot ${index + 1}`} loading="lazy" />
                <span>Shot {index + 1}</span>
              </a>
            ))}
          </div>
        ) : (
          empty(`${job.uploadPlan?.screenshots?.count ?? 0} planned shots, waiting for capture.`)
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
          <strong>{sourceTorrentLabel(job)}</strong>
          <span>PTP upload torrent</span>
          <strong>{job.artifacts?.uploadTorrent ?? "pending"}</strong>
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
                    <span>{phaseStateLabel(phase.state)}</span>
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
