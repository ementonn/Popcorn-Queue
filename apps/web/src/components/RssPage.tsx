import { Check, ExternalLink, LoaderCircle, RefreshCcw, Save, Trash2, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  acceptRssItem,
  createRssSubscription,
  deleteRssSubscription,
  ignoreRssItem,
  loadRssItems,
  loadRssSettings,
  loadRssSubscriptions,
  refreshRssSubscription,
  saveRssSettings,
  updateRssSubscription
} from "../api.js";
import type { ApiJob, RssFilterConfig, RssItem, RssItemStatus, RssSubscription, RssSubscriptionInput } from "../types.js";

type RssView = "proposals" | "all";
type PendingAction = { kind: "refresh" | "accept" | "ignore" | "toggle" | "delete"; id: string } | null;

interface FilterDraft {
  includeKeywords: string;
  excludeKeywords: string;
  allowedResolutions: string;
  allowedCodecs: string;
  allowedGroups: string;
  blockedGroups: string;
  minSizeGb: string;
  maxSizeGb: string;
}

const EMPTY_FILTER_DRAFT: FilterDraft = {
  includeKeywords: "",
  excludeKeywords: "",
  allowedResolutions: "",
  allowedCodecs: "",
  allowedGroups: "",
  blockedGroups: "",
  minSizeGb: "",
  maxSizeGb: ""
};

const SOURCE_SITES = ["zmweb", "pter", "tjupt", "mteam", "hdb", "hhclub", "unknown"];

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinList(value: string[] | undefined): string {
  return value?.join(", ") ?? "";
}

function bytesToGb(value: number | null | undefined): string {
  if (!value) return "";
  return String(Math.round((value / 1024 ** 3) * 100) / 100);
}

function gbToBytes(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 1024 ** 3) : null;
}

function draftFromFilter(filter: RssFilterConfig = {}): FilterDraft {
  return {
    includeKeywords: joinList(filter.includeKeywords),
    excludeKeywords: joinList(filter.excludeKeywords),
    allowedResolutions: joinList(filter.allowedResolutions),
    allowedCodecs: joinList(filter.allowedCodecs),
    allowedGroups: joinList(filter.allowedGroups),
    blockedGroups: joinList(filter.blockedGroups),
    minSizeGb: bytesToGb(filter.minSize),
    maxSizeGb: bytesToGb(filter.maxSize)
  };
}

function filterFromDraft(draft: FilterDraft): RssFilterConfig {
  const filter: RssFilterConfig = {};
  const includeKeywords = splitList(draft.includeKeywords);
  const excludeKeywords = splitList(draft.excludeKeywords);
  const allowedResolutions = splitList(draft.allowedResolutions);
  const allowedCodecs = splitList(draft.allowedCodecs);
  const allowedGroups = splitList(draft.allowedGroups);
  const blockedGroups = splitList(draft.blockedGroups);
  const minSize = gbToBytes(draft.minSizeGb);
  const maxSize = gbToBytes(draft.maxSizeGb);
  if (includeKeywords.length) filter.includeKeywords = includeKeywords;
  if (excludeKeywords.length) filter.excludeKeywords = excludeKeywords;
  if (allowedResolutions.length) filter.allowedResolutions = allowedResolutions;
  if (allowedCodecs.length) filter.allowedCodecs = allowedCodecs;
  if (allowedGroups.length) filter.allowedGroups = allowedGroups;
  if (blockedGroups.length) filter.blockedGroups = blockedGroups;
  if (minSize !== null) filter.minSize = minSize;
  if (maxSize !== null) filter.maxSize = maxSize;
  return filter;
}

