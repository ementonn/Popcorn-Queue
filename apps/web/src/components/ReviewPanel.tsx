import { useEffect, useMemo, useState } from "react";
import { downloadedBytesLabel, downloadDetail, downloadProgress, downloadSummary } from "../download-status.js";
import type { ApiJob, JobLogResponse, ReviewDraft, ReviewDraftPatch, ReviewGate } from "../types.js";
import { DraftEditor } from "./DraftEditor.js";

interface ReviewPanelProps {
  job: ApiJob | null;
  jobLogs: JobLogResponse;
  onResolveGate(jobId: string, gateId: string): void;
  onSaveReviewDraft(jobId: string, patch: ReviewDraftPatch): Promise<void> | void;
}

function openGates(job: ApiJob, severity: ReviewGate["severity"]): ReviewGate[] {
  return job.uploadPlan?.reviewGates.filter((gate) => gate.status === "open" && gate.severity === severity) ?? [];
}

function allWarnings(job: ApiJob): string[] {
  const releaseWarnings = job.uploadPlan?.releaseName?.warnings ?? [];
  const gateWarnings = openGates(job, "warning").map((gate) => `${gate.title}: ${gate.detail}`);
  return [...(job.artifacts?.reviewWarnings ?? []), ...gateWarnings, ...releaseWarnings];
}

function artifactBlockers(job: ApiJob): string[] {
  return job.artifacts?.reviewBlockers ?? [];
}

function linesFromText(value?: string): string[] {
  if (!value) return [];
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 16);
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

export function ReviewPanel({ job, jobLogs, onResolveGate, onSaveReviewDraft }: ReviewPanelProps) {
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

  const blockers = openGates(job, "blocker");
  const blockerMessages = artifactBlockers(job);
  const warnings = allWarnings(job);
  const screenshots = job.artifacts?.screenshots ?? [];
  const mediaValue = job.artifacts?.mediaInfoText ?? job.artifacts?.mediainfo ?? job.artifacts?.bdinfo;
  const legacyJsonMediaInfo = !job.artifacts?.mediaInfoText && Boolean(mediaValue?.trim().startsWith("{"));
  const mediaLines = linesFromText(mediaValue);
  const draftLines = linesFromText(job.artifacts?.description);
  const recentLogs = jobLogs.lines.length ? jobLogs.lines.slice(-8) : (job.events ?? []).slice(-8).map((event) => event.message);
  const download = job.downloadStatus;
  const downloadProgressValue = downloadProgress(download);

  return (
    <aside className="review-pane" data-testid="review-panel">
      <div className="review-header">
        <span className={`readiness ${job.uploadReadiness}`}>{job.uploadReadiness.replace("_", " ")}</span>
        <strong>{job.humanStep ?? job.phase}</strong>
      </div>

      <section>
        <h3>Blockers</h3>
        {blockers.length || blockerMessages.length ? (
          <div className="gate-list">
            {blockerMessages.map((blocker) => (
              <article className="gate blocker" key={blocker}>
                <strong>{blocker}</strong>
              </article>
            ))}
            {blockers.map((gate) => (
              <article className="gate blocker" key={gate.id}>
                <strong>{gate.title}</strong>
                <p>{gate.detail}</p>
                <button type="button" onClick={() => onResolveGate(job.id, gate.id)}>
                  Resolve
                </button>
              </article>
            ))}
          </div>
        ) : (
          empty("No open blockers.")
        )}
      </section>

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
                Shot {index + 1}
              </a>
            ))}
          </div>
        ) : (
          empty(`${job.uploadPlan?.screenshots?.count ?? 0} planned shots, waiting for capture.`)
        )}
      </section>

      <section>
        <h3>MediaInfo / BDInfo</h3>
        {mediaLines.length ? (
          <>
            {legacyJsonMediaInfo ? <p className="muted">Legacy internal MediaInfo JSON</p> : null}
            <pre className="artifact-pre">{mediaLines.join("\n")}</pre>
          </>
        ) : (
          empty(job.uploadPlan?.media ? `${job.uploadPlan.media.discType} media inspection pending.` : "Media inspection pending.")
        )}
      </section>

      <section>
        <h3>Upload Draft</h3>
        {draft ? (
          <DraftEditor
            draft={draft}
            saving={draftSaving}
            error={draftError}
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
          <strong>{job.torrent?.filename ?? "pending"}</strong>
          <span>PTP upload torrent</span>
          <strong>{job.artifacts?.uploadTorrent ?? "pending"}</strong>
          <span>qB handoff</span>
          <strong>{job.artifacts?.qbReady ? "ready" : "waiting"}</strong>
          {job.artifacts?.ptpUrl ? (
            <>
              <span>PTP result</span>
              <strong>{job.artifacts.ptpUrl}</strong>
            </>
          ) : null}
        </div>
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
