// Copies landing/ (the static landing page) into dist/ so the site root is the
// landing page and the wallet app (built by vite into dist/app/) is at /app/.
// The same assets/404.html is also placed in dist/app/assets/. Pages has no
// 404 status in _redirects. A 404.html in those directories makes a missing
// asset 404. There is no top-level 404.html, so unknown pages still fall back.
import { cpSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dist = resolve(app, "dist")
if (!existsSync(resolve(dist, "app/index.html"))) throw new Error("dist/app/index.html missing: run vite build first")
for (const name of readdirSync(dist)) if (name !== "app") rmSync(resolve(dist, name), { recursive: true, force: true })
cpSync(resolve(app, "landing"), dist, { recursive: true })
const appAssets = resolve(dist, "app/assets")
mkdirSync(appAssets, { recursive: true })
cpSync(resolve(app, "landing/assets/404.html"), resolve(appAssets, "404.html"))
console.log("assembled dist/: landing at /, wallet app at /app/")
