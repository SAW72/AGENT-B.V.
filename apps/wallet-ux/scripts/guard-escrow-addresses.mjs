import { register } from "node:module"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

// Cutover: this pin, the wallet book, the relayer book, and the superseded entries
// for both retired escrows change together at the redeploy.
export const LIVE_ESCROW = "0x3d660502D75f1e97b08c110255921b437A3C4C42"
export const RETIRED_ESCROW = "0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c"
export const RETIRED_ESCROW_ESC_M1 = "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d"
export const RETIRED_ESCROWS = [RETIRED_ESCROW, RETIRED_ESCROW_ESC_M1]
export const PHRASES = [
  "Submitting the refund request",
  "Submit the refund request through the relayer, or send it from your wallet.",
]

export class GuardError extends Error {
  constructor(message) {
    super(message)
    this.name = "GuardError"
  }
}

function fail(message) {
  throw new GuardError(message)
}

function countAddress(text, address) {
  const matches = text.match(new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"))
  return matches ? matches.length : 0
}

function countRetired(text) {
  return countAddress(text, RETIRED_ESCROW)
}

function walkJson(node, path, hits, address) {
  if (typeof node === "string") {
    const found = countAddress(node, address)
    if (found > 0) hits.push({ path, count: found })
    return
  }
  if (Array.isArray(node)) {
    node.forEach((value, index) => walkJson(value, `${path}[${index}]`, hits, address))
    return
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) walkJson(value, `${path}.${key}`, hits, address)
  }
}

function bookOccurrences(address = RETIRED_ESCROW) {
  const retiredLower = address.toLowerCase()
  const text = readFileSync(new URL("../src/book.ts", import.meta.url), "utf8")
  const block = text.match(/export const SUPERSEDED = \{[\s\S]*?\} as const/)
  if (!block || block.index === undefined) fail("src/book.ts has no SUPERSEDED blocked-address list.")
  const start = block.index
  const end = start + block[0].length
  let from = 0
  let inside = 0
  while (from < text.length) {
    const index = text.toLowerCase().indexOf(retiredLower, from)
    if (index < 0) break
    if (index < start || index >= end) {
      fail(`src/book.ts contains retired escrow ${address} outside the SUPERSEDED blocked-address list.`)
    }
    inside += 1
    from = index + retiredLower.length
  }
  if (inside < 1) fail(`SUPERSEDED does not contain the retired escrow literal ${address}.`)
  return inside
}

function jsonOccurrences(address = RETIRED_ESCROW) {
  const retiredLower = address.toLowerCase()
  const book = JSON.parse(readFileSync(new URL("../src/base-sepolia.json", import.meta.url), "utf8"))
  const hits = []
  walkJson(book, "$", hits, address)
  let count = 0
  for (const hit of hits) {
    const allowed =
      hit.path === "$.notes" || hit.path.startsWith("$.retired.") || hit.path.startsWith("$.superseded.")
    if (!allowed) {
      fail(
        `retired escrow ${address} appears at ${hit.path}. Allowed client book paths are SUPERSEDED, retired.*, superseded.*, and the top-level notes sentence.`,
      )
    }
    count += hit.count
  }
  const liveSlot = book.BotAttestationEscrow?.address
  if (typeof liveSlot === "string" && liveSlot.toLowerCase() === retiredLower) {
    fail(`base-sepolia.json BotAttestationEscrow.address is the retired escrow ${address}.`)
  }
  return { count, paths: hits.map((hit) => `${hit.path} (${hit.count})`) }
}

export function allowlistedRetiredCount(address = RETIRED_ESCROW) {
  return bookOccurrences(address) + jsonOccurrences(address).count
}

