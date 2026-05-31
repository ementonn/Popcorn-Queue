import type {
  ApiJob,
  AuthSessionInfo,
  DeleteJobMode,
  DeleteJobResponse,
  DiagnosticCheckResult,
  DiagnosticCheckTarget,
  DiagnosticsInfo,
  GlobalLogResponse,
  HealthInfo,
  JobLogResponse,
  ManualIntakePtpTarget,
  MediaPathValidationResult,
  PtpMovieSearchResponse,
  ReviewDraftPatch,
  RssItem,
  RssRefreshResult,
  RssSettings,
  RssSubscription,
  RssSubscriptionInput,
  SettingsResponse,
  SaveSettingsResponse
} from "./types.js";

export interface DashboardData {
  jobs: ApiJob[];
  health: HealthInfo;
  globalLogs: GlobalLogResponse;
  diagnostics: DiagnosticsInfo | null;
}

export function inferApiBaseFromLocation(location: URL, apiPort = import.meta.env.VITE_POPCORN_QUEUE_API_PORT ?? "3500"): string {
  const port = apiPort.trim() || "3500";
  return `${location.protocol}//${location.hostname}:${port}`;
}

function defaultApiBase(): string {
  if (typeof window === "undefined") return "http://localhost:3500";
  return inferApiBaseFromLocation(new URL(window.location.href));
}

const apiBase = defaultApiBase().replace(/\/$/, "");

