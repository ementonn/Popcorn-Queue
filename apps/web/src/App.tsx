import { Activity, Pause, Play, RefreshCcw, Search, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  debugAdvance,
  debugForceState,
  debugSkip,
  loadDashboard,
  loadGlobalLogs,
  loadJobLogs,
  pauseJob,
  resolveGate,
  retryFailed,
  saveReviewDraft,
  startUpload
} from "./api.js";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel.js";
import { QueueTable } from "./components/QueueTable.js";
import { ReviewPanel } from "./components/ReviewPanel.js";
import type { ApiJob, GlobalLogResponse, HealthInfo, JobLogResponse } from "./types.js";

function updateJob(jobs: ApiJob[], updated: ApiJob): ApiJob[] {
  return jobs.map((job) => (job.id === updated.id ? updated : job));
}

export function App() {
  const [jobs, setJobs] = useState<ApiJob[]>([]);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobLogs, setJobLogs] = useState<JobLogResponse>({ lines: [] });
  const [globalLogs, setGlobalLogs] = useState<GlobalLogResponse>({ api: [], worker: [] });
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [status, setStatus] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? jobs[0] ?? null,
    [jobs, selectedJobId]
  );

  const visibleJobs = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    if (!needle) return jobs;
    return jobs.filter((job) => {
      const haystack = [job.id, job.source.title, job.source.site, job.candidate?.title, job.candidate?.imdbId]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [jobs, searchTerm]);

  const refresh = useCallback(async () => {
    const dashboard = await loadDashboard();
    setJobs(dashboard.jobs);
    setHealth(dashboard.health);
    setGlobalLogs(dashboard.globalLogs);
    setSelectedJobId((current) => current ?? dashboard.jobs[0]?.id ?? null);
  }, []);

  useEffect(() => {
    refresh().catch((error: unknown) => {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "Unable to load dashboard" });
    });
    const timer = window.setInterval(() => {
      refresh().catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!selectedJob?.id) {
      setJobLogs({ lines: [] });
      return;
    }
    let cancelled = false;
    const load = () => {
      loadJobLogs(selectedJob.id)
        .then((logs) => {
          if (!cancelled) setJobLogs(logs);
        })
        .catch(() => {
          if (!cancelled) setJobLogs({ lines: [] });
        });
    };
    load();
    const timer = window.setInterval(load, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedJob?.id]);

  const runJobAction = useCallback(
    async (action: (jobId: string) => Promise<{ job: ApiJob }>, label: string) => {
      if (!selectedJob) return;
      try {
        const result = await action(selectedJob.id);
        setJobs((current) => updateJob(current, result.job));
        setStatus({ tone: "success", text: `${label}: ${result.job.id}` });
        setJobLogs(await loadJobLogs(result.job.id));
        setGlobalLogs(await loadGlobalLogs());
      } catch (error) {
        setStatus({ tone: "error", text: error instanceof Error ? error.message : `${label} failed` });
      }
    },
    [selectedJob]
  );

  const runJobIdAction = useCallback(async (jobId: string, action: (jobId: string) => Promise<{ job: ApiJob }>, label: string) => {
    try {
      const result = await action(jobId);
      setJobs((current) => updateJob(current, result.job));
      setSelectedJobId(result.job.id);
      setStatus({ tone: "success", text: `${label}: ${result.job.id}` });
      setJobLogs(await loadJobLogs(result.job.id));
      setGlobalLogs(await loadGlobalLogs());
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : `${label} failed` });
    }
  }, []);

  const handleResolveGate = useCallback(async (jobId: string, gateId: string) => {
    try {
      const result = await resolveGate(jobId, gateId);
      setJobs((current) => updateJob(current, result.job));
      setStatus({ tone: "success", text: `Gate resolved: ${gateId}` });
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "Gate resolve failed" });
    }
  }, []);

  const handleSaveReviewDraft = useCallback(async (jobId: string, patch: Parameters<typeof saveReviewDraft>[1]) => {
    const result = await saveReviewDraft(jobId, patch);
    setJobs((current) => updateJob(current, result.job));
    setStatus({ tone: "success", text: `Draft saved: ${result.job.id}` });
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">PQ</span>
          <span>Popcorn Queue</span>
        </div>
        <nav aria-label="Main">
          <a href="/" className="active" onClick={(event) => event.preventDefault()}>
            <Activity size={16} />
            Jobs
          </a>
        </nav>
        <div className="sidebar-section">
          <p>Service</p>
          <div className="instance-row">
            <span className={`dot ${health?.ok ? "online" : "warm"}`} />
            <span>API</span>
            <strong>{health?.ok ? "online" : "checking"}</strong>
          </div>
          <div className="instance-row">
            <span className={`dot ${health?.external?.torrentClientConfigured ? "online" : "warm"}`} />
            <span>qB handoff</span>
            <strong>{health?.external?.torrentClientConfigured ? "ready" : "manual"}</strong>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="toolbar">
          <span className="mobile-title">Popcorn Queue</span>
          <label className="search">
            <Search size={16} />
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search jobs, IMDb, source"
            />
          </label>
          <button
            type="button"
            className="primary"
            disabled={selectedJob?.uploadReadiness !== "ready"}
            onClick={() => runJobAction(startUpload, "Start Upload")}
          >
            <Play size={15} />
            Start Upload
          </button>
          <button type="button" onClick={() => runJobAction(pauseJob, "Pause")} disabled={!selectedJob}>
            <Pause size={15} />
            Pause
          </button>
          <button type="button" onClick={() => runJobAction(retryFailed, "Retry failed steps")} disabled={!selectedJob}>
            <RefreshCcw size={15} />
            Retry failed steps
          </button>
          <button type="button" onClick={() => setDiagnosticsOpen((value) => !value)}>
            <SlidersHorizontal size={15} />
            Diagnostics
          </button>
        </header>

        {status ? <div className={`status-banner ${status.tone}`}>{status.text}</div> : null}

        <QueueTable
          jobs={visibleJobs}
          selectedJobId={selectedJob?.id ?? null}
          onSelect={setSelectedJobId}
          onStartUpload={(jobId) => runJobIdAction(jobId, startUpload, "Start Upload")}
        />
      </main>

      <ReviewPanel job={selectedJob} jobLogs={jobLogs} onResolveGate={handleResolveGate} onSaveReviewDraft={handleSaveReviewDraft} />

      {diagnosticsOpen ? (
        <DiagnosticsPanel
          job={selectedJob}
          health={health}
          globalLogs={globalLogs}
          jobLogs={jobLogs}
          onAdvance={() => runJobAction(debugAdvance, "Advance phase")}
          onSkip={() => runJobAction(debugSkip, "Skip")}
          onForceState={() => runJobAction(debugForceState, "Force state")}
        />
      ) : null}
    </div>
  );
}