export function assertConfiguredEscrow(addresses, fallbackPin, superseded) {
  if (addresses.botAttestationEscrow !== LIVE_ESCROW) {
    fail(`ADDRESSES.botAttestationEscrow is not the live escrow ${LIVE_ESCROW}.`)
  }
  if (fallbackPin.botAttestationEscrow !== LIVE_ESCROW) {
    fail(`FALLBACK_PIN.botAttestationEscrow is not the live escrow ${LIVE_ESCROW}.`)
  }
  if (superseded.botAttestationEscrow !== RETIRED_ESCROW) {
    fail("SUPERSEDED.botAttestationEscrow is not the retired escrow.")
  }
  if (superseded.botAttestationEscrowEscM1 !== RETIRED_ESCROW_ESC_M1) {
    fail("SUPERSEDED.botAttestationEscrowEscM1 is not the retired ESC-M-1 escrow.")
  }
  for (const retired of RETIRED_ESCROWS) {
    const retiredLower = retired.toLowerCase()
    for (const [key, value] of Object.entries(addresses)) {
      if (typeof value === "string" && value.toLowerCase() === retiredLower) {
        fail(`ADDRESSES.${key} is the retired escrow ${retired}, which is blocked and is not a live slot.`)
      }
    }
  }
}

function javascriptFrom(target) {
  const info = statSync(target, { throwIfNoEntry: false })
  if (!info) fail(`bundle path ${target} does not exist.`)
  if (info.isFile()) return [readFileSync(target, "utf8")]
  const chunks = []
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const child = join(target, entry.name)
    if (entry.isDirectory()) chunks.push(...javascriptFrom(child))
    else if (entry.name.endsWith(".js")) chunks.push(readFileSync(child, "utf8"))
  }
  return chunks
}

export function assertBundle(target, expectedRetired, extraRetired = undefined) {
  const chunks = javascriptFrom(target)
  if (chunks.length === 0) fail(`${target} has no JavaScript bundle.`)
  const text = chunks.join("\n")
  if (!text.toLowerCase().includes(LIVE_ESCROW.toLowerCase())) {
    fail(`${target} does not contain the live escrow ${LIVE_ESCROW}.`)
  }
  for (const phrase of PHRASES) {
    if (!text.includes(phrase)) fail(`${target} does not contain ${JSON.stringify(phrase)}.`)
  }
  const found = countRetired(text)
  if (found !== expectedRetired) {
    fail(
      `${target} contains the retired escrow ${found} time(s); the allowlisted client sources contain it ${expectedRetired} time(s).`,
    )
  }
  if (extraRetired) {
    for (const [address, expected] of Object.entries(extraRetired)) {
      const extraFound = countAddress(text, address)
      if (extraFound !== expected) {
        fail(
          `${target} contains retired escrow ${address} ${extraFound} time(s); the allowlisted client sources contain it ${expected} time(s).`,
        )
      }
    }
  }
  console.log(
    `${target}: live escrow present, both claim-relayer phrases present, retired escrow count ${found} matches the allowlisted sources.`,
  )
}

function runCli(addresses, fallbackPin, superseded) {
  try {
    assertConfiguredEscrow(addresses, fallbackPin, superseded)
    const expected = {}
    for (const address of RETIRED_ESCROWS) {
      const bookCount = bookOccurrences(address)
      const json = jsonOccurrences(address)
      const total = bookCount + json.count
      if (total < 2) fail(`expected retired escrow ${address} in SUPERSEDED and in the retired book entry.`)
      expected[address] = total
      console.log(
        `Allowlisted sources for ${address}: src/book.ts SUPERSEDED (${bookCount}); ${json.paths.join(", ")}.`,
      )
    }
    console.log(
      `Configured escrow is ${LIVE_ESCROW}. Blocked list SUPERSEDED.botAttestationEscrow is ${RETIRED_ESCROW}. SUPERSEDED.botAttestationEscrowEscM1 is ${RETIRED_ESCROW_ESC_M1}.`,
    )
    console.log(
      "The top-level book notes sentence also names the retired escrows, so the bundle count is not blocked-list literals alone.",
    )
    const extra = { [RETIRED_ESCROW_ESC_M1]: expected[RETIRED_ESCROW_ESC_M1] }
    for (const target of process.argv.slice(2)) assertBundle(target, expected[RETIRED_ESCROW], extra)
  } catch (error) {
    if (error instanceof GuardError) {
      console.error(`Escrow address guard failed: ${error.message}`)
      process.exit(1)
    }
    throw error
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  register(new URL("./register-wallet-ux-ts.mjs", import.meta.url), pathToFileURL("./"))
  const { ADDRESSES, FALLBACK_PIN, SUPERSEDED } = await import("../src/addresses.ts")
  runCli(ADDRESSES, FALLBACK_PIN, SUPERSEDED)
}
