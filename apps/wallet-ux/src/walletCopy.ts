/** User-facing copy for the Agent-BV vote and withdraw screens. */

export const VOTE_HEADING = "Agent-BV arbitrator vote"
export const WITHDRAW_HEADING = "Agent-BV withdraw"

export const NOT_ARBITRATOR_TEXT =
  "This wallet is not one of the Agent-BV dispute panel's arbitrators, so it can't vote."

export const NO_DISPUTE_TEXT = "No dispute exists with that identifier."

export const ALREADY_VOTED_TEXT = "This wallet already voted on this dispute. Votes can't be changed."

export const RESOLVED_LEAD = "This dispute is already resolved."

export const DEAL_STANDS_LABEL = "The deal stands: the payee gets paid"

export const UNDO_DEAL_LABEL = "Undo the deal: the payer gets refunded"

export const VOTE_CHOICE_TEXT = "Choose who should get the money before voting."

export const VOTE_NOTE =
  "A case resolves automatically on the 3rd vote. A vote can't be changed. After it resolves, someone still has to call release when the payee gets paid, or refund when the payer gets refunded, on the Agent-BV escrow. Then the recipient withdraws."

export const VOTE_MUTED =
  "Only an Agent-BV dispute panel arbitrator can vote. The deal stands and the payee gets paid, or the deal is undone and the payer gets refunded. The connected wallet signs this. This page does not ask for a private key or a recovery phrase."

export const VOTE_SENDER_NOTE =
  "Only an Agent-BV dispute panel arbitrator can vote. The deal stands and the payee gets paid, or the deal is undone and the payer gets refunded. The connected wallet signs this on Base Sepolia."

export const CASE_UNREADABLE_TEXT = "This dispute could not be read."

export const ARBITRATOR_UNREADABLE_TEXT = "This wallet's place on the Agent-BV dispute panel could not be read."

export const PANEL_SIZE_UNREADABLE_TEXT = "The number of votes that resolve the case could not be read."

export const VOTED_UNREADABLE_TEXT = "Whether this wallet already voted could not be read."

export const ARBITRATOR_READING_TEXT = "Reading whether this wallet is an Agent-BV dispute panel arbitrator."

export const CASE_READING_TEXT = "Reading this dispute."

export const NOTHING_TO_WITHDRAW_TEXT =
  "Nothing to withdraw. This wallet has no credit on this Agent-BV escrow."

export const WITHDRAW_GAS_TEXT = "Funds go to this connected wallet. This wallet pays the gas."

export const WITHDRAW_SENDER_NOTE = `${WITHDRAW_GAS_TEXT} The connected wallet signs this on Base Sepolia.`

export const WITHDRAW_FAILED_TEXT = "The withdrawal did not go through. The credit stays on the Agent-BV escrow."

export const WITHDRAW_UNREADABLE_TEXT = "Available to withdraw could not be read."

export const WITHDRAW_CONNECT_TEXT = "Connect a wallet on Base Sepolia to see what is available to withdraw."

export const WITHDRAW_READING_TEXT = "Reading what is available to withdraw."

export const WITHDRAW_HIDDEN_TEXT = "The Agent-BV escrow credit stays hidden while reads are refused."

export const TX_PENDING_TEXT = "Waiting for Base Sepolia…"

export const TX_CONFIRMED_TEXT = "Done"

export const TX_LINK_LABEL = "View this transaction on Base Sepolia"

export const TX_REVERTED_TEXT = "This transaction reverted on Base Sepolia."

export const TX_RECEIPT_UNREADABLE_TEXT = "This transaction was sent, but its receipt could not be read."

export const TX_STILL_PENDING_TEXT = "This transaction is still pending. Check it on Basescan."

/** viem stops waiting after 180 seconds and throws this name while the transaction can still be pending. */
export function isReceiptTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("name" in error)) return false
  return (error as { name: unknown }).name === "WaitForTransactionReceiptTimeoutError"
}

export function availableToWithdrawText(amount: string): string {
  return `Available to withdraw: ${amount}`
}

export function voteTallyText(votesFor: bigint, votesAgainst: bigint, panelSize: bigint | null): string {
  const counts = `Votes so far: ${votesFor.toString()} for the payee, ${votesAgainst.toString()} for the payer`
  if (panelSize == null) return `${counts}.`
  return `${counts} (${panelSize.toString()} votes resolve the case).`
}

export function resolvedCaseText(dealStands: boolean): string {
  return dealStands ? `${RESOLVED_LEAD} ${DEAL_STANDS_LABEL}.` : `${RESOLVED_LEAD} ${UNDO_DEAL_LABEL}.`
}

export function txExplorerUrl(txHash: string): string {
  return `https://sepolia.basescan.org/tx/${txHash}`
}

export type DisputeRow = {
  votesFor: bigint
  votesAgainst: bigint
  resolved: boolean
  dealStands: boolean
  createdAt: bigint
}

function field(value: unknown, index: number, name: string): unknown {
  if (Array.isArray(value)) return value[index]
  if (value && typeof value === "object" && name in value) return (value as Record<string, unknown>)[name]
  return undefined
}

/** `disputes(bytes32)` tuple: votesFor, votesAgainst, resolved, upheld, createdAt. Exists when createdAt is not zero. */
export function parseDisputeRow(value: unknown): DisputeRow | null {
  const votesFor = field(value, 3, "votesFor")
  const votesAgainst = field(value, 4, "votesAgainst")
  const resolved = field(value, 5, "resolved")
  const dealStands = field(value, 6, "upheld")
  const createdAt = field(value, 7, "createdAt")
  if (typeof votesFor !== "bigint" || typeof votesAgainst !== "bigint") return null
  if (typeof resolved !== "boolean" || typeof dealStands !== "boolean" || typeof createdAt !== "bigint") return null
  return { votesFor, votesAgainst, resolved, dealStands, createdAt }
}
