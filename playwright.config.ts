import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "apps/web/e2e",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173",
    trace: "on-first-retry"
  },
  webServer: {
    command: "npm --workspace @popcorn-queue/web run dev -- --host 0.0.0.0 --port 5173",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 60_000
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 } }
    },
    {
      name: "chromium-mobile",
      use: { ...devices["Pixel 7"], viewport: { width: 412, height: 915 } }
    }
  ]
});
