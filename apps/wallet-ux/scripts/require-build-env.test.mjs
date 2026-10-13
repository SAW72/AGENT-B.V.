import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  applyRequiredBuildEnv,
  lookupChainId,
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
  it("uses the checked-in URL when the variable is unset", async () => {
    const lookup = () => {
      throw new Error("allowlisted RPC must not be looked up")
    }
    const values = await applyRequiredBuildEnv({}, undefined, lookup)
    expect(values.VITE_CLAIM_RELAYER_URL).toBe(RELAYER_URL)
    expect(values.VITE_BASE_SEPOLIA_RPC_URL).toBe(RPC_URL)
  })

  it("keeps a non-empty override on the pinned relayer host", async () => {
    const values = await applyRequiredBuildEnv({
      VITE_CLAIM_RELAYER_URL: `${RELAYER_URL}/`,
      VITE_BASE_SEPOLIA_RPC_URL: RPC_URL,
    })
    expect(values.VITE_CLAIM_RELAYER_URL).toBe(`${RELAYER_URL}/`)
  })

  it("fails closed when the relayer host is not pinned", async () => {
    await expect(
      applyRequiredBuildEnv({
        VITE_CLAIM_RELAYER_URL: OTHER_RELAYER,
        VITE_BASE_SEPOLIA_RPC_URL: RPC_URL,
      }),
    ).rejects.toThrow("VITE_CLAIM_RELAYER_URL host must be bot-verifier-claim-relayer.onrender.com.")
  })

  it("accepts an allowlisted RPC host without a chainId lookup", async () => {
    let lookedUp = false
    const values = await applyRequiredBuildEnv(
      { VITE_CLAIM_RELAYER_URL: RELAYER_URL, VITE_BASE_SEPOLIA_RPC_URL: RPC_URL },
      undefined,
      () => {
        lookedUp = true
        return 1
      },
    )
    expect(lookedUp).toBe(false)
    expect(values.VITE_BASE_SEPOLIA_RPC_URL).toBe(RPC_URL)
  })

  it("accepts another public RPC host when chainId is 84532", async () => {
    const values = await applyRequiredBuildEnv(
      { VITE_CLAIM_RELAYER_URL: RELAYER_URL, VITE_BASE_SEPOLIA_RPC_URL: "https://rpc.example.test" },
      undefined,
      async () => 84532,
    )
    expect(values.VITE_BASE_SEPOLIA_RPC_URL).toBe("https://rpc.example.test")
  })

  it("fails closed when a non-allowlisted RPC host is not chainId 84532", async () => {
    await expect(
      applyRequiredBuildEnv(
        { VITE_CLAIM_RELAYER_URL: RELAYER_URL, VITE_BASE_SEPOLIA_RPC_URL: "https://rpc.example.test" },
        undefined,
        async () => 8453,
      ),
    ).rejects.toThrow("VITE_BASE_SEPOLIA_RPC_URL chainId must be 84532.")
    await expect(
      applyRequiredBuildEnv(
        { VITE_CLAIM_RELAYER_URL: RELAYER_URL, VITE_BASE_SEPOLIA_RPC_URL: "https://rpc.example.test" },
        undefined,
        async () => {
          throw new Error("down")
        },
      ),
    ).rejects.toThrow("VITE_BASE_SEPOLIA_RPC_URL chainId check failed.")
    await expect(
      applyRequiredBuildEnv({
        VITE_CLAIM_RELAYER_URL: RELAYER_URL,
        VITE_BASE_SEPOLIA_RPC_URL: "http://sepolia.base.org",
      }),
    ).rejects.toThrow("VITE_BASE_SEPOLIA_RPC_URL chainId check failed.")
  })

  it("names VITE_CLAIM_RELAYER_URL when it is empty or whitespace", async () => {
    await expect(applyRequiredBuildEnv({ VITE_CLAIM_RELAYER_URL: "", VITE_BASE_SEPOLIA_RPC_URL: RPC_URL })).rejects.toThrow(
      /VITE_CLAIM_RELAYER_URL is empty/,
    )
    await expect(applyRequiredBuildEnv({ VITE_CLAIM_RELAYER_URL: "  ", VITE_BASE_SEPOLIA_RPC_URL: RPC_URL })).rejects.toThrow(
      /VITE_CLAIM_RELAYER_URL is empty/,
    )
  })

  it("names every empty required variable", async () => {
    await expect(applyRequiredBuildEnv({ VITE_CLAIM_RELAYER_URL: "", VITE_BASE_SEPOLIA_RPC_URL: "" })).rejects.toThrow(
      /VITE_CLAIM_RELAYER_URL, VITE_BASE_SEPOLIA_RPC_URL are empty/,
    )
  })

  it("refuses a relayer URL with credentials", async () => {
    await expect(
      applyRequiredBuildEnv({
        VITE_CLAIM_RELAYER_URL: "https://user:secret@bot-verifier-claim-relayer.onrender.com",
        VITE_BASE_SEPOLIA_RPC_URL: RPC_URL,
      }),
    ).rejects.toThrow(/VITE_CLAIM_RELAYER_URL must not include credentials/)
  })
})

