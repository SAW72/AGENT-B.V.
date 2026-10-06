import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  BaseError,
  CallExecutionError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  RpcRequestError,
  UserRejectedRequestError,
  encodeErrorResult,
  type Hex,
} from "viem"
import { describe, expect, it, vi } from "vitest"
import { escrowAbi } from "./abi"
import { ADDRESSES } from "./addresses"
import { errorText, presentError } from "./format"
import {
  DISPUTE_VOTES_CAST_TEXT,
  ERROR_GLOSSARY,
  POST_EXPIRY_REFUND_INTRO,
  POST_EXPIRY_REFUND_ORDER,
  RULING_PENDING_TEXT,
} from "./preview"
import { CLAIM_RELAYER_WALLET, submitAfterPreflight, submitRelayerAfterPreflight } from "./preflight"
import { RELAYER_RECEIPT_REVERTED_TEXT, RELAYER_USER_TEXT } from "./relayer"
import { REVERT_FALLBACK_TEXT, visibleDetail, WALLET_CANCEL_TEXT } from "./revert"
import { durationValidationMessage, FORM_ERRORS, previewCardCopy, submitSenderNote } from "./submit"

const escrow = ADDRESSES.botAttestationEscrow
if (!escrow) throw new Error("booked escrow missing")

const ESC_M1 = [
  {
    name: "DisputeAlreadyResolved",
    selector: "0xf10068b5",
    meaning: "Filing opens the panel case in the same transaction. A case that is already resolved is not opened on this claim.",
  },
  {
    name: "DisputeVotesCast",
    selector: "0x8aab0a8f",
    meaning: DISPUTE_VOTES_CAST_TEXT,
  },
  {
    name: "DisputePredatesEscrow",
    selector: "0x9bc3a099",
    meaning: "Filing opens the panel case in the same transaction. A case opened before this claim is not opened on this claim.",
  },
  {
    name: "DisputeChallengerNotParty",
    selector: "0xb4b5168e",
    meaning: "Filing opens the panel case in the same transaction. The escrow opens that case, and the caller is stored as the party.",
  },
  {
    name: "DisputeAfterExpiry",
    selector: "0xaf6c5d51",
    meaning: "The claim window has closed, so this dispute can't be filed.",
  },
  {
    name: "RulingPending",
    selector: "0x3a0621bd",
    meaning: "A dispute ruling is pending. Refund opens 7 days after expiry if the panel has not ruled.",
  },
] as const

const errorStringAbi = [
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
] as const

function executionError(data: Hex) {
  const reverted = new ContractFunctionRevertedError({
    abi: escrowAbi,
    data,
    functionName: "dispute",
  })
  return new ContractFunctionExecutionError(reverted, {
    abi: escrowAbi,
    args: [],
    contractAddress: escrow ?? undefined,
    functionName: "dispute",
  })
}

function rpcRevert(data: Hex) {
  const rpc = new RpcRequestError({
    body: { method: "eth_call", params: [] },
    error: { code: 3, message: "execution reverted", data },
    url: "https://sepolia.base.org",
  })
  const reverted = new ExecutionRevertedError({ cause: rpc, message: rpc.details })
  return new CallExecutionError(reverted, {
    to: escrow ?? undefined,
    data: "0x",
  })
}

