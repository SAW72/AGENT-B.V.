import { createHash } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { JSDOM } from "jsdom"
import puppeteer from "puppeteer-core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { readWalletRoute, taskHref } from "../src/routes.ts"
import { APP_CSP, IMMUTABLE_CACHE_CONTROL, LANDING_CSP_HEADER } from "./guard-pages-headers.mjs"
import { BUILD_COMMIT_META_NAME, readBuildCommitStamp } from "./build-stamp.mjs"
import {
  LAWYER_SIGNUP_DISCLAIMER,
  applyTestersPageConfig,
  loadTestersPageConfig,
  robotsMetaContent,
  robotsTxtBody,
  sitemapXmlBody,
} from "./testers-page-policy.mjs"

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const { implementation: LocationImpl } = require("jsdom/lib/jsdom/living/window/Location-impl.js")
const originalReplace = LocationImpl.prototype.replace
const wranglerBin = join(appRoot, "node_modules/wrangler/bin/wrangler.js")

let siteDir = ""
let stateDir = ""
let server
let base = ""

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: appRoot, env, stdio: ["ignore", "pipe", "pipe"] })
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

function pagesUnderLanding(segment) {
  const root = join(appRoot, "landing", segment)
  const pages = []
  const visit = (dir, urlPath) => {
    if (existsSync(join(dir, "index.html"))) pages.push(urlPath)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      visit(join(dir, entry.name), `${urlPath}${entry.name}/`)
    }
  }
  visit(root, `/${segment}/`)
  return pages
}

function expectAbsoluteHttps(value) {
  const url = new URL(value)
  expect(url.protocol).toBe("https:")
  expect(url.hostname).not.toBe("")
}

