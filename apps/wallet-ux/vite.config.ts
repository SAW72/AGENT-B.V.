import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, type Plugin } from "vitest/config"
import react from "@vitejs/plugin-react"
import { applyBrandHtml, brandManifestSource } from "./src/brand.ts"
import { requiredBuildEnvPlugin } from "./scripts/require-build-env.mjs"

const port = Number(process.env.PORT) || 5173
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

// Address book import is src/base-sepolia.json (inside this app).
// scripts/sync-book.mjs refreshes it from the repo root when that file is visible.

function walletBrand(): Plugin {
  const serveManifest: Plugin["configureServer"] = (server) => {
    server.middlewares.use((req, res, next) => {
      const path = req.url?.split("?")[0]
      if (path !== "/manifest.webmanifest" && path !== "/app/manifest.webmanifest") {
        next()
        return
      }
      res.setHeader("Content-Type", "application/manifest+json")
      res.end(brandManifestSource())
    })
  }
  return {
    name: "wallet-ux-brand",
    transformIndexHtml(html) {
      return applyBrandHtml(html)
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.webmanifest",
        source: brandManifestSource(),
      })
    },
    configureServer: serveManifest,
    configurePreviewServer: serveManifest,
  }
}

// The wallet app is served under /app/; the landing page owns the site root.
// scripts/assemble-site.mjs puts landing/ at dist/ and this build at dist/app/.
export default defineConfig({
  base: "/app/",
  build: { outDir: "dist/app", emptyOutDir: true },
  plugins: [requiredBuildEnvPlugin(), react(), walletBrand()],
  server: {
    host: "0.0.0.0",
    port,
    fs: { allow: [repoRoot] },
  },
  preview: {
    host: "0.0.0.0",
    port: Number(process.env.PORT) || 4173,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.mjs"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.{ts,tsx}", "scripts/**/*.{mjs,js,ts}"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.test.mjs",
        "**/*.d.ts",
        "**/dist/**",
      ],
    },
    // Cross-package tests load the relayer as real Node modules so claimIntent.json
    // stays next to import.meta.url. Vite must not bundle that package.
    server: {
      deps: {
        external: [/\/claim-relayer\/.*\.mjs$/],
      },
    },
  },
})
