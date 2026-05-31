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
    expect(item.downloadUrlDisplay).toBe("https://zmpt.cc/download.php?downhash=%5Bredacted%5D");
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

  it("stores RSS item sizes larger than 32-bit integers", async () => {
    await persistence.ensure();
    const subscription = await persistence.rssSubscriptions.create({
      name: "ZMPT Movies",
      site: "zmweb",
      feedUrl: "https://zmpt.cc/rss",
      enabled: true,
      filter: {}
    });

    const item = await persistence.rssItems.upsertFromRefresh({
      subscriptionId: subscription.id,
      guid: "large-size",
      sourceUrl: "https://zmpt.cc/details.php?id=2",
      downloadUrl: "https://zmpt.cc/download.php?downhash=large",
      title: "Large.Movie.2026.2160p.WEB-DL.x265-GROUP",
      subtitle: null,
      size: 9_788_381_427,
      publishedAt: null,
      status: "proposal",
      filterReason: null,
      checkResult: null,
      ptpTarget: null,
      raw: {}
    });

    expect(item.size).toBe(9_788_381_427);
    expect((await persistence.rssItems.list(subscription.id, {})).items[0]?.size).toBe(9_788_381_427);
  });

  it("migrates legacy RSS item size columns to BigInt", async () => {
    await persistence.prisma.$executeRawUnsafe(`
      CREATE TABLE "RssItem" (
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
    `);

    await persistence.ensure();
    const columns = await persistence.prisma.$queryRawUnsafe<Array<{ name: string; type: string }>>(`PRAGMA table_info("RssItem")`);

    expect(columns.find((column) => column.name === "size")?.type).toBe("BIGINT");
  });
});
