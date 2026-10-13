import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Production builds inline these public values. A hand build that left
// VITE_CLAIM_RELAYER_URL unset compiled the in-app refund relayer to undefined.
// This list is the default. A non-empty environment value overrides it.
// An empty environment value does not fall through to the file: that is how an
// empty GitHub variable used to wipe the URL. Secrets never belong in this list.
export const REQUIRED_BUILD_ENV_FILE = "build-env.required.json"
export const REQUIRED_BUILD_ENV_KEYS = ["VITE_CLAIM_RELAYER_URL", "VITE_BASE_SEPOLIA_RPC_URL"]

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
  const httpsOnly = key === "VITE_CLAIM_RELAYER_URL"
  const allowed = httpsOnly ? ["https:"] : ["https:", "http:"]
  if (!allowed.includes(parsed.protocol)) {
    throw new BuildEnvError(`${key} must be an ${httpsOnly ? "https" : "http or https"} URL.`)
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

export function resolveRequiredBuildEnv(env, fileValues) {
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
    assertPublicUrl(key, value)
    values[key] = value
  }
  if (missing.length > 0) throw new BuildEnvError(emptyMessage(missing), missing)
  return values
}

export function applyRequiredBuildEnv(env = process.env, root = appRoot) {
  const values = resolveRequiredBuildEnv(env, readRequiredBuildEnvFile(root))
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
      applyRequiredBuildEnv(process.env)
    },
    configResolved(config) {
      if (config.command !== "build") return
      assertInlinedBuildEnv(config.env)
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = applyRequiredBuildEnv(process.env)
    for (const key of REQUIRED_BUILD_ENV_KEYS) console.log(`${key}=${values[key]}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
