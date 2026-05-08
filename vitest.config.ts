import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@popcorn-queue/core": `${root}packages/core/src/index.ts`,
      "@popcorn-queue/integrations": `${root}packages/integrations/src/index.ts`,
      "@popcorn-queue/worker": `${root}apps/worker/src/index.ts`
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"]
  }
});
