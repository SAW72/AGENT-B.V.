/**
 * EIP-712 ClaimIntent types for the connected wallet.
 * claim-relayer/claimIntent.json is the schema the relayer loads.
 * Domain name and version come from that file so the packages cannot drift.
 * The other constants must stay byte-identical with that file. The wallet-ux
 * test reads the JSON and fails if those copies drift.
 */

import claimIntentSchema from "../../../claim-relayer/claimIntent.json" with { type: "json" }

export const CLAIM_INTENT_DOMAIN_NAME = claimIntentSchema.domainName
export const CLAIM_INTENT_DOMAIN_VERSION = claimIntentSchema.domainVersion
export const CLAIM_INTENT_PRIMARY_TYPE = "ClaimIntent" as const
export const CLAIM_DEADLINE_SKEW_SECONDS = 240

export const CLAIM_INTENT_TYPE_STRING =
  "ClaimIntent(uint8 action,bytes32 escrowId,address sender,uint256 nonce,uint256 deadline)"

/** Allowlisted signed actions. Refund stays uint8 1. Release is not in this list. */
export const CLAIM_INTENT_ACTIONS = ["refund"] as const

export const CLAIM_INTENT_ACTION_VALUES = { refund: 1 } as const

/** Old uint8 0. Recognized so it is refused and never treated as refund. */
export const CLAIM_INTENT_REFUSED_ACTIONS = { release: 0 } as const

export const CLAIM_INTENT_TYPES = {
  ClaimIntent: [
    { name: "action", type: "uint8" },
    { name: "escrowId", type: "bytes32" },
    { name: "sender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const

export function claimActionIndex(action: string): number {
  if (Object.prototype.hasOwnProperty.call(CLAIM_INTENT_REFUSED_ACTIONS, action)) {
    throw new Error(`Refused claim action ${action}`)
  }
  if (action === "refund") return CLAIM_INTENT_ACTION_VALUES.refund
  throw new Error(`Unknown claim action ${action}`)
}
