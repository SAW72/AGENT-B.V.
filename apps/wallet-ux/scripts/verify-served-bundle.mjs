import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

class VerifyExit extends Error {
  constructor(status = 1) {
    super("verify exit")
    this.status = status
  }
}

function fail(message) {
  console.error(message)
  throw new VerifyExit(1)
}

function errorLine(error) {
  const seen = new Set()
  function walk(err) {
    if (!err || seen.has(err)) return ""
    seen.add(err)
    if (typeof err === "string") return err.split("\n")[0]
    const code = typeof err.code === "string" ? err.code : ""
    const message = err instanceof Error ? err.message.split("\n")[0].trim() : ""
    if (message && message !== "fetch failed") {
      return code && !message.includes(code) ? `${code} ${message}` : message
    }
    if (Array.isArray(err.errors)) {
      for (const inner of err.errors) {
        const line = walk(inner)
        if (line) return line
      }
    }
    if (err.cause) {
      const line = walk(err.cause)
      if (line) return line
    }
    return code
  }
  return walk(error) || "network error"
}

function isJavaScriptContentType(header) {
  const media = String(header ?? "").split(";")[0].trim().toLowerCase()
  return media === "text/javascript" || media === "application/javascript" || media === "application/x-javascript"
}

function runGuard(args) {
  const result = spawnSync("node", args, { encoding: "utf8" })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) {
    fail(`Verify failed: could not run the bundle guard (${result.error.message}).`)
  }
  if (result.status !== 0) throw new VerifyExit(result.status ?? 1)
}

function referencedAssets(html) {
  return [...new Set([...html.matchAll(/(?:\/app)?\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g)].map((match) => match[0]))].sort()
}

async function fetchChecked(url) {
  try {
    return await fetch(url)
  } catch (error) {
    fail(`Verify failed: could not fetch ${url} (${errorLine(error)}).`)
  }
}

async function readBody(response, label) {
  try {
    return await response.text()
  } catch (error) {
    fail(`Verify failed: could not read ${label} (${errorLine(error)}).`)
  }
}

async function main() {
const deploymentUrl = (process.env.DEPLOYMENT_URL ?? "").trim()
if (!deploymentUrl) {
  fail("Verify failed: deployment URL is empty.")
}

const base = deploymentUrl.replace(/\/$/, "")
// APP_PATH is where the wallet app index lives ("/" by default, "/app/" for the
// landing-at-root layout). The landing page at "/" has no hashed bundle.
const appPath = (process.env.APP_PATH ?? "/").trim() || "/"
const indexResponse = await fetchChecked(`${base}${appPath}`)
if (!indexResponse.ok) {
  fail(`Verify failed: index responded ${indexResponse.status}.`)
}
const html = await readBody(indexResponse, `${base}${appPath}`)
const distIndexPath = process.env.DIST_INDEX ?? "dist/index.html"
let builtHtml = ""
try {
  builtHtml = readFileSync(distIndexPath, "utf8")
} catch {
  fail(`Verify failed: built index ${distIndexPath} is missing.`)
}
const expectedAssets = referencedAssets(builtHtml)
const servedAssets = referencedAssets(html)
if (expectedAssets.length === 0 || expectedAssets.join("\n") !== servedAssets.join("\n")) {
  fail(
    `Verify failed: served index.html does not reference the built asset hashes. Built: ${expectedAssets.join(", ") || "(none)"}. Served: ${servedAssets.join(", ") || "(none)"}.`,
  )
}
console.log(`Served index.html references the built asset hashes: ${servedAssets.join(", ")}.`)
const pending = servedAssets.filter((assetPath) => assetPath.endsWith(".js"))
if (pending.length === 0) {
  fail("Verify failed: deployed index HTML does not reference /assets/*.js.")
}

const directory = mkdtempSync(join(tmpdir(), "wallet-ux-served-"))
const bundlePath = join(directory, "served.js")
try {
  const seen = new Set()
  let javascript = ""
  while (pending.length > 0) {
    const assetPath = pending.pop()
    if (!assetPath || seen.has(assetPath)) continue
    seen.add(assetPath)
    console.log(`Fetching ${assetPath}`)
    const response = await fetchChecked(`${base}${assetPath}`)
    if (!response.ok) {
      fail(`Verify failed: could not download ${assetPath} (${response.status}).`)
    }
    const text = await readBody(response, assetPath)
    if (assetPath.endsWith(".js")) {
      const contentType = response.headers.get("content-type") ?? ""
      if (!isJavaScriptContentType(contentType)) {
        fail(`Verify failed: ${assetPath} content-type is not JavaScript (${contentType || "missing"}).`)
      }
      const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
      if (source.trim() === "") {
        fail(`Verify failed: ${assetPath} JavaScript is empty after stripping a UTF-8 BOM.`)
      }
      if (source.trimStart().startsWith("<")) {
        fail(`Verify failed: ${assetPath} body starts with '<' after leading whitespace.`)
      }
    }
    javascript += `${text}\n`
    for (const match of text.matchAll(/(?:\/app)?\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g)) {
      if (!seen.has(match[0])) pending.push(match[0])
    }
    for (const match of text.matchAll(/["'`]\.\/([A-Za-z0-9._-]+\.js)["'`]/g)) {
      const chunkPath = `${appPath === "/" ? "" : appPath.replace(/\/$/, "")}/assets/${match[1]}`
      if (!seen.has(chunkPath)) pending.push(chunkPath)
    }
  }
  writeFileSync(bundlePath, `${html}\n${javascript}`)

  runGuard([
    "--experimental-strip-types",
    "--disable-warning=ExperimentalWarning",
    "scripts/guard-escrow-addresses.mjs",
    bundlePath,
  ])
  runGuard(["scripts/guard-claim-secret.mjs", bundlePath])
} finally {
  rmSync(directory, { recursive: true, force: true })
}

console.log(`Served bundle at ${base} passed the escrow, phrase, and claim-secret checks.`)
}

try {
  await main()
} catch (error) {
  if (!(error instanceof VerifyExit)) {
    console.error(`Verify failed: ${errorLine(error)}.`)
  }
  process.exit(error instanceof VerifyExit ? error.status : 1)
}
