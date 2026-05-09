import { useCallback, useEffect, useRef, useState } from "react";
import { PTP_CODECS, PTP_CONTAINERS, PTP_RESOLUTIONS, PTP_SOURCES, PTP_SUBTITLE_OPTIONS, PTP_TRUMPABLE_OPTIONS, PTP_TYPES } from "../ptp-options.js";
import type { ReviewDraft } from "../types.js";

const AUTOSAVE_DELAY_MS = 600;

interface DraftEditorProps {
  draft: ReviewDraft;
  draftKey?: string;
  saving?: boolean;
  error?: string | null;
  onSave: (patch: Partial<ReviewDraft>) => Promise<void>;
  onRegisterFlush?: (flush: (() => Promise<void>) | null) => void;
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

const PTP_EDITION_TAG_GROUPS = [
  {
    label: "Collections",
    tags: ["Masters of Cinema", "The Criterion Collection", "Warner Archive Collection"]
  },
  {
    label: "Editions",
    tags: ["Director's Cut", "Extended Edition", "Rifftrax", "Theatrical Cut", "Uncut", "Unrated"]
  },
  {
    label: "Features",
    tags: [
      "2-Disc Set",
      "2in1",
      "2D/3D Edition",
      "3D Anaglyph",
      "3D Full SBS",
      "3D Half OU",
      "3D Half SBS",
      "4K Restoration",
      "4K Remaster",
      "10-bit",
      "DTS:X",
      "Dolby Atmos",
      "Dolby Vision",
      "Dual Audio",
      "English Dub",
      "Extras",
      "HDR10",
      "HDR10+",
      "Remux",
      "With Commentary"
    ]
  }
] as const;

export function DraftEditor({ draft, draftKey = "", saving = false, error = null, onSave, onRegisterFlush }: DraftEditorProps) {
  const [form, setForm] = useState(() => normalizeDraft(draft));
  const [activeDraftKey, setActiveDraftKey] = useState(draftKey);
  const [dirty, setDirty] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [localSaving, setLocalSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const formRef = useRef(form);
  const autosaveTimerRef = useRef<number | null>(null);
  const lastSavedSnapshotRef = useRef(JSON.stringify(form));
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  const saveAfterCurrentRef = useRef(false);
  const isSaving = saving || localSaving;

  useEffect(() => {
    formRef.current = form;
  }, [form]);

  const clearAutosaveTimer = useCallback(() => {
    if (autosaveTimerRef.current === null) return;
    window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = null;
  }, []);

  const saveNow = useCallback(
    async (value: ReviewDraft = formRef.current): Promise<void> => {
      const snapshot = JSON.stringify(value);
      if (snapshot === lastSavedSnapshotRef.current) {
        setDirty(false);
        setSaved(true);
        return;
      }

      if (saveInFlightRef.current) {
        saveAfterCurrentRef.current = true;
        await saveInFlightRef.current.catch(() => undefined);
        if (JSON.stringify(formRef.current) !== lastSavedSnapshotRef.current) {
          await saveNow(formRef.current);
        }
        return;
      }

      setLocalSaving(true);
      setLocalError(null);
      setSaved(false);
      const savePromise = onSave(value);
      saveInFlightRef.current = savePromise;

      try {
        await savePromise;
        lastSavedSnapshotRef.current = snapshot;
        if (JSON.stringify(formRef.current) === snapshot) {
          setDirty(false);
          setSaved(true);
        } else {
          setDirty(true);
          saveAfterCurrentRef.current = true;
        }
      } catch (saveError: unknown) {
        setDirty(true);
        setLocalError(saveError instanceof Error ? saveError.message : "Draft save failed");
        throw saveError;
      } finally {
        if (saveInFlightRef.current === savePromise) {
          saveInFlightRef.current = null;
          setLocalSaving(false);
        }
        if (saveAfterCurrentRef.current && JSON.stringify(formRef.current) !== lastSavedSnapshotRef.current) {
          saveAfterCurrentRef.current = false;
          void saveNow(formRef.current).catch(() => undefined);
        }
      }
    },
    [onSave]
  );

  const flushAutosave = useCallback(async () => {
    clearAutosaveTimer();
    await saveNow(formRef.current);
  }, [clearAutosaveTimer, saveNow]);

  useEffect(() => {
    onRegisterFlush?.(flushAutosave);
    return () => onRegisterFlush?.(null);
  }, [flushAutosave, onRegisterFlush]);

  useEffect(() => {
    if (draftKey !== activeDraftKey) {
      const next = normalizeDraft(draft);
      setActiveDraftKey(draftKey);
      setForm(next);
      lastSavedSnapshotRef.current = JSON.stringify(next);
      setDirty(false);
      setSaved(false);
      setLocalError(null);
      return;
    }
    if (dirty) return;
    const next = normalizeDraft(draft);
    const nextSnapshot = JSON.stringify(next);
    const keepSaved = saved && nextSnapshot === lastSavedSnapshotRef.current;
    setForm(next);
    lastSavedSnapshotRef.current = nextSnapshot;
    setSaved(keepSaved);
    setLocalError(null);
  }, [activeDraftKey, dirty, draft, draftKey, saved]);

  useEffect(() => {
    if (!dirty) {
      clearAutosaveTimer();
      return;
    }
    clearAutosaveTimer();
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void saveNow(formRef.current).catch(() => undefined);
    }, AUTOSAVE_DELAY_MS);
    return clearAutosaveTimer;
  }, [clearAutosaveTimer, dirty, form, saveNow]);

