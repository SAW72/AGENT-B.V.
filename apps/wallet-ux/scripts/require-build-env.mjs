import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Production builds inline these public values. A hand build that left
// VITE_CLAIM_RELAYER_URL unset compiled the in-app refund relayer to undefined.
// This list is the default. A non-empty environment value overrides it.
// An empty environment value does not fall through to the file: that is how an
// empty GitHub variable used to wipe the URL. The relayer value must be one
// exact allowlist entry. The build inlines that entry, not the raw string.
// An RPC host is allowlisted or must answer eth_chainId with 84532. Anything
// else fails closed. Secrets never belong in this list.
export const REQUIRED_BUILD_ENV_FILE = "build-env.required.json"
export const REQUIRED_BUILD_ENV_KEYS = ["VITE_CLAIM_RELAYER_URL", "VITE_BASE_SEPOLIA_RPC_URL"]
export const PINNED_RELAYER_HOST = "bot-verifier-claim-relayer.onrender.com"
export const PINNED_RELAYER_ORIGIN = "https://bot-verifier-claim-relayer.onrender.com"
export const ALLOWED_RELAYER_URLS = [
  PINNED_RELAYER_ORIGIN,
  `${PINNED_RELAYER_ORIGIN}/`,
  `${PINNED_RELAYER_ORIGIN}/v1/claims`,
]
export const RPC_HOST_ALLOWLIST = ["sepolia.base.org"]
export const REQUIRED_CHAIN_ID = 84532

const FORBIDDEN_TEXT = [
  "VITE_CLAIM_API_SECRET",
  "PRIVATE_KEY",
  "RELAYER_PRIVATE_KEY",
  "SPENCER_RUN_AUTH",
  "ADMIN_SECRET",
  "x-claim-secret",
  "LIVE_SUBMIT",
]

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

export class BuildEnvError extends Error {
  constructor(message, missing = []) {
    super(message)
    this.name = "BuildEnvError"
    this.missing = missing
  }
}

function emptyMessage(missing) {
  if (missing.length === 1) return `${missing[0]} is empty.`
  return `${missing.join(", ")} are empty.`
}

function assertPublicUrl(key, value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new BuildEnvError(`${key} is not a valid URL.`)
  }
  if (parsed.username || parsed.password) throw new BuildEnvError(`${key} must not include credentials.`)
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new BuildEnvError(`${key} must be an http or https URL.`)
  }
  return parsed
}

