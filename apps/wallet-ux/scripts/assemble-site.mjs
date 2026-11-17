// Copies landing/ (the static landing page) into dist/ so the site root is the
// landing page and the wallet app (built by vite into dist/app/) is at /app/.
// The same assets/404.html is also placed in dist/app/assets/. Pages has no
// 404 status in _redirects. A 404.html in those directories makes a missing
// asset 404. There is no top-level 404.html, so unknown pages still fall back.
import { cpSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { applyTestersPageConfig } from "./testers-page-policy.mjs"
import { assertReadyToClean, readSourceCommit, resolveWalletOutRoot } from "./out-dir.mjs"

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function fail(message) {
  console.error(message)
  console.error("wallet-ux output dir is not the expected directory. Refusing to continue.")
  process.exit(1)
}

// Print the source commit and the resolved out dir. Exit non-zero before any
// removal when that directory is not the expected one.
let commit
try {
  commit = readSourceCommit(app)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
console.log(`wallet-ux source commit: ${commit}`)

let dist
try {
  dist = resolveWalletOutRoot(process.env, app)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
console.log(`wallet-ux output dir: ${dist}`)
if (!existsSync(resolve(dist, "app/index.html"))) throw new Error("dist/app/index.html missing: run vite build first")

let cleanable
try {
  cleanable = assertReadyToClean(dist, app)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
if (cleanable !== dist) {
  fail(`wallet-ux output dir ${dist} is not the expected ${cleanable}.`)
}

for (const name of readdirSync(dist)) if (name !== "app") rmSync(resolve(dist, name), { recursive: true, force: true })
cpSync(resolve(app, "landing"), dist, { recursive: true })
const appAssets = resolve(dist, "app/assets")
mkdirSync(appAssets, { recursive: true })
cpSync(resolve(app, "landing/assets/404.html"), resolve(appAssets, "404.html"))
applyTestersPageConfig(dist)
console.log("assembled dist/: landing at /, wallet app at /app/")
