import { LoaderCircle, Save } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { loadSettings, saveSettings } from "../api.js";
import type { SettingField, SettingGroup, SettingsResponse } from "../types.js";

const GROUP_ORDER: SettingGroup[] = ["Browser", "PTP", "Image Hosts", "qBittorrent", "Tools"];

function fieldInputType(field: SettingField): string {
  if (field.type === "password") return "password";
  if (field.type === "number") return "number";
  return "text";
}

function initialValues(settings: SettingsResponse): Record<string, string> {
  return Object.fromEntries(settings.fields.map((field) => [field.key, field.secret ? "" : field.value]));
}

export function SettingsPage({
  onStatus
}: {
  onStatus?: (status: { tone: "info" | "error" | "success"; text: string } | null) => void;
}) {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadSettings()
      .then((response) => {
        if (!active) return;
        setSettings(response);
        setValues(initialValues(response));
        setError(null);
      })
      .catch((loadError) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Settings failed to load");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const fieldsByGroup = useMemo(() => {
    const grouped = new Map<SettingGroup, SettingField[]>();
    for (const group of GROUP_ORDER) grouped.set(group, []);
    for (const field of settings?.fields ?? []) grouped.get(field.group)?.push(field);
    return grouped;
  }, [settings]);

  const setFieldValue = (key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings || saving) return;
    setSaving(true);
    setError(null);
    onStatus?.(null);
    const payload: Record<string, string> = {};
    for (const field of settings.fields) {
      const value = values[field.key] ?? "";
      if (field.secret) {
        if (value) payload[field.key] = value;
      } else {
        payload[field.key] = value;
      }
    }

    try {
      const response = await saveSettings(payload);
      setSettings(response);
      setValues(initialValues(response));
      onStatus?.({ tone: "success", text: "Settings saved and reloaded." });
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "Settings save failed";
      setError(message);
      onStatus?.({ tone: "error", text: message });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <section className="settings-page" data-testid="settings-page">
        <div className="settings-loading">
          <LoaderCircle className="spin-icon" size={16} />
          Loading settings
        </div>
      </section>
    );
  }

  if (!settings) {
    return (
      <section className="settings-page" data-testid="settings-page">
        <div className="inline-status error">{error ?? "Settings unavailable"}</div>
      </section>
    );
  }

  return (
    <section className="settings-page" data-testid="settings-page">
      <form onSubmit={handleSubmit}>
        <div className="settings-header">
          <div>
            <h2>Settings</h2>
            <span>{settings.envPath}</span>
          </div>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? <LoaderCircle className="spin-icon" size={15} /> : <Save size={15} />}
            {saving ? "Saving..." : "Save"}
          </button>
        </div>

        {error ? <div className="inline-status error">{error}</div> : null}

        {GROUP_ORDER.map((group) => {
          const fields = fieldsByGroup.get(group) ?? [];
          if (!fields.length) return null;
          return (
            <fieldset className="settings-section" key={group}>
              <legend>{group}</legend>
              <div className="settings-grid">
                {fields.map((field) => {
                  const value = values[field.key] ?? "";
                  return (
                    <label className="settings-field" key={field.key}>
                      <span>
                        {field.label}
                        {field.secret && field.configured ? <em>Configured</em> : null}
                      </span>
                      {field.type === "boolean" ? (
                        <input type="checkbox" checked={value === "true"} onChange={(event) => setFieldValue(field.key, event.currentTarget.checked ? "true" : "false")} />
                      ) : (
                        <input
                          type={fieldInputType(field)}
                          value={value}
                          inputMode={field.type === "number" ? "numeric" : undefined}
                          placeholder={field.secret && field.configured ? "Configured" : ""}
                          onChange={(event) => setFieldValue(field.key, event.currentTarget.value)}
                        />
                      )}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </form>
    </section>
  );
}
