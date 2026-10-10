import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, type Plugin } from "vitest/config"
import react from "@vitejs/plugin-react"
import { applyBrandHtml, brandManifestSource } from "./src/brand.ts"

const port = Number(process.env.PORT) || 5173
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

// Address book import is src/base-sepolia.json (inside this app).
// scripts/sync-book.mjs refreshes it from the repo root when that file is visible.

function walletBrand(): Plugin {
  const serveManifest: Plugin["configureServer"] = (server) => {
    server.middlewares.use((req, res, next) => {
      const path = req.url?.split("?")[0]
      if (path !== "/manifest.webmanifest") {
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

export default defineConfig({
  plugins: [react(), walletBrand()],
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
  },
})