function displayDate(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function displaySize(value: number | null): string {
  if (value === null) return "unknown";
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`;
  const units = ["MB", "GB", "TB"];
  let current = value / 1024 ** 2;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(current >= 10 ? 1 : 2)} ${units[unit]}`;
}

function statusLabel(item: RssItem): string {
  if (item.status === "proposal") {
    const decision = item.checkResult?.decision?.status;
    if (decision === "not_found") return "Open";
    if (decision === "no_torrents") return "No torrents";
    if (decision === "coexist") return "Coexist";
    if (decision === "trumpable") return "Trumpable";
    return "Open";
  }
  if (item.status === "duplicate_full") return "Full";
  if (item.status === "duplicate_skip") return "Skip";
  if (item.status === "check_error") return "Check error";
  if (item.status === "filtered") return "Filtered";
  if (item.status === "accepted") return "Accepted";
  return "Ignored";
}

function statusTone(status: RssItemStatus): string {
  if (status === "proposal" || status === "accepted") return "ready";
  if (status === "check_error") return "failed";
  if (status === "filtered" || status === "duplicate_full" || status === "duplicate_skip") return "paused";
  return "created";
}

function itemDetail(item: RssItem): string {
  if (item.filterReason) return item.filterReason;
  if (item.lastError) return item.lastError;
  return item.checkResult?.decision?.reason ?? "";
}

function imdbIdFromUnknown(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const imdbId = (value as { imdbId?: unknown }).imdbId;
  if (typeof imdbId !== "string") return null;
  return imdbId.match(/tt\d{7,9}/i)?.[0].toLowerCase() ?? null;
}

function imdbTarget(item: RssItem): { url: string; label: string } | null {
  const decisionUrl = item.checkResult?.decision?.ptpUrl ?? null;
  const imdbIdFromUrl = decisionUrl?.match(/tt\d{7,9}/i)?.[0].toLowerCase() ?? null;
  if (decisionUrl && imdbIdFromUrl && /imdb\.com/i.test(decisionUrl)) {
    return { url: decisionUrl, label: `IMDb ${imdbIdFromUrl}` };
  }
  const imdbId = imdbIdFromUnknown(item.checkResult?.candidate);
  return imdbId ? { url: `https://www.imdb.com/title/${imdbId}`, label: `IMDb ${imdbId}` } : null;
}

export function RssPage({
  onStatus,
  onJobCreated
}: {
  onStatus?: (status: { tone: "info" | "error" | "success"; text: string } | null) => void;
  onJobCreated?: (job: ApiJob) => void;
}) {
  const [settingsMinutes, setSettingsMinutes] = useState("10");
  const [subscriptions, setSubscriptions] = useState<RssSubscription[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [items, setItems] = useState<RssItem[]>([]);
  const [view, setView] = useState<RssView>("proposals");
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingSubscription, setSavingSubscription] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RssSubscriptionInput>({
    name: "",
    site: "zmweb",
    feedUrl: "",
    enabled: true,
    filter: {}
  });
  const [filterDraft, setFilterDraft] = useState<FilterDraft>(EMPTY_FILTER_DRAFT);

  const selectedSubscription = useMemo(
    () => subscriptions.find((subscription) => subscription.id === selectedId) ?? null,
    [selectedId, subscriptions]
  );
  const editingSubscription = useMemo(
    () => subscriptions.find((subscription) => subscription.id === editingId) ?? null,
    [editingId, subscriptions]
  );
  const isEditing = Boolean(editingSubscription);

  const loadSubscriptions = useCallback(async () => {
    const response = await loadRssSubscriptions();
    setSubscriptions(response.subscriptions);
    setSelectedId((current) => {
      if (current && response.subscriptions.some((subscription) => subscription.id === current)) return current;
      return response.subscriptions[0]?.id ?? null;
    });
    return response.subscriptions;
  }, []);

  const loadSelectedItems = useCallback(async (subscriptionId: string, nextView = view) => {
    const response = await loadRssItems(subscriptionId, nextView);
    setItems(response.items);
  }, [view]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([loadRssSettings(), loadSubscriptions()])
      .then(([settingsResponse, subscriptionList]) => {
        if (!active) return;
        setSettingsMinutes(String(Math.max(1, Math.round(settingsResponse.settings.updateIntervalMs / 60_000))));
        const firstId = subscriptionList[0]?.id;
        if (firstId) void loadRssItems(firstId, view).then((response) => active && setItems(response.items));
        setError(null);
      })
      .catch((loadError) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "RSS failed to load");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadSubscriptions, view]);

  useEffect(() => {
    if (!selectedId) {
      setItems([]);
      return;
    }
    let active = true;
    loadRssItems(selectedId, view)
      .then((response) => {
        if (active) setItems(response.items);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "RSS items failed to load");
      });
    return () => {
      active = false;
    };
  }, [selectedId, view]);

  const updateForm = <K extends keyof RssSubscriptionInput>(key: K, value: RssSubscriptionInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const updateFilterDraft = (key: keyof FilterDraft, value: string) => {
    setFilterDraft((current) => ({ ...current, [key]: value }));
  };

  function resetSubscriptionForm(nextSite = form.site) {
    setEditingId(null);
    setForm({ name: "", site: nextSite, feedUrl: "", enabled: true, filter: {} });
    setFilterDraft(EMPTY_FILTER_DRAFT);
  }

  function startEditSubscription(subscription: RssSubscription) {
    setSelectedId(subscription.id);
    setEditingId(subscription.id);
    setError(null);
    setForm({
      name: subscription.name,
      site: subscription.site,
      feedUrl: "",
      enabled: subscription.enabled,
      filter: subscription.filter
    });
    setFilterDraft(draftFromFilter(subscription.filter));
  }

  async function handleSaveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const minutes = Number(settingsMinutes);
    if (!Number.isFinite(minutes) || minutes < 1) {
      setError("RSS interval must be at least 1 minute");
      return;
    }
    setSavingSettings(true);
    try {
      const response = await saveRssSettings(Math.round(minutes * 60_000));
      setSettingsMinutes(String(Math.round(response.settings.updateIntervalMs / 60_000)));
      onStatus?.({ tone: "success", text: "RSS interval saved." });
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "RSS settings save failed";
      setError(message);
      onStatus?.({ tone: "error", text: message });
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleSaveSubscription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.name.trim() || savingSubscription) return;
    if (!isEditing && !form.feedUrl.trim()) return;
    setSavingSubscription(true);
    setError(null);
    try {
      const filter = filterFromDraft(filterDraft);
      if (editingSubscription) {
        const feedUrl = form.feedUrl.trim();
        const response = await updateRssSubscription(editingSubscription.id, {
          name: form.name.trim(),
          site: form.site,
          enabled: form.enabled,
          filter,
          ...(feedUrl ? { feedUrl } : {})
        });
        setSubscriptions((current) => current.map((item) => (item.id === response.subscription.id ? response.subscription : item)));
        resetSubscriptionForm(response.subscription.site);
        onStatus?.({ tone: "success", text: `RSS subscription saved: ${response.subscription.name}` });
      } else {
        const response = await createRssSubscription({
          ...form,
          name: form.name.trim(),
          feedUrl: form.feedUrl.trim(),
          filter
        });
        await loadSubscriptions();
        setSelectedId(response.subscription.id);
        resetSubscriptionForm(form.site);
        setItems([]);
        onStatus?.({ tone: "success", text: `RSS subscription added: ${response.subscription.name}` });
      }
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "RSS subscription save failed";
      setError(message);
      onStatus?.({ tone: "error", text: message });
    } finally {
      setSavingSubscription(false);
    }
  }

  async function runSubscriptionAction(kind: Exclude<PendingAction, null>["kind"], subscription: RssSubscription) {
    setPendingAction({ kind, id: subscription.id });
    setError(null);
    try {
      if (kind === "refresh") {
        const response = await refreshRssSubscription(subscription.id);
        await Promise.all([loadSubscriptions(), loadSelectedItems(subscription.id)]);
        onStatus?.({
          tone: "success",
          text: `RSS refreshed: ${response.result.fetched} fetched, ${response.result.proposals} proposal(s).`
        });
      } else if (kind === "toggle") {
        const response = await updateRssSubscription(subscription.id, { enabled: !subscription.enabled });
        setSubscriptions((current) => current.map((item) => (item.id === response.subscription.id ? response.subscription : item)));
      } else if (kind === "delete") {
        if (!window.confirm(`Delete RSS subscription "${subscription.name}" and its stored items?`)) return;
        await deleteRssSubscription(subscription.id);
        const nextSubscriptions = await loadSubscriptions();
        const nextId = nextSubscriptions[0]?.id ?? null;
        setSelectedId(nextId);
        if (nextId) await loadSelectedItems(nextId);
        else setItems([]);
      }
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : "RSS action failed";
      setError(message);
      onStatus?.({ tone: "error", text: message });
    } finally {
      setPendingAction((current) => (current?.id === subscription.id && current.kind === kind ? null : current));
    }
  }

  async function runItemAction(kind: "accept" | "ignore", item: RssItem) {
    setPendingAction({ kind, id: item.id });
    setError(null);
    try {
      if (kind === "accept") {
        const response = await acceptRssItem(item.id);
        onJobCreated?.(response.job);
        onStatus?.({ tone: "success", text: `RSS proposal accepted: ${response.job.id}` });
      } else {
        await ignoreRssItem(item.id);
        onStatus?.({ tone: "success", text: "RSS item ignored." });
      }
      if (selectedId) await loadSelectedItems(selectedId);
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : `RSS item ${kind} failed`;
      setError(message);
      onStatus?.({ tone: "error", text: message });
    } finally {
      setPendingAction((current) => (current?.id === item.id && current.kind === kind ? null : current));
    }
  }

  if (loading) {
    return (
      <section className="rss-page" data-testid="rss-page">
        <div className="settings-loading">
          <LoaderCircle className="spin-icon" size={16} />
          Loading RSS
        </div>
      </section>
    );
  }

  return (
    <section className="rss-page" data-testid="rss-page">
      <div className="rss-header">
        <div>
          <h2>RSS</h2>
          <span>{subscriptions.length} subscription{subscriptions.length === 1 ? "" : "s"}</span>
        </div>
        <form className="rss-interval" onSubmit={handleSaveSettings}>
          <label>
            Refresh interval
            <input value={settingsMinutes} onChange={(event) => setSettingsMinutes(event.currentTarget.value)} inputMode="numeric" />
          </label>
          <span>min</span>
          <button type="submit" className="primary" disabled={savingSettings}>
            {savingSettings ? <LoaderCircle className="spin-icon" size={15} /> : <Save size={15} />}
            Save
          </button>
        </form>
      </div>

      {error ? <div className="inline-status error">{error}</div> : null}

      <div className="rss-layout">
        <aside className="rss-side">
          <form className="rss-form" onSubmit={handleSaveSubscription}>
            <div className="rss-form-head">
              <h3>{isEditing ? "Edit Subscription" : "Add Subscription"}</h3>
              {isEditing ? (
                <button type="button" onClick={() => resetSubscriptionForm()} disabled={savingSubscription}>
                  Cancel
                </button>
              ) : null}
            </div>
            <div className="settings-grid">
              <label className="settings-field">
                <span>Name</span>
                <input value={form.name} onChange={(event) => updateForm("name", event.currentTarget.value)} placeholder="ZMPT Movies" />
              </label>
              <label className="settings-field">
                <span>Site</span>
                <select value={form.site} onChange={(event) => updateForm("site", event.currentTarget.value)}>
                  {SOURCE_SITES.map((site) => (
                    <option value={site} key={site}>
                      {site}
                    </option>
                  ))}
                </select>
              </label>
              <label className="settings-field rss-field-wide">
                <span>Feed URL</span>
                <input
                  value={form.feedUrl}
                  onChange={(event) => updateForm("feedUrl", event.currentTarget.value)}
                  placeholder={isEditing ? "Leave blank to keep current URL" : "https://tracker/torrentrss.php?..."}
                />
              </label>
              <label className="settings-field rss-enabled-field">
                <span>Enabled</span>
                <input type="checkbox" checked={form.enabled} onChange={(event) => updateForm("enabled", event.currentTarget.checked)} />
              </label>
              <label className="settings-field">
                <span>Exclude keywords</span>
                <input value={filterDraft.excludeKeywords} onChange={(event) => updateFilterDraft("excludeKeywords", event.currentTarget.value)} placeholder="60Fps, TS" />
              </label>
              <label className="settings-field">
                <span>Include keywords</span>
                <input value={filterDraft.includeKeywords} onChange={(event) => updateFilterDraft("includeKeywords", event.currentTarget.value)} placeholder="WEB-DL" />
              </label>
              <label className="settings-field">
                <span>Resolution</span>
                <input value={filterDraft.allowedResolutions} onChange={(event) => updateFilterDraft("allowedResolutions", event.currentTarget.value)} placeholder="1080p, 2160p" />
              </label>
              <label className="settings-field">
                <span>Codec</span>
                <input value={filterDraft.allowedCodecs} onChange={(event) => updateFilterDraft("allowedCodecs", event.currentTarget.value)} placeholder="x264, x265" />
              </label>
              <label className="settings-field">
                <span>Allowed groups</span>
                <input value={filterDraft.allowedGroups} onChange={(event) => updateFilterDraft("allowedGroups", event.currentTarget.value)} />
              </label>
              <label className="settings-field">
                <span>Blocked groups</span>
                <input value={filterDraft.blockedGroups} onChange={(event) => updateFilterDraft("blockedGroups", event.currentTarget.value)} />
              </label>
              <label className="settings-field">
                <span>Min size GB</span>
                <input value={filterDraft.minSizeGb} onChange={(event) => updateFilterDraft("minSizeGb", event.currentTarget.value)} inputMode="decimal" />
              </label>
              <label className="settings-field">
                <span>Max size GB</span>
                <input value={filterDraft.maxSizeGb} onChange={(event) => updateFilterDraft("maxSizeGb", event.currentTarget.value)} inputMode="decimal" />
              </label>
            </div>
            <button type="submit" className="primary" disabled={savingSubscription || !form.name.trim() || (!isEditing && !form.feedUrl.trim())}>
              {savingSubscription ? <LoaderCircle className="spin-icon" size={15} /> : <Check size={15} />}
              {isEditing ? "Save" : "Add"}
            </button>
          </form>

          <div className="rss-subscriptions">
            <h3>Subscriptions</h3>
            {subscriptions.length ? (
              subscriptions.map((subscription) => {
                const selected = subscription.id === selectedId;
                const pending = pendingAction?.id === subscription.id ? pendingAction : null;
                return (
                  <div className={`rss-subscription ${selected ? "selected" : ""}`} key={subscription.id}>
                    <button type="button" className="rss-subscription-main" onClick={() => setSelectedId(subscription.id)}>
                      <strong>{subscription.name}</strong>
                    </button>
                    <div className="rss-subscription-meta">
                      <span className={`state-pill ${subscription.enabled ? "done" : "paused"}`}>{subscription.enabled ? "Enabled" : "Paused"}</span>
                      <span>{subscription.site}</span>
                      <span>{subscription.lastRunStatus ?? "not checked"}</span>
                    </div>
                    <div className="rss-subscription-footer">
                      <span>Last: {displayDate(subscription.lastFetchedAt)}</span>
                      <div>
                        <button type="button" onClick={() => void runSubscriptionAction("refresh", subscription)} disabled={Boolean(pending)}>
                          {pending?.kind === "refresh" ? <LoaderCircle className="spin-icon" size={14} /> : <RefreshCcw size={14} />}
                          Refresh
                        </button>
                        <button type="button" onClick={() => void runSubscriptionAction("toggle", subscription)} disabled={Boolean(pending)}>
                          {subscription.enabled ? <X size={14} /> : <Check size={14} />}
                          {subscription.enabled ? "Pause" : "Enable"}
                        </button>
                        <button type="button" onClick={() => startEditSubscription(subscription)} disabled={Boolean(pending) || savingSubscription} aria-label={`Edit ${subscription.name}`}>
                          Edit
                        </button>
                        <button type="button" className="danger" onClick={() => void runSubscriptionAction("delete", subscription)} disabled={Boolean(pending)}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    {subscription.lastRunMessage ? <p>{subscription.lastRunMessage}</p> : null}
                  </div>
                );
              })
            ) : (
              <div className="rss-empty">No RSS subscriptions yet.</div>
            )}
          </div>
        </aside>

        <div className="rss-items">
          <div className="rss-items-header">
            <div>
              <h3>{selectedSubscription ? selectedSubscription.name : "Items"}</h3>
              <span>{selectedSubscription ? `${selectedSubscription.site} · Last: ${displayDate(selectedSubscription.lastFetchedAt)}` : "Add a subscription to start checking releases."}</span>
            </div>
            <div className="segmented">
              <button type="button" className={view === "proposals" ? "active" : undefined} onClick={() => setView("proposals")}>
                Proposals
              </button>
              <button type="button" className={view === "all" ? "active" : undefined} onClick={() => setView("all")}>
                All items
              </button>
            </div>
          </div>

          <div className="table-wrap">
            <table className="rss-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Release</th>
                  <th>Source</th>
                  <th>PTP target</th>
                  <th>Published</th>
                  <th>Size</th>
                  <th>Detail</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const pending = pendingAction?.id === item.id ? pendingAction : null;
                  const imdb = imdbTarget(item);
                  return (
                    <tr key={item.id}>
                      <td data-label="Status">
                        <span className={`state-pill ${statusTone(item.status)}`}>{statusLabel(item)}</span>
                      </td>
                      <td data-label="Release">
                        <span className="rss-release-title">{item.title}</span>
                        {item.subtitle ? <span className="rss-release-subtitle">{item.subtitle}</span> : null}
                      </td>
                      <td data-label="Source">
                        {item.sourceUrl ? (
                          <a className="rss-source-link" href={item.sourceUrl} target="_blank" rel="noreferrer">
                            Source <ExternalLink size={13} />
                          </a>
                        ) : (
                          "None"
                        )}
                      </td>
                      <td data-label="PTP target">
                        {item.ptpTarget ? (
                          <a className="rss-target-link" href={item.ptpTarget.ptpUrl} target="_blank" rel="noreferrer">
                            {item.ptpTarget.displayTitle}
                          </a>
                        ) : imdb ? (
                          <a className="rss-target-link" href={imdb.url} target="_blank" rel="noreferrer">
                            {imdb.label}
                          </a>
                        ) : (
                          "None"
                        )}
                      </td>
                      <td data-label="Published">{displayDate(item.publishedAt)}</td>
                      <td data-label="Size">{displaySize(item.size)}</td>
                      <td data-label="Detail">
                        <span className="rss-detail">{itemDetail(item) || "-"}</span>
                      </td>
                      <td data-label="Action">
                        {item.status === "proposal" ? (
                          <div className="rss-row-actions">
                            <button type="button" className="action primary" onClick={() => void runItemAction("accept", item)} disabled={Boolean(pending)}>
                              {pending?.kind === "accept" ? <LoaderCircle className="spin-icon" size={14} /> : <Check size={14} />}
                              Accept
                            </button>
                            <button type="button" className="action" onClick={() => void runItemAction("ignore", item)} disabled={Boolean(pending)}>
                              Ignore
                            </button>
                          </div>
                        ) : item.acceptedJobId ? (
                          <span className="rss-job-id">{item.acceptedJobId}</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                {!items.length ? (
                  <tr>
                    <td colSpan={8}>
                      <div className="rss-empty">{selectedSubscription ? "No items in this view." : "No subscription selected."}</div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
