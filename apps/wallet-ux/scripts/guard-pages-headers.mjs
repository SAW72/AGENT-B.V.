import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Pinned Cloudflare Pages `_headers` for project agent-bv. The file must stay
 * byte-for-byte this text, so a header change is a reviewed change here too.
 *
 * Pages merges every matching rule, and joins repeated header names. So:
 * - `/*` carries only headers no other rule sets.
 * - Cache-Control is set only under /app/assets/*, which is content-hashed by
 *   Vite. HTML keeps the Pages default (max-age=0, must-revalidate).
 * - CSP is set under `/` and `/app/*`, one rule each, and nowhere else.
 */
export const APP_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
  "connect-src https://sepolia.base.org https://agent-bv-relayer-edge.s-a-wight72.workers.dev; " +
  "manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'"
export const LANDING_CSP_HEADER = "frame-ancestors 'none'"
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"

export const PAGES_HEADERS_FILE = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

# Landing page. Its <meta> CSP already limits scripts, styles and fonts and
# carries the inline-script hash. A meta CSP cannot send frame-ancestors, so this
# header adds only that. Both policies apply, and the stricter result wins.
/
  Content-Security-Policy: ${LANDING_CSP_HEADER}
  X-Frame-Options: DENY

# Wallet app, every route (/app/ and the SPA fallback, e.g. /app/identity).
# connect-src is the Base Sepolia RPC and the relayer edge Worker, nothing else.
# No unsafe-inline and no unsafe-eval: the built app has no inline script or
# style and never evaluates strings.
/app/*
  Content-Security-Policy: ${APP_CSP}
  X-Frame-Options: DENY

# Vite names these files by content hash, so a year-long immutable cache is safe.
# Cache-Control is set only here. HTML keeps the Pages default (max-age=0,
# must-revalidate), so no rule above or below matches HTML with it. Pages merges
# every matching rule, so do not add a Cache-Control to /* or /app/*.
/app/assets/*
  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}

# The shared not-found page is not content-hashed. Keep it out of the year cache.
/app/assets/404.html
  ! Cache-Control
/app/assets/404
  ! Cache-Control
`

// Parse a Pages _headers file into [{ pattern, set: [[name, value]], detach: [name] }].
export function parsePagesHeaders(text) {
  const rules = []
  let current = null
  for (const raw of text.split("\n")) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), set: [], detach: [] }
      rules.push(current)
      continue
    }
    if (!current) throw new Error("_headers header line before any path rule.")
    const line = raw.trim()
    if (line.startsWith("!")) {
      current.detach.push(line.slice(1).trim().toLowerCase())
      continue
    }
    const colon = line.indexOf(":")
    current.set.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()])
  }
  return rules
}

// Pages rules whose pattern matches a request path. `*` is a splat.
export function matchingRules(rules, path) {
  return rules.filter((rule) => {
    const source = rule.pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")
    return new RegExp(`^${source}$`).test(path)
  })
}

// "script-src 'self'; connect-src a b" -> { "script-src": ["'self'"], "connect-src": ["a", "b"] }
export function parseCsp(value) {
  const directives = {}
  for (const part of value.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (tokens.length > 0) directives[tokens[0]] = tokens.slice(1)
  }
  return directives
}

export function pagesHeadersPath(root = join(dirname(fileURLToPath(import.meta.url)), "..")) {
  return join(root, "landing", "_headers")
}

export function assertPagesHeaders(root) {
  const actual = readFileSync(pagesHeadersPath(root), "utf8")
  if (actual !== PAGES_HEADERS_FILE) {
    throw new Error("landing/_headers content changed. Keep the pinned security headers.")
  }
}

if (process.argv[1]?.endsWith("guard-pages-headers.mjs")) {
  try {
    assertPagesHeaders()
    console.log("Pages headers unchanged.")
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
