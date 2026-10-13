import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { JSDOM } from "jsdom"
import { build } from "vite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const { implementation: LocationImpl } = require("jsdom/lib/jsdom/living/window/Location-impl.js")
const originalReplace = LocationImpl.prototype.replace
const wranglerBin = join(appRoot, "node_modules/wrangler/bin/wrangler.js")

const LANDING_TITLE = "Agent-BV (Agent Bot Verifier): check the bot before you sign"
const APP_TITLE = "Agent-BV (Agent Bot Verifier) — Base Sepolia"

let siteDir = ""
let server
let base = ""

function waitReady(proc) {
  return new Promise((resolve, reject) => {
    let log = ""
    const timer = setTimeout(() => reject(new Error(`wrangler did not become ready\n${log}`)), 90_000)
    const onData = (chunk) => {
      log += chunk.toString()
      if (log.includes("Ready on")) {
        clearTimeout(timer)
        resolve()
      }
    }
    proc.stdout?.on("data", onData)
    proc.stderr?.on("data", onData)
    proc.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`wrangler exited ${code}\n${log}`))
    })
  })
}

async function get(path) {
  const response = await fetch(`${base}${path}`, { redirect: "manual" })
  const body = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    location: response.headers.get("location"),
    type: response.headers.get("content-type") ?? "",
    body,
    text: body.toString("utf8"),
  }
}

function inlineScript(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  expect(scripts).toHaveLength(1)
  return scripts[0][1]
}

function forwardedHref(html, url) {
  LocationImpl.prototype.replace = function (next) {
    const parsed = this._relevantDocument.encodingParseAURL(next)
    if (parsed === null) throw new Error(`Could not resolve ${next}`)
    this._relevantDocument._URL = parsed
  }
  const dom = new JSDOM(html, { url, runScripts: "dangerously" })
  return dom.window.location.href
}

describe("built site", () => {
  beforeAll(async () => {
    siteDir = mkdtempSync(join(tmpdir(), "wallet-ux-site-"))
    cpSync(join(appRoot, "landing"), siteDir, { recursive: true })
    await build({
      configFile: join(appRoot, "vite.config.ts"),
      root: appRoot,
      logLevel: "error",
      build: { outDir: join(siteDir, "app"), emptyOutDir: true },
    })
    const port = 18000 + Math.floor(Math.random() * 20000)
    base = `http://127.0.0.1:${port}`
    server = spawn(
      process.execPath,
      [
        wranglerBin,
        "pages",
        "dev",
        siteDir,
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--show-interactive-dev-session",
        "false",
        "--persist-to",
        join(siteDir, ".wrangler-state"),
      ],
      { cwd: appRoot, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    )
    await waitReady(server)
  }, 120_000)

  afterAll(() => {
    LocationImpl.prototype.replace = originalReplace
    if (server?.pid) {
      try {
        process.kill(-server.pid, "SIGTERM")
      } catch {
        server.kill("SIGTERM")
      }
    }
    if (siteDir) rmSync(siteDir, { recursive: true, force: true })
  })

  it("serves the landing page at / and the app at /app/", async () => {
    const root = await get("/")
    const app = await get("/app/")
    expect(root.status).toBe(200)
    expect(root.text).toContain(`<title>${LANDING_TITLE}</title>`)
    expect(root.text).toContain('href="/styles.css"')
    expect(root.text).not.toContain('href="styles.css"')
    expect(app.status).toBe(200)
    expect(app.text).toContain(`<title>${APP_TITLE}</title>`)
    expect(app.text).toContain('src="/app/assets/')
    expect(app.text).not.toContain(LANDING_TITLE)
  })

  it("redirects /points, /claim, and /release to /app/ and keeps the query string", async () => {
    const points = await get("/points")
    const claim = await get("/claim?escrow=0xabc")
    const release = await get("/release?dispute=0xdef&x=2")
    expect(points.status).toBe(301)
    expect(points.location).toBe("/app/")
    expect(claim.status).toBe(301)
    expect(claim.location).toBe("/app/?escrow=0xabc")
    expect(release.status).toBe(301)
    expect(release.location).toBe("/app/?dispute=0xdef&x=2")
  })

  it("forwards escrow and dispute links from the served landing page and keeps search and hash", async () => {
    const root = await get("/")
    expect(forwardedHref(root.text, "https://agent-bv.pages.dev/?escrow=0xabc&other=1#panel")).toBe(
      "https://agent-bv.pages.dev/app/?escrow=0xabc&other=1#panel",
    )
    expect(forwardedHref(root.text, "https://agent-bv.pages.dev/?dispute=0xdef#ruling")).toBe(
      "https://agent-bv.pages.dev/app/?dispute=0xdef#ruling",
    )
    expect(forwardedHref(root.text, "https://agent-bv.pages.dev/?foo=1#top")).toBe(
      "https://agent-bv.pages.dev/?foo=1#top",
    )
  })

  it("serves the app index for an unknown /app path and the real file for /app/assets", async () => {
    const app = await get("/app/")
    const nested = await get("/app/nope")
    const route = await get("/app/some/route")
    expect(nested.status).toBe(200)
    expect(nested.text).toBe(app.text)
    expect(route.status).toBe(200)
    expect(route.text).toBe(app.text)
    const script = app.text.match(/src="(\/app\/assets\/[^"]+\.js)"/)
    expect(script).not.toBeNull()
    const asset = await get(script[1])
    const file = readFileSync(join(siteDir, script[1].slice(1)))
    expect(asset.status).toBe(200)
    expect(asset.type).toContain("javascript")
    expect(asset.body.equals(file)).toBe(true)
    expect(asset.text.startsWith("<!doctype")).toBe(false)
  })

  it("styles nested landing fallbacks from root-relative assets", async () => {
    const nested = await get("/foo/bar")
    expect(nested.status).toBe(200)
    expect(nested.text).toContain(`<title>${LANDING_TITLE}</title>`)
    expect(nested.text).toContain('href="/styles.css"')
    expect(nested.text).toContain('src="/assets/mascot-sm.png"')
    const css = await get("/styles.css")
    const image = await get("/assets/mascot-sm.png")
    expect(css.status).toBe(200)
    expect(css.type).toContain("text/css")
    expect(css.body.equals(readFileSync(join(siteDir, "styles.css")))).toBe(true)
    expect(image.status).toBe(200)
    expect(image.type).toContain("image/png")
    expect(image.body.length).toBe(statSync(join(siteDir, "assets/mascot-sm.png")).size)
  })

  it("pins the served inline script hash in the CSP", async () => {
    const root = await get("/")
    const script = inlineScript(root.text)
    const hash = createHash("sha256").update(script).digest("base64")
    const policy = root.text.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)
    expect(policy).not.toBeNull()
    expect(policy[1]).toContain(`script-src 'sha256-${hash}'`)
    expect(policy[1]).toContain("default-src 'none'")
    expect(script).toContain('location.replace("/app/"+location.search+location.hash)')
  })
})
