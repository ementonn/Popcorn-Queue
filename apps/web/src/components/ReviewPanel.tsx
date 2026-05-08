import { downloadedBytesLabel, downloadDetail, downloadProgress, downloadSummary } from "../download-status.js";
import type { ApiJob, JobLogResponse, ReviewGate } from "../types.js";

interface ReviewPanelProps {
  job: ApiJob | null;
  jobLogs: JobLogResponse;
  onResolveGate(jobId: string, gateId: string): void;
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

export function ReviewPanel({ job, jobLogs, onResolveGate }: ReviewPanelProps) {
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
        <h3>Release Draft</h3>
        <div className="release-draft">
          <strong>{job.artifacts?.releaseName ?? job.uploadPlan?.releaseName?.generated ?? job.candidate?.title ?? job.source.title}</strong>
          {draftLines.length ? <pre>{draftLines.join("\n")}</pre> : empty("Description draft pending.")}
        </div>
      </section>

      <section>
        <h3>Torrent / qB Readiness</h3>
        <div className="key-value">
          <span>Torrent</span>
          <strong>{job.artifacts?.uploadTorrent ?? job.torrent?.filename ?? "pending"}</strong>
          <span>qB handoff</span>
          <strong>{job.artifacts?.qbReady ? "ready" : "waiting"}</strong>
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
