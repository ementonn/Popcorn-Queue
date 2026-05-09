import { FileUp, Link2, Search, UploadCloud } from "lucide-react";
import { useState } from "react";
import { createManualIntakeJob, searchPtpMovie, validateMediaPath } from "../api.js";
import type { ApiJob, ManualIntakePtpTarget, MediaPathValidationResult, PtpMovieSearchCandidate } from "../types.js";

interface NewJobPageProps {
  onCreated(job: ApiJob): void;
  onStatus(status: { tone: "success" | "error" | "info"; text: string }): void;
}

function releaseNameFromBasename(value: string): string {
  return value.replace(/\.[^.]+$/, "");
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function NewJobPage({ onCreated, onStatus }: NewJobPageProps) {
  const [mediaPath, setMediaPath] = useState("");
  const [validation, setValidation] = useState<MediaPathValidationResult | null>(null);
  const [torrentMode, setTorrentMode] = useState<"file" | "url">("file");
  const [torrentFile, setTorrentFile] = useState<File | null>(null);
  const [torrentUrl, setTorrentUrl] = useState("");
  const [releaseName, setReleaseName] = useState("");
  const [searchResults, setSearchResults] = useState<PtpMovieSearchCandidate[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<ManualIntakePtpTarget | null>(null);
  const [busy, setBusy] = useState(false);

  const hasTorrent = torrentMode === "file" ? Boolean(torrentFile) : torrentUrl.trim().length > 0;
  const canCreate = Boolean(validation?.ok && releaseName.trim() && hasTorrent && selectedTarget && !busy);

  async function handleValidate() {
    setBusy(true);
    try {
      const result = await validateMediaPath(mediaPath);
      setValidation(result);
      if (result.ok && !releaseName.trim()) setReleaseName(releaseNameFromBasename(result.basename));
      onStatus({ tone: result.ok ? "success" : "error", text: result.ok ? "Media path validated" : result.error ?? "Invalid media path" });
    } catch (error) {
      onStatus({ tone: "error", text: errorText(error, "Media path validation failed") });
    } finally {
      setBusy(false);
    }
  }

  async function handleSearch() {
    setBusy(true);
    try {
      const result = await searchPtpMovie({ title: releaseName, mediaPath });
      setSearchResults(result.results);
      setSelectedTarget(null);
      onStatus({ tone: result.results.length ? "success" : "info", text: result.results.length ? "PTP results loaded" : "No PTP movies found" });
    } catch (error) {
      onStatus({ tone: "error", text: errorText(error, "PTP search failed") });
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate() {
    if (!selectedTarget) return;
    setBusy(true);
    try {
      const input: Parameters<typeof createManualIntakeJob>[0] = {
        mediaPath,
        releaseName,
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
              placeholder="/home/emt/data/Movie.2024.1080p.WEB-DL.mkv"
            />
          </label>
          <div className="inline-actions">
            <button type="button" onClick={handleValidate} disabled={busy || !mediaPath.trim()}>
              <Search size={15} />
              Validate path
            </button>
            {validation ? (
              <span className={`inline-status ${validation.ok ? "ok" : "error"}`}>
                {validation.ok ? validation.basename : validation.error}
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
          <span>Release name</span>
          <input value={releaseName} onChange={(event) => setReleaseName(event.target.value)} placeholder="Movie.2024.1080p.WEB-DL.x265-GROUP" />
        </label>
      </section>

      <section className="intake-section" aria-labelledby="ptp-target-section-title">
        <div className="section-title-row">
          <h2 id="ptp-target-section-title">PTP Target</h2>
          {selectedTarget ? <span className="inline-status ok">Confirmed</span> : null}
        </div>
        <div className="intake-grid">
          <button type="button" onClick={handleSearch} disabled={busy || !releaseName.trim()}>
            <Search size={15} />
            Search PTP Movie
          </button>
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
      </div>
    </section>
  );
}
