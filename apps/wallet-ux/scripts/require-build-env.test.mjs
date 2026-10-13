import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  applyRequiredBuildEnv,
  readRequiredBuildEnvFile,
  REQUIRED_BUILD_ENV_FILE,
  requiredBuildEnvPlugin,
} from "./require-build-env.mjs"

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const RELAYER_URL = "https://bot-verifier-claim-relayer.onrender.com"
const RPC_URL = "https://sepolia.base.org"
const OTHER_RELAYER = "https://relayer.example.test"
const temps = []
const saved = {
  VITE_CLAIM_RELAYER_URL: process.env.VITE_CLAIM_RELAYER_URL,
  VITE_BASE_SEPOLIA_RPC_URL: process.env.VITE_BASE_SEPOLIA_RPC_URL,
}

afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function tempRoot(contents) {
  const directory = mkdtempSync(join(tmpdir(), "wallet-ux-build-env-"))
  temps.push(directory)
  writeFileSync(join(directory, REQUIRED_BUILD_ENV_FILE), contents)
  return directory
}

function runBuild(overrides) {
  const env = { ...process.env }
  delete env.VITE_CLAIM_RELAYER_URL
  delete env.VITE_BASE_SEPOLIA_RPC_URL
  delete env.VITE_CLAIM_API_SECRET
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return spawnSync("npm", ["run", "build"], {
    cwd: appRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
}

function outputOf(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
}

function distJavaScript() {
  const directory = join(appRoot, "dist")
  let text = ""
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (entry.name.endsWith(".js")) text += readFileSync(child, "utf8")
    }
  }
  walk(directory)
  return text
}

describe("required build env file", () => {
  it("checks in the public relayer URL and the public Base Sepolia RPC", () => {
    const text = readFileSync(join(appRoot, REQUIRED_BUILD_ENV_FILE), "utf8")
    expect(text).not.toContain("VITE_CLAIM_API_SECRET")
    expect(text).not.toContain("PRIVATE_KEY")
    expect(readRequiredBuildEnvFile()).toEqual({
      VITE_CLAIM_RELAYER_URL: RELAYER_URL,
      VITE_BASE_SEPOLIA_RPC_URL: RPC_URL,
    })
  })

  it("rejects a secret name in the list", () => {
    const root = tempRoot(`{\n  "VITE_CLAIM_API_SECRET": "nope",\n  "VITE_CLAIM_RELAYER_URL": "${RELAYER_URL}",\n  "VITE_BASE_SEPOLIA_RPC_URL": "${RPC_URL}"\n}\n`)
    expect(() => readRequiredBuildEnvFile(root)).toThrow(/build-env\.required\.json contains VITE_CLAIM_API_SECRET/)
  })

  it("rejects an unexpected key", () => {
    const root = tempRoot(
      JSON.stringify({
        VITE_CLAIM_RELAYER_URL: RELAYER_URL,
        VITE_BASE_SEPOLIA_RPC_URL: RPC_URL,
        VITE_OTHER: "https://example.test",
      }),
    )
    expect(() => readRequiredBuildEnvFile(root)).toThrow(/unexpected key VITE_OTHER/)
  })
})

