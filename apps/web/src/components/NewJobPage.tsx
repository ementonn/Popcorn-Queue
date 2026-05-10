import { FileUp, Link2, Search, UploadCloud } from "lucide-react";
import { useState } from "react";
import { createManualIntakeJob, resolvePtpTarget, searchPtpMovie, validateMediaPath } from "../api.js";
import type { ApiJob, ManualIntakePtpTarget, MediaPathValidationResult, PtpMovieSearchCandidate } from "../types.js";

interface NewJobPageProps {
  onCreated(job: ApiJob): void;
  onStatus(status: { tone: "success" | "error" | "info"; text: string }): void;
}

const STRIPPED_SOURCE_EXTENSIONS = /\.(mkv|mp4|m2ts|ts|mov|avi|torrent)$/i;

function releaseNameFromBasename(value: string): string {
  return value.replace(STRIPPED_SOURCE_EXTENSIONS, "");
}

function releaseNameFromValidation(validation: MediaPathValidationResult): string {
  return validation.kind === "file" ? releaseNameFromBasename(validation.basename) : validation.basename;
}

function releaseNameFromPathLike(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return releaseNameFromBasename(decodeURIComponent(new URL(trimmed).pathname.split("/").filter(Boolean).at(-1) ?? ""));
  } catch {
    return releaseNameFromBasename(trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function mediaValidationText(validation: MediaPathValidationResult): string {
  if (validation.warning === "media_path_is_directory") return "Warning: selected path is a folder, not a file.";
  if (validation.ok) return validation.basename;
  return validation.error ?? "Invalid media path";
}

function mediaValidationTone(validation: MediaPathValidationResult): "ok" | "warning" | "error" {
  if (validation.warning) return "warning";
  return validation.ok ? "ok" : "error";
}

export function NewJobPage({ onCreated, onStatus }: NewJobPageProps) {
  const [mediaPath, setMediaPath] = useState("");
  const [validation, setValidation] = useState<MediaPathValidationResult | null>(null);
  const [torrentMode, setTorrentMode] = useState<"file" | "url">("file");
  const [torrentFile, setTorrentFile] = useState<File | null>(null);
  const [torrentUrl, setTorrentUrl] = useState("");
  const [releaseName, setReleaseName] = useState("");
  const [searchResults, setSearchResults] = useState<PtpMovieSearchCandidate[]>([]);
  const [searchNotice, setSearchNotice] = useState<{ tone: "error"; text: string } | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<ManualIntakePtpTarget | null>(null);
  const [manualPtpUrl, setManualPtpUrl] = useState("");
  const [manualImdbUrl, setManualImdbUrl] = useState("");
  const [manualTargetError, setManualTargetError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hasTorrent = torrentMode === "file" ? Boolean(torrentFile) : torrentUrl.trim().length > 0;
  const hasValidMediaPath = Boolean(validation?.ok);
  const hasInputSource = hasValidMediaPath || hasTorrent;
  const derivedReleaseName =
    releaseName.trim() ||
    (validation?.ok ? releaseNameFromValidation(validation) : mediaPath.trim() ? releaseNameFromPathLike(mediaPath) : "") ||
    (torrentMode === "file" ? (torrentFile ? releaseNameFromBasename(torrentFile.name) : "") : releaseNameFromPathLike(torrentUrl));
  const canSearch = Boolean(derivedReleaseName || mediaPath.trim());
  const missingCreateRequirements = [
    hasInputSource ? null : "Validate media path or add source torrent",
    selectedTarget ? null : "Confirm PTP target"
  ].filter((item): item is string => Boolean(item));
  const createStatusText = busy
    ? "Working..."
    : missingCreateRequirements.length
      ? `Missing: ${missingCreateRequirements.join(", ")}`
      : null;
  const canCreate = !busy && missingCreateRequirements.length === 0;

  async function handleValidate() {
    setBusy(true);
    try {
      const result = await validateMediaPath(mediaPath);
      setValidation(result);
      onStatus({
        tone: result.ok ? (result.warning ? "info" : "success") : "error",
        text: result.warning ? mediaValidationText(result) : result.ok ? "Media path validated" : result.error ?? "Invalid media path"
      });
    } catch (error) {
      onStatus({ tone: "error", text: errorText(error, "Media path validation failed") });
    } finally {
      setBusy(false);
    }
  }

  async function handleSearch() {
    setBusy(true);
    try {
      const result = await searchPtpMovie({ title: derivedReleaseName, mediaPath });
      setSearchResults(result.results);
      setSelectedTarget(null);
      setSearchNotice(result.results.length ? null : { tone: "error", text: "No PTP movies found" });
      if (result.results.length) onStatus({ tone: "success", text: "PTP results loaded" });
    } catch (error) {
      const message = errorText(error, "PTP search failed");
      setSearchNotice({ tone: "error", text: message });
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate() {
    if (!canCreate || !selectedTarget) return;
    setBusy(true);
    try {
      const input: Parameters<typeof createManualIntakeJob>[0] = {
        ...(hasValidMediaPath ? { mediaPath: mediaPath.trim() } : {}),
        ...(releaseName.trim() ? { releaseName: releaseName.trim() } : {}),
        ptpTarget: selectedTarget,
        ...(torrentFile ? { torrentFile } : {}),
        ...(torrentMode === "url" ? { torrentUrl: torrentUrl.trim() } : {})
      };
      const result = await createManualIntakeJob(input);
      onCreated(result.job);
    } catch (error) {
      onStatus({ tone: "error", text: errorText(error, "Create job failed") });
    } finally {
      setBusy(false);
    }
  }

  async function handleManualTargetConfirm() {
    const ptpUrl = manualPtpUrl.trim();
    const imdbUrl = manualImdbUrl.trim();
    if (!ptpUrl && !imdbUrl) {
      setManualTargetError("Enter a PTP URL, Movie ID, or IMDb URL.");
      onStatus({ tone: "error", text: "Manual PTP target needs a PTP URL, Movie ID, or IMDb URL" });
      return;
    }

    setBusy(true);
    try {
      const result = await resolvePtpTarget({
        ...(ptpUrl ? { ptpUrl } : {}),
        ...(imdbUrl ? { imdbUrl } : {})
      });
      setSelectedTarget(result.target);
      setManualTargetError(null);
      setSearchNotice(null);
      onStatus({ tone: "success", text: "PTP target confirmed" });
    } catch (error) {
      const message = errorText(error, "PTP target lookup failed");
      setManualTargetError(message);
      onStatus({ tone: "error", text: message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="new-job-page">
      <div className="page-heading">
        <div>
          <h1>New Job</h1>
        </div>
        <UploadCloud size={22} aria-hidden="true" />
      </div>

      <section className="intake-section" aria-labelledby="media-section-title">
        <h2 id="media-section-title">Media</h2>
        <div className="intake-grid">
          <label className="field">
            <span>Server media path</span>
            <input
              value={mediaPath}
              onChange={(event) => {
                setMediaPath(event.target.value);
                setValidation(null);
              }}
              placeholder="/media/movies/Movie.2024.1080p.WEB-DL.mkv"
            />
          </label>
          <div className="inline-actions">
            <button type="button" onClick={handleValidate} disabled={busy || !mediaPath.trim()}>
              <Search size={15} />
              Validate path
            </button>
            {validation ? (
              <span className={`inline-status ${mediaValidationTone(validation)}`}>
                {mediaValidationText(validation)}
              </span>
            ) : null}
          </div>
        </div>
      </section>

      <section className="intake-section" aria-labelledby="torrent-section-title">
        <h2 id="torrent-section-title">Source Torrent</h2>
        <div className="intake-grid">
          <div className="segmented" role="group" aria-label="Torrent source">
            <button type="button" className={torrentMode === "file" ? "active" : undefined} onClick={() => setTorrentMode("file")}>
              <FileUp size={15} />
              Upload file
            </button>
            <button type="button" className={torrentMode === "url" ? "active" : undefined} onClick={() => setTorrentMode("url")}>
              <Link2 size={15} />
              Torrent URL
            </button>
          </div>
          {torrentMode === "file" ? (
            <label className="field">
              <span>Torrent file</span>
              <input name="torrent" type="file" accept=".torrent,application/x-bittorrent" onChange={(event) => setTorrentFile(event.target.files?.[0] ?? null)} />
            </label>
          ) : (
            <label className="field">
              <span>Torrent URL</span>
              <input value={torrentUrl} onChange={(event) => setTorrentUrl(event.target.value)} placeholder="https://tracker.example/download/123.torrent" />
            </label>
          )}
        </div>
      </section>

      <section className="intake-section" aria-labelledby="release-section-title">
        <h2 id="release-section-title">Release</h2>
        <label className="field">
          <span>Release name override</span>
          <input value={releaseName} onChange={(event) => setReleaseName(event.target.value)} placeholder="Movie.2024.1080p.WEB-DL.x265-GROUP" />
        </label>
      </section>

      <section className="intake-section" aria-labelledby="ptp-target-section-title">
        <div className="section-title-row">
          <h2 id="ptp-target-section-title">PTP Target</h2>
          {selectedTarget ? <span className="inline-status ok">Confirmed</span> : null}
        </div>
        <div className="intake-grid">
          <button type="button" onClick={handleSearch} disabled={busy || !canSearch}>
            <Search size={15} />
            Search PTP Movie
          </button>
          {searchNotice ? <span className={`inline-status ${searchNotice.tone}`}>{searchNotice.text}</span> : null}
          {searchResults.length ? (
            <div className="ptp-result-list">
              {searchResults.map((result) => (
                <div className={`ptp-result ${selectedTarget?.groupId === result.groupId ? "selected-target" : ""}`} key={result.groupId}>
                  <a href={result.ptpUrl} target="_blank" rel="noreferrer">
                    {result.displayTitle}
                  </a>
                  <button type="button" onClick={() => setSelectedTarget(result)}>
                    Confirm
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="manual-target-panel" aria-label="Manual PTP target">
            <h3>Manual target</h3>
            <div className="manual-target-grid">
              <label className="field manual-target-wide">
                <span>PTP URL or Movie ID</span>
                <input
                  value={manualPtpUrl}
                  onChange={(event) => {
                    const value = event.target.value;
                    setManualPtpUrl(value);
                    if (value.trim()) setManualImdbUrl("");
                    setManualTargetError(null);
                  }}
                  placeholder="https://passthepopcorn.me/torrents.php?id=205678"
                />
              </label>
              <label className="field manual-target-wide">
                <span>IMDb URL</span>
                <input
                  value={manualImdbUrl}
                  onChange={(event) => {
                    const value = event.target.value;
                    setManualImdbUrl(value);
                    if (value.trim()) setManualPtpUrl("");
                    setManualTargetError(null);
                  }}
                  placeholder="https://www.imdb.com/title/tt0075169/"
                />
              </label>
            </div>
            <div className="inline-actions">
              <button type="button" onClick={handleManualTargetConfirm} disabled={busy || (!manualPtpUrl.trim() && !manualImdbUrl.trim())}>
                <Link2 size={15} />
                Confirm
              </button>
              {manualTargetError ? <span className="inline-status error">{manualTargetError}</span> : null}
            </div>
          </div>
          {selectedTarget ? (
            <div className="selected-target-summary">
              <span>Selected movie</span>
              <a href={selectedTarget.ptpUrl} target="_blank" rel="noreferrer">
                {selectedTarget.displayTitle}
              </a>
            </div>
          ) : null}
        </div>
      </section>

      <div className="intake-actions">
        <button type="button" className="primary" onClick={handleCreate} disabled={!canCreate}>
          <UploadCloud size={15} />
          Create Job
        </button>
        <div className="create-status-row" aria-live="polite">
          {createStatusText ? <span className="inline-status warning">{createStatusText}</span> : null}
        </div>
      </div>
    </section>
  );
}
