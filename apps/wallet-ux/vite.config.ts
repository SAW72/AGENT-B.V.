import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, type Plugin } from "vitest/config"
import react from "@vitejs/plugin-react"
import { applyBrandHtml, brandManifestSource } from "./src/brand.ts"
import { requiredBuildEnvPlugin } from "./scripts/require-build-env.mjs"
import { assertWalletAppDir, resolveWalletOutRoot } from "./scripts/out-dir.mjs"

const port = Number(process.env.PORT) || 5173
const appRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(appRoot, "../..")

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
// scripts/assemble-site.mjs puts landing/ at the out root and this build at <out root>/app/.
// scripts/out-dir.mjs confines WALLET_UX_OUT_DIR. Unset stays <app>/dist, so a production
// build writes the same dist/app tree as before. An override is prepared here, at config
// load, before Vite writes. <root>/app must not be a symlink: emptyOutDir would follow it.
const walletOutRoot = resolveWalletOutRoot(process.env, appRoot)
assertWalletAppDir(walletOutRoot)

function walletOutDirLog(): Plugin {
  let logged = false
  return {
    name: "wallet-ux-out-dir",
    configResolved(config) {
      // vitest loads this config with command "serve". Log the real root once per vite build.
      if (config.command !== "build" || logged) return
      logged = true
      console.log(`wallet-ux output dir: ${walletOutRoot}`)
    },
  }
}

export default defineConfig({
  base: "/app/",
  build: { outDir: join(walletOutRoot, "app"), emptyOutDir: true },
  plugins: [walletOutDirLog(), requiredBuildEnvPlugin(), react(), walletBrand()],
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
