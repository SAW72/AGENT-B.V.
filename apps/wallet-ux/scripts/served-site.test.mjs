import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { JSDOM } from "jsdom"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const { implementation: LocationImpl } = require("jsdom/lib/jsdom/living/window/Location-impl.js")
const originalReplace = LocationImpl.prototype.replace
const wranglerBin = join(appRoot, "node_modules/wrangler/bin/wrangler.js")

let siteDir = ""
let stateDir = ""
let server
let base = ""

function run(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: appRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] })
    let log = ""
    proc.stdout?.on("data", (chunk) => {
      log += chunk.toString()
    })
    proc.stderr?.on("data", (chunk) => {
      log += chunk.toString()
    })
    proc.once("error", reject)
    proc.once("exit", (code) => {
      if (code === 0) resolve(log)
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${log}`))
    })
  })
}

function sameBytes(left, right) {
  return readFileSync(left).equals(readFileSync(right))
}

function openAppHrefs(html) {
  const dom = new JSDOM(html)
  return [...dom.window.document.querySelectorAll("a")]
    .filter((anchor) => /open the app/i.test(anchor.textContent ?? ""))
    .map((anchor) => anchor.getAttribute("href"))
}

function metaContent(html, selector) {
  const dom = new JSDOM(html)
  const element = dom.window.document.querySelector(selector)
  expect(element).not.toBeNull()
  return element.getAttribute("content")
}

function expectAbsoluteHttps(value) {
  const url = new URL(value)
  expect(url.protocol).toBe("https:")
  expect(url.hostname).not.toBe("")
}

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
    // The real production build: vite writes dist/app, assemble-site.mjs copies landing/ into dist.
    await run("npm", ["run", "build"])
    siteDir = join(appRoot, "dist")
    stateDir = mkdtempSync(join(tmpdir(), "wallet-ux-wrangler-"))
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
        stateDir,
      ],
      { cwd: appRoot, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    )
    await waitReady(server)
  }, 180_000)

  afterAll(() => {
    LocationImpl.prototype.replace = originalReplace
    if (server?.pid) {
      try {
        process.kill(-server.pid, "SIGTERM")
      } catch {
        server.kill("SIGTERM")
      }
    }
    if (stateDir) rmSync(stateDir, { recursive: true, force: true })
  })

  it("copies landing files into dist", async () => {
    for (const name of ["index.html", "styles.css", "_redirects", "_headers", "site.webmanifest", "assets/og-image.png", "assets/404.html"]) {
      expect(sameBytes(join(siteDir, name), join(appRoot, "landing", name))).toBe(true)
    }
    expect(sameBytes(join(siteDir, "app/assets/404.html"), join(appRoot, "landing/assets/404.html"))).toBe(true)
    expect(statSync(join(siteDir, "app/index.html")).isFile()).toBe(true)
  })

  it("points open-app links at /app/", async () => {
    const root = await get("/")
    const hrefs = openAppHrefs(root.text)
    expect(hrefs.length).toBeGreaterThan(0)
    expect(hrefs.every((href) => href === "/app/")).toBe(true)
  })

  it("serves an app manifest whose start_url and scope are /app/", async () => {
    const manifest = await get("/app/manifest.webmanifest")
    const file = readFileSync(join(siteDir, "app/manifest.webmanifest"), "utf8")
    expect(manifest.status).toBe(200)
    expect(manifest.text).toBe(file)
    const parsed = JSON.parse(manifest.text)
    expect(parsed.start_url).toBe("/app/")
    expect(parsed.scope).toBe("/app/")
  })

  it("serves absolute Open Graph and Twitter image URLs", async () => {
    const root = await get("/")
    expectAbsoluteHttps(metaContent(root.text, 'meta[property="og:image"]'))
    expectAbsoluteHttps(metaContent(root.text, 'meta[name="twitter:image"]'))
  })

  it("serves the landing page at / and the app at /app/", async () => {
    const root = await get("/")
    const app = await get("/app/")
    const landingFile = readFileSync(join(siteDir, "index.html"), "utf8")
    const appFile = readFileSync(join(siteDir, "app/index.html"), "utf8")
    expect(root.status).toBe(200)
    expect(root.text).toBe(landingFile)
    expect(root.text).toContain('href="/styles.css"')
    expect(root.text).not.toContain('href="styles.css"')
    expect(app.status).toBe(200)
    expect(app.text).toBe(appFile)
    expect(app.text).toContain('src="/app/assets/')
    expect(app.text).not.toBe(root.text)
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
    const missing = await get("/app/assets/nope.js")
    const notFound = readFileSync(join(siteDir, "app/assets/404.html"))
    expect(missing.status).toBe(404)
    expect(missing.type).toContain("text/html")
    expect(missing.body.equals(notFound)).toBe(true)
    expect(missing.text).not.toBe(app.text)
  })

  it("styles nested landing fallbacks from root-relative assets", async () => {
    const nested = await get("/foo/bar")
    const root = await get("/")
    expect(nested.status).toBe(200)
    expect(nested.text).toBe(root.text)
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
    const missing = await get("/assets/nope.png")
    const notFound = readFileSync(join(siteDir, "assets/404.html"))
    expect(missing.status).toBe(404)
    expect(missing.type).toContain("text/html")
    expect(missing.body.equals(notFound)).toBe(true)
    expect(missing.text).not.toBe(root.text)
  })

  it("redirects /app/index.html to /app/ and does not redirect /app/ back", async () => {
    const redirected = await get("/app/index.html")
    expect(redirected.status).toBe(301)
    expect(redirected.location).toBe("/app/")
    const app = await get("/app/")
    expect(app.status).toBe(200)
    expect(app.location).toBeNull()
    const followed = await fetch(`${base}/app/index.html`)
    expect(followed.status).toBe(200)
    expect(new URL(followed.url).pathname).toBe("/app/")
    expect(await followed.text()).toBe(app.text)
    const withQuery = await get("/app/index.html?x=1")
    expect(withQuery.status).toBe(301)
    expect(withQuery.location).toBe("/app/?x=1")
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
