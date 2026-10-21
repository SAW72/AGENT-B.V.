export const REPUTATION_CHAIN_ID = 84532

export const USAGE_LEDGER_ID = "agent-bv-sepolia-reputation"
export const ARBITRATOR_LEDGER_ID = "agent-bv-sepolia-arbitrator-rep"

export type ReputationLedgerName = "usage" | "arbitrator"

export type DraftSlot<T> = {
  value: T
  status: string
}

export type LedgerPoints = {
  ledger: string
  final: number
  provisional: number
}

export type DisclaimerLinks = {
  master_disclaimer: string | null
  legal_notice_url: string | null
  as_is: string | null
  not_investment: string | null
  eligibility_notice: string | null
  abuse_policy: string | null
}

export type ReputationBalance = {
  address: string
  chainId: number
  ledgers: {
    usage: LedgerPoints
    arbitrator: LedgerPoints
  }
  eligibility: {
    status: string
    points_withheld: boolean
  }
  config_version: string
  rule_version: string
  indexed_to_block: number | null
  indexed_to_block_timestamp: number | null
  finalized_block: number | null
  disclaimer: {
    text: string
    links: DisclaimerLinks | null
  }
}

export type HistoryStatus = "provisional" | "final" | "cancelled"

export type HistoryItem = {
  entry_id: string
  ledger: string
  chain_id: number
  wallet: string
  bot_id: string | null
  outcome_code: string
  points: number
  status: string
  source_contract: string
  event_names: string[]
  tx_hash: string
  log_index: number
  block_number: number
  block_hash: string
  block_timestamp: number
  escrow_id: string | null
  dispute_id: string | null
  rule_version: string
  config_version: string
  cancel_reason: string | null
  cancelled_by: string | null
}

export type ReputationHistory = {
  address: string
  chainId: number
  ledger: ReputationLedgerName
  items: HistoryItem[]
  next_cursor: string | null
}

export type ReputationConfig = {
  chainId: number
  config_version: string
  rule_version: string
  product: string
  product_title: string
  status: string
  caps: Record<string, DraftSlot<number>>
  thresholds: {
    min_amount_wei: DraftSlot<string>
    o2_min_create_to_release_seconds: DraftSlot<number>
    o3_min_set_duration_seconds: DraftSlot<number>
    o5_standalone_disputes_threshold: DraftSlot<number>
    o5_window_days: DraftSlot<number>
    day_boundary: DraftSlot<string>
    season_length_days: DraftSlot<number>
    season_start_block: DraftSlot<number | null>
    season_start_timestamp: DraftSlot<number | null>
  }
}

export type ReputationSnapshot = {
  balance: ReputationBalance
  config: ReputationConfig
  history: Record<ReputationLedgerName, ReputationHistory>
}
