import { DISPLAY_NAME } from "../brand"

/** Required line beside every reputation balance. */
export const BALANCE_LINE =
  "Testnet only. Not a token. Can't be transferred, sold, or redeemed. May be adjusted or cancelled, and does not convert to anything."

export const LATER_LABEL = "Testnet reputation (Base Sepolia)"

export const UNAVAILABLE = "Reputation unavailable"

export const REFUSED = "Reputation request was refused."

export const RATE_LIMITED = "Reputation is rate limited. Try again in a minute."

export const NETWORK_ERROR = "Could not load reputation."

export const WITHHELD = "Points withheld until eligibility is verified"

export const PLACEHOLDER_ELIGIBILITY = "Checklist #7 is open. Eligibility rules are not published yet."

export const PLACEHOLDER_ABUSE = "Checklist #9 is open. The abuse policy link is not published yet."

export const PLACEHOLDER_DISCLAIMER = "Checklist #11 is open. Disclaimer and AS IS links are not published yet."

export const PLACEHOLDER_CAPS = "Checklist #12 is open. Caps are draft."

export const LEDGERS_ARE_SEPARATE = "Usage ledger and arbitrator ledger are separate."

export function firstUseLabel(productTitle: string): string {
  return `${productTitle} testnet reputation (Base Sepolia)`
}

export function reputationHeading(productTitle: string | null, introduced: boolean): string {
  if (introduced) return LATER_LABEL
  return firstUseLabel(productTitle && productTitle.trim().length > 0 ? productTitle : DISPLAY_NAME)
}

const OUTCOMES: Record<string, string> = {
  O1: "Bot onboarded",
  O2: "Escrow completed without dispute",
  O3: "Refund path exercised",
  O4: "Dispute path completed",
  O5: "Standalone dispute",
  A1: "Vote on a resolved escrow dispute",
  A2: "Vote matched the outcome",
  ADJ: "Manual adjustment",
}

export function outcomePlain(code: string): string {
  return OUTCOMES[code] ?? code
}

export const CAP_LABELS: Record<string, string> = {
  usage_points_per_wallet_per_day: "Usage points per wallet per day",
  usage_points_per_bot_per_day: "Usage points per bot per day",
  escrows_per_wallet_per_day: "Counted escrows per wallet per day",
  o3_per_wallet_per_day: "Refund-path counts per wallet per day",
  o4_per_wallet_per_day: "Dispute-path counts per wallet per day",
  pair_per_day: "Same payer and payee pair per day",
  pair_lifetime: "Same payer and payee pair lifetime",
  usage_points_per_wallet_per_season: "Usage points per wallet per season",
  arbitrator_points_per_day: "Arbitrator points per day",
}

export function capLabel(key: string): string {
  return CAP_LABELS[key] ?? key
}

export function txExplorerUrl(txHash: string): string {
  return `https://sepolia.basescan.org/tx/${txHash}`
}

export function pointsAreWithheld(status: string, pointsWithheld: boolean): boolean {
  return pointsWithheld || status === "unverified"
}
