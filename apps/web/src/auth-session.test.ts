import { describe, expect, it } from "vitest";
import { authSessionAfterCheckFailure } from "./api.js";

describe("web auth session fallback", () => {
  it("keeps the app unauthenticated when the session check cannot reach the API", () => {
    expect(authSessionAfterCheckFailure()).toEqual({
      authRequired: true,
      authenticated: false,
      username: null
    });
  });
});