describe("ESC-M-1 revert text", () => {
  it.each(ESC_M1)("renders $name from a viem execution error and an RPC revert", (entry) => {
    const glossary = ERROR_GLOSSARY.find((item) => item.name === entry.name)
    expect(glossary?.meaning).toBe(entry.meaning)
    const data = entry.selector as Hex

    for (const error of [executionError(data), rpcRevert(data)]) {
      const presented = presentError(error)
      expect(presented.main).toBe(entry.meaning)
      expect(presented.detail).toBe(`Details: ${entry.name} (${entry.selector})`)
      expect(presented.main).not.toContain(entry.selector)
      expect(presented.main).not.toContain(entry.name)
      expect(errorText(error).startsWith(entry.meaning)).toBe(true)
      expect(errorText(error)).not.toContain("\n    at ")
      expect(error.shortMessage).not.toBe(presented.main)
    }
  })

  it("uses a plain fallback for an unknown selector and keeps the selector in the details", () => {
    const error = rpcRevert("0x12345678")
    const presented = presentError(error)
    expect(presented.main).toBe("The contract rejected this transaction. No funds moved.")
    expect(presented.detail).toBe("Details: 0x12345678")
    expect(presented.main).not.toContain("0x12345678")
    expect(error.shortMessage).toBe("Execution reverted for an unknown reason.")
  })

  it("renders Error(string) from the glossary, with the name only in the details", () => {
    const data = encodeErrorResult({ abi: errorStringAbi, args: ["not a party"] })
    const presented = presentError(rpcRevert(data))
    expect(presented.main).toBe("Only the payer or payee on this claim can open a dispute. Switch to that wallet.")
    expect(presented.detail).toBe("Details: Error (0x08c379a0)")
    expect(presented.main).not.toContain("0x08c379a0")
    expect(presented.main).not.toContain("()")
  })

  it("hides the details line when Error(string) has an empty reason", () => {
    for (const message of ["", "   "]) {
      const data = encodeErrorResult({ abi: errorStringAbi, args: [message] })
      const presented = presentError(rpcRevert(data))
      expect(presented.main).toBe(REVERT_FALLBACK_TEXT)
      expect(presented.detail).toBeNull()
      expect(visibleDetail(presented.detail)).toBeNull()
    }
    expect(visibleDetail("Details: ")).toBeNull()
    expect(visibleDetail("Details:")).toBeNull()
    expect(visibleDetail("   ")).toBeNull()
    expect(visibleDetail("Details: vault is paused for maintenance")).toBe("Details: vault is paused for maintenance")
  })

  it("uses plain English for an Error string that is not in the glossary", () => {
    const data = encodeErrorResult({ abi: errorStringAbi, args: ["vault is paused for maintenance"] })
    const presented = presentError(rpcRevert(data))
    expect(presented.main).toBe(REVERT_FALLBACK_TEXT)
    expect(presented.detail).toBe("Details: vault is paused for maintenance")
    expect(presented.main).not.toContain("vault is paused")
    expect(presented.main).not.toMatch(/unknown reason/i)
  })

  it("puts a Panic code in the details and keeps the main text plain", () => {
    const panicAbi = [{ type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] }] as const
    const data = encodeErrorResult({ abi: panicAbi, args: [0x11n] })
    const presented = presentError(rpcRevert(data))
    expect(presented.main).toBe(REVERT_FALLBACK_TEXT)
    expect(presented.detail).toBe("Details: Panic 0x11")
    expect(presented.main).not.toContain("0x11")
    expect(presented.main).not.toMatch(/unknown reason/i)
  })

  it("uses the fallback when revert data is empty, missing, or not a 4-byte-aligned payload", () => {
    const cases = ["0x", "0xabcd", "0x1234567890"] as const
    for (const data of cases) {
      const error = rpcRevert(data as Hex)
      const presented = presentError(error)
      expect(presented.main).toBe(REVERT_FALLBACK_TEXT)
      expect(presented.main).not.toMatch(/unknown reason/i)
      expect(error.shortMessage).toMatch(/unknown reason/i)
    }
    const missing = rpcRevert(undefined as unknown as Hex)
    const presented = presentError(missing)
    expect(presented.main).toBe(REVERT_FALLBACK_TEXT)
    expect(presented.main).not.toMatch(/unknown reason/i)
  })

  it("says the wallet was cancelled for UserRejectedRequestError and EIP-1193 code 4001", () => {
    const rejected = new UserRejectedRequestError(new Error("User denied"))
    rejected.stack = "UserRejectedRequestError: User rejected the request.\n    at secret/wallet.js:1:1"
    const wrapped = new BaseError("Wallet request failed.", { cause: rejected })
    const coded = new BaseError("Provider failed.", {
      cause: Object.assign(new Error("denied"), { code: 4001 }),
    })
    const stringCode = { code: "4001", message: "User rejected the request." }
    const actionRejected = {
      code: "ACTION_REJECTED",
      message: "ethers rejected",
      info: { error: { code: 4001, message: "User denied transaction signature" } },
    }
    const nestedInfo = { info: { error: { code: "4001" } } }

    for (const error of [rejected, wrapped, coded, stringCode, actionRejected, nestedInfo]) {
      const presented = presentError(error)
      expect(presented.main).toBe("You cancelled in your wallet")
      expect(presented.detail).toBeNull()
      expect(errorText(error)).toBe("You cancelled in your wallet")
      expect(errorText(error)).not.toContain("secret/wallet.js")
      expect(errorText(error)).not.toContain(" at ")
    }
  })
})