  const update = <K extends keyof ReviewDraft>(key: K, value: ReviewDraft[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setSaved(false);
  };

  const setEditionInformation = (enabled: boolean) => {
    setForm((current) => ({
      ...current,
      remaster: enabled,
      remasterYear: enabled ? current.remasterYear : "",
      remasterTitle: enabled ? current.remasterTitle : ""
    }));
    setDirty(true);
    setSaved(false);
  };

  const addEditionTag = (tag: string) => {
    setForm((current) => {
      const existing = current.remasterTitle
        .split("/")
        .map((item) => item.trim())
        .filter(Boolean);
      const tags = existing.includes(tag) ? existing : [...existing, tag];
      return {
        ...current,
        remaster: true,
        remasterTitle: tags.join(" / ")
      };
    });
    setDirty(true);
    setSaved(false);
  };

  const editionInformationEnabled = Boolean(form.remaster);
  const editionFields = (
    <>
      <label className="draft-checkbox-row wide">
        <input type="checkbox" checked={editionInformationEnabled} onChange={(event) => setEditionInformation(event.target.checked)} />
        <span>Edition Information</span>
      </label>
      {editionInformationEnabled ? (
        <>
          <label className="draft-field wide">
            <span>Information</span>
            <input
              value={form.remasterTitle}
              onChange={(event) => {
                const value = event.target.value;
                setForm((current) => ({
                  ...current,
                  remaster: value.trim() ? true : Boolean(current.remaster),
                  remasterTitle: value
                }));
                setDirty(true);
                setSaved(false);
              }}
            />
          </label>
          <label className="draft-field">
            <span>Edition year</span>
            <input value={form.remasterYear} onChange={(event) => update("remasterYear", event.target.value)} />
          </label>
          <div className="draft-field wide">
            <span>Quick tags</span>
            <div className="edition-tag-groups">
              {PTP_EDITION_TAG_GROUPS.map((group) => (
                <div className="edition-tag-group" key={group.label}>
                  <strong>{group.label}</strong>
                  <div className="edition-tags">
                    {group.tags.map((tag) => (
                      <button type="button" className="tag-button" key={tag} onClick={() => addEditionTag(tag)}>
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </>
  );
  const trumpableFields = (
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
  );

  return (
    <form
      className="draft-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void flushAutosave().catch(() => undefined);
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
        <div className="draft-checkbox-row wide">
          {(["scene", "personalRip", "internal"] as const).map((key) => (
            <label key={key}>
              <input type="checkbox" checked={form[key]} onChange={(event) => update(key, event.target.checked)} />
              <span>{key === "scene" ? "Scene" : key === "personalRip" ? "Personal rip" : "Internal"}</span>
            </label>
          ))}
        </div>
        {editionFields}
        <div className="draft-field wide">
          <span>Subtitles</span>
          <div className="draft-checkbox-row subtitle-grid">
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
        <label className="draft-field wide">
          <span>Description</span>
          <textarea value={form.description} onChange={(event) => update("description", event.target.value)} />
        </label>
        {trumpableFields}
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
        </div>
      ) : null}

      <div className="draft-actions" aria-live="polite">
        {isSaving ? <span>Saving...</span> : null}
        {!isSaving && saved ? <span>Saved</span> : null}
        {error || localError ? <span className="error-text">{error ?? localError}</span> : null}
      </div>
    </form>
  );
}
