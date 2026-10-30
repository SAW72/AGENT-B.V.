import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(root, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            RELAYER_DATA_AUTH: "test-relayer-data-auth",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.mjs"],
    include: ["test/**/*.d1.test.mjs"],
    fileParallelism: false,
  },
});
