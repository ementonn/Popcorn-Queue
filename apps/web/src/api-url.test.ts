import { describe, expect, it } from "vitest";
import { inferApiBaseFromLocation } from "./api.js";

describe("web API URL inference", () => {
  it("uses the browser host with the API port instead of build-time URL variables", () => {
    expect(inferApiBaseFromLocation(new URL("http://example.com:5173/jobs"))).toBe("http://example.com:3500");
    expect(inferApiBaseFromLocation(new URL("http://localhost:5173/"))).toBe("http://localhost:3500");
  });

  it("keeps the current protocol and accepts an explicit API port", () => {
    expect(inferApiBaseFromLocation(new URL("https://queue.example.test/"), "3510")).toBe("https://queue.example.test:3510");
  });
});
