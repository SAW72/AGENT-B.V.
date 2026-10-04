import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import escrowAbi from "./abi/BotAttestationEscrow.json"
import denylistAbi from "./abi/Denylist.json"
import disputePanelAbi from "./abi/DisputePanel.json"
import insuranceFundAbi from "./abi/InsuranceFund.json"
import liabilityAbi from "./abi/Liability.json"
import vaultHookAbi from "./abi/IVault.json"
import vaultAbi from "./abi/Vault.json"

type AbiItem = { type?: string; name?: string; stateMutability?: string }

function names(abi: AbiItem[], type = "function"): Set<string> {
  return new Set(abi.filter((item) => item.type === type).map((item) => item.name ?? ""))
}

describe("forge ABIs", () => {
  it("includes the Gate A read surface", () => {
    for (const name of ["owner", "pendingOwner", "denylistedHashes", "denylistedSignatures", "denylistedPrompts", "check"]) {
      expect(names(denylistAbi).has(name)).toBe(true)
    }
    for (const name of ["owner", "pendingOwner", "denylist"]) {
      expect(names(vaultAbi).has(name)).toBe(true)
      expect(names(vaultHookAbi).has(name)).toBe(true)
    }
    for (const name of ["owner", "arbitratorCount", "PANEL_SIZE"]) {
      expect(names(disputePanelAbi).has(name)).toBe(true)
    }
    for (const name of [
      "owner",
      "pendingOwner",
      "governance",
      "disputePanel",
      "lockedValue",
      "totalOwed",
      "pendingWithdrawals",
      "escrows",
      "createEscrow",
      "release",
      "refund",
      "dispute",
      "withdraw",
      "withdrawTo",
      "panelSubject",
      "RULING_GRACE",
    ]) {
      expect(names(escrowAbi).has(name)).toBe(true)
    }
    for (const name of ["Credited", "Withdrawn"]) {
      expect(names(escrowAbi, "event").has(name)).toBe(true)
    }
    for (const name of [
      "DisputeAlreadyResolved",
      "DisputeVotesCast",
      "DisputePredatesEscrow",
      "DisputeChallengerNotParty",
      "DisputeAfterExpiry",
      "ReleaseNotAuthorized",
      "NotParty",
      "RulingPending",
      "EscrowNotFound",
      "WithdrawFailed",
    ]) {
      expect(names(escrowAbi, "error").has(name)).toBe(true)
    }
    for (const name of ["owner", "insurance"]) expect(names(liabilityAbi).has(name)).toBe(true)
    for (const name of ["owner", "liability", "balance"]) expect(names(insuranceFundAbi).has(name)).toBe(true)
  })
})

const FORBIDDEN = ["useWriteContract", "useSignTypedData", "writeContract(", "wallet_sendTransaction"]

/** ClaimIntent is the only typed-data signature this app asks the wallet to make. */
const CLAIM_INTENT_SIGN_FILES = new Set(["relayer.ts", "FlowPreview.tsx"])

const SEND_ONLY = ["useSendTransaction", "sendTransactionAsync"]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path))
      continue
    }
    if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue
    if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path)
  }
  return out
}

describe("wallet writes", () => {
  it("limits sends to the Base Sepolia escrow submit and signs only a claim intent", () => {
    const src = dirname(fileURLToPath(import.meta.url))
    const hits: string[] = []
    const sendHits: string[] = []
    const signHits: string[] = []
    for (const path of sourceFiles(src)) {
      const text = readFileSync(path, "utf8")
      const file = path.slice(path.lastIndexOf("/") + 1)
      for (const token of FORBIDDEN) {
        if (text.includes(token)) hits.push(`${path} contains ${token}`)
      }
      if (text.includes("signTypedData(")) {
        signHits.push(file)
        if (!CLAIM_INTENT_SIGN_FILES.has(file)) hits.push(`${path} contains signTypedData(`)
      }
      for (const token of SEND_ONLY) {
        if (text.includes(token)) sendHits.push(`${path} contains ${token}`)
      }
    }
    expect(hits).toEqual([])
    expect(signHits.sort()).toEqual(["FlowPreview.tsx", "relayer.ts"])
    const relayer = readFileSync(join(src, "relayer.ts"), "utf8")
    expect(relayer).toContain("CLAIM_INTENT_PRIMARY_TYPE")
    expect(relayer).toContain("signTypedData(signArgs)")
    expect(sendHits.every((hit) => hit.includes("FlowPreview.tsx"))).toBe(true)
    expect(sendHits.length).toBeGreaterThan(0)
  })
})
