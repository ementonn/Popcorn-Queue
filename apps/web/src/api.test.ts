import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteRssSubscription } from "./api.js";

const originalFetch = globalThis.fetch;

describe("web API client", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends a JSON body for RSS DELETE requests", async () => {
    const requests: RequestInit[] = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return Response.json({ deleted: true });
    }) as typeof fetch;

    await deleteRssSubscription("subscription-id");

    expect(requests[0]).toMatchObject({
      method: "DELETE",
      body: "{}"
    });
  });
});
