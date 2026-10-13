import { confirmedNext } from "./routes"

export const GAS_FEE_TEXT = "Your wallet pays a small Base Sepolia gas fee in test ETH"
export const CANCELLED_IDLE_TEXT = "You cancelled. Nothing was sent."
export const PENDING_SLOW_TEXT = "Still waiting. This can take a minute on testnet. Do not submit this again."
export const PENDING_SLOW_MS = 60_000
export const BALANCE_WARN_TEXT = "This amount is more than the test ETH in this wallet. You can still continue."
export const ANOTHER_PENDING_REASON = "Another transaction is still pending"
export const REFUND_ALREADY_PENDING_REASON = "This refund is already pending"
export const VOTE_SEAT_REASON = "Only seated arbitrators can vote."
export const PREPARE_FIRST_REASON = "Prepare this step before submitting."

export type ActionProgress = {
  pending: string
  done: string
  next?: { href: string; label: string }
}

export const ACTION_PROGRESS: Record<string, ActionProgress> = {
  createEscrow: {
    pending: "Funding escrow…",
    done: "Escrow funded",
  },
  release: {
    pending: "Releasing payment…",
    done: "Payment released",
  },
  refund: {
    pending: "Refunding payment…",
    done: "Payment refunded",
  },
  dispute: {
    pending: "Opening dispute…",
    done: "Dispute opened",
  },
  vote: { pending: "Casting vote…", done: "Vote cast" },
  withdraw: { pending: "Withdrawing…", done: "Withdrawn" },
}

/** Pending and done copy, plus the confirmed Next route for this action and id. */
export function actionProgress(functionName: string, subjectId: string | null = null): ActionProgress {
  const base = ACTION_PROGRESS[functionName] ?? { pending: "Submitting…", done: "Done" }
  const next = confirmedNext(functionName, subjectId)
  return next ? { pending: base.pending, done: base.done, next } : { pending: base.pending, done: base.done }
}

export const CONTRACT_LABELS = {
  escrow: "Bot attestation escrow",
  panel: "Dispute panel",
} as const
