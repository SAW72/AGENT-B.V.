import { encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from "viem"
import { disputePanelAbi, escrowAbi } from "./abi"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"

export const MAX_DURATION_SECONDS = 30 * 24 * 60 * 60

export type CallPreview = {
  to: Address
  functionName: string
  calldata: Hex
  valueWei: bigint
}

export type ErrorGlossaryEntry = {
  name: string
  meaning: string
}

/** Shown when a refund hits an unresolved dispute inside the 7-day ruling window. */
export const RULING_PENDING_TEXT =
  "A dispute ruling is pending. Refund opens 7 days after expiry if the panel has not ruled."

/**
 * `DisputePending` on the #56 escrow.
 * Release: a party while the linked case is unresolved or was unwound.
 * Refund: before the claim ends, until the panel unwinds the deal; also whenever the panel upheld it.
 */
export const DISPUTE_PENDING_TEXT =
  "Release stays blocked while the dispute is unresolved or was unwound. A refund before the claim ends stays blocked until the panel unwinds the deal. A refund also stays blocked when the panel upheld the deal."

/**
 * Filing opens the panel case in the same transaction.
 * Votes cast on another case are not read.
 */
export const DISPUTE_VOTES_CAST_TEXT =
  "Filing opens the panel case in the same transaction. Votes cast on another case are not read."

export const POST_EXPIRY_REFUND_INTRO = "After the claim ends, a refund is decided in this order."

/** Post-expiry refund checks, in contract order. */
export const POST_EXPIRY_REFUND_ORDER = [
  { state: "Open", error: null, outcome: "The payer is refunded." },
  { state: "Disputed and upheld", error: "DisputePending", outcome: "The payee releases." },
  {
    state: "Disputed, unresolved, within 7 days after the claim ends",
    error: "RulingPending",
    outcome: RULING_PENDING_TEXT,
  },
  { state: "Otherwise", error: null, outcome: "The payer is refunded." },
] as const

export const FILE_DISPUTE_TEXT =
  "One transaction files this dispute. The identifier is random, so it cannot be guessed from the claim. If that identifier is already open, generate a new one. The claim stays open until a fresh identifier is filed."

export const FILE_DISPUTE_BUTTON = "Prepare this dispute"
export const NEW_CASE_ID_BUTTON = "Generate a new identifier"
export const CASE_ID_HINT = "A new random identifier for this case. It is not taken from the claim or the clock."

/** Contract error ReleaseNotAuthorized. */
export const RELEASE_NOT_AUTHORIZED_TEXT =
  "Only the payer can release an open escrow; after an upheld dispute, the payer or the payee."

export const RELEASE_NOT_RELAYABLE_TEXT = `${RELEASE_NOT_AUTHORIZED_TEXT} Send it from that wallet. Nothing was sent.`

export const RELEASE_SENDER_NOTE = `${RELEASE_NOT_AUTHORIZED_TEXT} The connected wallet sends this payout on Base Sepolia.`

/** Plain-English meanings for contract reverts. These builders do not submit. */
export const ERROR_GLOSSARY: readonly ErrorGlossaryEntry[] = [
  { name: "FundingBeforeGovernance", meaning: "New claims can't be created yet. The contract owner still needs to accept the governance handover." },
  { name: "EscrowNotOpen", meaning: "This claim is no longer in a state where that action is allowed (it may already be released, refunded, or disputed). Refresh to see its current status." },
  { name: "EscrowExpired", meaning: "This claim's time window has ended, so it can't be paid out that way. A dispute decided for the payee can still be paid out." },
  { name: "AttestationFailed", meaning: "This claim can't be created. The amount or the time window isn't allowed, or one of the bots is inactive, not approved for payments, blocked, or on the deny list." },
  { name: "InvalidParties", meaning: "The payer and payee aren't valid. They must be two different wallets, with two different bots, and the connected wallet must be allowed to act for the payer." },
  { name: "Replay", meaning: "This claim identifier was already used. Choose a new one." },
  { name: "InvalidDispute", meaning: "This dispute identifier can't be used. It is blank, or it matches the claim, the subject stored for the panel, or the claim mixed with the time the claim was created." },
  { name: "DisputeAlreadyResolved", meaning: "Filing opens the panel case in the same transaction. A case that is already resolved is not opened on this claim." },
  { name: "DisputeVotesCast", meaning: DISPUTE_VOTES_CAST_TEXT },
  { name: "DisputePredatesEscrow", meaning: "Filing opens the panel case in the same transaction. A case opened before this claim is not opened on this claim." },
  { name: "DisputeChallengerNotParty", meaning: "Filing opens the panel case in the same transaction. The escrow opens that case, and the caller is stored as the party." },
  { name: "ReleaseNotAuthorized", meaning: RELEASE_NOT_AUTHORIZED_TEXT },
  { name: "NotParty", meaning: "This wallet is not a party to this escrow." },
  { name: "DisputeAfterExpiry", meaning: "The claim window has closed, so this dispute can't be filed." },
  { name: "DisputeReasonTooLong", meaning: "The reason is longer than 256 bytes, so this dispute was not filed." },
  { name: "DisputePending", meaning: DISPUTE_PENDING_TEXT },
  { name: "RulingPending", meaning: RULING_PENDING_TEXT },
  { name: "ZeroAddress", meaning: "A required wallet address was left blank." },
  { name: "InvalidGovernance", meaning: "This contract was set up with its deployer as the governor, which isn't allowed." },
  { name: "NotGovernance", meaning: "Only the governor can do that, and the contract owner must already be the governor." },
  { name: "DependencyChangeWhileFunded", meaning: "Those settings can't be changed while funds are still locked in claims." },
  { name: "DenylistUnchanged", meaning: "That deny list is already the one in use." },
  { name: "VaultUnchanged", meaning: "That vault is already the one in use." },
  { name: "DisputePanelUnchanged", meaning: "That dispute panel is already the one in use." },
  { name: "not a party", meaning: "Only the payer or payee on this claim can open a dispute. Switch to that wallet." },
  { name: "not expired", meaning: "This claim can't be refunded yet. Its time window is still open." },
  { name: "transfer failed", meaning: "Paying the payee didn't go through. No funds were released." },
  { name: "refund failed", meaning: "The refund didn't go through. No funds were returned." },
  { name: "panel not seated", meaning: "A dispute can't be opened yet. The panel doesn't have enough members." },
  { name: "exists", meaning: "A dispute with this identifier is already open. Generate a new identifier and file again. The claim stays open." },
  { name: "not authorized", meaning: "Only a panel member can vote on this dispute." },
  { name: "no dispute", meaning: "There is no dispute with that identifier to vote on." },
  { name: "resolved", meaning: "This dispute is already decided, so it can't be voted on." },
  { name: "already voted", meaning: "You already voted on this dispute." },
  { name: "not owner", meaning: "Only the panel owner can do that." },
  { name: "zero arbitrator", meaning: "A panel member's wallet address was left blank." },
  { name: "nothing to withdraw", meaning: "This wallet has no credit to withdraw." },
  { name: "WithdrawFailed", meaning: "The withdrawal did not go through. The credit stays where it was." },
]

export function previewCreateEscrow(input: {
  escrow: Address
  escrowId: Hex
  payee: Address
  payerBotId: Hex
  payeeBotId: Hex
  durationSeconds: bigint
  valueWei: bigint
}): CallPreview {
  return {
    to: input.escrow,
    functionName: "createEscrow",
    valueWei: input.valueWei,
    calldata: encodeFunctionData({
      abi: escrowAbi,
      functionName: "createEscrow",
      args: [input.escrowId, input.payee, input.payerBotId, input.payeeBotId, input.durationSeconds],
    }),
  }
}

/**
 * Subject a panel case must use for this escrow row.
 * Matches `BotAttestationEscrow.panelSubject`: `keccak256(abi.encode(chainId, escrow, escrowId, createdAt))`.
 */
export function panelSubject(
  escrow: Address,
  escrowId: Hex,
  createdAt: bigint,
  chainId: number = BASE_SEPOLIA_CHAIN_ID,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }],
      [BigInt(chainId), escrow, escrowId, createdAt],
    ),
  )
}

