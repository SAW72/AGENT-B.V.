/**
 * Reject non-ASCII dashes in the ClaimIntent domain name.
 * UTF-8 sequences: e28090 U+2010, e28091 U+2011, e28092 U+2012,
 * e28093 U+2013, e28094 U+2014, e28892 U+2212.
 * Whole claimIntent schema files are scanned. Other text is scanned on
 * domain-name lines. The wallet dist is scanned in a window around the
 * domain-name anchors, because the bundle also contains unrelated punctuation.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const DOMAIN_NAME = "Agent-BV Relayer"
export const DOMAIN_NAME_UTF8 = Buffer.from(DOMAIN_NAME, "utf8")

export const FORBIDDEN_DASHES = [
  { id: "e28090", name: "U+2010 HYPHEN", bytes: Buffer.from("e28090", "hex") },
  { id: "e28091", name: "U+2011 NON-BREAKING HYPHEN", bytes: Buffer.from("e28091", "hex") },
  { id: "e28092", name: "U+2012 FIGURE DASH", bytes: Buffer.from("e28092", "hex") },
  { id: "e28093", name: "U+2013 EN DASH", bytes: Buffer.from("e28093", "hex") },
  { id: "e28094", name: "U+2014 EM DASH", bytes: Buffer.from("e28094", "hex") },
  { id: "e28892", name: "U+2212 MINUS SIGN", bytes: Buffer.from("e28892", "hex") },
]

const DOMAIN_LINE = /domainName|DOMAIN_NAME|LEGACY_DOMAIN_NAME|domain name|Claim Relayer|BV Relayer/
const TEXT_EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".ts", ".tsx", ".json", ".md", ".html"])
const DIST_EXTENSIONS = new Set([".js", ".html", ".css"])
const WINDOW = 48
const ANCHORS = [
  Buffer.from("domainName"),
  Buffer.from("DOMAIN_NAME"),
  Buffer.from("LEGACY_DOMAIN_NAME"),
  Buffer.from("Claim Relayer"),
  Buffer.from("BV Relayer"),
]

const scriptDir = dirname(fileURLToPath(import.meta.url))
export const walletUxRoot = resolve(scriptDir, "..")
export const repoRoot = resolve(walletUxRoot, "../..")

export function findForbidden(buffer) {
  const hits = []
  for (const dash of FORBIDDEN_DASHES) {
    let from = 0
    while (from < buffer.length) {
      const at = buffer.indexOf(dash.bytes, from)
      if (at < 0) break
      hits.push({ at, id: dash.id, name: dash.name })
      from = at + dash.bytes.length
    }
  }
  return hits
}

function isClaimIntentFile(filePath) {
  const base = filePath.split(/[\\/]/).pop()
  return base === "claimIntent.json" || base === "claimIntent.mjs" || base === "claimIntent.ts" || base === "claimIntent.tsx"
}

function lineNumberAt(buffer, index) {
  let line = 1
  for (let i = 0; i < index && i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a) line += 1
  }
  return line
}

export function scanSourceBuffer(buffer, label) {
  const hits = []
  const whole = isClaimIntentFile(label)
  if (whole) {
    for (const hit of findForbidden(buffer)) {
      hits.push(`${label}:${lineNumberAt(buffer, hit.at)} contains ${hit.name} (${hit.id})`)
    }
    return hits
  }
  let offset = 0
  const text = buffer.toString("utf8")
  const lines = text.split("\n")
  for (const line of lines) {
    if (DOMAIN_LINE.test(line)) {
      const lineBuffer = buffer.subarray(offset, offset + Buffer.byteLength(line))
      for (const hit of findForbidden(lineBuffer)) {
        hits.push(`${label}:${lineNumberAt(buffer, offset + hit.at)} contains ${hit.name} (${hit.id}) on a domain-name line`)
      }
    }
    offset += Buffer.byteLength(line) + 1
  }
  return hits
}

function walk(directory, extensions, skip) {
  const files = []
  let entries = []
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (skip.has(entry.name)) continue
    const child = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(child, extensions, skip))
    else if (entry.isFile() && extensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) files.push(child)
  }
  return files
}

export function scanSources(root = repoRoot) {
  const hits = []
  const roots = [join(root, "claim-relayer"), join(root, "apps/wallet-ux/src"), join(root, "apps/wallet-ux/scripts")]
  for (const start of roots) {
    for (const file of walk(start, TEXT_EXTENSIONS, new Set(["node_modules", "dist", "data"]))) {
      const buffer = readFileSync(file)
      hits.push(...scanSourceBuffer(buffer, relative(root, file)))
    }
  }
  return hits
}

export function scanDistBuffer(buffer, label) {
  const hits = []
  if (isClaimIntentFile(label)) {
    for (const hit of findForbidden(buffer)) {
      hits.push(`${label}:${lineNumberAt(buffer, hit.at)} contains ${hit.name} (${hit.id})`)
    }
  }
  for (const anchor of ANCHORS) {
    let from = 0
    while (from < buffer.length) {
      const at = buffer.indexOf(anchor, from)
      if (at < 0) break
      const start = Math.max(0, at - WINDOW)
      const end = Math.min(buffer.length, at + anchor.length + WINDOW)
      for (const hit of findForbidden(buffer.subarray(start, end))) {
        hits.push(
          `${label}:${lineNumberAt(buffer, start + hit.at)} contains ${hit.name} (${hit.id}) within ${WINDOW} bytes of ${anchor.toString("utf8")}`,
        )
      }
      from = at + anchor.length
    }
  }
  return hits
}

export function scanDist(distDir) {
  const info = statSync(distDir, { throwIfNoEntry: false })
  if (!info) return [`${distDir} does not exist.`]
  const files = info.isDirectory() ? walk(distDir, DIST_EXTENSIONS, new Set()) : DIST_EXTENSIONS.has(distDir.slice(distDir.lastIndexOf("."))) ? [distDir] : []
  if (files.length === 0) return [`${distDir} has no JavaScript, HTML, or CSS to scan.`]
  const hits = []
  let embedded = false
  for (const file of files) {
    const buffer = readFileSync(file)
    if (buffer.includes(DOMAIN_NAME_UTF8)) embedded = true
    hits.push(...scanDistBuffer(buffer, file))
  }
  if (!embedded) hits.push(`${distDir} does not embed ${DOMAIN_NAME} (${DOMAIN_NAME_UTF8.toString("hex")}).`)
  return hits
}

export function report(hits) {
  if (hits.length === 0) {
    console.log("Domain dash scan passed")
    return 0
  }
  console.error("Domain dash scan failed:")
  for (const hit of hits) console.error(hit)
  return 1
}

function main() {
  const distDir = process.argv[2] ? resolve(process.argv[2]) : join(walletUxRoot, "dist")
  return report([...scanSources(repoRoot), ...scanDist(distDir)])
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exit(main())
}
