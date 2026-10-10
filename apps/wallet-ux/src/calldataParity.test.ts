import { hashTypedData, type Address, type Hex } from "viem"
import { describe, expect, it } from "vitest"
import { claimSignArgs } from "./relayer"
import {
  previewCreateEscrow,
  previewDispute,
  previewRefund,
  previewRelease,
  previewVote,
  previewWithdraw,
} from "./preview"

const escrow = "0x3d660502D75f1e97b08c110255921b437A3C4C42" as Address
const panel = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb" as Address
const id = `0x${"ab".repeat(32)}` as Hex
const disputeId = `0x${"cd".repeat(32)}` as Hex
const payee = "0x6C756dacfEcEeA12D5D39536d2eCC175f18bc5A4" as Address
const sender = "0x6dBe4B1c56494Ee00d6f97FFE9f853F42299D6Ac" as Address

/**
 * Byte pins taken from the preview builders at 6c07a04.
 * The Phase 1 UI does not change encoding. A drift here is a calldata change.
 */
const PINNED = {
  createEscrow:
    "0x6acad9caabababababababababababababababababababababababababababababababab0000000000000000000000006c756dacfeceea12d5d39536d2ecc175f18bc5a4ababababababababababababababababababababababababababababababababcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd0000000000000000000000000000000000000000000000000000000000015180",
  release: "0x67d42a8babababababababababababababababababababababababababababababababab",
  refund: "0x7249fbb6abababababababababababababababababababababababababababababababab",
  dispute:
    "0x4b528670ababababababababababababababababababababababababababababababababcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd0000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000d6c6174652064656c697665727900000000000000000000000000000000000000",
  voteTrue:
    "0x9f2ce678cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd0000000000000000000000000000000000000000000000000000000000000001",
  voteFalse:
    "0x9f2ce678cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd0000000000000000000000000000000000000000000000000000000000000000",
  withdraw: "0x3ccfd60b",
  refundIntent: "0xbe12d32385e9153be51f406522ea8b6aa923c649b0742334334232bcbe888e76",
} as const

describe("calldata parity with 6c07a04", () => {
  it("createEscrow", () => {
    const preview = previewCreateEscrow({
      escrow,
      escrowId: id,
      payee,
      payerBotId: id,
      payeeBotId: disputeId,
      durationSeconds: 86400n,
      valueWei: 1_000_000_000_000_000n,
    })
    expect(preview.calldata).toBe(PINNED.createEscrow)
    expect(preview.valueWei).toBe(1_000_000_000_000_000n)
    expect(preview.to).toBe(escrow)
  })

  it("release", () => {
    const preview = previewRelease(escrow, id)
    expect(preview.calldata).toBe(PINNED.release)
    expect(preview.valueWei).toBe(0n)
  })

  it("refund", () => {
    const preview = previewRefund(escrow, id)
    expect(preview.calldata).toBe(PINNED.refund)
    expect(preview.valueWei).toBe(0n)
  })

  it("dispute", () => {
    const preview = previewDispute(escrow, id, disputeId, "late delivery")
    expect(preview.calldata).toBe(PINNED.dispute)
    expect(preview.valueWei).toBe(0n)
  })

  it("vote true", () => {
    expect(previewVote(panel, disputeId, true).calldata).toBe(PINNED.voteTrue)
  })

  it("vote false", () => {
    expect(previewVote(panel, disputeId, false).calldata).toBe(PINNED.voteFalse)
  })

  it("withdraw", () => {
    const preview = previewWithdraw(escrow)
    expect(preview.calldata).toBe(PINNED.withdraw)
    expect(preview.valueWei).toBe(0n)
  })

  it("relayer refund intent", () => {
    const preview = previewRefund(escrow, id)
    const args = claimSignArgs({
      preview,
      sender,
      verifyingContract: escrow,
      nowSeconds: 1_700_000_000,
      nonce: 1n,
    })
    expect(hashTypedData(args)).toBe(PINNED.refundIntent)
    expect(args.message.action).toBe(1)
    expect(args.message.escrowId).toBe(id)
  })
})
