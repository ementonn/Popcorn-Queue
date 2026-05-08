import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiJob } from "../types.js";

interface JobDrawerProps {
  job: ApiJob | null;
  onClose: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

const STORAGE_KEY = "popcorn.drawer.width";
const DEFAULT_WIDTH = 860;
const MIN_WIDTH = 520;
const DESKTOP_MARGIN = 260;

function releaseTitle(job: ApiJob): string {
  return job.artifacts?.releaseName ?? job.reviewDraft?.releaseName ?? job.uploadPlan?.releaseName?.generated ?? job.candidate?.title ?? job.source.title ?? job.id;
}

function clampWidth(value: number): number {
  if (typeof window === "undefined") return value;
  const max = window.innerWidth <= 700 ? window.innerWidth : Math.max(MIN_WIDTH, window.innerWidth - DESKTOP_MARGIN);
  const min = Math.min(MIN_WIDTH, max);
  return Math.min(Math.max(value, min), max);
}

function storedWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  const value = Number.parseInt(window.localStorage.getItem(STORAGE_KEY) ?? "", 10);
  return clampWidth(Number.isFinite(value) ? value : DEFAULT_WIDTH);
}

export function JobDrawer({ job, onClose, actions, children }: JobDrawerProps) {
  const [width, setWidth] = useState(storedWidth);
  const title = useMemo(() => (job ? releaseTitle(job) : ""), [job]);

  useEffect(() => {
    if (!job) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [job, onClose]);

  useEffect(() => {
    if (!job) return;
    setWidth((current) => clampWidth(current));
  }, [job]);

  const beginResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 700) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (moveEvent: PointerEvent) => {
      const next = clampWidth(startWidth + startX - moveEvent.clientX);
      setWidth(next);
      window.localStorage.setItem(STORAGE_KEY, String(Math.round(next)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [width]);

  if (!job) return null;

  return (
    <aside
      aria-label="Job review"
      className="job-drawer"
      data-testid="job-drawer"
      role="dialog"
      style={{ width: `${width}px` }}
    >
      <div className="job-drawer__resizer" data-testid="job-drawer-resizer" onPointerDown={beginResize} />
      <header className="job-drawer__header">
        <div>
          <span className={`readiness ${job.uploadReadiness}`}>{job.uploadReadiness.replace("_", " ")}</span>
          <h2>{title}</h2>
          <p>{job.humanStep ?? job.phase}</p>
        </div>
        <div className="job-drawer__controls">
          {actions ? <div className="job-drawer__actions">{actions}</div> : null}
          <button type="button" aria-label="Close job review" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </header>
      <div className="job-drawer__body">{children}</div>
    </aside>
  );
}
