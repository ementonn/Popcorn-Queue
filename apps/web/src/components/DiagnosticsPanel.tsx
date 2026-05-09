import { useState, type ReactNode } from "react";
import type { DiagnosticCheckResult, DiagnosticCheckTarget, DiagnosticToolName, DiagnosticsInfo, GlobalLogResponse, HealthInfo } from "../types.js";

interface DiagnosticsPanelProps {
  health: HealthInfo | null;
  globalLogs: GlobalLogResponse;
  diagnostics: DiagnosticsInfo | null;
  checks: Partial<Record<DiagnosticCheckTarget, DiagnosticCheckResult>>;
  onRunCheck(target: DiagnosticCheckTarget): Promise<void>;
}

function bool(value: boolean | undefined): string {
  if (value === undefined) return "unknown";
  return value ? "OK" : "No";
}

function apiStatusLabel(status: string | undefined, healthOk: boolean | undefined): string {
  const value = status ?? (healthOk ? "online" : "unknown");
  return value === "online" ? "OK" : value;
}

function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "unknown";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let current = value / 1024;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(current >= 10 ? 1 : 2)} ${units[unit]}`;
}

function checkDisplay(base: Omit<DiagnosticCheckResult, "target"> | undefined, result: DiagnosticCheckResult | undefined): Omit<DiagnosticCheckResult, "target"> {
  return result ?? base ?? { configured: false, status: "not_checked", detail: "No diagnostic data." };
}

function statusLabel(display: Omit<DiagnosticCheckResult, "target">): string {
  if (display.status === "ok" || display.status === "configured" || (display.status === "not_checked" && display.configured)) return "OK";
  if (display.status === "missing") return "Missing";
  if (display.status === "failed") return "Failed";
  if (display.status === "disabled") return "Disabled";
  return "Not checked";
}

function showDiagnosticDetail(display: Omit<DiagnosticCheckResult, "target">): boolean {
  if (!display.detail) return false;
  if (statusLabel(display) !== "OK") return true;
  const detail = display.detail.toLowerCase();
  return !(
    detail.includes(" is configured") ||
    detail.includes(" are configured") ||
    detail.includes(" is enabled") ||
    detail.includes(" are enabled")
  );
}

type DiagnosticTone = "positive" | "negative" | "neutral";

function diagnosticTone(value: ReactNode): DiagnosticTone {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "neutral";
  const normalized = String(value).trim().toLowerCase();
  if (!normalized || normalized === "unknown" || normalized === "not_checked") return "neutral";
  if (["ok", "yes", "enabled", "online", "configured", "ready", "complete", "completed", "true"].includes(normalized)) return "positive";
  if (["no", "disabled", "failed", "missing", "unavailable", "offline", "error", "not set", "false"].includes(normalized)) return "negative";
  return "neutral";
}

function DiagnosticValue({ children, testId }: { children: ReactNode; testId?: string }) {
  const tone = diagnosticTone(children);
  return (
    <strong className={`diagnostic-value ${tone}`} data-testid={testId}>
      {children}
    </strong>
  );
}

function DiagnosticStatus({ children, testId }: { children: ReactNode; testId?: string }) {
  const tone = diagnosticTone(children);
  return (
    <span className={`diagnostic-value ${tone}`} data-testid={testId}>
      {children}
    </span>
  );
}

export function DiagnosticsPanel({
  health,
  globalLogs,
  diagnostics,
  checks,
  onRunCheck
}: DiagnosticsPanelProps) {
  const [running, setRunning] = useState<DiagnosticCheckTarget | null>(null);
  const apiLog = diagnostics?.logs.api ?? globalLogs.api;
  const integrations = [
    { target: "qbittorrent" as const, label: "qB", button: "Check qB", base: diagnostics?.integrations.qbittorrent },
    { target: "ptp" as const, label: "PTP", button: "Check PTP", base: diagnostics?.integrations.ptp },
    { target: "image-host" as const, label: "Image host", button: "Check image host", base: diagnostics?.integrations.imageHost },
    { target: "tools" as const, label: "Tools", button: "Check tools", base: diagnostics?.integrations.tools }
  ];
  const toolOrder: DiagnosticToolName[] = ["ffmpeg", "mediainfo", "mkvmerge", "oxipng"];

  async function run(target: DiagnosticCheckTarget) {
    setRunning(target);
    try {
      await onRunCheck(target);
    } finally {
      setRunning(null);
    }
  }

  return (
    <section className="diagnostics" data-testid="diagnostics-panel">
      <div className="diagnostics-header">
        <h2>Diagnostics</h2>
        <span className={`diagnostic-value ${health?.ok ? "positive" : "negative"}`}>{health?.ok ? "API health: OK" : "API health: unavailable"}</span>
      </div>

      <section>
        <h3>System Health</h3>
        <div className="diagnostic-grid">
          <span>API</span>
          <DiagnosticValue>{apiStatusLabel(diagnostics?.system.api, health?.ok)}</DiagnosticValue>
          <span>Persistence</span>
          <DiagnosticValue>{diagnostics?.system.persistence ?? "unknown"}</DiagnosticValue>
          <span>Public web URL</span>
          <DiagnosticValue>{diagnostics?.system.publicWebUrl ?? health?.publicWebUrl ?? "not set"}</DiagnosticValue>
          <span>Public API URL</span>
          <DiagnosticValue>{diagnostics?.system.publicApiUrl ?? health?.publicApiUrl ?? "not set"}</DiagnosticValue>
          <span>PTP API</span>
          <DiagnosticValue testId="diagnostic-system-ptp-api">{bool(diagnostics?.system.ptpApiConfigured ?? health?.ptpConfigured)}</DiagnosticValue>
          <span>Browser bridge</span>
          <DiagnosticValue testId="diagnostic-system-browser-bridge">{bool(diagnostics?.system.browserBridgeConfigured ?? health?.browserTokenConfigured)}</DiagnosticValue>
          <span>External tools</span>
          <DiagnosticValue testId="diagnostic-system-external-tools">{(diagnostics?.system.externalToolsEnabled ?? health?.external?.externalToolsEnabled) ? "OK" : "Disabled"}</DiagnosticValue>
        </div>
      </section>

      <section>
        <h3>Integration Checks</h3>
        <div className="diagnostic-actions">
          {integrations.map((item) => {
            const display = checkDisplay(item.base, checks[item.target]);
            const label = statusLabel(display);
            return (
              <div className="diagnostic-action" key={item.target}>
                <div>
                  <strong>{item.label}</strong>
                  <DiagnosticStatus testId={`diagnostic-check-${item.target}-status`}>{label}</DiagnosticStatus>
                  {showDiagnosticDetail(display) ? <p>{display.detail}</p> : null}
                </div>
                <button type="button" onClick={() => void run(item.target)} disabled={running === item.target}>
                  {running === item.target ? "Checking" : item.button}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h3>Tool Versions</h3>
        <div className="tool-diagnostics">
          {toolOrder.map((toolName) => {
            const tool = diagnostics?.tools?.[toolName];
            return (
              <div className="tool-row" data-testid={`diagnostic-tool-${toolName}`} key={toolName}>
                <strong>{toolName}</strong>
                <DiagnosticStatus testId={`diagnostic-tool-${toolName}-status`}>{tool?.available ? "OK" : "Failed"}</DiagnosticStatus>
                <span>{tool?.version ?? tool?.error ?? "unknown"}</span>
                <code>{tool?.location ?? tool?.command ?? "unknown"}</code>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h3>Queue Health</h3>
        <div className="diagnostic-grid">
          <span>Total</span>
          <DiagnosticValue>{diagnostics?.queue.total ?? "unknown"}</DiagnosticValue>
          <span>Preparing</span>
          <DiagnosticValue>{diagnostics?.queue.preparing ?? "unknown"}</DiagnosticValue>
          <span>Review</span>
          <DiagnosticValue>{diagnostics?.queue.review ?? "unknown"}</DiagnosticValue>
          <span>Failed</span>
          <DiagnosticValue>{diagnostics?.queue.failed ?? "unknown"}</DiagnosticValue>
          <span>Done</span>
          <DiagnosticValue>{diagnostics?.queue.done ?? "unknown"}</DiagnosticValue>
          <span>Paused</span>
          <DiagnosticValue>{diagnostics?.queue.paused ?? "unknown"}</DiagnosticValue>
          <span>Stuck jobs</span>
          <DiagnosticValue>{diagnostics?.queue.stuck.length ?? "unknown"}</DiagnosticValue>
        </div>
      </section>

      <section>
        <h3>Storage / Cache</h3>
        <div className="diagnostic-grid">
          <span>Data root</span>
          <DiagnosticValue>{diagnostics?.storage.dataRoot ?? "unknown"}</DiagnosticValue>
          <span>Database</span>
          <DiagnosticValue>{diagnostics?.storage.databasePath ?? "unknown"}</DiagnosticValue>
          <span>Jobs</span>
          <DiagnosticValue>{diagnostics?.storage.jobCount ?? "unknown"}</DiagnosticValue>
          <span>Cache entries</span>
          <DiagnosticValue>{diagnostics?.storage.cacheEntries ?? "unknown"}</DiagnosticValue>
          <span>DB size</span>
          <DiagnosticValue>{bytes(diagnostics?.storage.databaseBytes)}</DiagnosticValue>
          <span>Free space</span>
          <DiagnosticValue>{bytes(diagnostics?.storage.dataRootFreeBytes)}</DiagnosticValue>
        </div>
      </section>

      <section>
        <h3>Configured Services</h3>
        <div className="diagnostic-grid">
          <span>Image host</span>
          <DiagnosticValue>{health?.external?.imageHost ?? "not set"}</DiagnosticValue>
          <span>qB configured</span>
          <DiagnosticValue>{bool(health?.external?.torrentClientConfigured)}</DiagnosticValue>
        </div>
      </section>

      <section>
        <h3>API Log</h3>
        <pre>{apiLog.slice(-100).join("\n") || "No API log lines."}</pre>
      </section>
    </section>
  );
}
