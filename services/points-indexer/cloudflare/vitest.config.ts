import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          BASE_SEPOLIA_RPC_URL: "http://rpc.test/base",
          POINTS_ENABLED: "true",
          POINTS_FAST_PACE: "1",
          POINTS_CORS_ORIGINS: "https://agent-bv.pages.dev",
        },
        ratelimits: {
          POINTS_GLOBAL_LIMITER: { namespace_id: "84532003", simple: { limit: 100000, period: 60 } },
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/disabled.test.ts", "test/budget.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
