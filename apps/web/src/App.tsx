import { Activity, FilePlus2, LoaderCircle, LockKeyhole, LogOut, Pause, Play, RefreshCcw, Search, SlidersHorizontal } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  loadDashboard,
  loadAuthSession,
  authSessionAfterCheckFailure,
  loadGlobalLogs,
  loadJobLogs,
  login,
  logout,
  pauseJob,
  resumeJob,
  retryFailed,
  runDiagnosticCheck,
  saveReviewDraft,
  startUpload
} from "./api.js";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel.js";
import { JobDrawer } from "./components/JobDrawer.js";
import { NewJobPage } from "./components/NewJobPage.js";
import { QueueTable } from "./components/QueueTable.js";
import { ReviewPanel } from "./components/ReviewPanel.js";
import type {
  ApiJob,
  AuthSessionInfo,
  DiagnosticCheckResult,
  DiagnosticCheckTarget,
  DiagnosticsInfo,
  GlobalLogResponse,
  HealthInfo,
  JobLogResponse,
  ReviewDraft
} from "./types.js";

type ActiveView = "jobs" | "new-job" | "diagnostics";
type PendingJobAction = { jobId: string; label: string; kind: "upload" | "pause" | "resume" | "retry" };

function updateJob(jobs: ApiJob[], updated: ApiJob): ApiJob[] {
  return jobs.map((job) => (job.id === updated.id ? updated : job));
}

function jobDisplayTitle(job: ApiJob): string {
  return job.artifacts?.releaseName ?? job.uploadPlan?.releaseName?.generated ?? job.candidate?.title ?? job.source.title ?? job.id;
}

