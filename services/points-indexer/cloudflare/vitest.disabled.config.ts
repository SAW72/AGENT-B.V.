import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          POINTS_FAST_PACE: "1",
          POINTS_CORS_ORIGINS: "https://agent-bv.pages.dev",
        },
      },
    }),
  ],
  test: {
    include: ["test/disabled.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