describe("preflight", () => {
  const calldata = "0x1234" as Hex

  it("does not open the wallet when the Base Sepolia simulation reverts", async () => {
    const send = vi.fn()
    const client = {
      call: vi.fn(async () => {
        throw rpcRevert("0xf10068b5")
      }),
    }
    await expect(
      submitAfterPreflight({
        chainId: 84532,
        client,
        account: "0x000000000000000000000000000000000000dEaD",
        to: escrow,
        data: calldata,
        value: 0n,
        send,
      }),
    ).rejects.toBeTruthy()
    expect(client.call).toHaveBeenCalledTimes(1)
    expect(client.call).toHaveBeenCalledWith({
      account: "0x000000000000000000000000000000000000dEaD",
      to: escrow,
      data: calldata,
      value: 0n,
    })
    expect(send).not.toHaveBeenCalled()
    try {
      await submitAfterPreflight({
        chainId: 84532,
        client,
        to: escrow,
        data: calldata,
        value: 0n,
        send,
      })
    } catch (cause) {
      expect(presentError(cause).main).toBe(
        "Filing opens the panel case in the same transaction. A case that is already resolved is not opened on this claim.",
      )
    }
  })

  it("opens the wallet only after a successful Base Sepolia simulation", async () => {
    const send = vi.fn(async () => "0xabc" as Hex)
    const client = { call: vi.fn(async () => ({ data: "0x" })) }
    await expect(
      submitAfterPreflight({
        chainId: 84532,
        client,
        to: escrow,
        data: calldata,
        value: 0n,
        send,
      }),
    ).resolves.toBe("0xabc")
    expect(client.call).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("refuses every other chain before the simulation or the wallet", async () => {
    const send = vi.fn()
    const client = { call: vi.fn() }
    await expect(
      submitAfterPreflight({
        chainId: 1,
        client,
        to: escrow,
        data: calldata,
        value: 0n,
        send,
      }),
    ).rejects.toThrow(/Base Sepolia/)
    await expect(
      submitAfterPreflight({
        chainId: 8453,
        client,
        to: escrow,
        data: calldata,
        value: 0n,
        send,
      }),
    ).rejects.toThrow(/Base Sepolia/)
    expect(client.call).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("runs the preflight in the submit handler before the wallet prompt", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "FlowPreview.tsx"), "utf8")
    const notice = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ErrorNotice.tsx"), "utf8")
    const styles = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8")
    const preflight = source.indexOf("submitAfterPreflight")
    const send = source.indexOf("send: () =>")
    expect(preflight).toBeGreaterThan(-1)
    expect(send).toBeGreaterThan(preflight)
    expect(source).toContain("presentError")
    expect(source).toContain("ErrorNotice")
    expect(source).toContain("chainId: BASE_SEPOLIA_CHAIN_ID")
    expect(notice).toContain('role="alert"')
    expect(styles).toContain("overflow-wrap: anywhere")
    expect(styles).toContain(".error-notice")
    const relayer = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "relayer.ts"), "utf8")
    const handler = relayer.slice(relayer.indexOf("export async function runRelayerSubmission"))
    const claimBody = handler.indexOf("claimBodyFromPreview")
    const simulate = handler.indexOf("submitRelayerAfterPreflight")
    const post = handler.indexOf("postLiveClaim")
    expect(claimBody).toBeGreaterThan(-1)
    expect(simulate).toBeGreaterThan(claimBody)
    expect(post).toBeGreaterThan(simulate)
    expect(handler).toContain("presentRelayerError")
    expect(source).toContain("runRelayerSubmission")
    expect(source).toContain("relayerFlight")
  })

  it("does not post to the claim relayer when the relayer-wallet simulation reverts", async () => {
    const post = vi.fn()
    const client = {
      call: vi.fn(async () => {
        throw rpcRevert("0xf10068b5")
      }),
    }
    await expect(
      submitRelayerAfterPreflight({
        client,
        to: escrow,
        data: calldata,
        value: 0n,
        post,
      }),
    ).rejects.toBeTruthy()
    expect(CLAIM_RELAYER_WALLET).toBe("0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861")
    expect(client.call).toHaveBeenCalledWith({
      account: CLAIM_RELAYER_WALLET,
      to: escrow,
      data: calldata,
      value: 0n,
    })
    expect(post).not.toHaveBeenCalled()
    try {
      await submitRelayerAfterPreflight({ client, to: escrow, data: calldata, value: 0n, post })
    } catch (cause) {
      expect(presentError(cause).main).toBe("Filing opens the panel case in the same transaction. A case that is already resolved is not opened on this claim.")
    }
  })
})

