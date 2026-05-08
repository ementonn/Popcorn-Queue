import { useEffect, useMemo, useState } from "react";
import { downloadedBytesLabel, downloadDetail, downloadProgress, downloadSummary } from "../download-status.js";
import type { ApiJob, JobLogResponse, ReviewDraft, ReviewDraftPatch, ReviewGate } from "../types.js";

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
  return [...gateWarnings, ...releaseWarnings];
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
    remasterYear: "",
    remasterTitle: "",
    subtitles: job.uploadPlan?.media?.subtitles.languages ?? [],
    trumpable: [],
    scene: false,
    personalRip: false,
    internal: false
  };
}

function commaList(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function draftToForm(draft: ReviewDraft) {
  return {
    ...draft,
    groupId: draft.groupId ?? "",
    subtitles: draft.subtitles.join(", "),
    trumpable: draft.trumpable.join(", ")
  };
}

export function ReviewPanel({ job, jobLogs, onResolveGate, onSaveReviewDraft }: ReviewPanelProps) {
  const draft = useMemo(() => (job ? job.reviewDraft ?? fallbackReviewDraft(job) : null), [job]);
  const [draftForm, setDraftForm] = useState(() => (draft ? draftToForm(draft) : null));
  const [draftStatus, setDraftStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    setDraftForm(draft ? draftToForm(draft) : null);
    setDraftStatus("idle");
  }, [draft]);

  if (!job) {
    return (
      <aside className="review-pane" data-testid="review-panel">
        <p className="muted">No job selected.</p>
      </aside>
    );
  }

  const blockers = openGates(job, "blocker");
  const warnings = allWarnings(job);
  const screenshots = job.artifacts?.screenshots ?? [];
  const mediaLines = linesFromText(job.artifacts?.mediainfo ?? job.artifacts?.bdinfo);
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
        {blockers.length ? (
          <div className="gate-list">
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
          <pre>{mediaLines.join("\n")}</pre>
        ) : (
          empty(job.uploadPlan?.media ? `${job.uploadPlan.media.discType} media inspection pending.` : "Media inspection pending.")
        )}
      </section>

      <section>
        <h3>Upload Draft</h3>
        {draftForm ? (
          <form
            className="draft-form"
            onSubmit={(event) => {
              event.preventDefault();
              setDraftStatus("saving");
              void Promise.resolve(
                onSaveReviewDraft(job.id, {
                  releaseName: draftForm.releaseName,
                  description: draftForm.description,
                  groupId: draftForm.groupId || null,
                  type: draftForm.type,
                  codec: draftForm.codec,
                  container: draftForm.container,
                  resolution: draftForm.resolution,
                  source: draftForm.source,
                  remasterYear: draftForm.remasterYear,
                  remasterTitle: draftForm.remasterTitle,
                  subtitles: commaList(draftForm.subtitles),
                  trumpable: commaList(draftForm.trumpable),
                  scene: draftForm.scene,
                  personalRip: draftForm.personalRip,
                  internal: draftForm.internal
                })
              )
                .then(() => setDraftStatus("saved"))
                .catch(() => setDraftStatus("error"));
            }}
          >
            <label className="field wide">
              <span>Release name</span>
              <input
                value={draftForm.releaseName}
                onChange={(event) => setDraftForm((current) => current && { ...current, releaseName: event.target.value })}
              />
            </label>
            <label className="field">
              <span>PTP group</span>
              <input value={draftForm.groupId} onChange={(event) => setDraftForm((current) => current && { ...current, groupId: event.target.value })} />
            </label>
            <label className="field">
              <span>Type</span>
              <input value={draftForm.type} onChange={(event) => setDraftForm((current) => current && { ...current, type: event.target.value })} />
            </label>
            <label className="field">
              <span>Codec</span>
              <input value={draftForm.codec} onChange={(event) => setDraftForm((current) => current && { ...current, codec: event.target.value })} />
            </label>
            <label className="field">
              <span>Container</span>
              <input value={draftForm.container} onChange={(event) => setDraftForm((current) => current && { ...current, container: event.target.value })} />
            </label>
            <label className="field">
              <span>Resolution</span>
              <input value={draftForm.resolution} onChange={(event) => setDraftForm((current) => current && { ...current, resolution: event.target.value })} />
            </label>
            <label className="field">
              <span>Source</span>
              <input value={draftForm.source} onChange={(event) => setDraftForm((current) => current && { ...current, source: event.target.value })} />
            </label>
            <label className="field">
              <span>Remaster year</span>
              <input value={draftForm.remasterYear} onChange={(event) => setDraftForm((current) => current && { ...current, remasterYear: event.target.value })} />
            </label>
            <label className="field">
              <span>Remaster title</span>
              <input value={draftForm.remasterTitle} onChange={(event) => setDraftForm((current) => current && { ...current, remasterTitle: event.target.value })} />
            </label>
            <label className="field wide">
              <span>Subtitles</span>
              <input value={draftForm.subtitles} onChange={(event) => setDraftForm((current) => current && { ...current, subtitles: event.target.value })} />
            </label>
            <label className="field wide">
              <span>Trumpable</span>
              <input value={draftForm.trumpable} onChange={(event) => setDraftForm((current) => current && { ...current, trumpable: event.target.value })} />
            </label>
            <label className="field wide">
              <span>Description</span>
              <textarea value={draftForm.description} onChange={(event) => setDraftForm((current) => current && { ...current, description: event.target.value })} />
            </label>
            <div className="draft-toggles">
              {(["scene", "personalRip", "internal"] as const).map((key) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={draftForm[key]}
                    onChange={(event) => setDraftForm((current) => current && { ...current, [key]: event.target.checked })}
                  />
                  <span>{key === "personalRip" ? "Personal rip" : key}</span>
                </label>
              ))}
            </div>
            <div className="draft-actions">
              <button type="submit" className="primary" disabled={draftStatus === "saving"}>
                Save Draft
              </button>
              {draftStatus === "saved" ? <span>Saved</span> : draftStatus === "error" ? <span className="error-text">Save failed</span> : null}
            </div>
          </form>
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
