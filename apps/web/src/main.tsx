import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  Cog,
  Download,
  ExternalLink,
  FilePlus2,
  Filter,
  Gauge,
  GitBranch,
  HardDrive,
  HeartPulse,
  Home,
  Info,
  ListChecks,
  Pause,
  Play,
  RefreshCcw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  StepForward,
  UploadCloud,
  XCircle,
  Zap
} from "lucide-react";
import "./styles.css";

type JobState = "waiting" | "review" | "queued" | "running" | "paused" | "failed" | "done";
type StatusTone = "info" | "success" | "warn" | "error";

interface ApiJob {
  id: string;
  state: JobState;
  phase: string;
  updatedAt: string;
  source: {
    site?: string;
    url?: string;
    title?: string;
  };
  candidate?: {
    site: string;
    title: string;
    imdbId?: string | null;
    sourceTorrentId?: string | null;
  };
  checkResult?: {
    cache?: {
      hit: boolean;
      policy?: "permanent";
      cachedAt?: string;
    };
    decision?: {
      status: string;
      reason: string;
    };
  };
  torrent?: {
    filename: string;
    bytes: number;
    contentType?: string;
  };
  uploadPlan?: {
    releaseName?: {
      generated: string;
      group: string | null;
      container: string | null;
      warnings: string[];
    };
    scene?: {
      status: string;
      releaseGroup: string | null;
      providers: string[];
      evidence: string[];
    };
    screenshots?: {
      count: number;
      imageHosts: string[];
      toneMapHint: string;
    };
    torrentReuse?: {
      strategy: string;
      preservePieceHashes: boolean;
      reason: string;
    };
    metadata?: {
      imdbId: string | null;
      providers: Array<{ provider: string; status: string; reason: string }>;
      tags: string[];
    };
    media?: {
      container: string | null;
      discType: string;
      audio: { codecs: string[]; languages: string[]; commentaryLikely: boolean };
      subtitles: { languages: string[]; embeddedLikely: boolean };
      trumpableChecks: string[];
    };
    reviewGates: Array<{
      id: string;
      severity: "blocker" | "warning" | "info";
      status: "open" | "resolved";
      title: string;
      detail: string;
    }>;
  };
  phases?: Array<{
    phase: string;
    state: string;
    retryCount: number;
    message: string;
  }>;
}

interface FeatureInfo {
  id: string;
  name: string;
  status: string;
  detail: string;
}

interface HealthInfo {
  ok: boolean;
  ptpConfigured: boolean;
  browserTokenConfigured: boolean;
  cachePolicy?: "permanent";
}

interface UiJob {
  id?: string;
  name: string;
  state: JobState | "ready";
  phase: string;
  source: string;
  cache: string;
  size: string;
  signal: string;
  progress: number;
  apiJob?: ApiJob;
}

interface UiStatus {
  tone: StatusTone;
  text: string;
}

const phaseOrder = [
  "intake",
  "metadata",
  "duplicate-check",
  "download",
  "extract",
  "analyze",
  "screenshots",
  "torrent-create",
  "seed-start",
  "preflight",
  "upload",
  "post-hook",
  "done"
];

const demoJobs: UiJob[] = [
  {
    name: "ATHENA.2022.FRENCH.1080p.NF.WEB-DL.x265-SMURF",
    state: "review",
    phase: "duplicate-check",
    source: "M-Team",
    cache: "permanent hit",
    size: "6.4 GB",
    signal: "IMDb + resolution match",
    progress: 64
  },
  {
    name: "Home.Sweet.Home.2021.1080p.WEB-DL.HDR.H265-TJUPT",
    state: "queued",
    phase: "intake",
    source: "TJUPT",
    cache: "new",
    size: "4.8 GB",
    signal: "waiting for browser torrent",
    progress: 12
  },
  {
    name: "Interstellar.2014.2160p.UHD.BluRay.x265",
    state: "running",
    phase: "screenshots",
    source: "file",
    cache: "refreshed",
    size: "31.2 GB",
    signal: "scene ok, screenshots 4/6",
    progress: 72
  },
  {
    name: "Perfect.Days.2023.1080p.BluRay.FLAC.x264",
    state: "ready",
    phase: "preflight",
    source: "watch",
    cache: "permanent hit",
    size: "13.7 GB",
    signal: "rules clean",
    progress: 92
  }
];

