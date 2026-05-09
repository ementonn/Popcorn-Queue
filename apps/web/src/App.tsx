import { Activity, Pause, Play, RefreshCcw, Search, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  loadDashboard,
  loadGlobalLogs,
  loadJobLogs,
  pauseJob,
  resumeJob,
  retryFailed,
  runDiagnosticCheck,
  saveReviewDraft,
  startUpload
} from "./api.js";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel.js";
import { JobDrawer } from "./components/JobDrawer.js";
import { QueueTable } from "./components/QueueTable.js";
import { ReviewPanel } from "./components/ReviewPanel.js";
import type { ApiJob, DiagnosticCheckResult, DiagnosticCheckTarget, DiagnosticsInfo, GlobalLogResponse, HealthInfo, JobLogResponse, ReviewDraft } from "./types.js";

type ActiveView = "jobs" | "diagnostics";

function updateJob(jobs: ApiJob[], updated: ApiJob): ApiJob[] {
  return jobs.map((job) => (job.id === updated.id ? updated : job));
}

export function App() {
  const [jobs, setJobs] = useState<ApiJob[]>([]);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobLogs, setJobLogs] = useState<JobLogResponse>({ lines: [] });
  const [globalLogs, setGlobalLogs] = useState<GlobalLogResponse>({ api: [] });
  const [diagnostics, setDiagnostics] = useState<DiagnosticsInfo | null>(null);
  const [diagnosticChecks, setDiagnosticChecks] = useState<Partial<Record<DiagnosticCheckTarget, DiagnosticCheckResult>>>({});
  const [activeView, setActiveView] = useState<ActiveView>("jobs");
  const [status, setStatus] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const localDraftsRef = useRef(new Map<string, ReviewDraft>());
  const draftFlushersRef = useRef(new Map<string, () => Promise<void>>());

  const withLocalDraft = useCallback((job: ApiJob): ApiJob => {
    const draft = localDraftsRef.current.get(job.id);
    return draft ? { ...job, reviewDraft: draft } : job;
  }, []);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? null,
    [jobs, selectedJobId]
  );
  const selectedJobComplete = selectedJob?.state === "done";

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
    setJobs(dashboard.jobs.map(withLocalDraft));
    setHealth(dashboard.health);
    setGlobalLogs(dashboard.globalLogs);
    setDiagnostics(dashboard.diagnostics);
    setSelectedJobId((current) => (current && dashboard.jobs.some((job) => job.id === current) ? current : null));
  }, [withLocalDraft]);

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
    async (
      action: (jobId: string) => Promise<{ job: ApiJob }>,
      label: string,
      options: { flushDraft?: boolean } = {}
    ) => {
      if (!selectedJob) return;
      try {
        if (options.flushDraft) {
          await draftFlushersRef.current.get(selectedJob.id)?.();
        }
        const result = await action(selectedJob.id);
        setJobs((current) => updateJob(current, withLocalDraft(result.job)));
        setStatus({ tone: "success", text: `${label}: ${result.job.id}` });
        setJobLogs(await loadJobLogs(result.job.id));
        setGlobalLogs(await loadGlobalLogs());
      } catch (error) {
        setStatus({ tone: "error", text: error instanceof Error ? error.message : `${label} failed` });
      }
    },
    [selectedJob, withLocalDraft]
  );

  const runJobIdAction = useCallback(async (jobId: string, action: (jobId: string) => Promise<{ job: ApiJob }>, label: string) => {
    try {
      const result = await action(jobId);
      setJobs((current) => updateJob(current, withLocalDraft(result.job)));
      setSelectedJobId(result.job.id);
      setStatus({ tone: "success", text: `${label}: ${result.job.id}` });
      setJobLogs(await loadJobLogs(result.job.id));
      setGlobalLogs(await loadGlobalLogs());
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : `${label} failed` });
    }
  }, [withLocalDraft]);

  const handleSaveReviewDraft = useCallback(async (jobId: string, patch: Parameters<typeof saveReviewDraft>[1]) => {
    const result = await saveReviewDraft(jobId, patch);
    if (result.job.reviewDraft) localDraftsRef.current.set(result.job.id, result.job.reviewDraft);
    setJobs((current) => updateJob(current, withLocalDraft(result.job)));
  }, [withLocalDraft]);

  const handleRegisterDraftFlush = useCallback((jobId: string, flush: (() => Promise<void>) | null) => {
    if (flush) {
      draftFlushersRef.current.set(jobId, flush);
      return;
    }
    draftFlushersRef.current.delete(jobId);
  }, []);

  const handleDiagnosticCheck = useCallback(async (target: DiagnosticCheckTarget) => {
    const result = await runDiagnosticCheck(target);
    setDiagnosticChecks((current) => ({ ...current, [target]: result }));
    const tools = result.tools;
    if (target === "tools" && tools) {
      setDiagnostics((current) => (current ? { ...current, tools } : current));
    }
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src="/icon.svg" alt="" aria-hidden="true" />
          <span>Popcorn Queue</span>
        </div>
        <nav aria-label="Main">
          <a
            href="/"
            className={activeView === "jobs" ? "active" : undefined}
            onClick={(event) => {
              event.preventDefault();
              setActiveView("jobs");
            }}
          >
            <Activity size={16} />
            Jobs
          </a>
          <a
            href="/diagnostics"
            className={activeView === "diagnostics" ? "active" : undefined}
            onClick={(event) => {
              event.preventDefault();
              setActiveView("diagnostics");
            }}
          >
            <SlidersHorizontal size={16} />
            Diagnostics
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
            <span>qBittorrent seeding</span>
            <strong>{health?.external?.torrentClientConfigured ? "Ready" : "Manual"}</strong>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="toolbar">
          <span className="mobile-title">Popcorn Queue</span>
          <nav className="mobile-nav" aria-label="Mobile main">
            <a
              href="/"
              className={activeView === "jobs" ? "active" : undefined}
              onClick={(event) => {
                event.preventDefault();
                setActiveView("jobs");
              }}
            >
              Jobs
            </a>
            <a
              href="/diagnostics"
              className={activeView === "diagnostics" ? "active" : undefined}
              onClick={(event) => {
                event.preventDefault();
                setActiveView("diagnostics");
              }}
            >
              Diagnostics
            </a>
          </nav>
          {activeView === "jobs" ? (
            <>
              <label className="search">
                <Search size={16} />
                <input
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder="Search jobs, IMDb, source"
                />
              </label>
              {!selectedJobComplete ? (
                <>
                  <button
                    type="button"
                    onClick={() => runJobAction(selectedJob?.state === "paused" ? resumeJob : pauseJob, selectedJob?.state === "paused" ? "Resume" : "Pause")}
                    disabled={!selectedJob}
                  >
                    {selectedJob?.state === "paused" ? <Play size={15} /> : <Pause size={15} />}
                    {selectedJob?.state === "paused" ? "Resume" : "Pause"}
                  </button>
                  <button type="button" onClick={() => runJobAction(retryFailed, "Retry failed steps")} disabled={!selectedJob}>
                    <RefreshCcw size={15} />
                    Retry failed steps
                  </button>
                </>
              ) : null}
            </>
          ) : null}
        </header>

        {status ? <div className={`status-banner ${status.tone}`}>{status.text}</div> : null}

        {activeView === "jobs" ? (
          <QueueTable
            jobs={visibleJobs}
            selectedJobId={selectedJob?.id ?? null}
            onSelect={setSelectedJobId}
            onPause={(jobId) => runJobIdAction(jobId, pauseJob, "Pause")}
            onResume={(jobId) => runJobIdAction(jobId, resumeJob, "Resume")}
            onRetry={(jobId) => runJobIdAction(jobId, retryFailed, "Retry")}
          />
        ) : (
          <DiagnosticsPanel
            health={health}
            globalLogs={globalLogs}
            diagnostics={diagnostics}
            checks={diagnosticChecks}
            onRunCheck={handleDiagnosticCheck}
          />
        )}
      </main>

      {activeView === "jobs" ? (
        <JobDrawer
          job={selectedJob}
          onClose={() => setSelectedJobId(null)}
          actions={
            selectedJob && selectedJob.state !== "done" ? (
              <>
                {selectedJob.uploadReadiness === "ready" ? (
                  <button type="button" className="primary" onClick={() => runJobAction(startUpload, "Upload", { flushDraft: true })}>
                    <Play size={15} />
                    Upload
                  </button>
                ) : null}
                <button type="button" onClick={() => runJobAction(selectedJob.state === "paused" ? resumeJob : pauseJob, selectedJob.state === "paused" ? "Resume" : "Pause")}>
                  {selectedJob.state === "paused" ? <Play size={15} /> : <Pause size={15} />}
                  {selectedJob.state === "paused" ? "Resume" : "Pause"}
                </button>
                <button type="button" onClick={() => runJobAction(retryFailed, "Retry failed steps")}>
                  <RefreshCcw size={15} />
                  Retry
                </button>
              </>
            ) : null
          }
        >
          <ReviewPanel
            job={selectedJob}
            jobLogs={jobLogs}
            onSaveReviewDraft={handleSaveReviewDraft}
            onRegisterDraftFlush={handleRegisterDraftFlush}
          />
        </JobDrawer>
      ) : null}
    </div>
  );
}