describe("resolve required build env", () => {
  it("uses the checked-in URL when the variable is unset", () => {
    const values = applyRequiredBuildEnv({})
    expect(values.VITE_CLAIM_RELAYER_URL).toBe(RELAYER_URL)
    expect(values.VITE_BASE_SEPOLIA_RPC_URL).toBe(RPC_URL)
  })

  it("keeps a non-empty override", () => {
    const values = applyRequiredBuildEnv({
      VITE_CLAIM_RELAYER_URL: `${OTHER_RELAYER}/`,
      VITE_BASE_SEPOLIA_RPC_URL: RPC_URL,
    })
    expect(values.VITE_CLAIM_RELAYER_URL).toBe(`${OTHER_RELAYER}/`)
  })

  it("names VITE_CLAIM_RELAYER_URL when it is empty or whitespace", () => {
    expect(() => applyRequiredBuildEnv({ VITE_CLAIM_RELAYER_URL: "", VITE_BASE_SEPOLIA_RPC_URL: RPC_URL })).toThrow(
      /VITE_CLAIM_RELAYER_URL is empty/,
    )
    expect(() => applyRequiredBuildEnv({ VITE_CLAIM_RELAYER_URL: "  ", VITE_BASE_SEPOLIA_RPC_URL: RPC_URL })).toThrow(
      /VITE_CLAIM_RELAYER_URL is empty/,
    )
  })

  it("names every empty required variable", () => {
    expect(() => applyRequiredBuildEnv({ VITE_CLAIM_RELAYER_URL: "", VITE_BASE_SEPOLIA_RPC_URL: "" })).toThrow(
      /VITE_CLAIM_RELAYER_URL, VITE_BASE_SEPOLIA_RPC_URL are empty/,
    )
  })

  it("refuses a relayer URL with credentials", () => {
    expect(() =>
      applyRequiredBuildEnv({
        VITE_CLAIM_RELAYER_URL: "https://user:secret@bot-verifier-claim-relayer.onrender.com",
        VITE_BASE_SEPOLIA_RPC_URL: RPC_URL,
      }),
    ).toThrow(/VITE_CLAIM_RELAYER_URL must not include credentials/)
  })
})

describe("vite build env plugin", () => {
  it("does not read or set the relayer URL while serving", () => {
    delete process.env.VITE_CLAIM_RELAYER_URL
    requiredBuildEnvPlugin().config({}, { command: "serve" })
    expect(process.env.VITE_CLAIM_RELAYER_URL).toBeUndefined()
  })

  it("fills an unset relayer URL before Vite inlines env", () => {
    delete process.env.VITE_CLAIM_RELAYER_URL
    delete process.env.VITE_BASE_SEPOLIA_RPC_URL
    requiredBuildEnvPlugin().config({}, { command: "build" })
    expect(process.env.VITE_CLAIM_RELAYER_URL).toBe(RELAYER_URL)
    expect(process.env.VITE_BASE_SEPOLIA_RPC_URL).toBe(RPC_URL)
  })

  it("fails the build hook when the inlined relayer URL is empty", () => {
    expect(() =>
      requiredBuildEnvPlugin().configResolved({
        command: "build",
        env: { VITE_CLAIM_RELAYER_URL: "", VITE_BASE_SEPOLIA_RPC_URL: RPC_URL },
      }),
    ).toThrow(/VITE_CLAIM_RELAYER_URL is empty/)
  })
})

describe("npm run build", () => {
  it("fails when VITE_CLAIM_RELAYER_URL is empty and names that variable", () => {
    const result = runBuild({ VITE_CLAIM_RELAYER_URL: "" })
    const output = outputOf(result)
    expect(result.status).not.toBe(0)
    expect(output).toContain("VITE_CLAIM_RELAYER_URL is empty.")
    expect(output).not.toContain("assembled dist")
  }, 60_000)

  it("passes when VITE_CLAIM_RELAYER_URL is set and inlines that URL", () => {
    const result = runBuild({ VITE_CLAIM_RELAYER_URL: OTHER_RELAYER })
    expect(result.status, outputOf(result)).toBe(0)
    const javascript = distJavaScript()
    expect(javascript).toContain(OTHER_RELAYER)
    expect(javascript).not.toContain(RELAYER_URL)
    expect(javascript).not.toContain("VITE_CLAIM_API_SECRET")
  }, 180_000)

  it("passes when VITE_CLAIM_RELAYER_URL is unset and inlines the checked-in URL", () => {
    const result = runBuild({})
    expect(result.status, outputOf(result)).toBe(0)
    const javascript = distJavaScript()
    expect(javascript).toContain(RELAYER_URL)
    expect(javascript).toContain(RPC_URL)
    expect(javascript).not.toContain("VITE_CLAIM_API_SECRET")
  }, 180_000)
})
