# RSS Proposals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an RSS subscriptions page that imports tracker RSS items into a proposal/history layer, runs filters and duplicate checks, and creates normal jobs only after the user accepts a proposal.

**Architecture:** Add a separate RSS domain beside Jobs: core owns RSS parsing/filter/status mapping, API owns SQLite persistence, refresh orchestration, routes, and accept-to-job conversion, and Web owns the RSS management UI. RSS refresh stores items and duplicate-check results but never downloads torrents; accepting a proposal downloads the torrent and reuses the existing job preparation pipeline.

**Tech Stack:** TypeScript, Fastify, Prisma/SQLite, Vitest, React/Vite, Playwright, existing `BrowserCheckService`, existing job repository/preparation service, `fast-xml-parser` for RSS XML parsing.

---

## File Structure

Create or modify these files:

- `package.json`, `package-lock.json`: add `fast-xml-parser`.
- `packages/core/src/rss.ts`: RSS types, XML parser, source metadata extraction, filter evaluation, duplicate-status mapping, URL redaction helpers.
- `packages/core/src/rss.test.ts`: parser/filter/status/redaction unit tests.
- `packages/core/src/index.ts`: export `rss.ts`.
- `packages/core/src/log-redaction.ts`: redact secret-bearing query parameters inside URL strings.
- `packages/core/src/log-redaction.test.ts`: URL redaction regression tests.
- `apps/api/prisma/schema.prisma`: add `RssSettings`, `RssSubscription`, and `RssItem` models.
- `apps/api/src/persistence.ts`: create RSS tables at startup and expose an RSS repository.
- `apps/api/src/rss-repository.ts`: SQLite-backed repository adapter and serialized row mapping.
- `apps/api/src/rss-service.ts`: refresh orchestration, duplicate checks, accept/ignore operations, and job conversion.
- `apps/api/src/rss-service.test.ts`: service tests with fake fetch and fake duplicate checker.
- `apps/api/src/routes/rss.ts`: RSS HTTP routes.
- `apps/api/src/routes/index.ts`: register RSS routes.
- `apps/api/src/api-context.ts`: expose RSS repository/service hooks in route context.
- `apps/api/src/server.ts`: instantiate RSS service and poller lifecycle.
- `apps/api/src/server.rss.test.ts`: route-level tests.
- `apps/api/src/server-test-utils.ts`: extend persistence mock with RSS repository.
- `apps/web/src/types.ts`: RSS API response/request types.
- `apps/web/src/api.ts`: RSS API client functions.
- `apps/web/src/components/RssPage.tsx`: RSS subscriptions/proposals/all-items page.
- `apps/web/src/App.tsx`: add RSS navigation and view state.
- `apps/web/src/styles.css`: RSS page layout and badges.
- `apps/web/e2e/ui.spec.ts`: RSS page smoke test with mocked API routes.
- `docs/configuration.md`: document RSS interval and secret handling.

---

### Task 1: Add RSS Core Parsing, Filtering, Status Mapping, And URL Redaction

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `packages/core/src/rss.ts`
- Create: `packages/core/src/rss.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/log-redaction.ts`
- Modify: `packages/core/src/log-redaction.test.ts`

- [ ] **Step 1: Add the XML parser dependency**

Run:

```bash
npm install fast-xml-parser
```

Expected: `package.json` and `package-lock.json` include `fast-xml-parser`.

- [ ] **Step 2: Write failing RSS core tests**

Create `packages/core/src/rss.test.ts` with these tests:

```ts
import { describe, expect, it } from "vitest";
import {
  evaluateRssFilter,
  parseRssFeed,
  redactSecretUrl,
  rssItemStatusFromDecision,
  rssItemToTorrentCandidate,
  type RssFilterConfig
} from "./rss.js";

const zmptRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>织梦 Torrents</title>
    <item>
      <title><![CDATA[[电影 / Movies]Fat and Fame 2018 2160p EDR WEB-DL HEVC DDP5.1-ZmWeb[人怕出名猪怕壮 / Fat and Fame | 类型：喜剧][9.12 GB]]]></title>
      <link>https://zmpt.cc/details.php?id=473940</link>
      <description><![CDATA[
        <a href="https://www.imdb.com/title/tt1234567/">IMDb</a>
        <fieldset><legend> 引用 </legend>
Complete name : 人怕出名猪怕壮.Fat.and.Fame.2018.2160p.EDR.WEB-DL.HEVC.DDP5.1-ZmWeb.mp4
        </fieldset>
      ]]></description>
      <enclosure url="https://zmpt.cc/download.php?downhash=secret-token" length="9788381427" type="application/x-bittorrent" />
      <guid isPermaLink="false">2091c757a41e7f50f480325d9f082e49d1e5f769</guid>
      <pubDate>Fri, 22 May 2026 12:39:47 +0800</pubDate>
    </item>
  </channel>
</rss>`;

describe("RSS parsing", () => {
  it("extracts normalized torrent fields from a NexusPHP RSS item", () => {
    const feed = parseRssFeed(zmptRss, { site: "zmweb" });
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      site: "zmweb",
      title: "Fat and Fame 2018 2160p EDR WEB-DL HEVC DDP5.1-ZmWeb",
      subtitle: "人怕出名猪怕壮 / Fat and Fame | 类型：喜剧",
      sourceUrl: "https://zmpt.cc/details.php?id=473940",
      downloadUrl: "https://zmpt.cc/download.php?downhash=secret-token",
      guid: "2091c757a41e7f50f480325d9f082e49d1e5f769",
      size: 9788381427,
      imdbId: "tt1234567"
    });
    expect(feed.items[0]?.publishedAt).toBe("2026-05-22T04:39:47.000Z");
  });

  it("creates TorrentCandidate input for duplicate check", () => {
    const item = parseRssFeed(zmptRss, { site: "zmweb" }).items[0]!;
    expect(rssItemToTorrentCandidate(item)).toMatchObject({
      site: "zmweb",
      title: "Fat and Fame 2018 2160p EDR WEB-DL HEVC DDP5.1-ZmWeb",
      subtitle: "人怕出名猪怕壮 / Fat and Fame | 类型：喜剧",
      imdbId: "tt1234567",
      sourceUrl: "https://zmpt.cc/details.php?id=473940",
      downloadUrl: "https://zmpt.cc/download.php?downhash=secret-token",
      sourceTorrentId: "473940"
    });
  });
});

describe("RSS filters", () => {
  it("filters by exclude keyword before duplicate checks", () => {
    const filter: RssFilterConfig = { excludeKeywords: ["60Fps"] };
    expect(evaluateRssFilter({ title: "Bystander.2025.2160p.WEB-DL.60Fps.HDR.x265-GROUP", size: 1 }, filter)).toEqual({
      passed: false,
      reason: "Title matched excluded keyword: 60Fps"
    });
  });

  it("passes when include, resolution, codec, group, and size rules match", () => {
    const filter: RssFilterConfig = {
      includeKeywords: ["WEB-DL"],
      allowedResolutions: ["2160p"],
      allowedCodecs: ["x265"],
      blockedGroups: ["HDSWEB"],
      minSize: 1_000,
      maxSize: 10_000
    };
    expect(evaluateRssFilter({ title: "Movie.2026.2160p.WEB-DL.x265-GROUP", size: 5_000 }, filter)).toEqual({
      passed: true,
      reason: null
    });
  });
});

describe("RSS duplicate status mapping", () => {
  it.each([
    ["open", "proposal"],
    ["not_found", "proposal"],
    ["no_torrents", "proposal"],
    ["coexist", "proposal"],
    ["trumpable", "proposal"],
    ["full", "duplicate_full"],
    ["skip", "duplicate_skip"],
    ["error", "check_error"],
    ["review", "duplicate_skip"]
  ] as const)("maps %s to %s", (decisionStatus, itemStatus) => {
    expect(rssItemStatusFromDecision(decisionStatus)).toBe(itemStatus);
  });
});

describe("RSS URL redaction", () => {
  it("redacts secret-bearing query values without hiding the source host", () => {
    expect(redactSecretUrl("https://zmpt.cc/torrentrss.php?passkey=abc&rows=10&downhash=def")).toBe(
      "https://zmpt.cc/torrentrss.php?passkey=%5Bredacted%5D&rows=10&downhash=%5Bredacted%5D"
    );
  });
});
```

- [ ] **Step 3: Run the failing core tests**

Run:

```bash
npm test -- packages/core/src/rss.test.ts
```

Expected: FAIL because `packages/core/src/rss.ts` does not exist.

- [ ] **Step 4: Implement RSS core helpers**

Create `packages/core/src/rss.ts` with this module:

```ts
import { XMLParser } from "fast-xml-parser";
import { parseTorrentTitle } from "./parse.js";
import type { RuleStatus, SourceSite, TorrentCandidate } from "./types.js";

export type RssItemStatus = "proposal" | "filtered" | "duplicate_full" | "duplicate_skip" | "check_error" | "ignored" | "accepted";

export interface ParsedRssItem {
  site: SourceSite;
  title: string;
  subtitle: string | null;
  sourceUrl: string | null;
  downloadUrl: string | null;
  guid: string | null;
  size: number | null;
  publishedAt: string | null;
  imdbId: string | null;
  sourceTorrentId: string | null;
  raw: Record<string, unknown>;
}

export interface ParsedRssFeed {
  title: string | null;
  items: ParsedRssItem[];
}

export interface RssFilterConfig {
  includeKeywords?: string[];
  excludeKeywords?: string[];
  allowedResolutions?: string[];
  allowedCodecs?: string[];
  allowedGroups?: string[];
  blockedGroups?: string[];
  minSize?: number | null;
  maxSize?: number | null;
}

const SECRET_QUERY_KEYS = new Set(["passkey", "downhash", "auth", "token", "key", "apikey", "api_key"]);

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && "#text" in (value as Record<string, unknown>)) return text((value as Record<string, unknown>)["#text"]);
  return String(value).trim();
}

function attr(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const direct = (value as Record<string, unknown>)[`@_${key}`] ?? (value as Record<string, unknown>)[key];
  return direct === undefined || direct === null ? null : String(direct);
}

function stripBracketPrefix(title: string): { title: string; subtitle: string | null } {
  const match = title.match(/^\[[^\]]+\]([^\[]+)(?:\[([^\]]+)\])?(?:\[[^\]]+\])?$/);
  if (!match) return { title: title.trim(), subtitle: null };
  return { title: match[1]?.trim() ?? title.trim(), subtitle: match[2]?.trim() || null };
}

function extractImdbId(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const match = value?.match(/tt\d{7,9}/i);
    if (match) return match[0].toLowerCase();
  }
  return null;
}

function sourceTorrentIdFromUrl(sourceUrl: string | null): string | null {
  if (!sourceUrl) return null;
  try {
    return new URL(sourceUrl).searchParams.get("id");
  } catch {
    return sourceUrl.match(/[?&]id=(\d+)/i)?.[1] ?? null;
  }
}

function parseDate(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function redactSecretUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return value.replace(/([?&](?:passkey|downhash|auth|token|key|api_key|apikey)=)[^&\s]+/gi, "$1[redacted]");
  }
}

export function parseRssFeed(xml: string, options: { site?: SourceSite } = {}): ParsedRssFeed {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    cdataPropName: "#text",
    textNodeName: "#text",
    trimValues: true
  });
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const channel = ((parsed.rss as Record<string, unknown> | undefined)?.channel ?? parsed.channel ?? {}) as Record<string, unknown>;
  const items = asArray(channel.item).map((item): ParsedRssItem => {
    const record = item as Record<string, unknown>;
    const rawTitle = text(record.title);
    const titleParts = stripBracketPrefix(rawTitle);
    const sourceUrl = text(record.link) || null;
    const enclosure = record.enclosure;
    const downloadUrl = attr(enclosure, "url");
    const size = Number(attr(enclosure, "length"));
    const description = text(record.description);
    return {
      site: options.site ?? "unknown",
      title: titleParts.title,
      subtitle: titleParts.subtitle,
      sourceUrl,
      downloadUrl,
      guid: text(record.guid) || null,
      size: Number.isFinite(size) ? size : null,
      publishedAt: parseDate(text(record.pubDate)),
      imdbId: extractImdbId(description, rawTitle),
      sourceTorrentId: sourceTorrentIdFromUrl(sourceUrl),
      raw: {
        title: rawTitle,
        sourceUrl,
        size: Number.isFinite(size) ? size : null,
        publishedAt: text(record.pubDate) || null
      }
    };
  });
  return { title: text(channel.title) || null, items };
}

function hasKeyword(title: string, keyword: string): boolean {
  return title.toLowerCase().includes(keyword.toLowerCase());
}

function releaseGroup(title: string): string | null {
  return title.match(/-([A-Za-z0-9]+)$/)?.[1] ?? null;
}

