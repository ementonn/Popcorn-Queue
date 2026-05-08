import { useEffect, useState } from "react";
import { PTP_CODECS, PTP_CONTAINERS, PTP_RESOLUTIONS, PTP_SOURCES, PTP_SUBTITLE_OPTIONS, PTP_TRUMPABLE_OPTIONS, PTP_TYPES } from "../ptp-options.js";
import type { ReviewDraft } from "../types.js";

interface DraftEditorProps {
  draft: ReviewDraft;
  saving?: boolean;
  error?: string | null;
  onSave: (patch: Partial<ReviewDraft>) => Promise<void>;
}

function normalizeDraft(draft: ReviewDraft): ReviewDraft {
  return {
    ...draft,
    groupId: draft.groupId ?? null,
    otherSource: draft.otherSource ?? "",
    otherCodec: draft.otherCodec ?? "",
    otherContainer: draft.otherContainer ?? "",
    otherResolutionWidth: draft.otherResolutionWidth ?? "",
    otherResolutionHeight: draft.otherResolutionHeight ?? "",
    imdb: draft.imdb ?? "",
    title: draft.title ?? "",
    year: draft.year ?? "",
    image: draft.image ?? "",
    trailer: draft.trailer ?? "",
    tags: draft.tags ?? "",
    synopsis: draft.synopsis ?? "",
    remaster: draft.remaster ?? Boolean(draft.remasterYear || draft.remasterTitle),
    special: draft.special ?? "",
    uploadToken: draft.uploadToken ?? "",
    artists: draft.artists?.length ? draft.artists : [{ name: "", importance: "" }]
  };
}