describe("end-user main text", () => {
  const identifiers = [
    "createEscrow",
    "openDispute",
    "setDenylist",
    "setVault",
    "setDisputePanel",
    "setArbitrator",
    "escrowId",
    "subjectHash",
    "PANEL_SIZE",
    "arbitratorCount",
    "expiresAt",
    "lockedValue",
    "CORE_TIMELOCK",
    "bytes32",
    "durationSeconds",
    "payerBotId",
    "payeeBotId",
  ]

  it("keeps glossary sentences and fallback messages free of calls and identifiers", () => {
    const actions = ["createEscrow", "release", "refund", "dispute", "openDispute", "vote", "withdraw", "withdrawTo"]
    const mains = [
      ...ERROR_GLOSSARY.map((entry) => entry.meaning),
      WALLET_CANCEL_TEXT,
      REVERT_FALLBACK_TEXT,
      ...RELAYER_USER_TEXT,
      ...Object.values(FORM_ERRORS),
      durationValidationMessage(2_592_000),
      ...actions.map((action) => submitSenderNote(action)),
      ...actions.map((action) => previewCardCopy(action, true)),
      ...actions.map((action) => previewCardCopy(action, false)),
      "This check only runs on the Base Sepolia network. Nothing was sent.",
      "The network client isn't ready, so nothing was sent.",
      "Only the payer or payee on this claim can open a dispute. Switch to that wallet.",
      "This claim is no longer in a state where that action is allowed (it may already be released, refunded, or disputed). Refresh to see its current status.",
      RULING_PENDING_TEXT,
      POST_EXPIRY_REFUND_INTRO,
      ...POST_EXPIRY_REFUND_ORDER.map((step) => step.state),
      ...POST_EXPIRY_REFUND_ORDER.map((step) => step.outcome),
    ]
    const rejectsCode = (text: string) =>
      text.includes("()") ||
      /\b[a-z]+[A-Z][A-Za-z0-9]*\b/.test(text) ||
      /\b[A-Z][A-Z0-9_]{3,}\b/.test(text) ||
      /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/.test(text) ||
      /0x[0-9a-fA-F]+/.test(text) ||
      identifiers.some((name) => text.includes(name))
    expect(rejectsCode("The relayer returned broadcast_failed.")).toBe(true)
    expect(rejectsCode("See 0xabc for the raw payload.")).toBe(true)
    expect(rejectsCode("dispute() needs escrowId")).toBe(true)
    for (const text of mains) {
      expect(text).not.toContain("()")
      expect(text).not.toMatch(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/)
      expect(text).not.toMatch(/\b[A-Z][A-Z0-9_]{3,}\b/)
      expect(text).not.toMatch(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/)
      expect(text).not.toMatch(/0x[0-9a-fA-F]+/)
      for (const name of identifiers) {
        expect(text).not.toContain(name)
      }
      expect(rejectsCode(text)).toBe(false)
    }
    expect(REVERT_FALLBACK_TEXT).toContain("No funds moved")
    expect(RELAYER_RECEIPT_REVERTED_TEXT).not.toContain("No funds moved")
    expect(ERROR_GLOSSARY.find((entry) => entry.name === "not a party")?.meaning).toBe(
      "Only the payer or payee on this claim can open a dispute. Switch to that wallet.",
    )
    expect(ERROR_GLOSSARY.find((entry) => entry.name === "EscrowNotOpen")?.meaning).toBe(
      "This claim is no longer in a state where that action is allowed (it may already be released, refunded, or disputed). Refresh to see its current status.",
    )
  })
})