describe("vite build env plugin", () => {
  it("does not read or set the relayer URL while serving", () => {
    delete process.env.VITE_CLAIM_RELAYER_URL
    requiredBuildEnvPlugin().config({}, { command: "serve" })
    expect(process.env.VITE_CLAIM_RELAYER_URL).toBeUndefined()
  })

  it("fills an unset relayer URL before Vite inlines env", async () => {
    delete process.env.VITE_CLAIM_RELAYER_URL
    delete process.env.VITE_BASE_SEPOLIA_RPC_URL
    await requiredBuildEnvPlugin().config({}, { command: "build" })
    expect(process.env.VITE_CLAIM_RELAYER_URL).toBe(RELAYER_URL)
    expect(process.env.VITE_BASE_SEPOLIA_RPC_URL).toBe(RPC_URL)
  })

  it("fails the build hook when the inlined relayer URL is empty", async () => {
    await expect(
      requiredBuildEnvPlugin().configResolved({
        command: "build",
        env: { VITE_CLAIM_RELAYER_URL: "", VITE_BASE_SEPOLIA_RPC_URL: RPC_URL },
      }),
    ).rejects.toThrow(/VITE_CLAIM_RELAYER_URL is empty/)
  })

  it("fails the build hook when the inlined relayer host is not pinned", async () => {
    await expect(
      requiredBuildEnvPlugin().configResolved({
        command: "build",
        env: { VITE_CLAIM_RELAYER_URL: OTHER_RELAYER, VITE_BASE_SEPOLIA_RPC_URL: RPC_URL },
      }),
    ).rejects.toThrow("VITE_CLAIM_RELAYER_URL host must be bot-verifier-claim-relayer.onrender.com.")
  })
})

describe("chainId lookup", () => {
  it("reads eth_chainId 0x14a34 as 84532 and fails closed on a bad response", async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ result: "0x14a34" }) })
    try {
      expect(await lookupChainId("https://rpc.example.test")).toBe(84532)
    } finally {
      globalThis.fetch = original
    }
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) })
    try {
      await expect(lookupChainId("https://rpc.example.test")).rejects.toThrow(
        "VITE_BASE_SEPOLIA_RPC_URL chainId check failed.",
      )
    } finally {
      globalThis.fetch = original
    }
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

  it("fails when the relayer host is not pinned and does not fall back to the file", () => {
    const result = runBuild({ VITE_CLAIM_RELAYER_URL: OTHER_RELAYER })
    const output = outputOf(result)
    expect(result.status).not.toBe(0)
    expect(output).toContain("VITE_CLAIM_RELAYER_URL host must be bot-verifier-claim-relayer.onrender.com.")
    expect(output).not.toContain("assembled dist")
  }, 60_000)

  it("passes when VITE_CLAIM_RELAYER_URL is unset and inlines the checked-in URL", () => {
    const result = runBuild({})
    expect(result.status, outputOf(result)).toBe(0)
    const javascript = distJavaScript()
    expect(javascript).toContain(RELAYER_URL)
    expect(javascript).toContain(RPC_URL)
    expect(javascript).not.toContain("VITE_CLAIM_API_SECRET")
  }, 180_000)
})