async function parseError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return response.statusText || "request_failed";

  try {
    const json = JSON.parse(text) as { error?: unknown; message?: unknown };
    const value = json.error ?? json.message;
    return typeof value === "string" ? value : text;
  } catch {
    return text;
  }
}

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const requestInit: RequestInit = { credentials: "include", ...(init ?? {}) };
  if (isFormData) {
    if (init?.headers) requestInit.headers = init.headers;
  } else {
    requestInit.headers = {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    };
  }
  const response = await fetch(`${apiBase}${path}`, requestInit);

  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${await parseError(response)}`);
  }

  return (await response.json()) as T;
}

export function loadAuthSession(): Promise<AuthSessionInfo> {
  return fetchJson<AuthSessionInfo>("/api/auth/session");
}

export function authSessionAfterCheckFailure(): AuthSessionInfo {
  return { authRequired: true, authenticated: false, username: null };
}

export function login(username: string, password: string): Promise<AuthSessionInfo> {
  return fetchJson<AuthSessionInfo>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
}

export function logout(): Promise<AuthSessionInfo> {
  return fetchJson<AuthSessionInfo>("/api/auth/logout", { method: "POST", body: "{}" });
}

export async function loadDashboard(): Promise<DashboardData> {
  const [jobs, health, globalLogs, diagnostics] = await Promise.all([
    fetchJson<{ jobs: ApiJob[] }>("/api/jobs"),
    fetchJson<HealthInfo>("/api/health"),
    loadGlobalLogs(),
    loadDiagnostics()
  ]);

  return { jobs: jobs.jobs, health, globalLogs, diagnostics };
}

export function loadJobLogs(jobId: string): Promise<JobLogResponse> {
  return fetchJson<JobLogResponse>(`/api/jobs/${jobId}/logs`).catch(() => ({ lines: [] }));
}

export function loadGlobalLogs(): Promise<GlobalLogResponse> {
  return fetchJson<GlobalLogResponse>("/api/logs/global").catch(() => ({ api: [] }));
}

export function loadDiagnostics(): Promise<DiagnosticsInfo | null> {
  return fetchJson<DiagnosticsInfo>("/api/diagnostics").catch(() => null);
}

export function runDiagnosticCheck(target: DiagnosticCheckTarget): Promise<DiagnosticCheckResult> {
  return fetchJson<DiagnosticCheckResult>(`/api/diagnostics/check/${target}`, { method: "POST", body: "{}" });
}

export function loadSettings(): Promise<SettingsResponse> {
  return fetchJson<SettingsResponse>("/api/settings");
}

export function saveSettings(values: Record<string, string | null>): Promise<SaveSettingsResponse> {
  return fetchJson<SaveSettingsResponse>("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({ values })
  });
}

export function validateMediaPath(mediaPath: string): Promise<MediaPathValidationResult> {
  return fetchJson<MediaPathValidationResult>("/api/intake/media-path/validate", {
    method: "POST",
    body: JSON.stringify({ mediaPath })
  });
}

export function searchPtpMovie(input: { title?: string; mediaPath?: string }): Promise<PtpMovieSearchResponse> {
  return fetchJson<PtpMovieSearchResponse>("/api/intake/ptp-search", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function resolvePtpTarget(input: { ptpUrl?: string; imdbUrl?: string }): Promise<{ target: ManualIntakePtpTarget }> {
  return fetchJson<{ target: ManualIntakePtpTarget }>("/api/intake/ptp-target/resolve", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function createManualIntakeJob(input: {
  mediaPath?: string;
  releaseName?: string;
  ptpTarget: ManualIntakePtpTarget;
  torrentFile?: File | null;
  torrentUrl?: string;
}): Promise<{ job: ApiJob }> {
  const form = new FormData();
  if (input.mediaPath?.trim()) form.set("mediaPath", input.mediaPath.trim());
  if (input.releaseName?.trim()) form.set("releaseName", input.releaseName.trim());
  form.set("ptpTarget", JSON.stringify(input.ptpTarget));
  if (input.torrentFile) form.set("torrent", input.torrentFile);
  if (input.torrentUrl) form.set("torrentUrl", input.torrentUrl);
  return fetchJson<{ job: ApiJob }>("/api/intake/jobs", { method: "POST", body: form });
}

export function startUpload(jobId: string): Promise<{ job: ApiJob }> {
  return fetchJson<{ job: ApiJob }>(`/api/jobs/${jobId}/start-upload`, { method: "POST", body: "{}" });
}

export function pauseJob(jobId: string): Promise<{ job: ApiJob }> {
  return fetchJson<{ job: ApiJob }>(`/api/jobs/${jobId}/pause`, { method: "POST", body: "{}" });
}

export function resumeJob(jobId: string): Promise<{ job: ApiJob }> {
  return fetchJson<{ job: ApiJob }>(`/api/jobs/${jobId}/resume`, { method: "POST", body: "{}" });
}

export function retryFailed(jobId: string): Promise<{ job: ApiJob }> {
  return fetchJson<{ job: ApiJob }>(`/api/jobs/${jobId}/retry-failed`, { method: "POST", body: "{}" });
}

export function retryPhase(jobId: string, phase: string): Promise<{ job: ApiJob }> {
  return fetchJson<{ job: ApiJob }>(`/api/jobs/${jobId}/phases/${phase}/retry`, { method: "POST", body: "{}" });
}

export function resolveGate(jobId: string, gateId: string): Promise<{ job: ApiJob }> {
  return fetchJson<{ job: ApiJob }>(`/api/jobs/${jobId}/review-gates/${gateId}/resolve`, { method: "POST", body: "{}" });
}

export function saveReviewDraft(jobId: string, patch: ReviewDraftPatch): Promise<{ job: ApiJob }> {
  return fetchJson<{ job: ApiJob }>(`/api/jobs/${jobId}/review-draft`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function debugSkip(jobId: string): Promise<{ job: ApiJob }> {
  return fetchJson<{ job: ApiJob }>(`/api/jobs/${jobId}/debug/skip`, { method: "POST", body: "{}" });
}

export function deleteJob(jobId: string, mode: DeleteJobMode): Promise<DeleteJobResponse> {
  return fetchJson<DeleteJobResponse>(`/api/jobs/${jobId}/delete`, {
    method: "POST",
    body: JSON.stringify({ mode, confirm: true })
  });
}

export function loadRssSettings(): Promise<{ settings: RssSettings }> {
  return fetchJson<{ settings: RssSettings }>("/api/rss/settings");
}

export function saveRssSettings(updateIntervalMs: number): Promise<{ settings: RssSettings }> {
  return fetchJson<{ settings: RssSettings }>("/api/rss/settings", {
    method: "PATCH",
    body: JSON.stringify({ updateIntervalMs })
  });
}

export function loadRssSubscriptions(): Promise<{ subscriptions: RssSubscription[] }> {
  return fetchJson<{ subscriptions: RssSubscription[] }>("/api/rss/subscriptions");
}

export function createRssSubscription(input: RssSubscriptionInput): Promise<{ subscription: RssSubscription }> {
  return fetchJson<{ subscription: RssSubscription }>("/api/rss/subscriptions", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateRssSubscription(id: string, input: Partial<RssSubscriptionInput>): Promise<{ subscription: RssSubscription }> {
  return fetchJson<{ subscription: RssSubscription }>(`/api/rss/subscriptions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function deleteRssSubscription(id: string): Promise<{ deleted: true }> {
  return fetchJson<{ deleted: true }>(`/api/rss/subscriptions/${id}`, { method: "DELETE", body: "{}" });
}

export function refreshRssSubscription(id: string): Promise<{ result: RssRefreshResult }> {
  return fetchJson<{ result: RssRefreshResult }>(`/api/rss/subscriptions/${id}/refresh`, { method: "POST", body: "{}" });
}

export function loadRssItems(id: string, view: "proposals" | "all"): Promise<{ items: RssItem[] }> {
  return fetchJson<{ items: RssItem[] }>(`/api/rss/subscriptions/${id}/items?view=${view}`);
}

export function acceptRssItem(id: string): Promise<{ item: RssItem; job: ApiJob }> {
  return fetchJson<{ item: RssItem; job: ApiJob }>(`/api/rss/items/${id}/accept`, { method: "POST", body: "{}" });
}

export function ignoreRssItem(id: string): Promise<{ item: RssItem }> {
  return fetchJson<{ item: RssItem }>(`/api/rss/items/${id}/ignore`, { method: "POST", body: "{}" });
}
