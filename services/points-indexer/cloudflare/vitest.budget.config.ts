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
          POINTS_CORS_ORIGINS: "https://agent-bv.pages.dev",
        },
        ratelimits: {
          POINTS_RATE_LIMITER: { namespace_id: "84532001", simple: { limit: 20, period: 60 } },
          POINTS_HEALTH_LIMITER: { namespace_id: "84532002", simple: { limit: 3, period: 60 } },
          POINTS_GLOBAL_LIMITER: { namespace_id: "84532003", simple: { limit: 4, period: 60 } },
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/geo-setup.ts"],
    include: ["test/budget.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
