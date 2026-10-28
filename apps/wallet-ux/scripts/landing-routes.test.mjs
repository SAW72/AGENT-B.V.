import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it } from "vitest"

const require = createRequire(import.meta.url)
const { implementation: LocationImpl } = require("jsdom/lib/jsdom/living/window/Location-impl.js")
const originalReplace = LocationImpl.prototype.replace

const landingHtml = readFileSync(new URL("../landing/index.html", import.meta.url), "utf8")
const redirectsSource = readFileSync(new URL("../landing/_redirects", import.meta.url), "utf8")

const CSP_WITHOUT_SCRIPT = [
  "default-src 'none'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
]

function inlineScript(source) {
  const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  expect(scripts).toHaveLength(1)
  return scripts[0][1]
}

function contentSecurityPolicy(source) {
  const match = source.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)
  expect(match).not.toBeNull()
  return match[1]
}

function redirectRules(source) {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const parts = line.split(/\s+/)
      expect(parts).toHaveLength(3)
      return { from: parts[0], to: parts[1], status: parts[2] }
    })
}

describe("landing deep-link forwarder", () => {
  const script = inlineScript(landingHtml)

  afterEach(() => {
    LocationImpl.prototype.replace = originalReplace
  })

  it("recomputes the script sha256 and pins that exact hash in script-src", () => {
    expect(script).not.toContain("innerHTML")
    expect(script).toBe(
      'var p=new URLSearchParams(location.search);if(p.has("escrow")||p.has("dispute"))location.replace("/app/"+location.search+location.hash)',
    )
    const hash = createHash("sha256").update(script).digest("base64")
    const directives = contentSecurityPolicy(landingHtml).split(";").map((part) => part.trim())
    expect(directives[0]).toBe(CSP_WITHOUT_SCRIPT[0])
    expect(directives[1]).toBe(`script-src 'sha256-${hash}'`)
    expect(directives.slice(2)).toEqual(CSP_WITHOUT_SCRIPT.slice(1))
  })

  function open(url) {
    // jsdom runs the inline script, then refuses the navigation
    // ("Not implemented: navigation"). Finish location.replace the way the
    // browser would so the resulting href can be asserted.
    LocationImpl.prototype.replace = function (next) {
      const parsed = this._relevantDocument.encodingParseAURL(next)
      if (parsed === null) throw new Error(`Could not resolve ${next}`)
      this._relevantDocument._URL = parsed
    }
    const dom = new JSDOM(landingHtml, { url, runScripts: "dangerously" })
    return dom.window.location.href
  }

  it("sends an escrow link to /app/ and keeps the search and hash", () => {
    expect(open("https://agent-bv.pages.dev/?escrow=0xabc&other=1#panel")).toBe(
      "https://agent-bv.pages.dev/app/?escrow=0xabc&other=1#panel",
    )
  })

  it("sends a dispute link to /app/", () => {
    expect(open("https://agent-bv.pages.dev/?dispute=0xdef#ruling")).toBe(
      "https://agent-bv.pages.dev/app/?dispute=0xdef#ruling",
    )
  })

  it("stays on the landing page when neither escrow nor dispute is present", () => {
    expect(open("https://agent-bv.pages.dev/?foo=1#top")).toBe("https://agent-bv.pages.dev/?foo=1#top")
  })
})

describe("landing _redirects", () => {
  const rules = redirectRules(redirectsSource)

  it("keeps the old root paths, the 301 app moves, and the /app/ SPA fallback", () => {
    expect(rules).toEqual([
      { from: "/app", to: "/app/", status: "301" },
      { from: "/index.html", to: "/", status: "301" },
      { from: "/app/index.html", to: "/app/", status: "301" },
      { from: "/manifest.webmanifest", to: "/app/manifest.webmanifest", status: "301" },
      { from: "/icon-192.png", to: "/app/icon-192.png", status: "301" },
      { from: "/icon-512.png", to: "/app/icon-512.png", status: "301" },
      { from: "/points", to: "/app/", status: "301" },
      { from: "/claim", to: "/app/", status: "301" },
      { from: "/release", to: "/app/", status: "301" },
      { from: "/app/manifest.webmanifest", to: "/app/manifest.webmanifest", status: "200" },
      { from: "/app/icon-192.png", to: "/app/icon-192.png", status: "200" },
      { from: "/app/icon-512.png", to: "/app/icon-512.png", status: "200" },
      { from: "/app/assets/*", to: "/app/assets/:splat", status: "200" },
      { from: "/app/*", to: "/app/", status: "200" },
    ])
  })

  it("serves /app/ files before the /app/* rewrite", () => {
    const splatAt = rules.findIndex((rule) => rule.from === "/app/*")
    expect(rules[splatAt]).toEqual({ from: "/app/*", to: "/app/", status: "200" })
    expect(rules.slice(0, splatAt)).toEqual(
      expect.arrayContaining([
        { from: "/app/index.html", to: "/app/", status: "301" },
        { from: "/app/assets/*", to: "/app/assets/:splat", status: "200" },
        { from: "/points", to: "/app/", status: "301" },
        { from: "/claim", to: "/app/", status: "301" },
        { from: "/release", to: "/app/", status: "301" },
      ]),
    )
    expect(rules.some((rule) => rule.to.endsWith("/index.html"))).toBe(false)
    expect(rules.some((rule) => rule.from.startsWith("/assets"))).toBe(false)
  })
})
