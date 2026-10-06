import { describe, expect, it } from "vitest"
import { ADDRESSES, BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import {
  assertSubmitTarget,
  evaluateEscrowSubmit,
  FORM_ERRORS,
  previewCardCopy,
  submitControl,
  submitSenderNote,
} from "./submit"

const escrow = ADDRESSES.botAttestationEscrow
const panel = ADDRESSES.disputePanel

describe("evaluateEscrowSubmit", () => {
  it("allows a connected Base Sepolia wallet", () => {
    expect(evaluateEscrowSubmit({ walletConnected: true, walletChainId: BASE_SEPOLIA_CHAIN_ID })).toEqual({
      ok: true,
      code: "ok",
      chainId: 84532,
    })
  })

  it("refuses Ethereum mainnet and Base mainnet", () => {
    const ethereum = evaluateEscrowSubmit({ walletConnected: true, walletChainId: 1 })
    const base = evaluateEscrowSubmit({ walletConnected: true, walletChainId: 8453 })
    expect(ethereum.ok).toBe(false)
    expect(base.ok).toBe(false)
    if (!ethereum.ok) expect(ethereum.code).toBe("mainnet")
    if (!base.ok) expect(base.code).toBe("base-mainnet")
    expect(submitControl(ethereum, false).testId).toBe("submit-refused")
    expect(submitControl(ethereum, false).disabled).toBe(true)
  })

  it("refuses a disconnected wallet, an unknown chain, a conflict, and every other chain", () => {
    expect(evaluateEscrowSubmit({ walletConnected: false, walletChainId: 84532 }).code).toBe("disconnected")
    expect(evaluateEscrowSubmit({ walletConnected: true, walletChainId: null }).code).toBe("unknown")
    expect(evaluateEscrowSubmit({ walletConnected: true, walletChainId: "conflict" }).code).toBe("conflict")
    expect(evaluateEscrowSubmit({ walletConnected: true, walletChainId: 11155111 }).code).toBe("wrong-chain")
  })

  it("enables the Sepolia submit control only when the decision is ok", () => {
    const ready = evaluateEscrowSubmit({ walletConnected: true, walletChainId: 84532 })
    expect(submitControl(ready, false)).toEqual({
      testId: "sepolia-submit",
      disabled: false,
      label: "Submit on Base Sepolia",
    })
    expect(submitControl(ready, true).disabled).toBe(true)
  })
})

describe("submit target", () => {
  it("allows the booked escrow and dispute panel only", () => {
    expect(escrow).toBe("0x3d660502D75f1e97b08c110255921b437A3C4C42")
    expect(panel).toBe("0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb")
    if (!escrow || !panel) throw new Error("booked addresses missing")
    expect(() => assertSubmitTarget(escrow, [escrow, panel])).not.toThrow()
    expect(() => assertSubmitTarget(panel, [escrow, panel])).not.toThrow()
    expect(() => assertSubmitTarget("0x0000000000000000000000000000000000000002", [escrow, panel])).toThrow(
      /booked Base Sepolia/,
    )
  })

  it("states who sends each prepared transaction in plain English", () => {
    expect(submitSenderNote("createEscrow")).toMatch(/allowed to fund claims for the payer/)
    expect(submitSenderNote("release")).toBe(
      "Only the payer can release an open escrow; after an upheld dispute, the payer or the payee. The connected wallet sends this payout on Base Sepolia.",
    )
    expect(submitSenderNote("refund")).toBe("Anyone can send a refund. The connected wallet sends this on Base Sepolia.")
    expect(submitSenderNote("dispute")).toBe("The payer or the payee has to send this. The connected wallet is the sender.")
    expect(previewCardCopy("dispute", false)).toBe(
      "This prepares one dispute on this claim. The connected wallet sends the claim, a new identifier, and the reason. Submit sends it from the connected wallet on Base Sepolia only.",
    )
    expect(previewCardCopy("dispute", true)).not.toMatch(/claim relayer/)
    expect(previewCardCopy("release", true)).not.toMatch(/claim relayer/)
    expect(previewCardCopy("release", true)).toMatch(/connected wallet on Base Sepolia only/)
    expect(previewCardCopy("refund", true)).toMatch(/claim relayer on Base Sepolia/)
    expect(previewCardCopy("openDispute", true)).not.toMatch(/claim relayer/)
    expect(previewCardCopy("createEscrow", true)).not.toMatch(/claim relayer/)
    expect(FORM_ERRORS.disputeClaim).toBe("Enter the claim identifier before opening a dispute.")
    for (const text of [submitSenderNote("dispute"), previewCardCopy("dispute", true), FORM_ERRORS.disputeClaim]) {
      expect(text).not.toMatch(/[()]/)
      expect(text).not.toMatch(/0x[0-9a-fA-F]+/)
      expect(text).not.toMatch(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/)
    }
  })
})
