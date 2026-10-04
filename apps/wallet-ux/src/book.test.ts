import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import deploymentBook from "./base-sepolia.json"
import { ADDRESSES, addressBook } from "./addresses"
import { FALLBACK_PIN, fallbackBook, resolveAddressBook, SUPERSEDED } from "./book"

const CANONICAL = {
  coreTimelock: "0x10CC9474b45625ADfd05C209f2518023484878D9",
  governanceTimelock: "0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33",
  denylist: "0xeE76876bECcFc1B58fC06fF4E654a517d784B224",
  vault: "0x1463D664fA467FBCDA4B05443434494f05e565bc",
  disputePanel: "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb",
  liability: "0x554Caf5a214B8d70D675C09186C5EAE24FEB7307",
  insuranceFund: "0x19fc26B36Cb2031062eD90C19db64b3b09753ab8",
} as const

const canonicalPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "deployments",
  "base-sepolia.json",
)

describe("deployment book", () => {
  it("keeps src/base-sepolia.json equal to deployments/base-sepolia.json", () => {
    expect(existsSync(canonicalPath)).toBe(true)
    expect(deploymentBook).toEqual(JSON.parse(readFileSync(canonicalPath, "utf8")))
  })

  it("reads the canonical live slots and ignores superseded", () => {
    expect(addressBook.source).toBe("src/base-sepolia.json")
    expect(addressBook.chainId).toBe(84532)
    expect(ADDRESSES.denylist).toBe(CANONICAL.denylist)
    expect(ADDRESSES.vault).toBe(CANONICAL.vault)
    expect(ADDRESSES.coreTimelock).toBe(CANONICAL.coreTimelock)
    expect(ADDRESSES.governanceTimelock).toBe(CANONICAL.governanceTimelock)
    expect(deploymentBook.governanceTimelock).toBe(CANONICAL.governanceTimelock)
    expect(ADDRESSES.disputePanel).toBe(CANONICAL.disputePanel)
    expect(ADDRESSES.liability).toBe(CANONICAL.liability)
    expect(ADDRESSES.insuranceFund).toBe(CANONICAL.insuranceFund)
    expect(ADDRESSES.botAttestationEscrow).toBe("0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d")
    expect(ADDRESSES.botAttestationEscrow).not.toBe(SUPERSEDED.botAttestationEscrow)
    expect(deploymentBook.BotAttestationEscrow.startBlock).toBe(47345163)
    expect(deploymentBook.BotAttestationEscrow.commit).toBe("444c427")
    expect(deploymentBook.BotAttestationEscrow.acceptOwnership).toBe("complete")
    expect(deploymentBook.BotAttestationEscrow.owner).toBe(CANONICAL.governanceTimelock)
    expect(deploymentBook.Denylist.owner).toBe(CANONICAL.governanceTimelock)
    expect(deploymentBook.Vault.owner).toBe(CANONICAL.governanceTimelock)
    expect(deploymentBook.Denylist.pendingOwner).toBe("0x0000000000000000000000000000000000000000")
    expect(deploymentBook.Vault.pendingOwner).toBe("0x0000000000000000000000000000000000000000")
    expect(deploymentBook.BotAttestationEscrow.constructorArgs.governance).toBe(CANONICAL.coreTimelock)
    expect(deploymentBook.governanceTimelockHardening.status).toBe("target-not-applied")
    expect(deploymentBook.governanceTimelockHardening.minDelayTarget).toBe(86400)
    expect(deploymentBook.governanceTimelockHardening.minDelayTarget).toBeGreaterThan(300)
    expect(deploymentBook.governanceTimelockHardening.liveMinDelay).toBe(300)
    expect(deploymentBook.governanceTimelockHardening.applied).toBe(false)
    expect(deploymentBook.governanceTimelockHardening.executorTarget).toBe(CANONICAL.governanceTimelock)
    expect(deploymentBook.governanceTimelockHardening.executorMode).toBe("closed")
    expect(deploymentBook.governanceTimelockHardening.liveExecutor).toBe("open")
    expect(deploymentBook.governanceTimelockHardening.timelock).toBe(CANONICAL.governanceTimelock)
    expect(deploymentBook.governanceTimelockHardening.notes).toContain("TARGET only")
    expect(deploymentBook.governanceTimelockHardening.notes).toContain("Spencer must confirm")
    expect(deploymentBook.BotAttestationEscrow.pendingOwner).toBe("0x0000000000000000000000000000000000000000")
    expect(deploymentBook.BotAttestationEscrow.acceptOwnershipTx).toBe(
      "0xe4286328ff1d177c724888255d3607187e4b4ea68d0f1e66d697e6152367e0e9",
    )
    expect(deploymentBook.BotAttestationEscrow.acceptOwnershipBlock).toBe(47345442)
    expect(deploymentBook.BotAttestationEscrow.basescan).toBe("verified")
    expect(deploymentBook.BotAttestationEscrow.basescanUrl).toBe(
      "https://sepolia.basescan.org/address/0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d#code",
    )
    expect(deploymentBook.claimRelayerWallet).toBe("0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861")
    expect(ADDRESSES.bvt).toBeNull()
    expect(JSON.stringify(ADDRESSES).toLowerCase()).not.toContain(SUPERSEDED.denylist.toLowerCase())
    expect(JSON.stringify(ADDRESSES).toLowerCase()).not.toContain(SUPERSEDED.vault.toLowerCase())
    expect(JSON.stringify(ADDRESSES).toLowerCase()).not.toContain(SUPERSEDED.botAttestationEscrow.toLowerCase())
    expect(deploymentBook.superseded.Denylist.address).toBe(SUPERSEDED.denylist)
    expect(deploymentBook.retired.BotAttestationEscrow.address).toBe(SUPERSEDED.botAttestationEscrow)
    expect(deploymentBook.retired.BotAttestationEscrow.reason).toBe("ESC-M-1 redeploy, retired 2026-09-26")
  })

  it("falls back to the corrected pin when the book is not Base Sepolia", () => {
    const book = resolveAddressBook({ ...deploymentBook, chainId: 1 })
    expect(book.source).toBe("fallback-pin")
    expect(book.denylist).toBe(FALLBACK_PIN.denylist)
    expect(book.vault).toBe(FALLBACK_PIN.vault)
    expect(book).toEqual(fallbackBook())
  })

  it("falls back when the live escrow is the retired address", () => {
    const poisoned = structuredClone(deploymentBook)
    poisoned.BotAttestationEscrow.address = SUPERSEDED.botAttestationEscrow
    const book = resolveAddressBook(poisoned)
    expect(book.source).toBe("fallback-pin")
    expect(book.botAttestationEscrow).toBe(FALLBACK_PIN.botAttestationEscrow)
  })

  it("falls back when a live slot is a superseded address", () => {
    const poisoned = structuredClone(deploymentBook)
    poisoned.Denylist.address = SUPERSEDED.denylist
    poisoned.Vault.denylist = SUPERSEDED.denylist
    const book = resolveAddressBook(poisoned)
    expect(book.source).toBe("fallback-pin")
    expect(book.denylist).toBe(CANONICAL.denylist)
    expect(book.vault).toBe(CANONICAL.vault)
  })

  it("falls back when Vault.denylist does not match the live Denylist", () => {
    const drifted = structuredClone(deploymentBook)
    drifted.Vault.denylist = SUPERSEDED.denylist
    expect(resolveAddressBook(drifted).source).toBe("fallback-pin")
  })

  it("accepts a valid book that differs from the pin", () => {
    const next = structuredClone(deploymentBook)
    const replacement = "0x0000000000000000000000000000000000000001"
    next.Denylist.address = replacement
    next.Vault.denylist = replacement
    const book = resolveAddressBook(next)
    expect(book.source).toBe("src/base-sepolia.json")
    expect(book.denylist).toBe("0x0000000000000000000000000000000000000001")
    expect(book.vault).toBe(CANONICAL.vault)
  })
})