function chromePath() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  for (const candidate of [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/local/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error("Chrome is required for the CSP check. Set CHROME_PATH.")
}

function waitReady(proc) {
  return new Promise((resolve, reject) => {
    let log = ""
    const timer = setTimeout(() => reject(new Error(`wrangler did not become ready\n${log}`)), 90_000)
    const onData = (chunk) => {
      log += chunk.toString()
      const match = log.match(/Ready on (http:\/\/127\.0\.0\.1:(\d+))/)
      const port = match ? Number(match[2]) : 0
      if (port > 0) {
        clearTimeout(timer)
        resolve(match[1])
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
    headers: response.headers,
    type: response.headers.get("content-type") ?? "",
    body,
    text: body.toString("utf8"),
  }
}

/** Canonical points line. Independent of LAWYER_SIGNUP_DISCLAIMER. */
const CANONICAL_POINTS_DISCLAIMER =
  "Testnet only. Not a token. Can't be transferred, sold, or redeemed. May be adjusted or cancelled, and does not convert to anything."

/** Denial allowed in tester-signup.yml. Not an earn promise. */
const EARN_DENIAL = "not earned by depositing funds"

function withoutEarnDenial(text) {
  return text.split(EARN_DENIAL).join("")
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
    // The real production build, in its own out dir so a parallel npm run build cannot clobber it.
    // vite writes <out>/app, assemble-site.mjs copies landing/ into <out>.
    siteDir = mkdtempSync(join(tmpdir(), "wallet-ux-out-"))
    const buildEnv = { ...process.env, WALLET_UX_OUT_DIR: siteDir }
    // This temp dir is a local test build, not a deploy build. A parent shell may
    // set CF_PAGES, WALLET_UX_DEPLOY, or GITHUB_WORKFLOW_REF (Cloudflare Pages,
    // the manual production signal, or the stale deploy workflow). Those signals
    // refuse any WALLET_UX_OUT_DIR override. A WALLET_UX_DEPLOY=1 build also
    // refuses to stamp a dirty git tree. This test must not set that signal, so
    // the dirty-tree guard stays strict for production and this suite can run
    // in a dirty worktree without weakening it.
    delete buildEnv.CF_PAGES
    delete buildEnv.WALLET_UX_DEPLOY
    delete buildEnv.GITHUB_WORKFLOW_REF
    await run("npm", ["run", "build"], buildEnv)
    stateDir = mkdtempSync(join(tmpdir(), "wallet-ux-wrangler-"))
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
        "0",
        "--show-interactive-dev-session",
        "false",
        "--persist-to",
        stateDir,
      ],
      { cwd: appRoot, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    )
    base = await waitReady(server)
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
    if (siteDir) rmSync(siteDir, { recursive: true, force: true })
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
    const escrowId = `0x${"ab".repeat(32)}`
    const disputeId = `0x${"cd".repeat(32)}`
    const escrowForward = forwardedHref(root.text, `https://agent-bv.pages.dev/?escrow=${escrowId}#pay`)
    expect(escrowForward).toBe(`https://agent-bv.pages.dev/app/?escrow=${escrowId}#pay`)
    const escrowRoute = readWalletRoute(escrowForward)
    expect(escrowRoute.flow).toBeNull()
    expect(escrowRoute.escrow.value).toBe(escrowId)
    expect(taskHref("release", { escrow: escrowRoute.escrow.value })).toBe(`/app/release?escrow=${escrowId}`)
    expect(taskHref("refund", { escrow: escrowRoute.escrow.value })).toBe(`/app/refund?escrow=${escrowId}`)
    expect(taskHref("dispute", { escrow: escrowRoute.escrow.value })).toBe(`/app/dispute?escrow=${escrowId}`)
    expect(taskHref("fund", { escrow: escrowRoute.escrow.value })).toBe("/app/fund")
    expect(taskHref("vote", { escrow: escrowRoute.escrow.value })).toBe("/app/vote")
    const disputeForward = forwardedHref(root.text, `https://agent-bv.pages.dev/?dispute=${disputeId}`)
    expect(disputeForward).toBe(`https://agent-bv.pages.dev/app/?dispute=${disputeId}`)
    const disputeRoute = readWalletRoute(disputeForward)
    expect(disputeRoute.dispute.value).toBe(disputeId)
    expect(taskHref("vote", { dispute: disputeRoute.dispute.value })).toBe(`/app/vote?dispute=${disputeId}`)
    expect(taskHref("release", { escrow: disputeRoute.escrow.value })).toBe("/app/release")
    const ignored = readWalletRoute(forwardedHref(root.text, "https://agent-bv.pages.dev/?escrow=0xabc"))
    expect(ignored.escrow.value).toBeNull()
    expect(taskHref("release", { escrow: ignored.escrow.value })).toBe("/app/release")
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

  it("serves the tester page and omits it from the sitemap", async () => {
    const page = await get("/testers/")
    const root = await get("/")
    const config = loadTestersPageConfig()
    expect(page.status).toBe(200)
    expect(page.type).toContain("text/html")
    expect(page.text).not.toBe(root.text)
    expect(page.text).toContain("Break our escrow before the bots do.")
    expect(page.text).toContain("Mission Briefing")
    expect(page.text).toContain('href="/testers/mission.css"')
    expect(page.text).toContain('src="/assets/case-file.svg"')
    expect(page.text).toContain(LAWYER_SIGNUP_DISCLAIMER)
    expect(page.text).toContain('data-lawyer-signup-disclaimer="exact"')
    expect(page.text).toContain(CANONICAL_POINTS_DISCLAIMER)
    expect(LAWYER_SIGNUP_DISCLAIMER).not.toContain(CANONICAL_POINTS_DISCLAIMER)
    const pointsDisclaimer = new JSDOM(page.text).window.document.querySelector(
      '[data-points-disclaimer="canonical"]',
    )
    expect(pointsDisclaimer).not.toBeNull()
    expect(pointsDisclaimer.textContent).toBe(CANONICAL_POINTS_DISCLAIMER)
    expect(pointsDisclaimer.closest("[hidden], [aria-hidden='true']")).toBeNull()
    expect(withoutEarnDenial(page.text).toLowerCase()).not.toContain("earn")
    expect(page.text).toContain('id="signup"')
    expect(page.text).not.toContain("PENDING LAWYER REVIEW")
    expect(page.text).not.toContain("An airdrop may come later")
    expect(page.text).not.toContain("testnet activity does not earn tokens")
    expect(page.text).not.toContain("/airdrop-interest/")
    expect(page.text).not.toContain("airdrop-interest-terms")
    expect(page.text).not.toContain(["future", "recognition"].join(" "))
    expect(page.text).not.toContain(["could include a token", "distribution"].join(" "))
    expect(page.text).not.toContain("You may lose any funds you use")
    expect(page.text).not.toContain("Use a wallet that does not hold real funds.")
    expect(page.text).not.toContain("Use a wallet that holds no real funds.")
    expect(page.text.toLowerCase()).not.toContain("airdrop")
    expect(page.text).toContain('href="/legal/tester-terms/"')
    expect(page.text).toContain('href="/legal/tester-privacy/"')
    expect(page.text).toContain('href="/legal/tester-sanctions/"')
    expect(root.text).not.toContain("/legal/tester-terms/")
    expect(root.text).not.toContain("An airdrop may come later")
    expect(root.text).not.toContain("/airdrop-interest/")
    expect(existsSync(join(siteDir, "airdrop-interest"))).toBe(false)
    expect(existsSync(join(siteDir, "legal/airdrop-interest-terms"))).toBe(false)
    const interest = await get("/airdrop-interest/")
    const interestIndexed = await get("/airdrop-interest/index.html")
    const airdropTerms = await get("/legal/airdrop-interest-terms/")
    for (const response of [interest, interestIndexed, airdropTerms]) {
      expect(response.text).not.toContain("Airdrop interest")
      expect(response.text).not.toContain("Airdrop Interest Terms")
      expect(response.text).not.toContain("No airdrop is promised")
      expect(response.text).not.toContain(["amount", "TBD"].join(" "))
      expect(response.text).toBe(root.text)
    }
    for (const path of ["/legal/tester-terms/", "/legal/tester-privacy/", "/legal/tester-sanctions/"]) {
      const draft = await get(path)
      expect(draft.status).toBe(200)
      expect(draft.text).toContain("PENDING LAWYER REVIEW")
      expect(draft.text).toContain("DRAFT")
      expect(draft.text).not.toBe(root.text)
    }
    expect(page.text).toContain("We only use this to contact you about testing. Never share private keys or seed phrases.")
    expect(page.text).toContain("GitHub issues are public.")
    expect(page.text).toContain("https://github.com/SAW72/AGENT-B.V./issues/new?template=tester-signup.yml")
    expect(page.text).toContain("84532")
    expect(page.text).toContain('property="og:title"')
    expect(page.text).toContain('property="og:description"')
    expect(page.text).toContain('property="og:type" content="website"')
    expect(page.text).toContain('property="og:url" content="https://agent-bv.pages.dev/testers/"')
    expect(page.text).toContain('href="/app/fund"')
    expect(page.text).toContain('href="/app/dispute"')
    const missionCss = await get("/testers/mission.css")
    expect(missionCss.status).toBe(200)
    expect(missionCss.type).toContain("text/css")
    const caseFile = await get("/assets/case-file.svg")
    expect(caseFile.status).toBe(200)
    const indexed = await get("/testers/index.html")
    if (indexed.status === 200) {
      expect(indexed.text).toBe(page.text)
    } else {
      expect([301, 302, 307, 308]).toContain(indexed.status)
      expect(indexed.location).toMatch(/\/testers\/?$/)
    }
    const map = await get("/sitemap.xml")
    expect(map.status).toBe(200)
    expect(map.text).toContain("https://agent-bv.pages.dev/")
    expect(map.text).toContain("https://agent-bv.pages.dev/app/")
    expect(map.text).not.toContain("airdrop-interest")
    if (config.index) {
      expect(map.text).toContain("https://agent-bv.pages.dev/testers/")
      expect(page.text).toContain('content="index, follow"')
    } else {
      expect(map.text).not.toContain("https://agent-bv.pages.dev/testers/")
      expect(page.text).toContain('content="noindex, nofollow"')
    }
    const robots = await get("/robots.txt")
    expect(robots.status).toBe(200)
    expect(robots.text).toBe(robotsTxtBody(config))
    const terms = await get("/legal/tester-terms/")
    expect(terms.text).toContain("<h1>Tester Terms</h1>")
    expect(terms.text).toContain(EARN_DENIAL)
    expect(withoutEarnDenial(terms.text).toLowerCase()).not.toContain("earn")
    expect(terms.text).not.toContain("Tester and Airdrop Terms")
    expect(terms.text).not.toContain(["future", "recognition"].join(" "))
    expect(terms.text).not.toContain(["could include a token", "distribution"].join(" "))
    expect(terms.text).not.toContain("production smart contracts and real funds")
    expect(terms.text).toContain("Use only free testnet tokens. They have no value. Do not connect a wallet that holds real funds.")
    expect(terms.text).toContain("We may change, suspend or cancel this program, the points program or these terms at any time without notice or liability.")
    expect(terms.text).not.toContain("these terms or any recognition")
    const privacy = await get("/legal/tester-privacy/")
    expect(privacy.text).toContain("We keep tester data while the program runs and for 12 months after it ends or you leave, then delete or anonymize it, unless law requires longer. Anonymized bug reports (handle and wallet removed) may be kept indefinitely. Wallet and points records are kept as long as tax and sanctions record rules require.")
    expect(privacy.text).not.toContain("any related recognition")
    const sanctionsPage = await get("/legal/tester-sanctions/")
    expect(sanctionsPage.text).toContain("You may not participate in, sign up for, or receive anything from this program if you are: (a) located in")
    expect(sanctionsPage.text).toContain("We may screen wallet addresses and participants, block access by geography, and withhold or revoke points or anything else from anyone at our discretion to comply with law.")
    expect(sanctionsPage.text).not.toContain(["withhold or revoke", "recognition"].join(" "))
    expect(sanctionsPage.text).not.toContain("receive any recognition from")
  })

  it("defaults the testers config switch to indexed, and covers both index switch states", () => {
    const defaults = loadTestersPageConfig()
    expect(defaults.index).toBe(true)
    expect(defaults).not.toHaveProperty("airdropLine")
    expect(defaults).not.toHaveProperty("softAirdropLine")

    const noindex = { index: false }
    expect(robotsMetaContent(noindex)).toBe("noindex, nofollow")
    expect(robotsTxtBody(noindex)).toContain("Disallow: /testers/")
    expect(sitemapXmlBody(noindex)).not.toContain("https://agent-bv.pages.dev/testers/")

    const indexed = { index: true }
    expect(robotsMetaContent(indexed)).toBe("index, follow")
    expect(robotsTxtBody(indexed)).not.toContain("Disallow: /testers/")
    expect(sitemapXmlBody(indexed)).toContain("https://agent-bv.pages.dev/testers/")
    expect(LAWYER_SIGNUP_DISCLAIMER.toLowerCase()).not.toContain("airdrop")
    expect(LAWYER_SIGNUP_DISCLAIMER.toLowerCase()).not.toContain("free-year")
    expect(LAWYER_SIGNUP_DISCLAIMER.toLowerCase()).not.toContain("free service")
  })


  it("keeps airdrop out of the /testers page, signup template, tester-terms, and tester-privacy", () => {
    const template = readFileSync(join(appRoot, "../../.github/ISSUE_TEMPLATE/tester-signup.yml"), "utf8")
    const terms = readFileSync(join(appRoot, "landing/legal/tester-terms/index.html"), "utf8")
    const privacy = readFileSync(join(appRoot, "landing/legal/tester-privacy/index.html"), "utf8")
    const testers = readFileSync(join(appRoot, "landing/testers/index.html"), "utf8")
    for (const [label, body] of [
      ["/testers", testers],
      ["tester-signup.yml", template],
      ["tester-terms", terms],
      ["tester-privacy", privacy],
    ]) {
      expect(body.toLowerCase(), label).not.toContain("airdrop")
    }
    expect(template).not.toContain("PENDING LAWYER REVIEW")
    expect(template).toContain(EARN_DENIAL)
    expect(withoutEarnDenial(template).toLowerCase()).not.toContain("earn")
    expect(withoutEarnDenial(testers).toLowerCase()).not.toContain("earn")
    expect(testers).toContain(CANONICAL_POINTS_DISCLAIMER)
    expect(withoutEarnDenial(terms).toLowerCase()).not.toContain("earn")
    expect(template).toContain("payment, or other distribution")
    expect(template).toContain("at least 18")
    expect(template).toContain("owned 50% or more")
    expect(template).toContain("acting on behalf of")
    expect(terms).toContain("PENDING LAWYER REVIEW")
    expect(privacy).toContain("PENDING LAWYER REVIEW")
    expect(terms).toContain("are not tokens, securities or a promise of any token, payment, or other distribution")
    expect(privacy).toContain("Wallet and points records are kept as long as tax and sanctions record rules require.")
  })

  it("noindexes legal pages and applies the testers index switch to robots and sitemap", async () => {
    const config = loadTestersPageConfig()
    const legalPages = pagesUnderLanding("legal")
    expect(legalPages.length).toBeGreaterThan(0)
    const map = await get("/sitemap.xml")
    expect(map.status).toBe(200)
    const locs = [...map.text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => match[1])
    const home = await get("/")
    const homeDom = new JSDOM(home.text)
    const hrefs = [...homeDom.window.document.querySelectorAll("header nav a, footer a")].map(
      (anchor) => anchor.getAttribute("href") ?? "",
    )
    for (const path of legalPages) {
      const page = await get(path)
      expect(page.status).toBe(200)
      const robots = new JSDOM(page.text).window.document.querySelector('head meta[name="robots"]')
      expect(robots).not.toBeNull()
      expect(robots.getAttribute("content")).toBe("noindex, nofollow")
      expect(locs.some((loc) => loc.includes(path))).toBe(false)
      expect(hrefs.some((href) => href.includes(path))).toBe(false)
    }
    const testers = await get("/testers/")
    const testersRobots = new JSDOM(testers.text).window.document.querySelector('head meta[name="robots"]')
    expect(testersRobots).not.toBeNull()
    expect(testersRobots.getAttribute("content")).toBe(robotsMetaContent(config))
    expect(locs.includes("https://agent-bv.pages.dev/testers/")).toBe(config.index)
    expect(hrefs.some((href) => href.includes("/testers/"))).toBe(true)
    const robotsTxt = await get("/robots.txt")
    expect(robotsTxt.text).toBe(robotsTxtBody(config))
    expect(testers.text.toLowerCase()).not.toContain("airdrop")
    expect(typeof applyTestersPageConfig).toBe("function")
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

  it("stamps the app index with the build commit, and nothing else carries it", async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: appRoot, encoding: "utf8" }).trim()
    const app = await get("/app/")
    expect(readBuildCommitStamp(app.text)).toBe(head)
    expect(app.text.match(new RegExp(BUILD_COMMIT_META_NAME, "g"))).toHaveLength(1)
    const root = await get("/")
    expect(readBuildCommitStamp(root.text)).toBeNull()
    const script = app.text.match(/src="(\/app\/assets\/[^"]+\.js)"/)
    const css = app.text.match(/href="(\/app\/assets\/[^"]+\.css)"/)
    for (const asset of [script[1], css[1]]) {
      expect((await get(asset)).text, asset).not.toContain(head)
    }
  })

  it("serves the pinned CSP, frame, and cache headers", async () => {
    const root = await get("/")
    expect(root.headers.get("content-security-policy")).toBe(LANDING_CSP_HEADER)
    expect(root.headers.get("x-frame-options")).toBe("DENY")
    for (const path of ["/app/", "/app/identity", "/app/fund"]) {
      const page = await get(path)
      expect(page.status, path).toBe(200)
      expect(page.headers.get("content-security-policy"), path).toBe(APP_CSP)
      expect(page.headers.get("x-frame-options"), path).toBe("DENY")
      expect(page.headers.get("x-content-type-options"), path).toBe("nosniff")
      expect(page.headers.get("referrer-policy"), path).toBe("strict-origin-when-cross-origin")
    }
    const app = await get("/app/")
    for (const html of [root, app, await get("/app/identity"), await get("/legal/")]) {
      expect(html.headers.get("cache-control")).not.toMatch(/immutable|max-age=[1-9]/)
    }
    const hashed = [...app.text.matchAll(/(?:src|href)="(\/app\/assets\/[^"]+\.(?:js|css))"/g)].map((match) => match[1])
    expect(hashed).toHaveLength(2)
    for (const asset of hashed) {
      expect((await get(asset)).headers.get("cache-control"), asset).toBe(IMMUTABLE_CACHE_CONTROL)
    }
    const missing = await get("/app/assets/nope.js")
    expect(missing.status).toBe(404)
    expect(missing.headers.get("cache-control") ?? "").not.toMatch(/immutable/)
    expect((await get("/app/assets/404")).headers.get("cache-control") ?? "").not.toMatch(/immutable/)
    // Landing assets are not content-hashed, so they get no year-long cache.
    expect((await get("/styles.css")).headers.get("cache-control") ?? "").not.toMatch(/immutable/)
  })

  // Real Chrome against the served build. The RPC host is answered locally and every other
  // external host is refused, so this needs no network. A CSP that blocks something the app
  // does shows up as a securitypolicyviolation event.
  it("loads /, /app/ and /app/identity in Chrome with no CSP violation", async () => {
    const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] })
    try {
      const violations = async (path, probe = false) => {
        const page = await browser.newPage()
        const rpcMethods = []
        const refused = []
        await page.setRequestInterception(true)
        page.on("request", (request) => {
          const url = new URL(request.url())
          if (url.hostname === "127.0.0.1") return void request.continue()
          if (url.hostname === "sepolia.base.org") {
            const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }
            if (request.method() === "OPTIONS") return void request.respond({ status: 204, headers: cors })
            const body = JSON.parse(request.postData() ?? "{}")
            const answer = (call) => {
              rpcMethods.push(call.method)
              return { jsonrpc: "2.0", id: call.id, result: call.method === "eth_chainId" ? "0x14a34" : "0x" }
            }
            return void request.respond({
              status: 200,
              headers: cors,
              contentType: "application/json",
              body: JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)),
            })
          }
          refused.push(request.url())
          void request.abort()
        })
        await page.evaluateOnNewDocument(`window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI))`)
        await page.goto(`${base}${path}`, { waitUntil: "load", timeout: 30_000 })
        await new Promise((resolve) => setTimeout(resolve, 1500))
        const found = await page.evaluate(() => window.__csp.slice())
        let control
        if (probe) {
          control = await page.evaluate(async () => {
            let fetchBlocked = false
            try {
              await fetch("https://example.com/")
            } catch {
              fetchBlocked = true
            }
            window.__ran = false
            const script = document.createElement("script")
            script.textContent = "window.__ran = true"
            document.head.appendChild(script)
            return { fetchBlocked, inlineRan: window.__ran }
          })
        }
        await page.close()
        return { found, rpcMethods, refused, control }
      }

      const landing = await violations("/")
      expect(landing.found).toEqual([])
      const app = await violations("/app/", true)
      expect(app.found).toEqual([])
      // The app reached the RPC host allowed by connect-src.
      expect(app.rpcMethods).toContain("eth_chainId")
      // Enforcement is real: an unlisted host and an inline script are both blocked.
      expect(app.control).toEqual({ fetchBlocked: true, inlineRan: false })
      const identity = await violations("/app/identity")
      expect(identity.found).toEqual([])
      expect(identity.rpcMethods).toContain("eth_chainId")
      expect(landing.refused.concat(app.refused, identity.refused).filter((url) => !/example\.com/.test(url))).toEqual([])
    } finally {
      await browser.close()
    }
  }, 60_000)
})

