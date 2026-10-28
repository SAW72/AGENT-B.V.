import { spawnSync } from "node:child_process"
import { readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Retired claim-secret markers. The value is not read from the environment.
// x-claim-secret is matched in any case. Both markers are also matched in the
// encodings this scan already used for embedded secrets.
const NEEDLES = [
  { name: "x-claim-secret", caseInsensitive: true, variants: ["x-claim-secret", "X-CLAIM-SECRET", "X-Claim-Secret"] },
  { name: "VITE_CLAIM_API_SECRET", caseInsensitive: false, variants: ["VITE_CLAIM_API_SECRET"] },
]

const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error("Claim leak scan needs at least one file or directory.")
  process.exit(1)
}

// build-env.required.json is the checked-in public build list from #95.
// Every scan covers it, including a dist-only invocation.
const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
targets.push(join(appRoot, "build-env.required.json"))

function encodings(value) {
  const standard = Buffer.from(value, "utf8").toString("base64")
  const urlSafe = standard.replaceAll("+", "-").replaceAll("/", "_")
  const hex = Buffer.from(value, "utf8").toString("hex")
  const labeled = [
    ["raw", value],
    ["base64", standard],
    ["base64-without-padding", standard.replace(/=+$/, "")],
    ["base64url", urlSafe],
    ["base64url-without-padding", urlSafe.replace(/=+$/, "")],
    ["url", encodeURIComponent(value)],
    ["hex", hex],
    ["hex-uppercase", hex.toUpperCase()],
    ["json", JSON.stringify(value).slice(1, -1)],
  ]
  const seen = new Set()
  const unique = []
  for (const entry of labeled) {
    if (!entry[1] || seen.has(entry[1])) continue
    seen.add(entry[1])
    unique.push(entry)
  }
  return unique
}

function grepQuiet(value, target, recursive, ignoreCase) {
  const caseFlag = ignoreCase ? "-i " : ""
  const script = recursive
    ? `grep -R ${caseFlag}-q -F -- "$SCAN_VALUE" "$SCAN_PATH"`
    : `grep ${caseFlag}-q -F -- "$SCAN_VALUE" "$SCAN_PATH"`
  return spawnSync("bash", ["-c", script], {
    env: { ...process.env, SCAN_VALUE: value, SCAN_PATH: target },
    stdio: "ignore",
  })
}

function nonEmptyJavaScriptCount(directory) {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    console.error(`Claim leak scan failed: could not read ${directory}.`)
    process.exit(1)
  }
  let count = 0
  for (const entry of entries) {
    const child = join(directory, entry.name)
    if (entry.isDirectory()) count += nonEmptyJavaScriptCount(child)
    else if (entry.isFile() && entry.name.endsWith(".js") && statSync(child).size > 0) count += 1
  }
  return count
}

function formsFor(needle) {
  const seen = new Set()
  const forms = []
  for (const variant of needle.variants) {
    for (const [label, value] of encodings(variant)) {
      if (label === "raw") continue
      if (seen.has(value)) continue
      seen.add(value)
      forms.push([label, value])
    }
  }
  return forms
}

for (const target of targets) {
  const info = statSync(target, { throwIfNoEntry: false })
  if (!info) {
    console.error(`Claim leak scan failed: ${target} does not exist.`)
    process.exit(1)
  }
  const recursive = info.isDirectory()
  if (recursive && nonEmptyJavaScriptCount(target) === 0) {
    console.error(`Claim leak scan failed: no JavaScript scanned in ${target}.`)
    process.exit(1)
  }
  for (const needle of NEEDLES) {
    const raw = grepQuiet(needle.variants[0], target, recursive, needle.caseInsensitive)
    if (raw.status === 0) {
      console.error(`Claim leak scan failed: the raw form of ${needle.name} is present in ${target}.`)
      process.exit(1)
    }
    if (raw.status !== 1) {
      console.error(`Claim leak scan failed: grep could not scan ${target} for ${needle.name}.`)
      process.exit(1)
    }
    for (const [label, value] of formsFor(needle)) {
      const result = grepQuiet(value, target, recursive, false)
      if (result.status === 0) {
        console.error(`Claim leak scan failed: the ${label} form of ${needle.name} is present in ${target}.`)
        process.exit(1)
      }
      if (result.status !== 1) {
        console.error(`Claim leak scan failed: grep could not scan ${target} for the ${label} form of ${needle.name}.`)
        process.exit(1)
      }
    }
  }
}

console.log(`Claim leak scan passed for ${targets.length} path(s).`)
