import type { ApiJob, GlobalLogResponse, HealthInfo, JobLogResponse } from "../types.js";

interface DiagnosticsPanelProps {
  job: ApiJob | null;
  health: HealthInfo | null;
  globalLogs: GlobalLogResponse;
  jobLogs: JobLogResponse;
  onAdvance(): void;
  onSkip(): void;
  onForceState(): void;
}

function bool(value: boolean | undefined): string {
  if (value === undefined) return "unknown";
  return value ? "yes" : "no";
}

export function DiagnosticsPanel({
  job,
  health,
  globalLogs,
  jobLogs,
  onAdvance,
  onSkip,
  onForceState
}: DiagnosticsPanelProps) {
  return (
    <aside className="diagnostics" data-testid="diagnostics-panel">
      <div className="diagnostics-header">
        <h2>Diagnostics</h2>
        <span>{health?.ok ? "API health: ok" : "API health: unavailable"}</span>
      </div>

      <section>
        <h3>Service health</h3>
        <div className="diagnostic-grid">
          <span>Worker health</span>
          <strong>{health?.external?.externalToolsEnabled ? "tools enabled" : "standby"}</strong>
          <span>Image host</span>
          <strong>{health?.external?.imageHost ?? "not set"}</strong>
          <span>qB configured</span>
          <strong>{bool(health?.external?.torrentClientConfigured)}</strong>
          <span>Browser bridge</span>
          <strong>{bool(health?.browserTokenConfigured)}</strong>
        </div>
      </section>

      <section>
        <h3>Phase list</h3>
        {job?.phases?.length ? (
          <ol className="phase-list">
            {job.phases.map((phase) => (
              <li key={phase.phase}>
                <span>{phase.phase}</span>
                <strong>{phase.state}</strong>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No phase data for the selected job.</p>
        )}
      </section>

      <section>
        <h3>Debug controls</h3>
        <div className="button-row">
          <button type="button" onClick={onAdvance} disabled={!job}>
            Advance phase
          </button>
          <button type="button" onClick={onSkip} disabled={!job}>
            Skip
          </button>
          <button type="button" onClick={onForceState} disabled={!job}>
            Force state
          </button>
        </div>
      </section>

      <section>
        <h3>Global logs</h3>
        <div className="log-grid">
          <pre>{globalLogs.api.slice(-12).join("\n") || "No API log lines."}</pre>
          <pre>{globalLogs.worker.slice(-12).join("\n") || "No worker log lines."}</pre>
        </div>
      </section>

      <section>
        <h3>Job logs</h3>
        <pre>{jobLogs.lines.slice(-16).join("\n") || "No job log lines."}</pre>
      </section>
    </aside>
  );
}