export function evaluateRssFilter(item: Pick<ParsedRssItem, "title" | "size">, filter: RssFilterConfig = {}): { passed: boolean; reason: string | null } {
  for (const keyword of filter.excludeKeywords ?? []) {
    if (keyword && hasKeyword(item.title, keyword)) return { passed: false, reason: `Title matched excluded keyword: ${keyword}` };
  }
  for (const keyword of filter.includeKeywords ?? []) {
    if (keyword && !hasKeyword(item.title, keyword)) return { passed: false, reason: `Title did not match required keyword: ${keyword}` };
  }
  const parsed = parseTorrentTitle(item.title);
  if (filter.allowedResolutions?.length && (!parsed.resolution || !filter.allowedResolutions.includes(parsed.resolution))) {
    return { passed: false, reason: `Resolution is not allowed: ${parsed.resolution ?? "unknown"}` };
  }
  if (filter.allowedCodecs?.length && (!parsed.codec || !filter.allowedCodecs.some((codec) => parsed.codec?.toLowerCase() === codec.toLowerCase()))) {
    return { passed: false, reason: `Codec is not allowed: ${parsed.codec ?? "unknown"}` };
  }
  const group = releaseGroup(item.title);
  if (filter.allowedGroups?.length && (!group || !filter.allowedGroups.some((allowed) => allowed.toLowerCase() === group.toLowerCase()))) {
    return { passed: false, reason: `Release group is not allowed: ${group ?? "unknown"}` };
  }
  if (filter.blockedGroups?.some((blocked) => group?.toLowerCase() === blocked.toLowerCase())) {
    return { passed: false, reason: `Release group is blocked: ${group}` };
  }
  if (filter.minSize !== undefined && filter.minSize !== null && (item.size ?? 0) < filter.minSize) {
    return { passed: false, reason: `Size is below minimum: ${item.size ?? 0}` };
  }
  if (filter.maxSize !== undefined && filter.maxSize !== null && (item.size ?? 0) > filter.maxSize) {
    return { passed: false, reason: `Size is above maximum: ${item.size ?? 0}` };
  }
  return { passed: true, reason: null };
}

export function rssItemStatusFromDecision(status: RuleStatus): RssItemStatus {
  if (status === "open" || status === "not_found" || status === "no_torrents" || status === "coexist" || status === "trumpable") return "proposal";
  if (status === "full") return "duplicate_full";
  if (status === "skip" || status === "review") return "duplicate_skip";
  return "check_error";
}

export function rssItemToTorrentCandidate(item: ParsedRssItem): TorrentCandidate {
  return {
    site: item.site,
    title: item.title,
    ...(item.subtitle ? { subtitle: item.subtitle } : {}),
    ...(item.imdbId ? { imdbId: item.imdbId } : {}),
    ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
    ...(item.downloadUrl ? { downloadUrl: item.downloadUrl } : {}),
    ...(item.sourceTorrentId ? { sourceTorrentId: item.sourceTorrentId } : {})
  };
}
```

- [ ] **Step 5: Export RSS helpers**

Modify `packages/core/src/index.ts`:

```ts
export * from "./rss.js";
```

Add it after the existing exports.

- [ ] **Step 6: Extend log redaction for secret URLs**

Modify `packages/core/src/log-redaction.ts` so string values are redacted:

```ts
import { redactSecretUrl } from "./rss.js";

export function redactForLog<T>(value: T): T {
  if (typeof value === "string") return redactSecretUrl(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactForLog(item)) as T;
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSecretKey(key) ? REDACTED_TEXT : redactForLog(item);
  }
  return output as T;
}
```

- [ ] **Step 7: Add log redaction regression test**

Append to `packages/core/src/log-redaction.test.ts`:

```ts
it("redacts secret query parameters inside URL strings", () => {
  const redacted = redactForLog({
    feedUrl: "https://zmpt.cc/torrentrss.php?passkey=secret&rows=10",
    nested: {
      downloadUrl: "https://zmpt.cc/download.php?downhash=secret-token"
    }
  });

  expect(JSON.stringify(redacted)).not.toContain("secret");
  expect(redacted).toMatchObject({
    feedUrl: "https://zmpt.cc/torrentrss.php?passkey=%5Bredacted%5D&rows=10",
    nested: {
      downloadUrl: "https://zmpt.cc/download.php?downhash=%5Bredacted%5D"
    }
  });
});
```

- [ ] **Step 8: Run core tests**

Run:

```bash
npm test -- packages/core/src/rss.test.ts packages/core/src/log-redaction.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit core RSS helpers**

Run:

```bash
git add package.json package-lock.json packages/core/src/rss.ts packages/core/src/rss.test.ts packages/core/src/index.ts packages/core/src/log-redaction.ts packages/core/src/log-redaction.test.ts
git commit -m "Add RSS parsing and filtering core"
```

---

### Task 2: Add RSS Persistence Models And Repository

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/src/rss-repository.ts`
- Modify: `apps/api/src/persistence.ts`
- Create: `apps/api/src/rss-repository.test.ts`

- [ ] **Step 1: Add failing repository tests**

Create `apps/api/src/rss-repository.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrismaPersistence } from "./persistence.js";

let dataDir = "";
let persistence: PrismaPersistence;

describe("RSS persistence", () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-rss-db-"));
    process.env.DATABASE_URL = `file:${path.join(dataDir, "rss.db")}`;
    persistence = new PrismaPersistence();
  });

  afterEach(async () => {
    await persistence.disconnect();
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
  });

  it("stores settings, subscriptions, and item status updates", async () => {
    await persistence.ensure();
    await persistence.rssSettings.update({ updateIntervalMs: 600_000 });
    expect(await persistence.rssSettings.get()).toMatchObject({ updateIntervalMs: 600_000 });

    const subscription = await persistence.rssSubscriptions.create({
      name: "ZMPT Movies",
      site: "zmweb",
      feedUrl: "https://zmpt.cc/torrentrss.php?passkey=secret",
      enabled: true,
      filter: { excludeKeywords: ["60Fps"] }
    });

    const item = await persistence.rssItems.upsertFromRefresh({
      subscriptionId: subscription.id,
      guid: "guid-1",
      sourceUrl: "https://zmpt.cc/details.php?id=1",
      downloadUrl: "https://zmpt.cc/download.php?downhash=secret",
      title: "Movie.2026.1080p.WEB-DL.x265-GROUP",
      subtitle: null,
      size: 123,
      publishedAt: "2026-05-31T00:00:00.000Z",
      status: "proposal",
      filterReason: null,
      checkResult: null,
      ptpTarget: null,
      raw: { title: "raw" }
    });

    expect(item.status).toBe("proposal");
    await persistence.rssItems.markIgnored(item.id);
    expect((await persistence.rssItems.list(subscription.id, {})).items[0]).toMatchObject({ status: "ignored" });
  });

  it("dedupes refresh items by subscription and guid", async () => {
    await persistence.ensure();
    const subscription = await persistence.rssSubscriptions.create({
      name: "ZMPT Movies",
      site: "zmweb",
      feedUrl: "https://zmpt.cc/rss",
      enabled: true,
      filter: {}
    });

    const first = await persistence.rssItems.upsertFromRefresh({
      subscriptionId: subscription.id,
      guid: "same-guid",
      sourceUrl: "https://zmpt.cc/details.php?id=1",
      downloadUrl: "https://zmpt.cc/download.php?downhash=one",
      title: "Movie.2026.1080p.WEB-DL.x265-GROUP",
      subtitle: null,
      size: 123,
      publishedAt: null,
      status: "proposal",
      filterReason: null,
      checkResult: null,
      ptpTarget: null,
      raw: {}
    });
    const second = await persistence.rssItems.upsertFromRefresh({
      subscriptionId: subscription.id,
      guid: "same-guid",
      sourceUrl: "https://zmpt.cc/details.php?id=1",
      downloadUrl: "https://zmpt.cc/download.php?downhash=two",
      title: "Movie.2026.1080p.WEB-DL.x265-GROUP",
      subtitle: null,
      size: 456,
      publishedAt: null,
      status: "duplicate_full",
      filterReason: null,
      checkResult: null,
      ptpTarget: null,
      raw: {}
    });

    expect(second.id).toBe(first.id);
    const list = await persistence.rssItems.list(subscription.id, {});
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ status: "duplicate_full", size: 456 });
  });
});
```

- [ ] **Step 2: Run the failing repository tests**

Run:

```bash
npm test -- apps/api/src/rss-repository.test.ts
```

Expected: FAIL because RSS repository properties do not exist.

- [ ] **Step 3: Add Prisma models**

Append to `apps/api/prisma/schema.prisma`:

```prisma
model RssSettings {
  id               String   @id
  updateIntervalMs Int      @map("update_interval_ms")
  updatedAt        DateTime @updatedAt
}

model RssSubscription {
  id             String   @id
  name           String
  site           String
  feedUrl        String   @map("feed_url")
  enabled        Boolean  @default(true)
  filterJson     String   @default("{}") @map("filter_json")
  lastFetchedAt  DateTime? @map("last_fetched_at")
  lastRunStatus  String?  @map("last_run_status")
  lastRunMessage String?  @map("last_run_message")
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@index([createdAt])
}

model RssItem {
  id              String   @id
  subscriptionId  String   @map("subscription_id")
  guid            String?
  sourceUrl       String?  @map("source_url")
  downloadUrl     String?  @map("download_url")
  title           String
  subtitle        String?
  size            BigInt?
  publishedAt     DateTime? @map("published_at")
  status          String
  filterReason    String?  @map("filter_reason")
  checkResultJson String?  @map("check_result_json")
  ptpTargetJson   String?  @map("ptp_target_json")
  acceptedJobId   String?  @map("accepted_job_id")
  lastError       String?  @map("last_error")
  rawJson         String   @default("{}") @map("raw_json")
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([subscriptionId, createdAt])
  @@index([subscriptionId, guid])
  @@index([subscriptionId, sourceUrl])
  @@index([status])
}
```

- [ ] **Step 4: Create RSS repository types and implementation**

Create `apps/api/src/rss-repository.ts`:

```ts
import { randomUUID } from "node:crypto";
import { redactSecretUrl, type BrowserCheckResult, type RssFilterConfig, type RssItemStatus, type SourceSite } from "@popcorn-queue/core";
import type { PrismaPersistence } from "./persistence.js";

export interface RssSettingsRecord {
  id: string;
  updateIntervalMs: number;
  updatedAt: string;
}

export interface RssSubscriptionRecord {
  id: string;
  name: string;
  site: SourceSite;
  feedUrl: string;
  feedUrlDisplay: string;
  enabled: boolean;
  filter: RssFilterConfig;
  lastFetchedAt: string | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RssPtpTarget {
  groupId: string;
  displayTitle: string;
  year: string | null;
  imdbId: string | null;
  ptpUrl: string;
  resolvedFrom: "imdb" | "title_year";
}

export interface RssItemRecord {
  id: string;
  subscriptionId: string;
  guid: string | null;
  sourceUrl: string | null;
  sourceUrlDisplay: string | null;
  downloadUrl: string | null;
  downloadUrlDisplay: string | null;
  title: string;
  subtitle: string | null;
  size: number | null;
  publishedAt: string | null;
  status: RssItemStatus;
  filterReason: string | null;
  checkResult: BrowserCheckResult | null;
  ptpTarget: RssPtpTarget | null;
  acceptedJobId: string | null;
  lastError: string | null;
  raw: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRssSubscriptionInput {
  name: string;
  site: SourceSite;
  feedUrl: string;
  enabled: boolean;
  filter: RssFilterConfig;
}

export interface UpsertRssItemInput {
  subscriptionId: string;
  guid: string | null;
  sourceUrl: string | null;
  downloadUrl: string | null;
  title: string;
  subtitle: string | null;
  size: number | null;
  publishedAt: string | null;
  status: RssItemStatus;
  filterReason: string | null;
  checkResult: BrowserCheckResult | null;
  ptpTarget: RssPtpTarget | null;
  raw: Record<string, unknown>;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  return value ? JSON.parse(value) as T : fallback;
}

function dateIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function optionalDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

export class PrismaRssSettingsRepository {
  constructor(private readonly persistence: PrismaPersistence) {}

  async get(): Promise<RssSettingsRecord> {
    await this.persistence.ensure();
    const row = await this.persistence.query(() => this.persistence.prisma.rssSettings.upsert({
      where: { id: "default" },
      create: { id: "default", updateIntervalMs: 600_000, updatedAt: new Date() },
      update: {}
    }));
    return { id: row.id, updateIntervalMs: row.updateIntervalMs, updatedAt: row.updatedAt.toISOString() };
  }

  async update(input: { updateIntervalMs: number }): Promise<RssSettingsRecord> {
    await this.persistence.ensure();
    const row = await this.persistence.query(() => this.persistence.prisma.rssSettings.upsert({
      where: { id: "default" },
      create: { id: "default", updateIntervalMs: input.updateIntervalMs, updatedAt: new Date() },
      update: { updateIntervalMs: input.updateIntervalMs, updatedAt: new Date() }
    }));
    return { id: row.id, updateIntervalMs: row.updateIntervalMs, updatedAt: row.updatedAt.toISOString() };
  }
}

export class PrismaRssSubscriptionRepository {
  constructor(private readonly persistence: PrismaPersistence) {}

