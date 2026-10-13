// Copies landing/ (the static landing page) into dist/ so the site root is the
// landing page and the wallet app (built by vite into dist/app/) is at /app/.
import { cpSync, existsSync, rmSync, readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dist = resolve(app, "dist")
if (!existsSync(resolve(dist, "app/index.html"))) throw new Error("dist/app/index.html missing: run vite build first")
for (const name of readdirSync(dist)) if (name !== "app") rmSync(resolve(dist, name), { recursive: true, force: true })
cpSync(resolve(app, "landing"), dist, { recursive: true })
console.log("assembled dist/: landing at /, wallet app at /app/")