const navItems = [
  { label: "Dashboard", icon: Home, active: false },
  { label: "Jobs", icon: ListChecks, active: true },
  { label: "Review", icon: ClipboardCheck, active: false },
  { label: "New Upload", icon: FilePlus2, active: false },
  { label: "Cross-Seed", icon: GitBranch, active: false },
  { label: "Health", icon: HeartPulse, active: false },
  { label: "Settings", icon: Cog, active: false }
];

function getApiBase(): string {
  const envBase = import.meta.env.VITE_POPCORN_QUEUE_API_URL;
  if (envBase) return String(envBase).replace(/\/+$/, "");
  return `${window.location.protocol}//${window.location.hostname}:3500`;
}

const apiBase = typeof window === "undefined" ? "" : getApiBase();

function formatBytes(bytes?: number): string {
  if (!bytes) return "--";
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function progressForPhase(phase: string): number {
  const index = phaseOrder.indexOf(phase);
  if (index < 0) return 0;
  return Math.round((index / (phaseOrder.length - 1)) * 100);
}

function formatApiError(path: string, response: Response, text: string): string {
  const prefix = `${path} failed with HTTP ${response.status}`;
  if (!text.trim()) return prefix;
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string; detail?: string };
    const detail = parsed.message ?? parsed.error ?? parsed.detail;
    if (detail) return `${prefix}: ${detail}`;
  } catch {
    // Use the plain response text below.
  }
  return `${prefix}: ${text.trim().slice(0, 240)}`;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "unknown error";
}

function initialSelectedJobId(): string | null {
  if (typeof window === "undefined") return null;
  const pathMatch = window.location.pathname.match(/^\/jobs\/([^/]+)/);
  if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]);
  return new URLSearchParams(window.location.search).get("job");
}

function jobHref(jobId: string): string {
  return `/jobs/${encodeURIComponent(jobId)}`;
}

function toUiJob(job: ApiJob): UiJob {
  const openGate = job.uploadPlan?.reviewGates.find((gate) => gate.status === "open");
  const cache = job.checkResult?.cache
    ? job.checkResult.cache.hit
      ? "permanent hit"
      : "refreshed"
    : "planned";
  const signal =
    openGate?.detail ??
    job.checkResult?.decision?.reason ??
    job.uploadPlan?.scene?.evidence?.[0] ??
    job.uploadPlan?.releaseName?.generated ??
    "upload plan ready";

  return {
    id: job.id,
    name: job.candidate?.title ?? job.source.title ?? "Untitled upload",
    state: job.state,
    phase: job.phase,
    source: job.source.site ?? job.candidate?.site ?? "manual",
    cache,
    size: formatBytes(job.torrent?.bytes),
    signal,
    progress: job.state === "done" ? 100 : progressForPhase(job.phase),
    apiJob: job
  };
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(formatApiError(path, response, text));
  return (text ? JSON.parse(text) : {}) as T;
}

