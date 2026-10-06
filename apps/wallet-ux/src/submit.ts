import type { Address } from "viem"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { BASE_MAINNET_CHAIN_ID, ETHEREUM_MAINNET_CHAIN_ID, type WalletChainId } from "./guard"
import { RELEASE_SENDER_NOTE } from "./preview"
import { VOTE_CHOICE_TEXT, VOTE_SENDER_NOTE, WITHDRAW_SENDER_NOTE } from "./walletCopy"

export type SubmitCode = "ok" | "disconnected" | "conflict" | "unknown" | "mainnet" | "base-mainnet" | "wrong-chain"

export type SubmitDecision =
  | { ok: true; code: "ok"; chainId: typeof BASE_SEPOLIA_CHAIN_ID }
  | { ok: false; code: Exclude<SubmitCode, "ok">; reason: string }

const SEPOLIA = `Base Sepolia (${BASE_SEPOLIA_CHAIN_ID})`

/** Wallet writes are allowed only while the connected wallet reports Base Sepolia. */
export function evaluateEscrowSubmit(input: {
  walletConnected: boolean
  walletChainId: WalletChainId
}): SubmitDecision {
  if (!input.walletConnected) {
    return {
      ok: false,
      code: "disconnected",
      reason: `Connect a wallet on ${SEPOLIA} to submit.`,
    }
  }
  if (input.walletChainId === "conflict") {
    return {
      ok: false,
      code: "conflict",
      reason: `Wallet chain id is inconsistent. Submit stays off until the wallet reports ${SEPOLIA}.`,
    }
  }
  if (input.walletChainId == null) {
    return {
      ok: false,
      code: "unknown",
      reason: `Wallet chain id is unknown. Submit stays off until the wallet reports ${SEPOLIA}.`,
    }
  }
  if (input.walletChainId === ETHEREUM_MAINNET_CHAIN_ID) {
    return {
      ok: false,
      code: "mainnet",
      reason: `Ethereum mainnet (chain id 1) is refused. Switch to ${SEPOLIA}.`,
    }
  }
  if (input.walletChainId === BASE_MAINNET_CHAIN_ID) {
    return {
      ok: false,
      code: "base-mainnet",
      reason: `Base mainnet (chain id 8453) is refused. Switch to ${SEPOLIA}.`,
    }
  }
  if (input.walletChainId !== BASE_SEPOLIA_CHAIN_ID) {
    return {
      ok: false,
      code: "wrong-chain",
      reason: `Chain id ${input.walletChainId} is refused. Switch to ${SEPOLIA}.`,
    }
  }
  return { ok: true, code: "ok", chainId: BASE_SEPOLIA_CHAIN_ID }
}

export function assertSubmitTarget(to: Address, allowed: readonly Address[]): void {
  const target = to.toLowerCase()
  if (!allowed.some((item) => item.toLowerCase() === target)) {
    throw new Error("Submit target is not the booked Base Sepolia escrow or dispute panel.")
  }
}

export function submitSenderNote(functionName: string): string {
  if (functionName === "createEscrow") {
    return "The connected wallet sends this new claim. It goes through only when that wallet is allowed to fund claims for the payer."
  }
  if (functionName === "dispute") {
    return "The payer or the payee has to send this. The connected wallet is the sender."
  }
  if (functionName === "openDispute") {
    return "The connected wallet sends this dispute to the panel on Base Sepolia."
  }
  if (functionName === "release") {
    return RELEASE_SENDER_NOTE
  }
  if (functionName === "refund") {
    return "Anyone can send a refund. The connected wallet sends this on Base Sepolia."
  }
  if (functionName === "vote") return VOTE_SENDER_NOTE
  if (functionName === "withdraw") return WITHDRAW_SENDER_NOTE
  return "The connected wallet sends this on Base Sepolia."
}

export function previewCardCopy(functionName: string, relayerConfigured: boolean): string {
  const lead =
    functionName === "createEscrow"
      ? "This prepares a new claim."
      : functionName === "release"
        ? "This prepares a payout of a claim."
        : functionName === "refund"
          ? "This prepares a refund of a claim."
          : functionName === "dispute"
            ? "This prepares one dispute on this claim. The connected wallet sends the claim, a new identifier, and the reason."
            : functionName === "openDispute"
              ? "This prepares opening a dispute."
              : functionName === "vote"
                ? "This prepares an Agent-BV arbitrator vote."
                : functionName === "withdraw"
                  ? "This prepares a withdrawal on the Agent-BV escrow."
                  : "This prepares a transaction."
  const relayer =
    relayerConfigured && functionName === "refund"
      ? " A refund can also be sent through the claim relayer on Base Sepolia."
      : ""
  return `${lead} Submit sends it from the connected wallet on Base Sepolia only.${relayer}`
}

export const FORM_ERRORS = {
  createIds: "Enter the claim identifier and both bot identifiers before creating a claim.",
  payee: "Enter the payee wallet address.",
  valueFormat: "Enter an amount of ETH, such as 0.01.",
  valueZero: "Enter an amount greater than zero. Nothing was sent.",
  releaseId: "Enter the claim identifier before releasing this claim.",
  refundId: "Enter the claim identifier before refunding this claim.",
  openIds: "Enter the claim identifier before opening a dispute.",
  openReason: "Enter a reason before opening a dispute.",
  subjectNetwork: "The network did not answer, so this dispute was not prepared.",
  subjectNoCode: "No escrow contract at this address on this network.",
  subjectRejected: "The escrow rejected the subject read, so this dispute was not prepared.",
  subjectNotBooked: "This contract did not return a dispute subject. It is not a supported escrow.",
  subjectNotOpen:
    "This claim is no longer in a state where that action is allowed (it may already be released, refunded, or disputed). Refresh to see its current status.",
  subjectExpired: "The claim window has closed, so this dispute can't be filed.",
  reasonTooLong: "The reason is longer than 256 bytes, so this dispute was not prepared.",
  subjectMissing: "This claim is not on the escrow yet, so this dispute was not prepared.",
  subjectPending: "The subject is still being read, so this dispute was not prepared.",
  disputeClaim: "Enter the claim identifier before opening a dispute.",
  disputeId: "Enter the dispute identifier before opening a dispute.",
  denylistHash: "Enter the identifier before looking it up.",
  denylistCheck: "Enter the weight, behavior, and prompt identifiers before checking the deny list.",
  voteId: "Enter the dispute identifier before voting.",
  voteChoice: VOTE_CHOICE_TEXT,
} as const

export function durationValidationMessage(maxSeconds: number): string {
  return `Enter a whole number of seconds from 1 through ${maxSeconds}, which is 30 days.`
}

export function submitControl(decision: SubmitDecision, pending: boolean): {
  testId: "sepolia-submit" | "submit-refused"
  disabled: boolean
  label: string
} {
  if (!decision.ok) {
    return { testId: "submit-refused", disabled: true, label: decision.reason }
  }
  if (pending) {
    return { testId: "sepolia-submit", disabled: true, label: "Submitting on Base Sepolia…" }
  }
  return { testId: "sepolia-submit", disabled: false, label: "Submit on Base Sepolia" }
}
