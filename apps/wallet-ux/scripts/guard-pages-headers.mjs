import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Pinned Cloudflare Pages `_headers` for project agent-bv.
 * Live responses on both Pages hosts already send these two headers and no
 * Content-Security-Policy. The file must stay byte-for-byte the same so a
 * later upload does not change that policy.
 */
export const PAGES_HEADERS_FILE = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
`

export function pagesHeadersPath(root = join(dirname(fileURLToPath(import.meta.url)), "..")) {
  return join(root, "public", "_headers")
}

export function assertPagesHeaders(root) {
  const actual = readFileSync(pagesHeadersPath(root), "utf8")
  if (actual !== PAGES_HEADERS_FILE) {
    throw new Error("public/_headers content changed. Keep the pinned security headers.")
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
