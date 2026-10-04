import { decodeFunctionData, parseEther, toFunctionSelector } from "viem"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { disputePanelAbi, escrowAbi } from "./abi"
import { randomBytes32 } from "./bytes32"
import {
  ERROR_GLOSSARY,
  MAX_DURATION_SECONDS,
  DISPUTE_PENDING_TEXT,
  DISPUTE_VOTES_CAST_TEXT,
  POST_EXPIRY_REFUND_ORDER,
  RELEASE_NOT_AUTHORIZED_TEXT,
  RULING_PENDING_TEXT,
  previewCreateEscrow,
  previewDispute,
  panelSubject,
  previewOpenDispute,
  previewRefund,
  previewRelease,
} from "./preview"

const escrow = "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d" as const
const panel = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb" as const
const id = `0x${"ab".repeat(32)}` as const
const other = `0x${"cd".repeat(32)}` as const
const payee = "0x0000000000000000000000000000000000000002" as const

describe("calldata preview", () => {
  it("encodes createEscrow without sending value anywhere but the preview", () => {
    const preview = previewCreateEscrow({
      escrow,
      escrowId: id,
      payee,
      payerBotId: id,
      payeeBotId: other,
      durationSeconds: BigInt(MAX_DURATION_SECONDS),
      valueWei: parseEther("0.01"),
    })
    const decoded = decodeFunctionData({ abi: escrowAbi, data: preview.calldata })
    expect(preview.to).toBe(escrow)
    expect(preview.functionName).toBe("createEscrow")
    expect(preview.valueWei).toBe(parseEther("0.01"))
    expect(decoded.functionName).toBe("createEscrow")
    expect(decoded.args?.[0]).toBe(id)
  })

  it("encodes release, refund, and dispute as zero-value calldata", () => {
    const release = previewRelease(escrow, id)
    const refund = previewRefund(escrow, id)
    const dispute = previewDispute(escrow, id, other, "preview only")
    const opened = previewOpenDispute(panel, other, id, "preview only")
    expect(decodeFunctionData({ abi: escrowAbi, data: release.calldata }).functionName).toBe("release")
    expect(decodeFunctionData({ abi: escrowAbi, data: refund.calldata }).functionName).toBe("refund")
    const decoded = decodeFunctionData({ abi: escrowAbi, data: dispute.calldata })
    expect(decoded.functionName).toBe("dispute")
    expect(decoded.args).toEqual([id, other, "preview only"])
    expect(dispute.to).toBe(escrow)
    expect(dispute.valueWei).toBe(0n)
    expect(decodeFunctionData({ abi: disputePanelAbi, data: opened.calldata }).functionName).toBe("openDispute")
    expect(release.valueWei).toBe(0n)
    expect(opened.to).toBe(panel)
  })

  it("lists the escrow and panel revert strings", () => {
    const names = ERROR_GLOSSARY.map((entry) => entry.name)
    expect(names).toContain("FundingBeforeGovernance")
    expect(names).toContain("panel not seated")
    expect(names).toContain("AttestationFailed")
    expect(names).toContain("DisputeAlreadyResolved")
    expect(names).toContain("DisputeVotesCast")
    expect(names).toContain("DisputePredatesEscrow")
    expect(names).toContain("DisputeChallengerNotParty")
    expect(names).toContain("ReleaseNotAuthorized")
    expect(names).toContain("NotParty")
    expect(names).toContain("DisputeAfterExpiry")
    expect(names).toContain("DisputeReasonTooLong")
    expect(ERROR_GLOSSARY.find((entry) => entry.name === "DisputeReasonTooLong")?.meaning).toBe(
      "The reason is longer than 256 bytes, so this dispute was not filed.",
    )
    expect(ERROR_GLOSSARY.find((entry) => entry.name === "InvalidDispute")?.meaning).toBe(
      "This dispute identifier can't be used. It is blank, or it matches the claim, the subject stored for the panel, or the claim mixed with the time the claim was created.",
    )
    expect(ERROR_GLOSSARY.find((entry) => entry.name === "exists")?.meaning).toBe(
      "A dispute with this identifier is already open. Generate a new identifier and file again. The claim stays open.",
    )
    expect(RELEASE_NOT_AUTHORIZED_TEXT).toBe(
      "Only the payer can release an open escrow; after an upheld dispute, the payer or the payee.",
    )
    expect(ERROR_GLOSSARY.find((entry) => entry.name === "ReleaseNotAuthorized")?.meaning).toBe(
      RELEASE_NOT_AUTHORIZED_TEXT,
    )
    expect(ERROR_GLOSSARY.find((entry) => entry.name === "NotParty")?.meaning).toBe(
      "This wallet is not a party to this escrow.",
    )
    expect(DISPUTE_PENDING_TEXT).toBe(
      "Release stays blocked while the dispute is unresolved or was unwound. A refund before the claim ends stays blocked until the panel unwinds the deal. A refund also stays blocked when the panel upheld the deal.",
    )
    expect(ERROR_GLOSSARY.find((entry) => entry.name === "DisputePending")?.meaning).toBe(DISPUTE_PENDING_TEXT)
    expect(ERROR_GLOSSARY.find((entry) => entry.name === "RulingPending")?.meaning).toBe(RULING_PENDING_TEXT)
    expect(ERROR_GLOSSARY.find((entry) => entry.name === "DisputeVotesCast")?.meaning).toBe(DISPUTE_VOTES_CAST_TEXT)
    expect(DISPUTE_VOTES_CAST_TEXT).not.toMatch(/already has votes/)
    expect(toFunctionSelector("DisputeVotesCast()")).toBe("0x8aab0a8f")
    const revertCopy = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../claim-relayer/revertCopy.json"), "utf8"),
    ) as {
      DisputeVotesCast: { selector: string; meaning: string }
      ReleaseNotAuthorized: { selector: string; meaning: string }
      DisputePending: { selector: string; meaning: string }
    }
    expect(revertCopy.DisputeVotesCast.selector).toBe("0x8aab0a8f")
    expect(revertCopy.DisputeVotesCast.meaning).toBe(DISPUTE_VOTES_CAST_TEXT)
    expect(revertCopy.ReleaseNotAuthorized.selector).toBe("0xfe28f476")
    expect(toFunctionSelector("ReleaseNotAuthorized()")).toBe("0xfe28f476")
    expect(revertCopy.ReleaseNotAuthorized.meaning).toBe(RELEASE_NOT_AUTHORIZED_TEXT)
    expect(revertCopy.DisputePending.selector).toBe("0xfd29e9e5")
    expect(revertCopy.DisputePending.meaning).toBe(DISPUTE_PENDING_TEXT)
    expect(toFunctionSelector("DisputePending()")).toBe("0xfd29e9e5")
    expect(toFunctionSelector("RulingPending()")).toBe("0x3a0621bd")
    expect(toFunctionSelector("RULING_GRACE()")).toBe("0x3cfbadae")
    expect(POST_EXPIRY_REFUND_ORDER.map((step) => step.error)).toEqual([
      null,
      "DisputePending",
      "RulingPending",
      null,
    ])
    expect(POST_EXPIRY_REFUND_ORDER.map((step) => step.state)).toEqual([
      "Open",
      "Disputed and upheld",
      "Disputed, unresolved, within 7 days after the claim ends",
      "Otherwise",
    ])
    expect(POST_EXPIRY_REFUND_ORDER.map((step) => step.outcome)).toEqual([
      "The payer is refunded.",
      "The payee releases.",
      RULING_PENDING_TEXT,
      "The payer is refunded.",
    ])
    const flow = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "FlowPreview.tsx"), "utf8")
    expect(flow).toContain('data-testid="post-expiry-refund-order"')
    expect(flow).toContain("POST_EXPIRY_REFUND_ORDER")
  })

  it("fills the dispute subject from the claim id and the time the claim was created", () => {
    const createdAt = 1_700_000_000n
    const subject = panelSubject(escrow, id, createdAt)
    expect(subject).toBe("0xbb13800c96edf91bb23cf6e0b3563c7f804d0f2215f3c390d62689d2a4ca1d7a")
    expect(subject).not.toBe(id)
    expect(panelSubject(escrow, id, createdAt)).toBe(subject)
    expect(panelSubject(escrow, other, createdAt)).not.toBe(subject)
    expect(panelSubject(panel, id, createdAt)).not.toBe(subject)
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "FlowPreview.tsx"), "utf8")
    expect(source).not.toContain("panelSubject(escrow, claim, created)")
    expect(source).toContain('id="open-subject"')
    expect(source).toContain('id="open-created-at"')
    expect(source).toContain("readOnly")
    expect(source).not.toContain("Use the claim identifier. The panel stores this as the subject.")
    const openForm = source.slice(source.indexOf("function OpenDisputeForm"))
    expect(openForm).toContain("readDisputeSubject")
    expect(openForm).toContain("currentNowSeconds()")
    expect(openForm).toContain("disputeWindowMessage")
    expect(openForm).not.toContain("panelSubject(")
    expect(openForm).not.toContain("setCreatedAt")
    expect(openForm).not.toContain("parseCreatedAt")
    expect(openForm).toContain("randomBytes32()")
    expect(openForm).not.toContain("previewOpenDispute")
    expect(openForm).toContain("previewDispute(escrow, claim, id, trimmedReason)")
    expect(openForm).toContain('id="open-dispute"')
    expect(openForm).not.toContain("keccak256")
    expect(openForm).not.toContain("Date.now")
    expect(openForm).not.toContain("function DisputeForm")
    expect(source).not.toContain('data-testid="open-and-link"')
    expect(source).not.toContain("Link a dispute")
    expect(source).not.toContain("Prepare this dispute link")
  })

  it("draws a case identifier from 32 random bytes", () => {
    const seen: Uint8Array[] = []
    const first = randomBytes32((bytes) => {
      seen.push(bytes)
      bytes.fill(0xab)
    })
    expect(seen[0]).toHaveLength(32)
    expect(first).toBe(`0x${"ab".repeat(32)}`)
    const second = randomBytes32((bytes) => {
      bytes.fill(0xcd)
    })
    expect(second).not.toBe(first)
    expect(randomBytes32((bytes) => bytes.fill(0))).toBe(`0x${"00".repeat(31)}01`)
    const helper = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "bytes32.ts"), "utf8")
    expect(helper).toContain("crypto.getRandomValues")
    expect(helper).not.toContain("createdAt")
    expect(helper).not.toContain("escrowId")
  })
})

describe("Base Sepolia submit", () => {
  it("submits escrow calldata from the connected wallet on chain 84532", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "FlowPreview.tsx"), "utf8")
    expect(source).not.toContain("Held until Spencer go")
    expect(source).not.toContain("held-submit")
    expect(source).toContain("sendTransactionAsync")
    expect(source).toContain("chainId: BASE_SEPOLIA_CHAIN_ID")
    expect(source).toContain("evaluateEscrowSubmit")
    expect(source).toContain("assertSubmitTarget")
    expect(source).not.toContain("writeContract(")
    expect(source).not.toContain("wallet_sendTransaction")
  })
})
