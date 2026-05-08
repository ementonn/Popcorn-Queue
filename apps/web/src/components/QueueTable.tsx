import type { ApiJob, ReviewGate } from "../types.js";

interface QueueTableProps {
  jobs: ApiJob[];
  selectedJobId: string | null;
  onSelect(jobId: string): void;
  onStartUpload(jobId: string): void;
}

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

function blockerText(job: ApiJob): string {
  const gates = openGates(job);
  const blockers = gates.filter((gate) => gate.severity === "blocker").length;
  const warnings = gates.filter((gate) => gate.severity === "warning").length;
  if (!blockers) return "Clear";
  return `${blockers} blocker${blockers === 1 ? "" : "s"}`;
}

function warningText(job: ApiJob): string {
  const warnings = openGates(job).filter((gate) => gate.severity === "warning").length;
  return warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "None";
}

function actionText(job: ApiJob): string {
  if (job.uploadReadiness === "ready") return "Upload";
  if (job.state === "failed") return "Retry";
  return "Review";
}

export function QueueTable({ jobs, selectedJobId, onSelect, onStartUpload }: QueueTableProps) {
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
              <th>Blockers</th>
              <th>Warnings</th>
              <th>Updated</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const selected = job.id === selectedJobId;
              const action = actionText(job);
              return (
                <tr key={job.id} className={selected ? "selected" : undefined} onClick={() => onSelect(job.id)}>
                  <td>
                    <span className={`state-pill ${job.state}`}>{job.state.replace("_", " ")}</span>
                  </td>
                  <td>
                    <a className="job-link" href={`/jobs/${job.id}`} onClick={(event) => event.preventDefault()}>
                      {releaseTitle(job)}
                    </a>
                  </td>
                  <td>{sourceLabel(job)}</td>
                  <td>{job.humanStep ?? job.phase}</td>
                  <td>{blockerText(job)}</td>
                  <td>{warningText(job)}</td>
                  <td>{updatedLabel(job.updatedAt)}</td>
                  <td>
                    <button
                      type="button"
                      className={job.uploadReadiness === "ready" ? "action primary" : "action"}
                      disabled={job.uploadReadiness !== "ready"}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (job.uploadReadiness === "ready") onStartUpload(job.id);
                      }}
                    >
                      {action}
                    </button>
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