function setListValue(values: string[], value: string, checked: boolean): string[] {
  if (checked) return [...new Set([...values, value])];
  return values.filter((item) => item !== value);
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: readonly string[]; onChange: (value: string) => void }) {
  return (
    <label className="draft-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option value={option} key={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

export function DraftEditor({ draft, saving = false, error = null, onSave }: DraftEditorProps) {
  const [form, setForm] = useState(() => normalizeDraft(draft));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [localSaving, setLocalSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const isSaving = saving || localSaving;

  useEffect(() => {
    setForm(normalizeDraft(draft));
    setSaved(false);
    setLocalError(null);
  }, [draft]);

  const update = <K extends keyof ReviewDraft>(key: K, value: ReviewDraft[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  return (
    <form
      className="draft-editor"
      onSubmit={(event) => {
        event.preventDefault();
        setLocalSaving(true);
        setLocalError(null);
        void onSave(form)
          .then(() => {
            setSaved(true);
          })
          .catch((saveError: unknown) => {
            setLocalError(saveError instanceof Error ? saveError.message : "Draft save failed");
          })
          .finally(() => setLocalSaving(false));
      }}
    >
      <div className="draft-grid">
        <label className="draft-field wide">
          <span>Release name</span>
          <input value={form.releaseName} onChange={(event) => update("releaseName", event.target.value)} />
        </label>
        <label className="draft-field">
          <span>PTP group</span>
          <input value={form.groupId ?? ""} onChange={(event) => update("groupId", event.target.value || null)} />
        </label>
        <SelectField label="Type" value={form.type} options={PTP_TYPES} onChange={(value) => update("type", value)} />
        <SelectField label="Source" value={form.source} options={PTP_SOURCES} onChange={(value) => update("source", value)} />
        <SelectField label="Codec" value={form.codec} options={PTP_CODECS} onChange={(value) => update("codec", value)} />
        <SelectField label="Container" value={form.container} options={PTP_CONTAINERS} onChange={(value) => update("container", value)} />
        <SelectField label="Resolution" value={form.resolution} options={PTP_RESOLUTIONS} onChange={(value) => update("resolution", value)} />
        {form.resolution === "Other" ? (
          <>
            <label className="draft-field">
              <span>Width</span>
              <input value={form.otherResolutionWidth ?? ""} onChange={(event) => update("otherResolutionWidth", event.target.value)} />
            </label>
            <label className="draft-field">
              <span>Height</span>
              <input value={form.otherResolutionHeight ?? ""} onChange={(event) => update("otherResolutionHeight", event.target.value)} />
            </label>
          </>
        ) : null}
        <div className="draft-field wide">
          <span>Subtitles</span>
          <div className="draft-checkbox-row">
            {PTP_SUBTITLE_OPTIONS.map((option) => (
              <label key={option.id}>
                <input
                  type="checkbox"
                  checked={form.subtitles.includes(option.id)}
                  onChange={(event) => update("subtitles", setListValue(form.subtitles, option.id, event.target.checked))}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="draft-field wide">
          <span>Trumpable</span>
          <div className="draft-checkbox-row">
            {PTP_TRUMPABLE_OPTIONS.map((option) => (
              <label key={option.id}>
                <input
                  type="checkbox"
                  checked={form.trumpable.includes(option.id)}
                  onChange={(event) => update("trumpable", setListValue(form.trumpable, option.id, event.target.checked))}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="draft-checkbox-row wide">
          {(["scene", "personalRip", "internal"] as const).map((key) => (
            <label key={key}>
              <input type="checkbox" checked={form[key]} onChange={(event) => update(key, event.target.checked)} />
              <span>{key === "personalRip" ? "Personal rip" : key}</span>
            </label>
          ))}
        </div>
        <label className="draft-field wide">
          <span>Description</span>
          <textarea value={form.description} onChange={(event) => update("description", event.target.value)} />
        </label>
      </div>

      <button className="advanced-toggle" type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((value) => !value)}>
        Advanced PTP fields
      </button>

      {advancedOpen ? (
        <div className="draft-grid advanced-fields">
          <label className="draft-field">
            <span>IMDb</span>
            <input value={form.imdb ?? ""} onChange={(event) => update("imdb", event.target.value)} />
          </label>
          <label className="draft-field">
            <span>Title</span>
            <input value={form.title ?? ""} onChange={(event) => update("title", event.target.value)} />
          </label>
          <label className="draft-field">
            <span>Year</span>
            <input value={form.year ?? ""} onChange={(event) => update("year", event.target.value)} />
          </label>
          <label className="draft-field">
            <span>Poster image</span>
            <input value={form.image ?? ""} onChange={(event) => update("image", event.target.value)} />
          </label>
          <label className="draft-field">
            <span>Trailer</span>
            <input value={form.trailer ?? ""} onChange={(event) => update("trailer", event.target.value)} />
          </label>
          <label className="draft-field">
            <span>Tags</span>
            <input value={form.tags ?? ""} onChange={(event) => update("tags", event.target.value)} />
          </label>
          <label className="draft-field">
            <span>Special</span>
            <input value={form.special ?? ""} onChange={(event) => update("special", event.target.value)} />
          </label>
          <label className="draft-field">
            <span>Upload token</span>
            <input value={form.uploadToken ?? ""} onChange={(event) => update("uploadToken", event.target.value)} />
          </label>
          <label className="draft-field">
            <span>Remaster year</span>
            <input value={form.remasterYear} onChange={(event) => update("remasterYear", event.target.value)} />
          </label>
          <label className="draft-field">
            <span>Remaster title</span>
            <input value={form.remasterTitle} onChange={(event) => update("remasterTitle", event.target.value)} />
          </label>
          <label className="draft-field wide">
            <span>Synopsis</span>
            <textarea value={form.synopsis ?? ""} onChange={(event) => update("synopsis", event.target.value)} />
          </label>
          <label className="draft-field">
            <span>Artist</span>
            <input
              value={form.artists?.[0]?.name ?? ""}
              onChange={(event) => update("artists", [{ name: event.target.value, importance: form.artists?.[0]?.importance ?? "" }])}
            />
          </label>
          <label className="draft-field">
            <span>Artist role</span>
            <select
              value={form.artists?.[0]?.importance ?? ""}
              onChange={(event) => update("artists", [{ name: form.artists?.[0]?.name ?? "", importance: event.target.value as "1" | "2" | "3" | "4" | "5" | "" }])}
            >
              <option value="">Not set</option>
              <option value="1">Director</option>
              <option value="2">Writer</option>
              <option value="3">Producer</option>
              <option value="4">Composer</option>
              <option value="5">Cinematographer</option>
            </select>
          </label>
          <label className="draft-checkbox-row wide">
            <input type="checkbox" checked={Boolean(form.remaster)} onChange={(event) => update("remaster", event.target.checked)} />
            <span>Remaster</span>
          </label>
        </div>
      ) : null}

      <div className="draft-actions">
        <button type="submit" className="primary" disabled={isSaving}>
          Save draft
        </button>
        {saved ? <span>Draft saved</span> : null}
        {error || localError ? <span className="error-text">{error ?? localError}</span> : null}
      </div>
    </form>
  );
}

