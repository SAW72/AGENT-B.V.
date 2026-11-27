import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const src = dirname(fileURLToPath(import.meta.url))
const root = dirname(src)

function sourceFiles(): string[] {
  const inRegister = readdirSync(src)
    .filter((name) => (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.includes(".test."))
    .map((name) => join(src, name))
  return [...inRegister, join(root, "RegisterWizard.tsx"), join(root, "registerCopy.ts")]
}

const forbidden = [
  /from\s+["']wagmi["']/,
  /from\s+["']viem["']/,
  /from\s+["']@tanstack\//,
  /registry\/register/,
  /src\/registry\//,
  /sendTransactionAsync/,
  /writeContract/,
  /useWriteContract/,
  /useSendTransaction/,
  /useAccount\(/,
  /useConnect\(/,
  /useWalletClient\(/,
  /useSwitchChain\(/,
  /window\.ethereum/,
  /eth_sendTransaction/,
  /eth_estimateGas/,
  /Look up/,
  /duplicateOwnerId/,
  /metamask/i,
  /coinbase wallet/i,
  /\u2014/,
  /[0-9a-fA-F]{64}/,
  /\b2048\b/,
]

describe("register wizard imports", () => {
  it("keeps presentational files free of wallet clients, registry helpers, and brand names", () => {
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      const source = readFileSync(file, "utf8")
      for (const pattern of forbidden) {
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern)
      }
    }
  })
})