  async create(input: CreateRssSubscriptionInput): Promise<RssSubscriptionRecord> {
    await this.persistence.ensure();
    const now = new Date();
    const row = await this.persistence.query(() => this.persistence.prisma.rssSubscription.create({
      data: {
        id: randomUUID(),
        name: input.name,
        site: input.site,
        feedUrl: input.feedUrl,
        enabled: input.enabled,
        filterJson: JSON.stringify(input.filter),
        createdAt: now,
        updatedAt: now
      }
    }));
    return this.deserialize(row);
  }

  async list(): Promise<RssSubscriptionRecord[]> {
    await this.persistence.ensure();
    const rows = await this.persistence.query(() => this.persistence.prisma.rssSubscription.findMany({ orderBy: { createdAt: "desc" } }));
    return rows.map((row) => this.deserialize(row));
  }

  async get(id: string): Promise<RssSubscriptionRecord | null> {
    await this.persistence.ensure();
    const row = await this.persistence.query(() => this.persistence.prisma.rssSubscription.findUnique({ where: { id } }));
    return row ? this.deserialize(row) : null;
  }

  async update(id: string, patch: Partial<CreateRssSubscriptionInput> & { lastFetchedAt?: string | null; lastRunStatus?: string | null; lastRunMessage?: string | null }): Promise<RssSubscriptionRecord | null> {
    await this.persistence.ensure();
    const data: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.site !== undefined) data.site = patch.site;
    if (patch.feedUrl !== undefined) data.feedUrl = patch.feedUrl;
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    if (patch.filter !== undefined) data.filterJson = JSON.stringify(patch.filter);
    if (patch.lastFetchedAt !== undefined) data.lastFetchedAt = optionalDate(patch.lastFetchedAt);
    if (patch.lastRunStatus !== undefined) data.lastRunStatus = patch.lastRunStatus;
    if (patch.lastRunMessage !== undefined) data.lastRunMessage = patch.lastRunMessage;
    const row = await this.persistence.query(() => this.persistence.prisma.rssSubscription.update({ where: { id }, data }).catch(() => null));
    return row ? this.deserialize(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    await this.persistence.ensure();
    await this.persistence.query(() => this.persistence.prisma.rssItem.deleteMany({ where: { subscriptionId: id } }));
    const result = await this.persistence.query(() => this.persistence.prisma.rssSubscription.deleteMany({ where: { id } }));
    return result.count > 0;
  }

  private deserialize(row: { id: string; name: string; site: string; feedUrl: string; enabled: boolean; filterJson: string; lastFetchedAt: Date | null; lastRunStatus: string | null; lastRunMessage: string | null; createdAt: Date; updatedAt: Date }): RssSubscriptionRecord {
    return {
      id: row.id,
      name: row.name,
      site: row.site as SourceSite,
      feedUrl: row.feedUrl,
      feedUrlDisplay: redactSecretUrl(row.feedUrl),
      enabled: row.enabled,
      filter: parseJson<RssFilterConfig>(row.filterJson, {}),
      lastFetchedAt: dateIso(row.lastFetchedAt),
      lastRunStatus: row.lastRunStatus,
      lastRunMessage: row.lastRunMessage,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    };
  }
}

export class PrismaRssItemRepository {
  constructor(private readonly persistence: PrismaPersistence) {}

  async upsertFromRefresh(input: UpsertRssItemInput): Promise<RssItemRecord> {
    await this.persistence.ensure();
    const existing = await this.findExisting(input);
    if (existing?.status === "ignored" || existing?.status === "accepted") return existing;
    const now = new Date();
    const data = {
      guid: input.guid,
      sourceUrl: input.sourceUrl,
      downloadUrl: input.downloadUrl,
      title: input.title,
      subtitle: input.subtitle,
      size: input.size === null ? null : BigInt(input.size),
      publishedAt: optionalDate(input.publishedAt),
      status: input.status,
      filterReason: input.filterReason,
      checkResultJson: input.checkResult ? JSON.stringify(input.checkResult) : null,
      ptpTargetJson: input.ptpTarget ? JSON.stringify(input.ptpTarget) : null,
      lastError: null,
      rawJson: JSON.stringify(input.raw),
      updatedAt: now
    };
    const row = existing
      ? await this.persistence.query(() => this.persistence.prisma.rssItem.update({ where: { id: existing.id }, data }))
      : await this.persistence.query(() => this.persistence.prisma.rssItem.create({
          data: { id: randomUUID(), subscriptionId: input.subscriptionId, ...data, createdAt: now }
        }));
    return this.deserialize(row);
  }

  async list(subscriptionId: string, options: { view?: "proposals" | "all"; status?: RssItemStatus } = {}): Promise<{ items: RssItemRecord[] }> {
    await this.persistence.ensure();
    const where: Record<string, unknown> = { subscriptionId };
    if (options.view === "proposals") where.status = "proposal";
    if (options.status) where.status = options.status;
    const rows = await this.persistence.query(() => this.persistence.prisma.rssItem.findMany({ where, orderBy: { createdAt: "desc" } }));
    return { items: rows.map((row) => this.deserialize(row)) };
  }

  async get(id: string): Promise<RssItemRecord | null> {
    await this.persistence.ensure();
    const row = await this.persistence.query(() => this.persistence.prisma.rssItem.findUnique({ where: { id } }));
    return row ? this.deserialize(row) : null;
  }

  async markIgnored(id: string): Promise<RssItemRecord | null> {
    return this.updateStatus(id, { status: "ignored", lastError: null });
  }

  async markAccepted(id: string, jobId: string): Promise<RssItemRecord | null> {
    return this.updateStatus(id, { status: "accepted", acceptedJobId: jobId, lastError: null });
  }

  async markAcceptError(id: string, error: string): Promise<RssItemRecord | null> {
    return this.updateStatus(id, { lastError: error });
  }

  async findAcceptedBySource(sourceUrl: string | null, downloadUrl: string | null): Promise<RssItemRecord | null> {
    await this.persistence.ensure();
    if (!sourceUrl && !downloadUrl) return null;
    const row = await this.persistence.query(() => this.persistence.prisma.rssItem.findFirst({
      where: {
        status: "accepted",
        OR: [
          ...(sourceUrl ? [{ sourceUrl }] : []),
          ...(downloadUrl ? [{ downloadUrl }] : [])
        ]
      }
    }));
    return row ? this.deserialize(row) : null;
  }

  private async updateStatus(id: string, patch: { status?: RssItemStatus; acceptedJobId?: string; lastError?: string | null }): Promise<RssItemRecord | null> {
    await this.persistence.ensure();
    const row = await this.persistence.query(() => this.persistence.prisma.rssItem.update({ where: { id }, data: { ...patch, updatedAt: new Date() } }).catch(() => null));
    return row ? this.deserialize(row) : null;
  }

  private async findExisting(input: UpsertRssItemInput): Promise<RssItemRecord | null> {
    const row = await this.persistence.query(() => this.persistence.prisma.rssItem.findFirst({
      where: {
        subscriptionId: input.subscriptionId,
        OR: [
          ...(input.guid ? [{ guid: input.guid }] : []),
          ...(input.sourceUrl ? [{ sourceUrl: input.sourceUrl }] : []),
          { title: input.title, publishedAt: optionalDate(input.publishedAt) }
        ]
      }
    }));
    return row ? this.deserialize(row) : null;
  }

