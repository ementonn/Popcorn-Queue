import type { FastifyInstance } from "fastify";
import type { RssFilterConfig, RssItemStatus, SourceSite } from "@popcorn-queue/core";
import type { ApiRouteContext } from "../api-context.js";
import type { RssItemRecord, RssSubscriptionRecord } from "../rss-repository.js";

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

function validateSubscription(input: SaveSubscriptionBody, partial = false): SaveSubscriptionBody {
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

function publicSubscription(subscription: RssSubscriptionRecord) {
  const { feedUrl: _feedUrl, ...safe } = subscription;
  return safe;
}

function publicItem(item: RssItemRecord) {
  const { downloadUrl: _downloadUrl, ...safe } = item;
  return safe;
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

  app.get("/api/rss/subscriptions", async () => ({
    subscriptions: (await context.rssSubscriptions.list()).map(publicSubscription)
  }));

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
      return reply.code(201).send({ subscription: publicSubscription(subscription) });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "rss_subscription_create_failed" });
    }
  });

  app.patch<{ Params: { id: string }; Body: SaveSubscriptionBody }>("/api/rss/subscriptions/:id", async (request, reply) => {
    try {
      const subscription = await context.rssSubscriptions.update(request.params.id, validateSubscription(request.body ?? {}, true));
      return subscription ? { subscription: publicSubscription(subscription) } : reply.code(404).send({ error: "rss_subscription_not_found" });
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

  app.get<{ Params: { id: string }; Querystring: { view?: "proposals" | "all"; status?: RssItemStatus } }>("/api/rss/subscriptions/:id/items", async (request) => {
    const options: { view?: "proposals" | "all"; status?: RssItemStatus } = {
      view: request.query.view === "proposals" ? "proposals" : "all",
      ...(request.query.status ? { status: request.query.status } : {})
    };
    const result = await context.rssItems.list(request.params.id, options);
    return { items: result.items.map(publicItem) };
  });

  app.post<{ Params: { id: string } }>("/api/rss/items/:id/accept", async (request, reply) => {
    try {
      const result = await context.getRssService().acceptItem(request.params.id);
      return { item: publicItem(result.item), job: result.job };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "rss_item_accept_failed" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/rss/items/:id/ignore", async (request, reply) => {
    try {
      return { item: publicItem(await context.getRssService().ignoreItem(request.params.id)) };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : "rss_item_not_found" });
    }
  });
}