function App() {
  const [jobs, setJobs] = useState<ApiJob[]>([]);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [features, setFeatures] = useState<FeatureInfo[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(() => initialSelectedJobId());
  const [statusMessage, setStatusMessage] = useState<UiStatus>({ tone: "info", text: "Connecting to API..." });

  async function loadData() {
    try {
      const [jobsResponse, healthResponse, featuresResponse] = await Promise.all([
        fetchJson<{ jobs: ApiJob[] }>("/api/jobs"),
        fetchJson<HealthInfo>("/api/health"),
        fetchJson<{ features: FeatureInfo[] }>("/api/features")
      ]);
      setJobs(jobsResponse.jobs);
      setHealth(healthResponse);
      setFeatures(featuresResponse.features);
      setStatusMessage({
        tone: "success",
        text: jobsResponse.jobs.length ? "API connected." : "API connected; showing examples until jobs arrive."
      });
      setSelectedJobId((current) => {
        if (current && jobsResponse.jobs.some((job) => job.id === current)) return current;
        return jobsResponse.jobs[0]?.id ?? current;
      });
    } catch (error) {
      setStatusMessage({ tone: "error", text: `API offline at ${apiBase}; showing local examples. ${formatUnknownError(error)}` });
    }
  }

  useEffect(() => {
    void loadData();
    const interval = window.setInterval(() => void loadData(), 10_000);
    return () => window.clearInterval(interval);
  }, []);

  const uiJobs = useMemo(() => (jobs.length ? jobs.map(toUiJob) : demoJobs), [jobs]);
  const selected = useMemo(() => {
    return uiJobs.find((job) => job.id && job.id === selectedJobId) ?? uiJobs[0] ?? demoJobs[0];
  }, [selectedJobId, uiJobs]);
  const realSelected = selected?.apiJob ?? jobs[0] ?? null;
  const allGates = realSelected?.uploadPlan?.reviewGates ?? [];
  const openGates = allGates.filter((gate) => gate.status === "open");
  const resolvedGates = allGates.filter((gate) => gate.status === "resolved");
  const gateCounts = {
    blocker: openGates.filter((gate) => gate.severity === "blocker").length,
    warning: openGates.filter((gate) => gate.severity === "warning").length,
    info: openGates.filter((gate) => gate.severity === "info").length
  };
  const counts = useMemo(() => {
    const active = uiJobs.filter((job) => job.state === "running").length;
    const review = uiJobs.filter((job) => job.state === "review").length;
    const ready = uiJobs.filter((job) => job.state === "queued" || job.state === "ready").length;
    return { active, review, ready, total: uiJobs.length };
  }, [uiJobs]);
  const filters = [
    { label: "All", count: counts.total, active: true },
    { label: "Review", count: counts.review, active: false },
    { label: "Running", count: counts.active, active: false },
    { label: "Cache hit", count: uiJobs.filter((job) => job.cache.includes("hit")).length, active: false }
  ];

  async function applyJobAction(action: "start" | "pause" | "retry" | "advance") {
    try {
      if (!realSelected) {
        await createSampleJob();
        return;
      }
      const response = await fetchJson<{ job: ApiJob }>(`/api/jobs/${realSelected.id}/${action}`, { method: "POST", body: "{}" });
      setJobs((current) => current.map((job) => (job.id === response.job.id ? response.job : job)));
      setSelectedJobId(response.job.id);
      setStatusMessage({ tone: "success", text: `${action} applied to ${response.job.candidate?.title ?? response.job.id}.` });
    } catch (error) {
      setStatusMessage({ tone: "error", text: `${action} failed: ${formatUnknownError(error)}` });
    }
  }

  async function resolveGate(jobId: string, gateId: string) {
    try {
      const response = await fetchJson<{ job: ApiJob }>(`/api/jobs/${jobId}/review-gates/${encodeURIComponent(gateId)}/resolve`, {
        method: "POST",
        body: "{}"
      });
      setJobs((current) => current.map((job) => (job.id === response.job.id ? response.job : job)));
      setStatusMessage({ tone: "success", text: "Review gate resolved." });
    } catch (error) {
      setStatusMessage({ tone: "error", text: `Resolve failed: ${formatUnknownError(error)}` });
    }
  }

  async function createSampleJob() {
    try {
      const response = await fetchJson<{ job: ApiJob }>("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          site: "unknown",
          title: "The.Holdovers.2023.1080p.BluRay.FLAC.x264-PTPQUEUE",
          imdbId: "tt14849194",
          sourceTorrentId: "manual-import"
        })
      });
      setJobs((current) => [response.job, ...current]);
      setSelectedJobId(response.job.id);
      setStatusMessage({ tone: "success", text: "Created sample upload job." });
    } catch (error) {
      setStatusMessage({ tone: "error", text: `Import failed: ${formatUnknownError(error)}` });
    }
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">pq</span>
          <span>Popcorn Queue</span>
        </div>

        <nav aria-label="Primary navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <a key={item.label} href={`#${item.label.toLowerCase().replace(/\s+/g, "-")}`} className={item.active ? "active" : undefined}>
                <Icon size={16} />
                <span>{item.label}</span>
              </a>
            );
          })}
        </nav>

        <div className="sidebar-section">
          <p>Instances</p>
          <button className="scope-button">
            <HardDrive size={15} />
            <span>All upload nodes</span>
            <ChevronDown size={14} />
          </button>
          <div className="instance-row">
            <span className={`dot ${health?.ok ? "online" : "warm"}`} />
            <span>api</span>
            <strong>{health?.ok ? "online" : "demo"}</strong>
          </div>
          <div className="instance-row">
            <span className={`dot ${health?.ptpConfigured ? "online" : "warm"}`} />
            <span>ptp-api</span>
            <strong>{health?.ptpConfigured ? "ready" : "missing"}</strong>
          </div>
        </div>

        <div className="sidebar-footer">
          <span>PTP cache</span>
          <strong>Permanent</strong>
        </div>
      </aside>

      <section className="workspace">
        <header className="toolbar">
          <div className="mobile-title">Popcorn Queue</div>
          <button className="icon-button" aria-label="Filter queue">
            <Filter size={16} />
          </button>
          <div className="search">
            <Search size={15} />
            <input placeholder="Search jobs, IMDb, PTP ID, source" />
          </div>
          <button className="action primary" onClick={() => void applyJobAction("start")}><Play size={15} />Start</button>
          <button className="action" onClick={() => void applyJobAction("pause")}><Pause size={15} />Pause</button>
          <button className="action" onClick={() => void applyJobAction("retry")}><RefreshCcw size={15} />Retry</button>
          <button className="action" onClick={() => void applyJobAction("advance")}><StepForward size={15} />Advance</button>
        </header>

        <section className="summary-strip" aria-label="Queue summary">
          <article>
            <span><Gauge size={15} />Active</span>
            <strong>{counts.active}</strong>
          </article>
          <article>
            <span><ShieldCheck size={15} />Review</span>
            <strong>{counts.review}</strong>
          </article>
          <article>
            <span><UploadCloud size={15} />Ready</span>
            <strong>{counts.ready}</strong>
          </article>
          <article>
            <span><Archive size={15} />PTP cache</span>
            <strong>Permanent</strong>
          </article>
        </section>

        <div className="workspace-body">
          <aside className="filter-sidebar" aria-label="Job filters">
            <div className="panel-heading">
              <span>Views</span>
              <button aria-label="Edit views"><Settings2 size={14} /></button>
            </div>
            {filters.map((filter) => (
              <button key={filter.label} className={filter.active ? "filter-chip active" : "filter-chip"}>
                <span>{filter.label}</span>
                <strong>{filter.count}</strong>
              </button>
            ))}
            <div className="filter-group">
              <p>Trackers</p>
              <label><input type="checkbox" defaultChecked /> M-Team</label>
              <label><input type="checkbox" defaultChecked /> TJUPT</label>
              <label><input type="checkbox" defaultChecked /> File import</label>
            </div>
          </aside>

          <section className="queue" aria-label="Upload queue">
            <div className="queue-header">
              <div>
                <h1>Jobs</h1>
                <div className={`status-banner ${statusMessage.tone}`} role="status">
                  {statusMessage.tone === "error" ? <AlertCircle size={15} /> : statusMessage.tone === "warn" ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
                  <span>{statusMessage.text}</span>
                </div>
              </div>
              <button className="action" onClick={() => void createSampleJob()}><Download size={15} />Import</button>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Release</th>
                    <th>Source</th>
                    <th>Phase</th>
                    <th>Size</th>
                    <th>Cache</th>
                    <th>Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {uiJobs.map((job) => (
                    <tr
                      key={job.id ?? job.name}
                      className={job.id && job.id === selectedJobId ? "selected" : undefined}
                      onClick={() => job.id && setSelectedJobId(job.id)}
                    >
                      <td><span className={`pill ${job.state}`}>{job.state}</span></td>
                      <td>
                        <div className="release-cell">
                          <strong>{job.name}</strong>
                          <span>{job.apiJob?.uploadPlan?.releaseName?.generated ?? "PTP upload candidate"}</span>
                        </div>
                      </td>
                      <td>{job.source}</td>
                      <td>{job.phase}</td>
                      <td>{job.size}</td>
                      <td>{job.cache}</td>
                      <td>
                        <div className="signal-cell">
                          <span>{job.signal}</span>
                          <div className="meter" aria-label={`${job.progress}% complete`}>
                            <i style={{ width: `${job.progress}%` }} />
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </section>

      <aside className="inspector">
        <h2><Activity size={17} /> Inspector</h2>
        <section className="inspector-card">
          <div className={`status-line ${openGates.length ? "warn" : ""}`}>
            {openGates.length ? <XCircle size={17} /> : <CheckCircle2 size={17} />}
            <span>{openGates.length ? `${openGates.length} review gates open` : "Upload plan ready"}</span>
          </div>
          {realSelected && (
            <a className="job-link" href={jobHref(realSelected.id)}>
              <ExternalLink size={14} />
              <span>{realSelected.id}</span>
            </a>
          )}
          <dl>
            <dt>Selected phase</dt><dd>{selected?.phase ?? "duplicate-check"}</dd>
            <dt>PTP cache</dt><dd>{selected?.cache ?? "Permanent"}</dd>
            <dt>Release name</dt><dd>{realSelected?.uploadPlan?.releaseName?.generated ?? "Review required"}</dd>
            <dt>Next action</dt><dd>{openGates.length ? "Resolve review gates before upload" : "Advance to the next phase"}</dd>
          </dl>
          {realSelected && (
            <div className="mini-actions">
              <button onClick={() => void applyJobAction("advance")}>Advance phase</button>
              <button onClick={() => void fetchJson<{ job: ApiJob }>(`/api/jobs/${realSelected.id}/plan/refresh`, { method: "POST", body: "{}" }).then((response) => {
                setJobs((current) => current.map((job) => (job.id === response.job.id ? response.job : job)));
                setStatusMessage({ tone: "success", text: "Upload plan refreshed." });
              }).catch((error: unknown) => {
                setStatusMessage({ tone: "error", text: `Refresh failed: ${formatUnknownError(error)}` });
              })}>Refresh plan</button>
            </div>
          )}
        </section>

        <section className="inspector-card">
          <h3><Server size={15} /> Upsies features</h3>
          <dl>
            <dt>Scene check</dt><dd>{realSelected?.uploadPlan?.scene?.status ?? "predbnet + srrdb planned"}</dd>
            <dt>Screenshots</dt><dd>{realSelected?.uploadPlan?.screenshots?.count ?? 6} planned with host fallback</dd>
            <dt>Torrent reuse</dt><dd>{realSelected?.uploadPlan?.torrentReuse?.strategy ?? "preserve piece hashes"}</dd>
            <dt>MediaInfo</dt><dd>{realSelected?.uploadPlan?.media?.audio.codecs.join(", ") || "pending"}</dd>
          </dl>
        </section>

        <section className="inspector-card">
          <h3><Activity size={15} /> Job status</h3>
          <div className="phase-list">
            {(realSelected?.phases ?? []).slice(0, 5).map((phase) => (
              <div className="phase-row" key={phase.phase}>
                <span className={`phase-dot ${phase.state}`} />
                <span>{phase.phase}</span>
                <strong>{phase.message || phase.state}</strong>
              </div>
            ))}
            {!realSelected?.phases?.length && <p className="muted-copy">Waiting for API job status.</p>}
          </div>
        </section>

        <section className="inspector-card">
          <h3><Info size={15} /> Review gates</h3>
          <div className="gate-summary" aria-label="Open review gate summary">
            <span><strong>{gateCounts.blocker}</strong> blockers</span>
            <span><strong>{gateCounts.warning}</strong> warnings</span>
            <span><strong>{gateCounts.info}</strong> info</span>
          </div>
          {openGates.length ? (
            <div className="gate-list">
              {openGates.map((gate) => (
                <div className={`gate ${gate.severity}`} key={gate.id}>
                  <div className="gate-title">
                    <strong>{gate.title}</strong>
                    <em>{gate.severity}</em>
                  </div>
                  <span>{gate.detail}</span>
                  {realSelected && <button onClick={() => void resolveGate(realSelected.id, gate.id)}>Resolve</button>}
                </div>
              ))}
            </div>
          ) : (
              <p className="muted-copy">No open gates. Banned groups, EVO encodes, MP4 remux, duplicate slots, and missing metadata are checked in the upload plan.</p>
          )}
          {resolvedGates.length > 0 && (
            <p className="muted-copy">{resolvedGates.length} resolved gate{resolvedGates.length === 1 ? "" : "s"} kept for audit.</p>
          )}
        </section>

        <section className="inspector-card note">
          <h3><Info size={15} /> Feature status</h3>
          <p>{features.find((feature) => feature.id === "upload-plan")?.detail ?? "Upsies-style upload planning is available when the API is connected."}</p>
        </section>
      </aside>

      <nav className="mobile-footer" aria-label="Mobile navigation">
        <a href="#dashboard"><Home size={18} /><span>Home</span></a>
        <a href="#jobs" className="active"><ListChecks size={18} /><span>Jobs</span></a>
        <a href="#review"><ClipboardCheck size={18} /><span>Review</span></a>
        <a href="#health"><Zap size={18} /><span>Health</span></a>
      </nav>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
