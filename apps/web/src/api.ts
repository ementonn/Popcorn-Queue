import type { ApiJob, DiagnosticCheckResult, DiagnosticCheckTarget, DiagnosticsInfo, GlobalLogResponse, HealthInfo, JobLogResponse, ReviewDraftPatch } from "./types.js";

export interface DashboardData {
  jobs: ApiJob[];
  health: HealthInfo;
  globalLogs: GlobalLogResponse;
  diagnostics: DiagnosticsInfo | null;
}

const apiBase = (
  import.meta.env.VITE_API_BASE_URL ??
  import.meta.env.VITE_POPCORN_QUEUE_API_URL ??
  import.meta.env.VITE_API_URL ??
  ""
).replace(/\/$/, "");

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
  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
  });

  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${await parseError(response)}`);
  }

  return (await response.json()) as T;
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

export function resolveGate(jobId: string, gateId: string): Promise<{ job: ApiJob }> {
  return fetchJson<{ job: ApiJob }>(`/api/jobs/${jobId}/review-gates/${gateId}/resolve`, { method: "POST", body: "{}" });
}

export function saveReviewDraft(jobId: string, patch: ReviewDraftPatch): Promise<{ job: ApiJob }> {
  return fetchJson<{ job: ApiJob }>(`/api/jobs/${jobId}/review-draft`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function debugSkip(jobId: string): Promise<{ job: ApiJob }> {
  return fetchJson<{ job: ApiJob }>(`/api/jobs/${jobId}/debug/skip`, { method: "POST", body: "{}" });
}
