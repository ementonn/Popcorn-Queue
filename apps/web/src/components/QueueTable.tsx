import { downloadDetail, downloadProgress, downloadSummary } from "../download-status.js";
import { currentStepLabel } from "../job-display.js";
import type { ApiJob, ReviewGate } from "../types.js";

interface QueueTableProps {
  jobs: ApiJob[];
  selectedJobId: string | null;
  pendingAction?: { jobId: string; label: string } | null;
  onSelect(jobId: string): void;
  onPause(jobId: string): void;
  onResume(jobId: string): void;
  onRetry(jobId: string): void;
}

type QueueAction = "upload" | "retry" | "pause" | "resume";

function releaseTitle(job: ApiJob): string {
  return job.artifacts?.releaseName ?? job.uploadPlan?.releaseName?.generated ?? job.candidate?.title ?? job.source.title ?? job.id;
}

function sourceLabel(job: ApiJob): string {
  return job.source.site ?? job.candidate?.site ?? "manual";
}

function updatedLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function openGates(job: ApiJob): ReviewGate[] {
  return job.uploadPlan?.reviewGates.filter((gate) => gate.status === "open") ?? [];
}

function warningText(job: ApiJob): string {
  const warnings = openGates(job).filter((gate) => gate.severity === "warning").length;
  return warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "None";
}

function queueAction(job: ApiJob): QueueAction | null {
  if (job.state === "done") return null;
  if (job.state === "needs_reseed") return "retry";
  if (job.state === "failed") return "retry";
  if (job.state === "review") return "upload";
  if (job.state === "paused") return "resume";
  if (job.state === "preparing") return "pause";
  return null;
}

function actionLabel(action: QueueAction): string {
  if (action === "retry") return "Retry";
  if (action === "resume") return "Resume";
  if (action === "pause") return "Pause";
  return "Upload";
}

export function QueueTable({ jobs, selectedJobId, pendingAction, onSelect, onPause, onResume, onRetry }: QueueTableProps) {
  return (
    <section className="queue" aria-label="Upload queue">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Release</th>
              <th>Source</th>
              <th>Step</th>
              <th>Download</th>
              <th>Warnings</th>
              <th>Updated</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const selected = job.id === selectedJobId;
              const progress = downloadProgress(job.downloadStatus);
              const action = queueAction(job);
              const pending = pendingAction?.jobId === job.id ? pendingAction : null;
              return (
                <tr key={job.id} className={selected ? "selected" : undefined} onClick={() => onSelect(job.id)}>
                  <td data-label="Status">
                    <span className={`state-pill ${job.state}`}>{job.state.replace("_", " ")}</span>
                  </td>
                  <td data-label="Release">
                    <a className="job-link" href={`/jobs/${job.id}`} onClick={(event) => event.preventDefault()}>
                      {releaseTitle(job)}
                    </a>
                  </td>
                  <td data-label="Source">{sourceLabel(job)}</td>
                  <td data-label="Step">{currentStepLabel(job)}</td>
                  <td className="download-cell" data-label="Download">
                    <div className="download-line">
                      <span>{downloadSummary(job.downloadStatus)}</span>
                    </div>
                    {progress !== null ? (
                      <div className="download-progress" aria-label={`Download ${Math.round(progress * 100)}%`}>
                        <span style={{ width: `${progress * 100}%` }} />
                      </div>
                    ) : null}
                    <span className="download-meta">{downloadDetail(job.downloadStatus)}</span>
                  </td>
                  <td data-label="Warnings">{warningText(job)}</td>
                  <td data-label="Updated">{updatedLabel(job.updatedAt)}</td>
                  <td data-label="Action">
                    {action ? (
                      <button
                        type="button"
                        className="action"
                        disabled={Boolean(pending)}
                        aria-busy={pending ? "true" : undefined}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (pending) return;
                          if (action === "retry") onRetry(job.id);
                          else if (action === "pause") onPause(job.id);
                          else if (action === "resume") onResume(job.id);
                          else onSelect(job.id);
                        }}
                      >
                        {pending?.label ?? actionLabel(action)}
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
