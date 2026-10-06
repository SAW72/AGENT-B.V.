import { getAddress, isAddress } from "viem"
import { describe, expect, it } from "vitest"
import { ADDRESSES, BASE_SEPOLIA_CHAIN_ID, NOT_DEPLOYED, SUPERSEDED, ZERO_ADDRESS } from "./addresses"
import { parseBytes32 } from "./bytes32"
import { panelNotSeated } from "./read"

const LIVE = [
  ADDRESSES.coreTimelock,
  ADDRESSES.denylist,
  ADDRESSES.vault,
  ADDRESSES.disputePanel,
  ADDRESSES.liability,
  ADDRESSES.insuranceFund,
] as const

describe("address pin", () => {
  it("pins the post-redeploy Denylist and Vault", () => {
    expect(ADDRESSES.chainId).toBe(BASE_SEPOLIA_CHAIN_ID)
    expect(ADDRESSES.network).toBe("base-sepolia")
    expect(ADDRESSES.denylist).toBe("0xeE76876bECcFc1B58fC06fF4E654a517d784B224")
    expect(ADDRESSES.vault).toBe("0x1463D664fA467FBCDA4B05443434494f05e565bc")
    expect(ADDRESSES.denylist).not.toBe(SUPERSEDED.denylist)
    expect(ADDRESSES.vault).not.toBe(SUPERSEDED.vault)
    expect(ADDRESSES.botAttestationEscrow).not.toBe(SUPERSEDED.botAttestationEscrow)
    expect(ADDRESSES.botAttestationEscrow).not.toBe(SUPERSEDED.botAttestationEscrowEscM1)
  })

  it("loads live escrow from the book and keeps BVT unset", () => {
    expect(ADDRESSES.botAttestationEscrow).toBe("0x3d660502D75f1e97b08c110255921b437A3C4C42")
    const bvt = NOT_DEPLOYED.filter(([name]) => name !== "BotAttestationEscrow")
    expect(bvt.map(([, address]) => address)).toEqual([null, null, null, null, null])
  })

  it("uses checksummed addresses", () => {
    for (const address of [
      ...LIVE,
      SUPERSEDED.denylist,
      SUPERSEDED.vault,
      SUPERSEDED.botAttestationEscrow,
      SUPERSEDED.botAttestationEscrowEscM1,
      ZERO_ADDRESS,
    ]) {
      expect(isAddress(address)).toBe(true)
      expect(getAddress(address)).toBe(address)
    }
  })
})

describe("parseBytes32", () => {
  const hash = "11".repeat(32)

  it("accepts 32-byte hex with or without a prefix", () => {
    expect(parseBytes32(hash)).toBe(`0x${hash}`)
    expect(parseBytes32(`0x${hash}`)).toBe(`0x${hash}`)
    expect(parseBytes32(`0X${hash.toUpperCase()}`)).toBe(`0x${hash}`)
  })

  it("rejects empty, short, and non-hex values", () => {
    expect(parseBytes32("")).toBeNull()
    expect(parseBytes32("0x1234")).toBeNull()
    expect(parseBytes32(`${hash}zz`)).toBeNull()
  })
})

describe("panelNotSeated", () => {
  it("is true when fewer than PANEL_SIZE arbitrators are seated", () => {
    expect(panelNotSeated(0n, 3n)).toBe(true)
    expect(panelNotSeated(2n, 3n)).toBe(true)
    expect(panelNotSeated(3n, 3n)).toBe(false)
  })
})