export function previewRelease(escrow: Address, escrowId: Hex): CallPreview {
  return {
    to: escrow,
    functionName: "release",
    valueWei: 0n,
    calldata: encodeFunctionData({ abi: escrowAbi, functionName: "release", args: [escrowId] }),
  }
}

export function previewRefund(escrow: Address, escrowId: Hex): CallPreview {
  return {
    to: escrow,
    functionName: "refund",
    valueWei: 0n,
    calldata: encodeFunctionData({ abi: escrowAbi, functionName: "refund", args: [escrowId] }),
  }
}

/** One wallet call: dispute(escrowId, disputeId, reason). The escrow opens the panel case. */
export function previewDispute(escrow: Address, escrowId: Hex, disputeId: Hex, reason: string): CallPreview {
  return {
    to: escrow,
    functionName: "dispute",
    valueWei: 0n,
    calldata: encodeFunctionData({
      abi: escrowAbi,
      functionName: "dispute",
      args: [escrowId, disputeId, reason],
    }),
  }
}

/** Panel-only preview. The dispute form does not send this. The escrow calls it inside dispute(). */
export function previewOpenDispute(panel: Address, disputeId: Hex, subjectHash: Hex, reason: string): CallPreview {
  return {
    to: panel,
    functionName: "openDispute",
    valueWei: 0n,
    calldata: encodeFunctionData({
      abi: disputePanelAbi,
      functionName: "openDispute",
      args: [disputeId, subjectHash, reason],
    }),
  }
}

/** Allowlisted arbitrator vote. The connected wallet is the signer. */
export function previewVote(panel: Address, disputeId: Hex, support: boolean): CallPreview {
  return {
    to: panel,
    functionName: "vote",
    valueWei: 0n,
    calldata: encodeFunctionData({
      abi: disputePanelAbi,
      functionName: "vote",
      args: [disputeId, support],
    }),
  }
}

/** Pull the caller's full credit to the caller. */
export function previewWithdraw(escrow: Address): CallPreview {
  return {
    to: escrow,
    functionName: "withdraw",
    valueWei: 0n,
    calldata: encodeFunctionData({ abi: escrowAbi, functionName: "withdraw" }),
  }
}

/** Pull the caller's full credit to `to`. */
export function previewWithdrawTo(escrow: Address, to: Address): CallPreview {
  return {
    to: escrow,
    functionName: "withdrawTo",
    valueWei: 0n,
    calldata: encodeFunctionData({
      abi: escrowAbi,
      functionName: "withdrawTo",
      args: [to],
    }),
  }
}