const RELAYER_URL_ERROR = `VITE_CLAIM_RELAYER_URL must be exactly ${ALLOWED_RELAYER_URLS.join(", ")}.`
// A 64-hex key, with an optional 0x prefix, bounded so a longer hex run does not match.
const HEX_KEY = /(?:^|[^0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/i
const QUERY_SECRET = /[?&](api[_-]?key|key|token|secret|auth)=/i
const PATH_KEY = /\/v2\/[A-Za-z0-9_-]{16,}|\/[A-Za-z0-9_-]{32,}(?=[/?#]|$)/

function hrefMatchesEntry(url, entry) {
  const href = new URL(entry).href
  // Node keeps a trailing empty "?" or "#" on href. :443, dot segments, %2e,
  // and backslashes are rewritten into href. The raw entry rejects all of those.
  return url.href === href || url.href === `${href}?` || url.href === `${href}#`
}

function canonicalRelayerUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new BuildEnvError("VITE_CLAIM_RELAYER_URL is not a valid URL.")
  }
  if (url.username || url.password) {
    throw new BuildEnvError("VITE_CLAIM_RELAYER_URL must not include credentials.")
  }
  const entry = ALLOWED_RELAYER_URLS.find(
    (candidate) => raw === candidate && hrefMatchesEntry(url, candidate) && url.hostname === PINNED_RELAYER_HOST,
  )
  if (entry === undefined) throw new BuildEnvError(RELAYER_URL_ERROR)
  return entry
}

function assertNoSecret(label, value) {
  if (HEX_KEY.test(value) || QUERY_SECRET.test(value) || PATH_KEY.test(value)) {
    throw new BuildEnvError(`${label} contains a secret.`)
  }
}

function isAllowlistedRpc(url) {
  return url.protocol === "https:" && url.port === "" && RPC_HOST_ALLOWLIST.includes(url.hostname)
}

function rpcLookupAllowed(url) {
  if (url.protocol !== "https:" || url.port !== "") return false
  const host = url.hostname
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false
  if (host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return false
  return host.includes(".")
}

export async function lookupChainId(rpcUrl) {
  let response
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new BuildEnvError("VITE_BASE_SEPOLIA_RPC_URL chainId check failed.")
  }
  if (!response.ok) throw new BuildEnvError("VITE_BASE_SEPOLIA_RPC_URL chainId check failed.")
  let body
  try {
    body = await response.json()
  } catch {
    throw new BuildEnvError("VITE_BASE_SEPOLIA_RPC_URL chainId check failed.")
  }
  const result = body?.result
  const chainId =
    typeof result === "number"
      ? result
      : typeof result === "string" && /^0x[0-9a-fA-F]+$/.test(result)
        ? Number.parseInt(result, 16)
        : Number.NaN
  if (!Number.isInteger(chainId)) throw new BuildEnvError("VITE_BASE_SEPOLIA_RPC_URL chainId check failed.")
  return chainId
}

async function assertRpc(url, raw, lookup) {
  if (isAllowlistedRpc(url)) return
  if (!rpcLookupAllowed(url)) throw new BuildEnvError("VITE_BASE_SEPOLIA_RPC_URL chainId check failed.")
  let chainId
  try {
    chainId = await lookup(raw)
  } catch (error) {
    if (error instanceof BuildEnvError) throw error
    throw new BuildEnvError("VITE_BASE_SEPOLIA_RPC_URL chainId check failed.")
  }
  if (chainId !== REQUIRED_CHAIN_ID) {
    throw new BuildEnvError(`VITE_BASE_SEPOLIA_RPC_URL chainId must be ${REQUIRED_CHAIN_ID}.`)
  }
}

export function readRequiredBuildEnvFile(root = appRoot) {
  const path = join(root, REQUIRED_BUILD_ENV_FILE)
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch {
    throw new BuildEnvError(`${REQUIRED_BUILD_ENV_FILE} is missing.`)
  }
  assertNoSecret(REQUIRED_BUILD_ENV_FILE, text)
  for (const forbidden of FORBIDDEN_TEXT) {
    if (text.includes(forbidden)) {
      throw new BuildEnvError(`${REQUIRED_BUILD_ENV_FILE} contains ${forbidden}.`)
    }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BuildEnvError(`${REQUIRED_BUILD_ENV_FILE} is not valid JSON.`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BuildEnvError(`${REQUIRED_BUILD_ENV_FILE} must be a JSON object.`)
  }
  for (const key of Object.keys(parsed)) {
    if (!REQUIRED_BUILD_ENV_KEYS.includes(key)) {
      throw new BuildEnvError(`${REQUIRED_BUILD_ENV_FILE} contains unexpected key ${key}.`)
    }
    if (typeof parsed[key] !== "string") {
      throw new BuildEnvError(`${REQUIRED_BUILD_ENV_FILE} ${key} must be a string.`)
    }
  }
  for (const key of REQUIRED_BUILD_ENV_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
      throw new BuildEnvError(`${REQUIRED_BUILD_ENV_FILE} is missing ${key}.`)
    }
  }
  return parsed
}

export async function resolveRequiredBuildEnv(env, fileValues, lookup = lookupChainId) {
  const missing = []
  const values = {}
  for (const key of REQUIRED_BUILD_ENV_KEYS) {
    const hasEnv = Object.prototype.hasOwnProperty.call(env, key) && env[key] !== undefined
    const raw = hasEnv ? env[key] : fileValues[key]
    const value = typeof raw === "string" ? raw.trim() : ""
    if (!value) {
      missing.push(key)
      continue
    }
    assertNoSecret(key, value)
    if (key === "VITE_CLAIM_RELAYER_URL") {
      values[key] = canonicalRelayerUrl(value)
      continue
    }
    const parsed = assertPublicUrl(key, value)
    if (key === "VITE_BASE_SEPOLIA_RPC_URL") await assertRpc(parsed, value, lookup)
    values[key] = value
  }
  if (missing.length > 0) throw new BuildEnvError(emptyMessage(missing), missing)
  return values
}

export async function applyRequiredBuildEnv(env = process.env, root = appRoot, lookup = lookupChainId) {
  const values = await resolveRequiredBuildEnv(env, readRequiredBuildEnvFile(root), lookup)
  for (const [key, value] of Object.entries(values)) env[key] = value
  return values
}

export function assertInlinedBuildEnv(env) {
  const missing = REQUIRED_BUILD_ENV_KEYS.filter((key) => !String(env?.[key] ?? "").trim())
  if (missing.length > 0) throw new BuildEnvError(emptyMessage(missing), missing)
}

export function requiredBuildEnvPlugin() {
  return {
    name: "wallet-ux-required-build-env",
    config(_config, { command }) {
      if (command !== "build") return
      return applyRequiredBuildEnv(process.env).then(() => undefined)
    },
    async configResolved(config) {
      if (config.command !== "build") return
      assertInlinedBuildEnv(config.env)
      await resolveRequiredBuildEnv(config.env, {
        VITE_CLAIM_RELAYER_URL: "",
        VITE_BASE_SEPOLIA_RPC_URL: "",
      })
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = await applyRequiredBuildEnv(process.env)
    for (const key of REQUIRED_BUILD_ENV_KEYS) console.log(`${key}=${values[key]}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