function LoginView({
  loading,
  onLogin
}: {
  loading: boolean;
  onLogin: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const disabled = loading || submitting || !username.trim() || !password;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled) return;
    setSubmitting(true);
    setError(null);
    try {
      await onLogin(username.trim(), password);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Sign in failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={handleSubmit}>
        <div className="login-brand">
          <img className="brand-mark" src="/icon.svg" alt="" aria-hidden="true" />
          <span>Popcorn Queue</span>
        </div>
        <h1>Sign in</h1>
        <label className="field">
          PTP username
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            disabled={loading || submitting}
            autoFocus
          />
        </label>
        <label className="field">
          PTP password
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="current-password"
            disabled={loading || submitting}
          />
        </label>
        {error ? (
          <div className="inline-status error login-error" role="alert">
            {error}
          </div>
        ) : null}
        <button type="submit" className="primary" disabled={disabled}>
          {submitting || loading ? <LoaderCircle className="spin-icon" size={15} /> : <LockKeyhole size={15} />}
          {loading ? "Checking..." : submitting ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}

function SessionBootView() {
  return (
    <main className="login-shell">
      <div className="session-panel" role="status" aria-live="polite">
        <div className="login-brand">
          <img className="brand-mark" src="/icon.svg" alt="" aria-hidden="true" />
          <span>Popcorn Queue</span>
        </div>
        <LoaderCircle className="spin-icon session-spinner" size={22} />
        <span>Checking session</span>
      </div>
    </main>
  );
}

export function App() {
  const [authSession, setAuthSession] = useState<AuthSessionInfo | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
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
  const [pendingJobAction, setPendingJobAction] = useState<PendingJobAction | null>(null);
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
  const selectedJobCanPause = Boolean(selectedJob && selectedJob.state !== "done" && selectedJob.state !== "needs_reseed");
  const selectedPendingAction = pendingJobAction?.jobId === selectedJob?.id ? pendingJobAction : null;

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
    let cancelled = false;
    loadAuthSession()
      .then((session) => {
        if (!cancelled) setAuthSession(session);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setAuthSession(authSessionAfterCheckFailure());
          setStatus({ tone: "error", text: error instanceof Error ? error.message : "Unable to check web session" });
        }
      })
      .finally(() => {
        if (!cancelled) setAuthLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (authLoading || (authSession?.authRequired && !authSession.authenticated)) return;
    refresh().catch((error: unknown) => {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "Unable to load dashboard" });
    });
    const timer = window.setInterval(() => {
      refresh().catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [authLoading, authSession?.authRequired, authSession?.authenticated, refresh]);

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
      options: { flushDraft?: boolean; pendingLabel?: string; kind?: PendingJobAction["kind"] } = {}
    ) => {
      if (!selectedJob || pendingJobAction) return;
      const pending: PendingJobAction = {
        jobId: selectedJob.id,
        label: options.pendingLabel ?? `${label}...`,
        kind: options.kind ?? "pause"
      };
      setPendingJobAction(pending);
      if (pending.kind === "upload") setStatus({ tone: "info", text: `Uploading to PTP: ${jobDisplayTitle(selectedJob)}` });
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
      } finally {
        setPendingJobAction((current) => (current?.jobId === pending.jobId && current.kind === pending.kind ? null : current));
      }
    },
    [pendingJobAction, selectedJob, withLocalDraft]
  );

  const runJobIdAction = useCallback(async (jobId: string, action: (jobId: string) => Promise<{ job: ApiJob }>, label: string) => {
    if (pendingJobAction) return;
    const pending: PendingJobAction = {
      jobId,
      label: `${label}...`,
      kind: label === "Retry" ? "retry" : label === "Resume" ? "resume" : "pause"
    };
    setPendingJobAction(pending);
    try {
      const result = await action(jobId);
      setJobs((current) => updateJob(current, withLocalDraft(result.job)));
      setSelectedJobId(result.job.id);
      setStatus({ tone: "success", text: `${label}: ${result.job.id}` });
      setJobLogs(await loadJobLogs(result.job.id));
      setGlobalLogs(await loadGlobalLogs());
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : `${label} failed` });
    } finally {
      setPendingJobAction((current) => (current?.jobId === pending.jobId && current.kind === pending.kind ? null : current));
    }
  }, [pendingJobAction, withLocalDraft]);

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

  const handleManualJobCreated = useCallback((job: ApiJob) => {
    const next = withLocalDraft(job);
    setJobs((current) => [next, ...current.filter((item) => item.id !== next.id)]);
    setSelectedJobId(next.id);
    setActiveView("jobs");
    setStatus({ tone: "success", text: `Created job: ${next.id}` });
  }, [withLocalDraft]);

  const handleLogin = useCallback(
    async (username: string, password: string) => {
      const session = await login(username, password);
      setAuthSession(session);
      setStatus(null);
      await refresh();
    },
    [refresh]
  );

  const handleLogout = useCallback(async () => {
    try {
      const session = await logout();
      setAuthSession(session);
      setJobs([]);
      setHealth(null);
      setSelectedJobId(null);
      setJobLogs({ lines: [] });
      setGlobalLogs({ api: [] });
      setDiagnostics(null);
      setDiagnosticChecks({});
      setStatus(null);
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "Logout failed" });
    }
  }, []);

  if (authLoading) {
    return <SessionBootView />;
  }

  if (authSession?.authRequired && !authSession.authenticated) {
    return <LoginView loading={false} onLogin={handleLogin} />;
  }

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
          <a
            href="/new-job"
            className={activeView === "new-job" ? "active" : undefined}
            onClick={(event) => {
              event.preventDefault();
              setActiveView("new-job");
            }}
          >
            <FilePlus2 size={16} />
            New Job
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
        {authSession?.authRequired && authSession.authenticated ? (
          <div className="sidebar-footer">
            <button type="button" className="sidebar-button" onClick={handleLogout}>
              <LogOut size={15} />
              Logout
            </button>
          </div>
        ) : null}
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
            <a
              href="/new-job"
              className={activeView === "new-job" ? "active" : undefined}
              onClick={(event) => {
                event.preventDefault();
                setActiveView("new-job");
              }}
            >
              New Job
            </a>
          </nav>
          {authSession?.authRequired && authSession.authenticated ? (
            <button type="button" className="mobile-logout" onClick={handleLogout}>
              <LogOut size={15} />
              Logout
            </button>
          ) : null}
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
                  {selectedJobCanPause ? (
                    <button
                      type="button"
                      onClick={() => runJobAction(selectedJob?.state === "paused" ? resumeJob : pauseJob, selectedJob?.state === "paused" ? "Resume" : "Pause")}
                      disabled={!selectedJob || Boolean(selectedPendingAction)}
                    >
                      {selectedJob?.state === "paused" ? <Play size={15} /> : <Pause size={15} />}
                      {selectedJob?.state === "paused" ? "Resume" : "Pause"}
                    </button>
                  ) : null}
                  <button type="button" onClick={() => runJobAction(retryFailed, "Retry failed steps", { kind: "retry" })} disabled={!selectedJob || Boolean(selectedPendingAction)}>
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
            pendingAction={pendingJobAction}
            onSelect={setSelectedJobId}
            onPause={(jobId) => runJobIdAction(jobId, pauseJob, "Pause")}
            onResume={(jobId) => runJobIdAction(jobId, resumeJob, "Resume")}
            onRetry={(jobId) => runJobIdAction(jobId, retryFailed, "Retry")}
          />
        ) : activeView === "new-job" ? (
          <NewJobPage onCreated={handleManualJobCreated} onStatus={setStatus} />
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
                {selectedPendingAction?.kind === "upload" || (selectedJob.state === "review" && selectedJob.uploadReadiness === "ready") ? (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => runJobAction(startUpload, "Upload", { flushDraft: true, pendingLabel: "Uploading...", kind: "upload" })}
                    disabled={Boolean(selectedPendingAction)}
                    aria-busy={selectedPendingAction?.kind === "upload" ? "true" : undefined}
                  >
                    {selectedPendingAction?.kind === "upload" ? <LoaderCircle className="spin-icon" size={15} /> : <Play size={15} />}
                    {selectedPendingAction?.kind === "upload" ? "Uploading..." : "Upload"}
                  </button>
                ) : null}
                {selectedJobCanPause ? (
                  <button
                    type="button"
                    onClick={() =>
                      runJobAction(selectedJob.state === "paused" ? resumeJob : pauseJob, selectedJob.state === "paused" ? "Resume" : "Pause", {
                        kind: selectedJob.state === "paused" ? "resume" : "pause"
                      })
                    }
                    disabled={Boolean(selectedPendingAction)}
                  >
                    {selectedJob.state === "paused" ? <Play size={15} /> : <Pause size={15} />}
                    {selectedJob.state === "paused" ? "Resume" : "Pause"}
                  </button>
                ) : null}
                <button type="button" onClick={() => runJobAction(retryFailed, "Retry failed steps", { kind: "retry" })} disabled={Boolean(selectedPendingAction)}>
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