  private deserialize(row: { id: string; subscriptionId: string; guid: string | null; sourceUrl: string | null; downloadUrl: string | null; title: string; subtitle: string | null; size: bigint | number | null; publishedAt: Date | null; status: string; filterReason: string | null; checkResultJson: string | null; ptpTargetJson: string | null; acceptedJobId: string | null; lastError: string | null; rawJson: string; createdAt: Date; updatedAt: Date }): RssItemRecord {
    return {
      id: row.id,
      subscriptionId: row.subscriptionId,
      guid: row.guid,
      sourceUrl: row.sourceUrl,
      sourceUrlDisplay: row.sourceUrl ? redactSecretUrl(row.sourceUrl) : null,
      downloadUrl: row.downloadUrl,
      downloadUrlDisplay: row.downloadUrl ? redactSecretUrl(row.downloadUrl) : null,
      title: row.title,
      subtitle: row.subtitle,
      size: row.size === null ? null : Number(row.size),
      publishedAt: dateIso(row.publishedAt),
      status: row.status as RssItemStatus,
      filterReason: row.filterReason,
      checkResult: parseJson<BrowserCheckResult | null>(row.checkResultJson, null),
      ptpTarget: parseJson<RssPtpTarget | null>(row.ptpTargetJson, null),
      acceptedJobId: row.acceptedJobId,
      lastError: row.lastError,
      raw: parseJson<Record<string, unknown>>(row.rawJson, {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    };
  }
}
```

- [ ] **Step 5: Wire repositories into persistence**

Modify `apps/api/src/persistence.ts` imports:

```ts
import { PrismaRssItemRepository, PrismaRssSettingsRepository, PrismaRssSubscriptionRepository } from "./rss-repository.js";
```

Add readonly properties to `PrismaPersistence`:

```ts
readonly rssSettings = new PrismaRssSettingsRepository(this);
readonly rssSubscriptions = new PrismaRssSubscriptionRepository(this);
readonly rssItems = new PrismaRssItemRepository(this);
```

Add table creation to `createTables()`:

```ts
await this.query(() => this.prisma.$executeRawUnsafe(`
  CREATE TABLE IF NOT EXISTS "RssSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "update_interval_ms" INTEGER NOT NULL,
    "updatedAt" DATETIME NOT NULL
  )
`));
await this.query(() => this.prisma.$executeRawUnsafe(`
  CREATE TABLE IF NOT EXISTS "RssSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "site" TEXT NOT NULL,
    "feed_url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "filter_json" TEXT NOT NULL DEFAULT '{}',
    "last_fetched_at" DATETIME,
    "last_run_status" TEXT,
    "last_run_message" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )
`));
await this.query(() => this.prisma.$executeRawUnsafe(`
  CREATE TABLE IF NOT EXISTS "RssItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subscription_id" TEXT NOT NULL,
    "guid" TEXT,
    "source_url" TEXT,
    "download_url" TEXT,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "size" INTEGER,
    "published_at" DATETIME,
    "status" TEXT NOT NULL,
    "filter_reason" TEXT,
    "check_result_json" TEXT,
    "ptp_target_json" TEXT,
    "accepted_job_id" TEXT,
    "last_error" TEXT,
    "raw_json" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )
`));
await this.query(() => this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "RssSubscription_createdAt_idx" ON "RssSubscription"("createdAt")`));
await this.query(() => this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "RssItem_subscription_createdAt_idx" ON "RssItem"("subscription_id", "createdAt")`));
await this.query(() => this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "RssItem_subscription_guid_idx" ON "RssItem"("subscription_id", "guid")`));
await this.query(() => this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "RssItem_subscription_source_idx" ON "RssItem"("subscription_id", "source_url")`));
await this.query(() => this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "RssItem_status_idx" ON "RssItem"("status")`));
```

- [ ] **Step 6: Run Prisma generation and repository tests**

Run:

```bash
npm --workspace @popcorn-queue/api run prisma:generate
npm test -- apps/api/src/rss-repository.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit RSS persistence**

Run:

```bash
git add apps/api/prisma/schema.prisma apps/api/src/rss-repository.ts apps/api/src/rss-repository.test.ts apps/api/src/persistence.ts
git commit -m "Add RSS persistence"
```

---

### Task 3: Add RSS Service Refresh, Classification, Ignore, And Accept Logic

**Files:**
- Create: `apps/api/src/rss-service.ts`
- Create: `apps/api/src/rss-service.test.ts`
- Modify: `apps/api/src/server-test-utils.ts`

- [ ] **Step 1: Write failing RSS service tests**

Create `apps/api/src/rss-service.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { BrowserCheckResult, TorrentCandidate } from "@popcorn-queue/core";
import { JobRepository } from "./jobs.js";
import {
  MemoryRssItemRepository,
  MemoryRssSettingsRepository,
  MemoryRssSubscriptionRepository,
  RssService
} from "./rss-service.js";

function checkResult(candidate: TorrentCandidate, status: BrowserCheckResult["decision"]["status"]): BrowserCheckResult {
  return {
    candidate,
    parsed: null,
    decision: {
      status,
      movieFound: status !== "not_found",
      reason: `${status} reason`,
      confidence: "high",
      ...(status === "open"
        ? {
            movie: { GroupId: "123", Title: "Movie", Year: "2026", ImdbId: "tt1234567", Torrents: [] },
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=123"
          }
        : {})
    },
    cache: { key: "ptp:test", hit: false, policy: "permanent" }
  };
}

const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss><channel><title>Test</title>
  <item>
    <title><![CDATA[[电影 / Movies]Movie 2026 1080p WEB-DL x265-GROUP[中文字幕][1.00 GB]]]></title>
    <link>https://zmpt.cc/details.php?id=1</link>
    <description><![CDATA[https://www.imdb.com/title/tt1234567/]]></description>
    <enclosure url="https://zmpt.cc/download.php?downhash=secret" length="1000" />
    <guid>guid-open</guid>
    <pubDate>Sun, 31 May 2026 00:00:00 +0800</pubDate>
  </item>
  <item>
    <title><![CDATA[[电影 / Movies]Bystander 2025 2160p WEB-DL 60Fps x265-GROUP[中字][2.00 GB]]]></title>
    <link>https://zmpt.cc/details.php?id=2</link>
    <enclosure url="https://zmpt.cc/download.php?downhash=secret2" length="2000" />
    <guid>guid-filtered</guid>
  </item>
</channel></rss>`;

describe("RSS service", () => {
  it("refreshes a subscription into proposals and filtered history without downloading", async () => {
    const subscriptions = new MemoryRssSubscriptionRepository();
    const items = new MemoryRssItemRepository();
    const settings = new MemoryRssSettingsRepository();
    const subscription = await subscriptions.create({
      name: "ZMPT",
      site: "zmweb",
      feedUrl: "https://zmpt.cc/rss?passkey=secret",
      enabled: true,
      filter: { excludeKeywords: ["60Fps"] }
    });
    const fetchImpl = vi.fn(async () => new Response(rssXml, { status: 200 }));
    const duplicateChecks = {
      check: vi.fn(async (candidate: TorrentCandidate) => checkResult(candidate, "open"))
    };
    const service = new RssService({
      settings,
      subscriptions,
      items,
      duplicateChecks,
      jobRepository: new JobRepository([]),
      dataRoot: "/tmp/rss-service-test",
      fetchImpl,
      enqueuePreparation: vi.fn()
    });

    const result = await service.refreshSubscription(subscription.id);

    expect(result).toMatchObject({ fetched: 2, proposals: 1, filtered: 1 });
    expect(fetchImpl).toHaveBeenCalledWith("https://zmpt.cc/rss?passkey=secret");
    expect(duplicateChecks.check).toHaveBeenCalledTimes(1);
    const all = await items.list(subscription.id, {});
    expect(all.items.map((item) => item.status).sort()).toEqual(["filtered", "proposal"]);
    expect(all.items.find((item) => item.status === "proposal")?.ptpTarget).toMatchObject({
      groupId: "123",
      displayTitle: "Movie [2026]",
      ptpUrl: "https://passthepopcorn.me/torrents.php?id=123",
      resolvedFrom: "imdb"
    });
  });

  it("keeps full duplicate items in All Items but not Proposals", async () => {
    const subscriptions = new MemoryRssSubscriptionRepository();
    const items = new MemoryRssItemRepository();
    const subscription = await subscriptions.create({ name: "ZMPT", site: "zmweb", feedUrl: "https://zmpt.cc/rss", enabled: true, filter: {} });
    const service = new RssService({
      settings: new MemoryRssSettingsRepository(),
      subscriptions,
      items,
      duplicateChecks: { check: vi.fn(async (candidate: TorrentCandidate) => checkResult(candidate, "full")) },
      jobRepository: new JobRepository([]),
      dataRoot: "/tmp/rss-service-test",
      fetchImpl: vi.fn(async () => new Response(rssXml, { status: 200 })),
      enqueuePreparation: vi.fn()
    });

    await service.refreshSubscription(subscription.id);

    expect((await items.list(subscription.id, { view: "proposals" })).items).toHaveLength(0);
    expect((await items.list(subscription.id, {})).items.some((item) => item.status === "duplicate_full")).toBe(true);
  });
});
```

- [ ] **Step 2: Run failing service tests**

Run:

```bash
npm test -- apps/api/src/rss-service.test.ts
```

Expected: FAIL because `rss-service.ts` does not exist.

- [ ] **Step 3: Implement RSS service and memory repositories**

Create `apps/api/src/rss-service.ts` with service boundaries:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  buildJobWorkspacePaths,
  evaluateRssFilter,
  parseRssFeed,
  rssItemStatusFromDecision,
  rssItemToTorrentCandidate,
  type BrowserCheckResult,
  type RssFilterConfig,
  type RssItemStatus,
  type SourceSite,
  type TorrentCandidate
} from "@popcorn-queue/core";
import { downloadTorrentFromUrl } from "./intake.js";
import type { JobRepository } from "./jobs.js";
import type { RssItemRecord, RssPtpTarget, RssSettingsRecord, RssSubscriptionRecord, UpsertRssItemInput } from "./rss-repository.js";

export interface RssSettingsStore {
  get(): Promise<RssSettingsRecord>;
  update(input: { updateIntervalMs: number }): Promise<RssSettingsRecord>;
}

export interface RssSubscriptionStore {
  create(input: { name: string; site: SourceSite; feedUrl: string; enabled: boolean; filter: RssFilterConfig }): Promise<RssSubscriptionRecord>;
  list(): Promise<RssSubscriptionRecord[]>;
  get(id: string): Promise<RssSubscriptionRecord | null>;
  update(id: string, patch: Partial<{ name: string; site: SourceSite; feedUrl: string; enabled: boolean; filter: RssFilterConfig; lastFetchedAt: string | null; lastRunStatus: string | null; lastRunMessage: string | null }>): Promise<RssSubscriptionRecord | null>;
  delete(id: string): Promise<boolean>;
}

export interface RssItemStore {
  upsertFromRefresh(input: UpsertRssItemInput): Promise<RssItemRecord>;
  list(subscriptionId: string, options: { view?: "proposals" | "all"; status?: RssItemStatus }): Promise<{ items: RssItemRecord[] }>;
  get(id: string): Promise<RssItemRecord | null>;
  markIgnored(id: string): Promise<RssItemRecord | null>;
  markAccepted(id: string, jobId: string): Promise<RssItemRecord | null>;
  markAcceptError(id: string, error: string): Promise<RssItemRecord | null>;
  findAcceptedBySource(sourceUrl: string | null, downloadUrl: string | null): Promise<RssItemRecord | null>;
}

export interface RssDuplicateCheckService {
  check(candidate: TorrentCandidate): Promise<BrowserCheckResult>;
}

export interface RssRefreshResult {
  subscriptionId: string;
  fetched: number;
  proposals: number;
  filtered: number;
  duplicates: number;
  errors: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown RSS error");
}

function ptpTargetFromCheckResult(result: BrowserCheckResult): RssPtpTarget | null {
  const movie = result.decision.movie;
  const groupId = movie?.GroupId;
  const ptpUrl = result.decision.ptpUrl;
  if (!groupId || !ptpUrl) return null;
  const title = movie.Title ?? movie.Name ?? "PTP movie";
  const year = movie.Year ? String(movie.Year) : null;
  return {
    groupId: String(groupId),
    displayTitle: year ? `${title} [${year}]` : title,
    year,
    imdbId: movie.ImdbId ? String(movie.ImdbId) : result.candidate.imdbId ?? null,
    ptpUrl,
    resolvedFrom: result.candidate.imdbId ? "imdb" : "title_year"
  };
}

export class RssService {
  private readonly running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: {
    settings: RssSettingsStore;
    subscriptions: RssSubscriptionStore;
    items: RssItemStore;
    duplicateChecks: RssDuplicateCheckService;
    jobRepository: Pick<JobRepository, "createFromBrowser" | "attachWorkspace">;
    dataRoot: string;
    fetchImpl: typeof fetch;
    enqueuePreparation(jobId: string): void;
  }) {}

  async refreshSubscription(subscriptionId: string): Promise<RssRefreshResult> {
    if (this.running.has(subscriptionId)) throw new Error("rss_refresh_already_running");
    this.running.add(subscriptionId);
    try {
      const subscription = await this.options.subscriptions.get(subscriptionId);
      if (!subscription) throw new Error("rss_subscription_not_found");
      const response = await this.options.fetchImpl(subscription.feedUrl);
      if (!response.ok) throw new Error(`rss_fetch_failed_${response.status}`);
      const parsed = parseRssFeed(await response.text(), { site: subscription.site });
      let proposals = 0;
      let filtered = 0;
      let duplicates = 0;
      let errors = 0;

      for (const parsedItem of parsed.items) {
        const filter = evaluateRssFilter(parsedItem, subscription.filter);
        if (!filter.passed) {
          filtered += 1;
          await this.options.items.upsertFromRefresh({ ...this.baseItem(subscription.id, parsedItem), status: "filtered", filterReason: filter.reason, checkResult: null, ptpTarget: null });
          continue;
        }

        const candidate = rssItemToTorrentCandidate(parsedItem);
        try {
          const checkResult = await this.options.duplicateChecks.check(candidate);
          const status = rssItemStatusFromDecision(checkResult.decision.status);
          if (status === "proposal") proposals += 1;
          else if (status === "duplicate_full" || status === "duplicate_skip") duplicates += 1;
          else errors += 1;
          await this.options.items.upsertFromRefresh({
            ...this.baseItem(subscription.id, parsedItem),
            status,
            filterReason: null,
            checkResult,
            ptpTarget: ptpTargetFromCheckResult(checkResult)
          });
        } catch (error) {
          errors += 1;
          await this.options.items.upsertFromRefresh({ ...this.baseItem(subscription.id, parsedItem), status: "check_error", filterReason: null, checkResult: null, ptpTarget: null, raw: { ...parsedItem.raw, error: errorMessage(error) } });
        }
      }

      await this.options.subscriptions.update(subscription.id, {
        lastFetchedAt: new Date().toISOString(),
        lastRunStatus: "ok",
        lastRunMessage: `Fetched ${parsed.items.length} item(s).`
      });
      return { subscriptionId, fetched: parsed.items.length, proposals, filtered, duplicates, errors };
    } catch (error) {
      await this.options.subscriptions.update(subscriptionId, {
        lastFetchedAt: new Date().toISOString(),
        lastRunStatus: "failed",
        lastRunMessage: errorMessage(error)
      });
      throw error;
    } finally {
      this.running.delete(subscriptionId);
    }
  }

  async acceptItem(itemId: string): Promise<{ item: RssItemRecord; job: Awaited<ReturnType<JobRepository["createFromBrowser"]>> }> {
    const item = await this.options.items.get(itemId);
    if (!item) throw new Error("rss_item_not_found");
    if (item.status !== "proposal") throw new Error("rss_item_not_proposal");
    if (!item.downloadUrl) throw new Error("rss_item_missing_download_url");
    const duplicate = await this.options.items.findAcceptedBySource(item.sourceUrl, item.downloadUrl);
    if (duplicate?.acceptedJobId) throw new Error(`rss_item_already_accepted:${duplicate.acceptedJobId}`);
    try {
      const torrent = await downloadTorrentFromUrl(item.downloadUrl, this.options.fetchImpl);
      const candidate: TorrentCandidate = {
        site: "unknown",
        title: item.title,
        ...(item.subtitle ? { subtitle: item.subtitle } : {}),
        ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
        ...(item.downloadUrl ? { downloadUrl: item.downloadUrl } : {})
      };
      const job = await this.options.jobRepository.createFromBrowser({
        candidate,
        ...(item.checkResult ? { checkResult: item.checkResult } : {}),
        torrent: { filename: torrent.filename, bytes: torrent.bytes.byteLength, ...(torrent.contentType ? { contentType: torrent.contentType } : {}) },
        sourceUrl: item.sourceUrl ?? undefined,
        sourceSite: "rss",
        title: item.title
      });
      const paths = buildJobWorkspacePaths(this.options.dataRoot, job.id);
      await Promise.all([mkdir(paths.inputDir, { recursive: true }), mkdir(paths.torrentDir, { recursive: true }), mkdir(paths.sourceDownloadDir, { recursive: true }), mkdir(paths.logs.dir, { recursive: true })]);
      await writeFile(paths.sourceTorrent, torrent.bytes);
      await writeFile(paths.sourceJson, `${JSON.stringify({ candidate, checkResult: item.checkResult, rssItem: { id: item.id, sourceUrl: item.sourceUrl, ptpTarget: item.ptpTarget } }, null, 2)}\n`, "utf8");
      const attached = await this.options.jobRepository.attachWorkspace(job.id, {
        workspace: { dataRoot: paths.dataRoot, jobRoot: paths.jobRoot, manifest: paths.manifest },
        torrentFilePath: paths.sourceTorrent,
        source: {
          site: "rss",
          title: item.title,
          ...(item.subtitle ? { subtitle: item.subtitle } : {}),
          ...(item.sourceUrl ? { url: item.sourceUrl } : {}),
          ...(item.downloadUrl ? { torrentUrl: item.downloadUrl } : {}),
          ...(item.ptpTarget ? { ptpTarget: item.ptpTarget } : {})
        }
      });
      const updatedItem = await this.options.items.markAccepted(item.id, job.id);
      this.options.enqueuePreparation(job.id);
      return { item: updatedItem ?? item, job: attached ?? job };
    } catch (error) {
      await this.options.items.markAcceptError(item.id, errorMessage(error));
      throw error;
    }
  }

  async ignoreItem(itemId: string): Promise<RssItemRecord> {
    const item = await this.options.items.markIgnored(itemId);
    if (!item) throw new Error("rss_item_not_found");
    return item;
  }

  async refreshEnabledSubscriptions(): Promise<void> {
    const subscriptions = await this.options.subscriptions.list();
    for (const subscription of subscriptions) {
      if (!subscription.enabled) continue;
      await this.refreshSubscription(subscription.id).catch(() => undefined);
    }
  }

  async startPolling(): Promise<void> {
    await this.stopPolling();
    const settings = await this.options.settings.get();
    this.timer = setInterval(() => {
      void this.refreshEnabledSubscriptions();
    }, settings.updateIntervalMs);
  }

  async stopPolling(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reschedule(): void {
    void this.startPolling();
  }

  private baseItem(subscriptionId: string, item: ReturnType<typeof parseRssFeed>["items"][number]) {
    return {
      subscriptionId,
      guid: item.guid,
      sourceUrl: item.sourceUrl,
      downloadUrl: item.downloadUrl,
      title: item.title,
      subtitle: item.subtitle,
      size: item.size,
      publishedAt: item.publishedAt,
      raw: item.raw
    };
  }
}
```

Also include memory repository classes in this file for tests:

```ts
export class MemoryRssSettingsRepository implements RssSettingsStore {
  private settings: RssSettingsRecord = { id: "default", updateIntervalMs: 600_000, updatedAt: new Date(0).toISOString() };
  async get() { return this.settings; }
  async update(input: { updateIntervalMs: number }) {
    this.settings = { id: "default", updateIntervalMs: input.updateIntervalMs, updatedAt: new Date().toISOString() };
    return this.settings;
  }
}

export class MemoryRssSubscriptionRepository implements RssSubscriptionStore {
  private subscriptions: RssSubscriptionRecord[] = [];
  async create(input: { name: string; site: SourceSite; feedUrl: string; enabled: boolean; filter: RssFilterConfig }) {
    const now = new Date().toISOString();
    const subscription: RssSubscriptionRecord = { id: randomUUID(), ...input, feedUrlDisplay: input.feedUrl, lastFetchedAt: null, lastRunStatus: null, lastRunMessage: null, createdAt: now, updatedAt: now };
    this.subscriptions.unshift(subscription);
    return subscription;
  }
  async list() { return this.subscriptions; }
  async get(id: string) { return this.subscriptions.find((item) => item.id === id) ?? null; }
  async update(id: string, patch: Partial<RssSubscriptionRecord>) {
    const index = this.subscriptions.findIndex((item) => item.id === id);
    if (index < 0) return null;
    this.subscriptions[index] = { ...this.subscriptions[index]!, ...patch, updatedAt: new Date().toISOString() };
    return this.subscriptions[index]!;
  }
  async delete(id: string) {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter((item) => item.id !== id);
    return this.subscriptions.length !== before;
  }
}

export class MemoryRssItemRepository implements RssItemStore {
  private items: RssItemRecord[] = [];
  async upsertFromRefresh(input: UpsertRssItemInput) {
    const existing = this.items.find((item) => item.subscriptionId === input.subscriptionId && ((input.guid && item.guid === input.guid) || (input.sourceUrl && item.sourceUrl === input.sourceUrl)));
    if (existing?.status === "ignored" || existing?.status === "accepted") return existing;
    const now = new Date().toISOString();
    const next: RssItemRecord = {
      id: existing?.id ?? randomUUID(),
      ...input,
      sourceUrlDisplay: input.sourceUrl,
      downloadUrlDisplay: input.downloadUrl,
      acceptedJobId: existing?.acceptedJobId ?? null,
      lastError: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.items = [next, ...this.items.filter((item) => item.id !== next.id)];
    return next;
  }
  async list(subscriptionId: string, options: { view?: "proposals" | "all"; status?: RssItemStatus } = {}) {
    return {
      items: this.items.filter((item) => item.subscriptionId === subscriptionId && (options.view === "proposals" ? item.status === "proposal" : true) && (!options.status || item.status === options.status))
    };
  }
  async get(id: string) { return this.items.find((item) => item.id === id) ?? null; }
  async markIgnored(id: string) { return this.patch(id, { status: "ignored", lastError: null }); }
  async markAccepted(id: string, jobId: string) { return this.patch(id, { status: "accepted", acceptedJobId: jobId, lastError: null }); }
  async markAcceptError(id: string, error: string) { return this.patch(id, { lastError: error }); }
  async findAcceptedBySource(sourceUrl: string | null, downloadUrl: string | null) {
    return this.items.find((item) => item.status === "accepted" && ((sourceUrl && item.sourceUrl === sourceUrl) || (downloadUrl && item.downloadUrl === downloadUrl))) ?? null;
  }
  private async patch(id: string, patch: Partial<RssItemRecord>) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return null;
    this.items[index] = { ...this.items[index]!, ...patch, updatedAt: new Date().toISOString() };
    return this.items[index]!;
  }
}
```

- [ ] **Step 4: Update server test mock to use memory RSS repositories**

Modify `apps/api/src/server-test-utils.ts` mock:

```ts
const { MemoryCacheStore } = await import("@popcorn-queue/core");
const { JobRepository } = await import("./jobs.js");
const { MemoryRssItemRepository, MemoryRssSettingsRepository, MemoryRssSubscriptionRepository } = await import("./rss-service.js");
```

Inside the mocked `PrismaPersistence` class:

```ts
readonly rssSettings = new MemoryRssSettingsRepository();
readonly rssSubscriptions = new MemoryRssSubscriptionRepository();
readonly rssItems = new MemoryRssItemRepository();
```

- [ ] **Step 5: Run service tests**

Run:

```bash
npm test -- apps/api/src/rss-service.test.ts apps/api/src/rss-repository.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit RSS service**

Run:

```bash
git add apps/api/src/rss-service.ts apps/api/src/rss-service.test.ts apps/api/src/server-test-utils.ts
git commit -m "Add RSS refresh service"
```

---

### Task 4: Add RSS API Routes

**Files:**
- Create: `apps/api/src/routes/rss.ts`
- Modify: `apps/api/src/routes/index.ts`
- Modify: `apps/api/src/api-context.ts`
- Create: `apps/api/src/server.rss.test.ts`

- [ ] **Step 1: Write failing API route tests**

Create `apps/api/src/server.rss.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { PtpClient } from "@popcorn-queue/integrations";
import { withConfiguredServer, testConfig } from "./server-test-utils.js";

describe("API RSS routes", () => {
  it("creates subscriptions, saves interval settings, refreshes, and lists proposals/all items", async () => {
    vi.spyOn(PtpClient.prototype, "searchByCandidate").mockResolvedValue({
      movies: [{ GroupId: "123", Title: "Movie", Year: "2026", ImdbId: "tt1234567", Torrents: [] }]
    });
    const config = testConfig();
    const rssXml = `<?xml version="1.0"?><rss><channel><item>
      <title><![CDATA[[电影 / Movies]Movie 2026 1080p WEB-DL x265-GROUP[中字][1 GB]]]></title>
      <link>https://zmpt.cc/details.php?id=1</link>
      <description><![CDATA[https://www.imdb.com/title/tt1234567/]]></description>
      <enclosure url="https://zmpt.cc/download.php?downhash=secret" length="1000" />
      <guid>guid-1</guid>
    </item></channel></rss>`;
    const fetchImpl = vi.fn(async () => new Response(rssXml, { status: 200 }));

    await withConfiguredServer(config, { autoPrepare: false, fetchImpl }, async (app) => {
      const settings = await app.inject({ method: "PATCH", url: "/api/rss/settings", payload: { updateIntervalMs: 300000 } });
      expect(settings.statusCode).toBe(200);
      expect(settings.json()).toMatchObject({ settings: { updateIntervalMs: 300000 } });

      const created = await app.inject({
        method: "POST",
        url: "/api/rss/subscriptions",
        payload: {
          name: "ZMPT",
          site: "zmweb",
          feedUrl: "https://zmpt.cc/torrentrss.php?passkey=secret",
          enabled: true,
          filter: {}
        }
      });
      expect(created.statusCode).toBe(201);
      expect(JSON.stringify(created.json())).not.toContain("secret");
      const subscriptionId = created.json<{ subscription: { id: string } }>().subscription.id;

      const refresh = await app.inject({ method: "POST", url: `/api/rss/subscriptions/${subscriptionId}/refresh` });
      expect(refresh.statusCode).toBe(200);
      expect(refresh.json()).toMatchObject({ result: { fetched: 1, proposals: 1 } });

      const proposals = await app.inject({ method: "GET", url: `/api/rss/subscriptions/${subscriptionId}/items?view=proposals` });
      expect(proposals.statusCode).toBe(200);
      expect(proposals.json()).toMatchObject({
        items: [
          {
            title: "Movie 2026 1080p WEB-DL x265-GROUP",
            status: "proposal",
            ptpTarget: { groupId: "123", ptpUrl: "https://passthepopcorn.me/torrents.php?id=123" }
          }
        ]
      });
      expect(JSON.stringify(proposals.json())).not.toContain("secret");
    });
  });
});
```

- [ ] **Step 2: Run failing route tests**

Run:

```bash
npm test -- apps/api/src/server.rss.test.ts
```

Expected: FAIL with 404s for `/api/rss/*`.

- [ ] **Step 3: Extend API context**

Modify `apps/api/src/api-context.ts`:

```ts
import type { RssService } from "./rss-service.js";
```

Add to `ApiRouteContext`:

```ts
getRssService(): RssService;
rssSettings: PrismaPersistence["rssSettings"];
rssSubscriptions: PrismaPersistence["rssSubscriptions"];
rssItems: PrismaPersistence["rssItems"];
```

- [ ] **Step 4: Implement RSS route module**

Create `apps/api/src/routes/rss.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { RssFilterConfig, SourceSite } from "@popcorn-queue/core";
import type { ApiRouteContext } from "../api-context.js";

interface SaveRssSettingsBody {
  updateIntervalMs?: number;
}

interface SaveSubscriptionBody {
  name?: string;
  site?: SourceSite;
  feedUrl?: string;
  enabled?: boolean;
  filter?: RssFilterConfig;
}

function validateInterval(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 60_000) throw new Error("rss_interval_too_short");
  return Math.round(parsed);
}

function validateSubscription(input: SaveSubscriptionBody, partial = false) {
  const output: SaveSubscriptionBody = {};
  if (!partial || input.name !== undefined) {
    const name = String(input.name ?? "").trim();
    if (!name) throw new Error("rss_subscription_name_required");
    output.name = name;
  }
  if (!partial || input.site !== undefined) output.site = (input.site || "unknown") as SourceSite;
  if (!partial || input.feedUrl !== undefined) {
    const feedUrl = String(input.feedUrl ?? "").trim();
    if (!/^https?:\/\//i.test(feedUrl)) throw new Error("rss_feed_url_invalid");
    output.feedUrl = feedUrl;
  }
  if (input.enabled !== undefined) output.enabled = Boolean(input.enabled);
  if (input.filter !== undefined) output.filter = input.filter;
  return output;
}

export function registerRssRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  app.get("/api/rss/settings", async () => ({ settings: await context.rssSettings.get() }));

  app.patch<{ Body: SaveRssSettingsBody }>("/api/rss/settings", async (request, reply) => {
    try {
      const settings = await context.rssSettings.update({ updateIntervalMs: validateInterval(request.body?.updateIntervalMs) });
      context.getRssService().reschedule();
      return { settings };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "rss_settings_save_failed" });
    }
  });

  app.get("/api/rss/subscriptions", async () => ({ subscriptions: await context.rssSubscriptions.list() }));

  app.post<{ Body: SaveSubscriptionBody }>("/api/rss/subscriptions", async (request, reply) => {
    try {
      const input = validateSubscription(request.body ?? {});
      const subscription = await context.rssSubscriptions.create({
        name: input.name!,
        site: input.site!,
        feedUrl: input.feedUrl!,
        enabled: input.enabled ?? true,
        filter: input.filter ?? {}
      });
      return reply.code(201).send({ subscription });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "rss_subscription_create_failed" });
    }
  });

  app.patch<{ Params: { id: string }; Body: SaveSubscriptionBody }>("/api/rss/subscriptions/:id", async (request, reply) => {
    try {
      const subscription = await context.rssSubscriptions.update(request.params.id, validateSubscription(request.body ?? {}, true));
      return subscription ? { subscription } : reply.code(404).send({ error: "rss_subscription_not_found" });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "rss_subscription_update_failed" });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/rss/subscriptions/:id", async (request, reply) => {
    const deleted = await context.rssSubscriptions.delete(request.params.id);
    return deleted ? { deleted: true } : reply.code(404).send({ error: "rss_subscription_not_found" });
  });

  app.post<{ Params: { id: string } }>("/api/rss/subscriptions/:id/refresh", async (request, reply) => {
    try {
      return { result: await context.getRssService().refreshSubscription(request.params.id) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "rss_refresh_failed" });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { view?: "proposals" | "all"; status?: string } }>("/api/rss/subscriptions/:id/items", async (request) => {
    return context.rssItems.list(request.params.id, {
      view: request.query.view === "proposals" ? "proposals" : "all",
      status: request.query.status as never
    });
  });

  app.post<{ Params: { id: string } }>("/api/rss/items/:id/accept", async (request, reply) => {
    try {
      return await context.getRssService().acceptItem(request.params.id);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "rss_item_accept_failed" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/rss/items/:id/ignore", async (request, reply) => {
    try {
      return { item: await context.getRssService().ignoreItem(request.params.id) };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : "rss_item_not_found" });
    }
  });
}
```

- [ ] **Step 5: Register RSS routes**

Modify `apps/api/src/routes/index.ts`:

```ts
import { registerRssRoutes } from "./rss.js";
```

Call it after settings/health:

```ts
registerRssRoutes(app, context);
```

- [ ] **Step 6: Run route tests**

Run:

```bash
npm test -- apps/api/src/server.rss.test.ts
```

Expected: PASS after Task 6 server wiring is complete. If it still fails because `getRssService()` is missing, proceed to Task 6 and rerun.

- [ ] **Step 7: Commit RSS routes**

Run after Task 6 passes:

```bash
git add apps/api/src/routes/rss.ts apps/api/src/routes/index.ts apps/api/src/api-context.ts apps/api/src/server.rss.test.ts
git commit -m "Add RSS API routes"
```

---

### Task 5: Wire RSS Service Into The API Server

**Files:**
- Modify: `apps/api/src/rss-service.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/server.rss.test.ts`

- [ ] **Step 1: Add a route test that poller is disabled in tests unless invoked manually**

Append to `apps/api/src/server.rss.test.ts`:

```ts
it("does not refresh RSS feeds before manual refresh when auto preparation is disabled", async () => {
  const fetchImpl = vi.fn(async () => new Response("<rss><channel /></rss>", { status: 200 }));

  await withConfiguredServer(testConfig(), { autoPrepare: false, fetchImpl }, async (app) => {
    const created = await app.inject({
      method: "POST",
      url: "/api/rss/subscriptions",
      payload: { name: "ZMPT", site: "zmweb", feedUrl: "https://zmpt.cc/rss?passkey=secret", enabled: true, filter: {} }
    });
    expect(created.statusCode).toBe(201);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Instantiate RSS service in the API server**

Modify `apps/api/src/server.ts` imports:

```ts
import { RssService } from "./rss-service.js";
```

Add a service variable:

```ts
let rssService: RssService;
```

Inside `applyRuntimeConfig`, after `preparation` is created:

```ts
rssService = new RssService({
  settings: persistence.rssSettings,
  subscriptions: persistence.rssSubscriptions,
  items: persistence.rssItems,
  duplicateChecks: browserChecks,
  jobRepository,
  dataRoot: config.paths.dataRoot,
  fetchImpl: options.fetchImpl ?? fetch,
  enqueuePreparation
});
```

Add to `routeContext`:

```ts
rssSettings: persistence.rssSettings,
rssSubscriptions: persistence.rssSubscriptions,
rssItems: persistence.rssItems,
getRssService: () => rssService,
```

Add lifecycle hooks:

```ts
app.addHook("onReady", async () => {
  await resumeInterruptedPreparation();
  if (autoPrepare) await rssService.startPolling();
});

app.addHook("onClose", async () => {
  await rssService.stopPolling();
  await persistence.disconnect();
});
```

Replace the existing separate `onReady` and `onClose` hooks with the combined versions so disconnect still happens exactly once.

Update the CORS method list in `apps/api/src/server.ts` so the RSS subscription delete route works from the Web UI:

```ts
methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
```

- [ ] **Step 3: Run RSS route and service tests**

Run:

```bash
npm test -- apps/api/src/rss-service.test.ts apps/api/src/server.rss.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit server wiring**

Run:

```bash
git add apps/api/src/rss-service.ts apps/api/src/server.ts apps/api/src/server.rss.test.ts
git commit -m "Wire RSS service into API"
```

---

### Task 6: Implement Accept Proposal End-To-End

**Files:**
- Modify: `apps/api/src/rss-service.test.ts`
- Modify: `apps/api/src/rss-service.ts`
- Modify: `apps/api/src/server.rss.test.ts`

- [ ] **Step 1: Add failing accept service test**

Append to `apps/api/src/rss-service.test.ts`:

```ts
it("downloads a torrent and creates a preparing job only when a proposal is accepted", async () => {
  const subscriptions = new MemoryRssSubscriptionRepository();
  const items = new MemoryRssItemRepository();
  const jobRepository = new JobRepository([]);
  const subscription = await subscriptions.create({ name: "ZMPT", site: "zmweb", feedUrl: "https://zmpt.cc/rss", enabled: true, filter: {} });
  const item = await items.upsertFromRefresh({
    subscriptionId: subscription.id,
    guid: "guid-1",
    sourceUrl: "https://zmpt.cc/details.php?id=1",
    downloadUrl: "https://zmpt.cc/download.php?downhash=secret",
    title: "Movie.2026.1080p.WEB-DL.x265-GROUP",
    subtitle: "中字",
    size: 123,
    publishedAt: null,
    status: "proposal",
    filterReason: null,
    checkResult: checkResult({ site: "zmweb", title: "Movie.2026.1080p.WEB-DL.x265-GROUP" }, "open"),
    ptpTarget: { groupId: "123", displayTitle: "Movie [2026]", year: "2026", imdbId: "tt1234567", ptpUrl: "https://passthepopcorn.me/torrents.php?id=123", resolvedFrom: "imdb" },
    raw: {}
  });
  const enqueuePreparation = vi.fn();
  const service = new RssService({
    settings: new MemoryRssSettingsRepository(),
    subscriptions,
    items,
    duplicateChecks: { check: vi.fn() },
    jobRepository,
    dataRoot: "/tmp/rss-service-accept-test",
    fetchImpl: vi.fn(async () => new Response("d4:infod6:lengthi1eee", { status: 200, headers: { "content-type": "application/x-bittorrent" } })),
    enqueuePreparation
  });

  const result = await service.acceptItem(item.id);

  expect(result.item.status).toBe("accepted");
  expect(result.item.acceptedJobId).toBe(result.job.id);
  expect(result.job.state).toBe("preparing");
  expect(result.job.source).toMatchObject({ site: "rss", url: "https://zmpt.cc/details.php?id=1", title: item.title, subtitle: "中字" });
  expect(result.job.source.ptpTarget).toMatchObject({ groupId: "123" });
  expect(enqueuePreparation).toHaveBeenCalledWith(result.job.id);
});
```

- [ ] **Step 2: Run failing accept test**

Run:

```bash
npm test -- apps/api/src/rss-service.test.ts -t "downloads a torrent"
```

Expected: FAIL if Task 3 accept implementation was incomplete.

- [ ] **Step 3: Complete accept implementation**

Ensure `acceptItem()` in `apps/api/src/rss-service.ts`:

- rejects non-`proposal` items with `rss_item_not_proposal`;
- rejects missing `downloadUrl`;
- checks `findAcceptedBySource`;
- calls `downloadTorrentFromUrl`;
- creates the job with `sourceSite: "rss"`;
- writes `paths.sourceTorrent`;
- attaches workspace and source fields;
- marks the RSS item accepted;
- calls `enqueuePreparation`.

Use the code from Task 3 Step 3 as the target implementation.

- [ ] **Step 4: Add route-level accept test**

Append to `apps/api/src/server.rss.test.ts`:

```ts
it("accepts a proposal and returns the created job", async () => {
  const config = testConfig();
  const rssXml = `<?xml version="1.0"?><rss><channel><item>
    <title><![CDATA[[电影 / Movies]Movie 2026 1080p WEB-DL x265-GROUP[中字][1 GB]]]></title>
    <link>https://zmpt.cc/details.php?id=1</link>
    <description><![CDATA[https://www.imdb.com/title/tt1234567/]]></description>
    <enclosure url="https://zmpt.cc/download.php?downhash=secret" length="1000" />
    <guid>guid-1</guid>
  </item></channel></rss>`;
  let servedTorrent = false;
  const fetchImpl = vi.fn(async (url: string | URL) => {
    const value = String(url);
    if (value.includes("download.php")) {
      servedTorrent = true;
      return new Response("d4:infod6:lengthi1eee", { status: 200, headers: { "content-type": "application/x-bittorrent" } });
    }
    return new Response(rssXml, { status: 200 });
  });
  vi.spyOn(PtpClient.prototype, "searchByCandidate").mockResolvedValue({
    movies: [{ GroupId: "123", Title: "Movie", Year: "2026", ImdbId: "tt1234567", Torrents: [] }]
  });

  await withConfiguredServer(config, { autoPrepare: false, fetchImpl }, async (app) => {
    const created = await app.inject({ method: "POST", url: "/api/rss/subscriptions", payload: { name: "ZMPT", site: "zmweb", feedUrl: "https://zmpt.cc/rss?passkey=secret", enabled: true, filter: {} } });
    const subscriptionId = created.json<{ subscription: { id: string } }>().subscription.id;
    await app.inject({ method: "POST", url: `/api/rss/subscriptions/${subscriptionId}/refresh` });
    const proposals = await app.inject({ method: "GET", url: `/api/rss/subscriptions/${subscriptionId}/items?view=proposals` });
    const itemId = proposals.json<{ items: Array<{ id: string }> }>().items[0]!.id;

    const accept = await app.inject({ method: "POST", url: `/api/rss/items/${itemId}/accept` });

    expect(accept.statusCode).toBe(200);
    expect(accept.json()).toMatchObject({ item: { status: "accepted" }, job: { state: "preparing" } });
    expect(servedTorrent).toBe(true);
  });
});
```

- [ ] **Step 5: Run accept tests**

Run:

```bash
npm test -- apps/api/src/rss-service.test.ts apps/api/src/server.rss.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit accept flow**

Run:

```bash
git add apps/api/src/rss-service.ts apps/api/src/rss-service.test.ts apps/api/src/server.rss.test.ts
git commit -m "Add RSS proposal accept flow"
```

---

### Task 7: Add Web RSS API Types And Client

**Files:**
- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/api.ts`

- [ ] **Step 1: Add RSS types**

Append to `apps/web/src/types.ts`:

```ts
export type RssItemStatus = "proposal" | "filtered" | "duplicate_full" | "duplicate_skip" | "check_error" | "ignored" | "accepted";

export interface RssFilterConfig {
  includeKeywords?: string[];
  excludeKeywords?: string[];
  allowedResolutions?: string[];
  allowedCodecs?: string[];
  allowedGroups?: string[];
  blockedGroups?: string[];
  minSize?: number | null;
  maxSize?: number | null;
}

export interface RssSettings {
  id: string;
  updateIntervalMs: number;
  updatedAt: string;
}

export interface RssSubscription {
  id: string;
  name: string;
  site: string;
  feedUrlDisplay: string;
  enabled: boolean;
  filter: RssFilterConfig;
  lastFetchedAt: string | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RssPtpTarget {
  groupId: string;
  displayTitle: string;
  year: string | null;
  imdbId: string | null;
  ptpUrl: string;
  resolvedFrom: "imdb" | "title_year";
}

export interface RssItem {
  id: string;
  subscriptionId: string;
  sourceUrlDisplay: string | null;
  title: string;
  subtitle: string | null;
  size: number | null;
  publishedAt: string | null;
  status: RssItemStatus;
  filterReason: string | null;
  checkResult: {
    decision?: {
      status: string;
      reason: string;
    };
  } | null;
  ptpTarget: RssPtpTarget | null;
  acceptedJobId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Add Web API client functions**

Modify imports in `apps/web/src/api.ts` to include RSS types:

```ts
RssFilterConfig,
RssItem,
RssSettings,
RssSubscription
```

Append functions:

```ts
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

export function createRssSubscription(input: { name: string; site: string; feedUrl: string; enabled: boolean; filter: RssFilterConfig }): Promise<{ subscription: RssSubscription }> {
  return fetchJson<{ subscription: RssSubscription }>("/api/rss/subscriptions", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateRssSubscription(id: string, input: Partial<{ name: string; site: string; feedUrl: string; enabled: boolean; filter: RssFilterConfig }>): Promise<{ subscription: RssSubscription }> {
  return fetchJson<{ subscription: RssSubscription }>(`/api/rss/subscriptions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function deleteRssSubscription(id: string): Promise<{ deleted: true }> {
  return fetchJson<{ deleted: true }>(`/api/rss/subscriptions/${id}`, { method: "DELETE" });
}

export function refreshRssSubscription(id: string): Promise<{ result: { fetched: number; proposals: number; filtered: number; duplicates: number; errors: number } }> {
  return fetchJson<{ result: { fetched: number; proposals: number; filtered: number; duplicates: number; errors: number } }>(`/api/rss/subscriptions/${id}/refresh`, {
    method: "POST",
    body: "{}"
  });
}

export function loadRssItems(subscriptionId: string, view: "proposals" | "all"): Promise<{ items: RssItem[] }> {
  return fetchJson<{ items: RssItem[] }>(`/api/rss/subscriptions/${subscriptionId}/items?view=${view}`);
}

export function acceptRssItem(id: string): Promise<{ item: RssItem; job: ApiJob }> {
  return fetchJson<{ item: RssItem; job: ApiJob }>(`/api/rss/items/${id}/accept`, { method: "POST", body: "{}" });
}

export function ignoreRssItem(id: string): Promise<{ item: RssItem }> {
  return fetchJson<{ item: RssItem }>(`/api/rss/items/${id}/ignore`, { method: "POST", body: "{}" });
}
```

- [ ] **Step 3: Run Web typecheck**

Run:

```bash
npm --workspace @popcorn-queue/web run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit Web API types**

Run:

```bash
git add apps/web/src/types.ts apps/web/src/api.ts
git commit -m "Add RSS web API client"
```

---

### Task 8: Build The RSS Web Page

**Files:**
- Create: `apps/web/src/components/RssPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/e2e/ui.spec.ts`

- [ ] **Step 1: Add mocked RSS API routes to the Playwright UI test**

In `apps/web/e2e/ui.spec.ts` `beforeEach`, add:

```ts
await page.route("**/api/rss/settings", async (route) => {
  if (route.request().method() === "PATCH") {
    await route.fulfill({ json: { settings: { id: "default", updateIntervalMs: 300000, updatedAt: "2026-05-31T00:00:00.000Z" } } });
    return;
  }
  await route.fulfill({ json: { settings: { id: "default", updateIntervalMs: 600000, updatedAt: "2026-05-31T00:00:00.000Z" } } });
});
await page.route("**/api/rss/subscriptions", async (route) => {
  if (route.request().method() === "POST") {
    await route.fulfill({ status: 201, json: { subscription: rssSubscriptions[0] } });
    return;
  }
  await route.fulfill({ json: { subscriptions: rssSubscriptions } });
});
await page.route("**/api/rss/subscriptions/rss-zmpt", async (route) => {
  await route.fulfill({ json: { subscription: { ...rssSubscriptions[0], filter: route.request().postDataJSON().filter } } });
});
await page.route("**/api/rss/subscriptions/rss-zmpt/items?view=proposals", async (route) => {
  await route.fulfill({ json: { items: rssItems.filter((item) => item.status === "proposal") } });
});
await page.route("**/api/rss/subscriptions/rss-zmpt/items?view=all", async (route) => {
  await route.fulfill({ json: { items: rssItems } });
});
await page.route("**/api/rss/subscriptions/rss-zmpt/refresh", async (route) => {
  await route.fulfill({ json: { result: { fetched: 3, proposals: 1, filtered: 1, duplicates: 1, errors: 0 } } });
});
await page.route("**/api/rss/items/rss-item-open/accept", async (route) => {
  await route.fulfill({ json: { item: { ...rssItems[0], status: "accepted", acceptedJobId: "job-rss" }, job: { ...apiJobs[0], id: "job-rss" } } });
});
await page.route("**/api/rss/items/rss-item-open/ignore", async (route) => {
  await route.fulfill({ json: { item: { ...rssItems[0], status: "ignored" } } });
});
```

Add fixtures near `apiJobs`:

```ts
const rssSubscriptions = [
  {
    id: "rss-zmpt",
    name: "ZMPT Movies",
    site: "zmweb",
    feedUrlDisplay: "https://zmpt.cc/torrentrss.php?passkey=%5Bredacted%5D",
    enabled: true,
    filter: { excludeKeywords: ["60Fps"], allowedResolutions: ["1080p", "2160p"] },
    lastFetchedAt: "2026-05-31T00:00:00.000Z",
    lastRunStatus: "ok",
    lastRunMessage: "Fetched 3 item(s).",
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z"
  }
];

const rssItems = [
  {
    id: "rss-item-open",
    subscriptionId: "rss-zmpt",
    sourceUrlDisplay: "https://zmpt.cc/details.php?id=1",
    title: "Movie.2026.1080p.WEB-DL.x265-GROUP",
    subtitle: "中字",
    size: 1000,
    publishedAt: "2026-05-31T00:00:00.000Z",
    status: "proposal",
    filterReason: null,
    checkResult: { decision: { status: "open", reason: "1080p encode slot is open." } },
    ptpTarget: { groupId: "123", displayTitle: "Movie [2026]", year: "2026", imdbId: "tt1234567", ptpUrl: "https://passthepopcorn.me/torrents.php?id=123", resolvedFrom: "imdb" },
    acceptedJobId: null,
    lastError: null,
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z"
  },
  {
    id: "rss-item-full",
    subscriptionId: "rss-zmpt",
    sourceUrlDisplay: "https://zmpt.cc/details.php?id=2",
    title: "Full.Movie.2026.1080p.WEB-DL.x264-GROUP",
    subtitle: null,
    size: 2000,
    publishedAt: null,
    status: "duplicate_full",
    filterReason: null,
    checkResult: { decision: { status: "full", reason: "1080p encode slot is full." } },
    ptpTarget: { groupId: "456", displayTitle: "Full Movie [2026]", year: "2026", imdbId: "tt7654321", ptpUrl: "https://passthepopcorn.me/torrents.php?id=456", resolvedFrom: "title_year" },
    acceptedJobId: null,
    lastError: null,
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z"
  },
  {
    id: "rss-item-filtered",
    subscriptionId: "rss-zmpt",
    sourceUrlDisplay: "https://zmpt.cc/details.php?id=3",
    title: "Bystander.2025.2160p.WEB-DL.60Fps.x265-GROUP",
    subtitle: null,
    size: 3000,
    publishedAt: null,
    status: "filtered",
    filterReason: "Title matched excluded keyword: 60Fps",
    checkResult: null,
    ptpTarget: null,
    acceptedJobId: null,
    lastError: null,
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z"
  }
];
```

- [ ] **Step 2: Add failing e2e test for RSS page**

Append to `apps/web/e2e/ui.spec.ts`:

```ts
test("manages RSS proposals and all items", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only RSS assertion.");
  await page.goto("/");

  await page.getByRole("link", { name: "RSS" }).click();

  await expect(page.getByRole("heading", { name: "RSS" })).toBeVisible();
  await expect(page.getByText("ZMPT Movies")).toBeVisible();
  await expect(page.getByText("Movie.2026.1080p.WEB-DL.x265-GROUP")).toBeVisible();
  await expect(page.getByRole("link", { name: "Source" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Movie [2026]" })).toBeVisible();
  await expect(page.getByText("open")).toBeVisible();
  await page.getByPlaceholder("Blocked groups").fill("HDSWEB");
  await page.getByRole("button", { name: "Save Filter" }).click();
  await expect(page.getByText("RSS filter saved.")).toBeVisible();

  await page.getByRole("button", { name: "All Items" }).click();
  await expect(page.getByText("Full.Movie.2026.1080p.WEB-DL.x264-GROUP")).toBeVisible();
  await expect(page.getByText("Bystander.2025.2160p.WEB-DL.60Fps.x265-GROUP")).toBeVisible();
  await expect(page.getByText("Title matched excluded keyword: 60Fps")).toBeVisible();

  await page.getByRole("button", { name: "Proposals" }).click();
  await page.getByRole("button", { name: "Refresh Now" }).click();
  await expect(page.getByText("Fetched 3 item(s), 1 proposal(s).")).toBeVisible();

  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText(/Accepted proposal/i)).toBeVisible();
});
```

- [ ] **Step 3: Run failing e2e test**

Run:

```bash
npm run test:e2e -- --project=chromium-desktop apps/web/e2e/ui.spec.ts -g "manages RSS"
```

Expected: FAIL because the RSS page and nav do not exist.

- [ ] **Step 4: Create RSS page component**

Create `apps/web/src/components/RssPage.tsx`:

```tsx
import { LoaderCircle, Plus, RefreshCcw, Save } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  acceptRssItem,
  createRssSubscription,
  ignoreRssItem,
  loadRssItems,
  loadRssSettings,
  loadRssSubscriptions,
  refreshRssSubscription,
  saveRssSettings,
  updateRssSubscription
} from "../api.js";
import type { RssFilterConfig, RssItem, RssSettings, RssSubscription } from "../types.js";

type RssView = "proposals" | "all";

function splitCsv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function joinCsv(values: string[] | undefined): string {
  return (values ?? []).join(", ");
}

function formatSize(value: number | null): string {
  if (!value) return "Unknown size";
  const gb = value / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = value / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
}

function duplicateBadge(item: RssItem): string {
  return item.checkResult?.decision?.status ?? (item.status === "filtered" ? "not checked" : item.status);
}

function reason(item: RssItem): string {
  return item.filterReason ?? item.checkResult?.decision?.reason ?? item.lastError ?? "";
}

export function RssPage({ onStatus }: { onStatus?: (status: { tone: "info" | "error" | "success"; text: string } | null) => void }) {
  const [settings, setSettings] = useState<RssSettings | null>(null);
  const [subscriptions, setSubscriptions] = useState<RssSubscription[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [items, setItems] = useState<RssItem[]>([]);
  const [view, setView] = useState<RssView>("proposals");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState("10");
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [excludeKeywords, setExcludeKeywords] = useState("60Fps");
  const [filterDraft, setFilterDraft] = useState({
    includeKeywords: "",
    excludeKeywords: "",
    allowedResolutions: "",
    allowedCodecs: "",
    allowedGroups: "",
    blockedGroups: "",
    minSize: "",
    maxSize: ""
  });

  const selected = useMemo(() => subscriptions.find((subscription) => subscription.id === selectedId) ?? subscriptions[0] ?? null, [selectedId, subscriptions]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsResponse, subscriptionsResponse] = await Promise.all([loadRssSettings(), loadRssSubscriptions()]);
      setSettings(settingsResponse.settings);
      setIntervalMinutes(String(Math.round(settingsResponse.settings.updateIntervalMs / 60_000)));
      setSubscriptions(subscriptionsResponse.subscriptions);
      setSelectedId((current) => current ?? subscriptionsResponse.subscriptions[0]?.id ?? null);
    } catch (error) {
      onStatus?.({ tone: "error", text: error instanceof Error ? error.message : "RSS failed to load" });
    } finally {
      setLoading(false);
    }
  }, [onStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selected) {
      setItems([]);
      return;
    }
    loadRssItems(selected.id, view)
      .then((response) => setItems(response.items))
      .catch((error) => onStatus?.({ tone: "error", text: error instanceof Error ? error.message : "RSS items failed to load" }));
  }, [onStatus, selected, view]);

  useEffect(() => {
    if (!selected) return;
    setFilterDraft({
      includeKeywords: joinCsv(selected.filter.includeKeywords),
      excludeKeywords: joinCsv(selected.filter.excludeKeywords),
      allowedResolutions: joinCsv(selected.filter.allowedResolutions),
      allowedCodecs: joinCsv(selected.filter.allowedCodecs),
      allowedGroups: joinCsv(selected.filter.allowedGroups),
      blockedGroups: joinCsv(selected.filter.blockedGroups),
      minSize: selected.filter.minSize ? String(selected.filter.minSize) : "",
      maxSize: selected.filter.maxSize ? String(selected.filter.maxSize) : ""
    });
  }, [selected]);

  const handleSaveInterval = async () => {
    if (!settings) return;
    setBusy(true);
    try {
      const response = await saveRssSettings(Number(intervalMinutes) * 60_000);
      setSettings(response.settings);
      onStatus?.({ tone: "success", text: "RSS interval saved." });
    } catch (error) {
      onStatus?.({ tone: "error", text: error instanceof Error ? error.message : "RSS interval save failed" });
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newName.trim() || !newUrl.trim()) return;
    setBusy(true);
    try {
      const filter: RssFilterConfig = { excludeKeywords: splitCsv(excludeKeywords) };
      const response = await createRssSubscription({ name: newName.trim(), site: "zmweb", feedUrl: newUrl.trim(), enabled: true, filter });
      setSubscriptions((current) => [response.subscription, ...current]);
      setSelectedId(response.subscription.id);
      setNewName("");
      setNewUrl("");
      onStatus?.({ tone: "success", text: "RSS subscription added." });
    } catch (error) {
      onStatus?.({ tone: "error", text: error instanceof Error ? error.message : "RSS subscription failed" });
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const response = await refreshRssSubscription(selected.id);
      const refreshed = await loadRssItems(selected.id, view);
      setItems(refreshed.items);
      onStatus?.({ tone: "success", text: `Fetched ${response.result.fetched} item(s), ${response.result.proposals} proposal(s).` });
    } catch (error) {
      onStatus?.({ tone: "error", text: error instanceof Error ? error.message : "RSS refresh failed" });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveFilter = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const filter: RssFilterConfig = {
        includeKeywords: splitCsv(filterDraft.includeKeywords),
        excludeKeywords: splitCsv(filterDraft.excludeKeywords),
        allowedResolutions: splitCsv(filterDraft.allowedResolutions),
        allowedCodecs: splitCsv(filterDraft.allowedCodecs),
        allowedGroups: splitCsv(filterDraft.allowedGroups),
        blockedGroups: splitCsv(filterDraft.blockedGroups),
        minSize: filterDraft.minSize ? Number(filterDraft.minSize) : null,
        maxSize: filterDraft.maxSize ? Number(filterDraft.maxSize) : null
      };
      const response = await updateRssSubscription(selected.id, { filter });
      setSubscriptions((current) => current.map((subscription) => (subscription.id === response.subscription.id ? response.subscription : subscription)));
      onStatus?.({ tone: "success", text: "RSS filter saved." });
    } catch (error) {
      onStatus?.({ tone: "error", text: error instanceof Error ? error.message : "RSS filter save failed" });
    } finally {
      setBusy(false);
    }
  };

  const handleAccept = async (item: RssItem) => {
    setBusy(true);
    try {
      const response = await acceptRssItem(item.id);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      onStatus?.({ tone: "success", text: `Accepted proposal: ${response.job.id}` });
    } catch (error) {
      onStatus?.({ tone: "error", text: error instanceof Error ? error.message : "Accept proposal failed" });
    } finally {
      setBusy(false);
    }
  };

  const handleIgnore = async (item: RssItem) => {
    setBusy(true);
    try {
      const response = await ignoreRssItem(item.id);
      setItems((current) => current.filter((entry) => entry.id !== response.item.id));
      onStatus?.({ tone: "success", text: "RSS proposal ignored." });
    } catch (error) {
      onStatus?.({ tone: "error", text: error instanceof Error ? error.message : "Ignore proposal failed" });
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <section className="rss-page">
        <div className="settings-loading"><LoaderCircle className="spin-icon" size={16} /> Loading RSS</div>
      </section>
    );
  }

  return (
    <section className="rss-page" aria-label="RSS">
      <aside className="rss-sidebar">
        <div className="rss-sidebar__header">
          <h2>RSS</h2>
          <button type="button" onClick={handleSaveInterval} disabled={busy}>
            {busy ? <LoaderCircle className="spin-icon" size={14} /> : <Save size={14} />}
            Save
          </button>
        </div>
        <label className="field">
          Update interval minutes
          <input value={intervalMinutes} inputMode="numeric" onChange={(event) => setIntervalMinutes(event.currentTarget.value)} />
        </label>
        <div className="rss-subscriptions">
          {subscriptions.map((subscription) => (
            <button type="button" key={subscription.id} className={selected?.id === subscription.id ? "active" : undefined} onClick={() => setSelectedId(subscription.id)}>
              <strong>{subscription.name}</strong>
              <span>{subscription.lastRunStatus ?? "Not checked"} · {subscription.feedUrlDisplay}</span>
            </button>
          ))}
        </div>
        <form className="rss-add" onSubmit={handleCreate}>
          <h3>Add Subscription</h3>
          <input value={newName} placeholder="Name" onChange={(event) => setNewName(event.currentTarget.value)} />
          <input value={newUrl} placeholder="RSS URL" onChange={(event) => setNewUrl(event.currentTarget.value)} />
          <input value={excludeKeywords} placeholder="Exclude keywords" onChange={(event) => setExcludeKeywords(event.currentTarget.value)} />
          <button type="submit" disabled={busy || !newName.trim() || !newUrl.trim()}>
            <Plus size={14} />
            Add
          </button>
        </form>
      </aside>

      <div className="rss-main">
        <div className="rss-header">
          <div>
            <h2>{selected?.name ?? "No subscription"}</h2>
            <span>{selected?.lastRunMessage ?? "Create or select a subscription"}</span>
          </div>
          <button type="button" onClick={handleRefresh} disabled={!selected || busy}>
            {busy ? <LoaderCircle className="spin-icon" size={15} /> : <RefreshCcw size={15} />}
            Refresh Now
          </button>
        </div>
        <div className="rss-tabs">
          <button type="button" className={view === "proposals" ? "active" : undefined} onClick={() => setView("proposals")}>Proposals</button>
          <button type="button" className={view === "all" ? "active" : undefined} onClick={() => setView("all")}>All Items</button>
        </div>
        {selected ? (
          <section className="rss-filter" aria-label="Subscription filter">
            <div className="rss-filter__header">
              <h3>Filter</h3>
              <button type="button" onClick={handleSaveFilter} disabled={busy}>Save Filter</button>
            </div>
            <div className="rss-filter__grid">
              <input value={filterDraft.includeKeywords} placeholder="Include keywords" onChange={(event) => setFilterDraft((current) => ({ ...current, includeKeywords: event.currentTarget.value }))} />
              <input value={filterDraft.excludeKeywords} placeholder="Exclude keywords" onChange={(event) => setFilterDraft((current) => ({ ...current, excludeKeywords: event.currentTarget.value }))} />
              <input value={filterDraft.allowedResolutions} placeholder="Allowed resolutions" onChange={(event) => setFilterDraft((current) => ({ ...current, allowedResolutions: event.currentTarget.value }))} />
              <input value={filterDraft.allowedCodecs} placeholder="Allowed codecs" onChange={(event) => setFilterDraft((current) => ({ ...current, allowedCodecs: event.currentTarget.value }))} />
              <input value={filterDraft.allowedGroups} placeholder="Allowed groups" onChange={(event) => setFilterDraft((current) => ({ ...current, allowedGroups: event.currentTarget.value }))} />
              <input value={filterDraft.blockedGroups} placeholder="Blocked groups" onChange={(event) => setFilterDraft((current) => ({ ...current, blockedGroups: event.currentTarget.value }))} />
              <input value={filterDraft.minSize} inputMode="numeric" placeholder="Min size bytes" onChange={(event) => setFilterDraft((current) => ({ ...current, minSize: event.currentTarget.value }))} />
              <input value={filterDraft.maxSize} inputMode="numeric" placeholder="Max size bytes" onChange={(event) => setFilterDraft((current) => ({ ...current, maxSize: event.currentTarget.value }))} />
            </div>
          </section>
        ) : null}
        <div className="rss-items">
          {items.map((item) => (
            <article className="rss-item" key={item.id}>
              <div className="rss-item__body">
                <h3>{item.title}</h3>
                <p>{formatSize(item.size)} {item.sourceUrlDisplay ? <>· <a href={item.sourceUrlDisplay} target="_blank" rel="noreferrer">Source</a></> : null}</p>
                {item.ptpTarget ? <p><strong>PTP target:</strong> <a href={item.ptpTarget.ptpUrl} target="_blank" rel="noreferrer">{item.ptpTarget.displayTitle}</a></p> : null}
                <div className="rss-badges">
                  <span className={`rss-badge ${duplicateBadge(item)}`}>{duplicateBadge(item)}</span>
                  <span>{item.status}</span>
                </div>
                {reason(item) ? <p className="rss-reason">{reason(item)}</p> : null}
              </div>
              {item.status === "proposal" ? (
                <div className="rss-item__actions">
                  <button type="button" onClick={() => void handleIgnore(item)} disabled={busy}>Ignore</button>
                  <button type="button" className="primary" onClick={() => void handleAccept(item)} disabled={busy}>Accept</button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Add RSS navigation**

Modify `apps/web/src/App.tsx`:

```ts
import { Activity, FilePlus2, LoaderCircle, LockKeyhole, LogOut, Pause, Play, RefreshCcw, Rss, Search, Settings as SettingsIcon, SlidersHorizontal, Trash2 } from "lucide-react";
import { RssPage } from "./components/RssPage.js";
type ActiveView = "jobs" | "new-job" | "diagnostics" | "settings" | "rss";
```

Add sidebar and mobile nav links using `<Rss size={16} />` and `setActiveView("rss")`.

Add render branch:

```tsx
) : activeView === "rss" ? (
  <RssPage onStatus={setStatus} />
) : activeView === "settings" ? (
```

- [ ] **Step 6: Add CSS**

Append to `apps/web/src/styles.css`:

```css
.rss-page {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 16px;
  min-height: calc(100vh - 88px);
}

.rss-sidebar,
.rss-main {
  min-width: 0;
}

.rss-sidebar__header,
.rss-header,
.rss-tabs,
.rss-item,
.rss-item__actions {
  display: flex;
  align-items: center;
}

.rss-sidebar__header,
.rss-header {
  justify-content: space-between;
  gap: 12px;
}

.rss-subscriptions {
  display: grid;
  gap: 8px;
  margin: 14px 0;
}

.rss-subscriptions button {
  text-align: left;
  justify-content: flex-start;
  display: grid;
  gap: 4px;
}

.rss-subscriptions button span,
.rss-header span,
.rss-item p,
.rss-reason {
  color: var(--muted);
  font-size: 12px;
}

.rss-add {
  display: grid;
  gap: 8px;
}

.rss-tabs {
  gap: 8px;
  margin: 16px 0;
}

.rss-filter {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  padding: 12px;
  margin-bottom: 12px;
}

.rss-filter__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.rss-filter__grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.rss-tabs .active,
.rss-subscriptions .active {
  background: var(--text);
  color: var(--surface);
}

.rss-items {
  display: grid;
  gap: 10px;
}

.rss-item {
  justify-content: space-between;
  gap: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  padding: 12px;
}

.rss-item__body {
  min-width: 0;
}

.rss-item h3 {
  margin: 0 0 6px;
  font-size: 15px;
  overflow-wrap: anywhere;
}

.rss-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.rss-badge,
.rss-badges span {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 12px;
}

.rss-badge.open,
.rss-badge.not_found,
.rss-badge.no_torrents {
  background: #d1e7dd;
  color: #0f5132;
}

.rss-badge.coexist,
.rss-badge.trumpable {
  background: #fff3cd;
  color: #664d03;
}

.rss-badge.full,
.rss-badge.skip,
.rss-badge.error {
  background: #f8d7da;
  color: #842029;
}

.rss-item__actions {
  gap: 8px;
}

@media (max-width: 900px) {
  .rss-page {
    grid-template-columns: 1fr;
  }

  .rss-filter__grid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 7: Run Web tests**

Run:

```bash
npm --workspace @popcorn-queue/web run typecheck
npm run test:e2e -- --project=chromium-desktop apps/web/e2e/ui.spec.ts -g "manages RSS"
```

Expected: PASS.

- [ ] **Step 8: Commit RSS Web UI**

Run:

```bash
git add apps/web/src/components/RssPage.tsx apps/web/src/App.tsx apps/web/src/styles.css apps/web/e2e/ui.spec.ts
git commit -m "Add RSS proposal page"
```

---

### Task 9: Final Verification And Documentation

**Files:**
- Modify: `docs/configuration.md`

- [ ] **Step 1: Document RSS configuration and behavior**

Add to `docs/configuration.md`:

```md
## RSS Subscriptions

RSS subscriptions are managed from the Web UI. Feed URLs can contain tracker
passkeys, so Popcorn Queue stores the full URL for polling but only displays
redacted URLs in the UI and logs. RSS refreshes only create proposal/history
items. Torrents are downloaded only after a user accepts a proposal.

The RSS page has one global update interval. Each subscription owns its own
filter rules for include/exclude keywords, allowed resolutions, codecs, release
groups, and size bounds.
```

- [ ] **Step 2: Run focused test suite**

Run:

```bash
npm test -- packages/core/src/rss.test.ts packages/core/src/log-redaction.test.ts apps/api/src/rss-repository.test.ts apps/api/src/rss-service.test.ts apps/api/src/server.rss.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run API and Web typechecks**

Run:

```bash
npm --workspace @popcorn-queue/api run typecheck
npm --workspace @popcorn-queue/web run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run full typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit docs**

Run:

```bash
git add docs/configuration.md
git commit -m "Document RSS subscriptions"
```

- [ ] **Step 6: Final status check**

Run:

```bash
git status --short
git log --oneline -8
```

Expected: clean worktree and visible RSS implementation commits.

---

## Self-Review Notes

- Spec coverage: parser, per-subscription filters, global interval, duplicate-check proposal mapping, All Items history, source/PTP links, accept-only download, ignore, redaction, API routes, UI, and tests are covered.
- Scope: This is one feature with backend and frontend slices. The plan keeps each slice separately testable and committable.
- Type consistency: RSS status names match the design spec; Web types mirror API repository records; accept flow uses existing job creation/preparation contracts.
