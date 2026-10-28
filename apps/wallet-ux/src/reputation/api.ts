import { BASE_SEPOLIA_CHAIN_ID } from "../addresses"
import {
  NETWORK_ERROR,
  RATE_LIMITED,
  REFUSED,
} from "./copy"
import type {
  DisclaimerLinks,
  DraftSlot,
  HistoryItem,
  LedgerPoints,
  ReputationBalance,
  ReputationConfig,
  ReputationHistory,
  ReputationLedgerName,
} from "./types"

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const LEDGERS = new Set<ReputationLedgerName>(["usage", "arbitrator"])

export class ReputationRequestError extends Error {
  readonly status: number | null
  readonly code: string

  constructor(message: string, status: number | null, code: string) {
    super(message)
    this.name = "ReputationRequestError"
    this.status = status
    this.code = code
  }
}

export function reputationRoot(relayerUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(relayerUrl)
  } catch {
    throw new ReputationRequestError("VITE_CLAIM_RELAYER_URL is not a valid URL.", null, "invalid_relayer_url")
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ReputationRequestError("VITE_CLAIM_RELAYER_URL must be http or https.", null, "invalid_relayer_url")
  }
  if (parsed.username || parsed.password) {
    throw new ReputationRequestError("VITE_CLAIM_RELAYER_URL must not include credentials.", null, "invalid_relayer_url")
  }
  let path = parsed.pathname.replace(/\/$/, "")
  if (path.endsWith("/v1/claims")) path = path.slice(0, -"/v1/claims".length)
  return `${parsed.origin}${path}`
}

export function reputationBalanceUrl(root: string, address: string): string {
  return `${root}/v1/reputation/${address.toLowerCase()}?chainId=${BASE_SEPOLIA_CHAIN_ID}`
}

export function reputationConfigUrl(root: string): string {
  return `${root}/v1/reputation/config?chainId=${BASE_SEPOLIA_CHAIN_ID}`
}

export function reputationHistoryUrl(
  root: string,
  address: string,
  ledger: ReputationLedgerName,
  cursor: string | null,
  limit = 25,
): string {
  const url = new URL(`${root}/v1/reputation/${address.toLowerCase()}/history`)
  url.searchParams.set("chainId", String(BASE_SEPOLIA_CHAIN_ID))
  url.searchParams.set("ledger", ledger)
  url.searchParams.set("limit", String(limit))
  if (cursor) url.searchParams.set("cursor", cursor)
  return url.toString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function invalid(field: string): never {
  throw new ReputationRequestError(NETWORK_ERROR, null, `invalid_response:${field}`)
}

function requireChain(value: unknown): number {
  if (value !== BASE_SEPOLIA_CHAIN_ID) invalid("chainId")
  return BASE_SEPOLIA_CHAIN_ID
}

function requireAddress(value: unknown): string {
  if (typeof value !== "string" || !ADDRESS.test(value)) invalid("address")
  return value.toLowerCase()
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(field)
  return value
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field)
  return value
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null
  return requireNumber(value, field)
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null
  return requireString(value, field)
}

function parseLedgerPoints(value: unknown, field: string): LedgerPoints {
  if (!isRecord(value)) invalid(field)
  return {
    ledger: requireString(value.ledger, `${field}.ledger`),
    final: requireNumber(value.final, `${field}.final`),
    provisional: requireNumber(value.provisional, `${field}.provisional`),
  }
}

function parseLinks(value: unknown): DisclaimerLinks | null {
  if (value === null) return null
  if (!isRecord(value)) invalid("disclaimer.links")
  const link = (key: keyof DisclaimerLinks): string | null => {
    const slot = value[key]
    if (slot === null || slot === undefined) return null
    if (typeof slot !== "string") invalid(`disclaimer.links.${key}`)
    const trimmed = slot.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  return {
    master_disclaimer: link("master_disclaimer"),
    legal_notice_url: link("legal_notice_url"),
    as_is: link("as_is"),
    not_investment: link("not_investment"),
    eligibility_notice: link("eligibility_notice"),
    abuse_policy: link("abuse_policy"),
  }
}

export function parseBalance(value: unknown): ReputationBalance {
  if (!isRecord(value) || !isRecord(value.ledgers) || !isRecord(value.eligibility) || !isRecord(value.disclaimer)) {
    invalid("balance")
  }
  if ("total" in value || "total" in value.ledgers) invalid("total")
  return {
    address: requireAddress(value.address),
    chainId: requireChain(value.chainId),
    ledgers: {
      usage: parseLedgerPoints(value.ledgers.usage, "ledgers.usage"),
      arbitrator: parseLedgerPoints(value.ledgers.arbitrator, "ledgers.arbitrator"),
    },
    eligibility: {
      status: requireString(value.eligibility.status, "eligibility.status"),
      points_withheld: value.eligibility.points_withheld === true,
    },
    config_version: requireString(value.config_version, "config_version"),
    rule_version: requireString(value.rule_version, "rule_version"),
    indexed_to_block: nullableNumber(value.indexed_to_block, "indexed_to_block"),
    indexed_to_block_timestamp: nullableNumber(value.indexed_to_block_timestamp, "indexed_to_block_timestamp"),
    finalized_block: nullableNumber(value.finalized_block, "finalized_block"),
    disclaimer: {
      text: requireString(value.disclaimer.text, "disclaimer.text"),
      links: parseLinks(value.disclaimer.links),
    },
  }
}

function parseHistoryItem(value: unknown): HistoryItem {
  if (!isRecord(value)) invalid("history.item")
  if (!Array.isArray(value.event_names) || value.event_names.some((name) => typeof name !== "string")) {
    invalid("event_names")
  }
  return {
    entry_id: requireString(value.entry_id, "entry_id"),
    ledger: requireString(value.ledger, "ledger"),
    chain_id: requireChain(value.chain_id),
    wallet: requireAddress(value.wallet),
    bot_id: nullableString(value.bot_id, "bot_id"),
    outcome_code: requireString(value.outcome_code, "outcome_code"),
    points: requireNumber(value.points, "points"),
    status: requireString(value.status, "status"),
    source_contract: requireString(value.source_contract, "source_contract"),
    event_names: value.event_names as string[],
    tx_hash: requireString(value.tx_hash, "tx_hash"),
    log_index: requireNumber(value.log_index, "log_index"),
    block_number: requireNumber(value.block_number, "block_number"),
    block_hash: requireString(value.block_hash, "block_hash"),
    block_timestamp: requireNumber(value.block_timestamp, "block_timestamp"),
    escrow_id: nullableString(value.escrow_id, "escrow_id"),
    dispute_id: nullableString(value.dispute_id, "dispute_id"),
    rule_version: requireString(value.rule_version, "rule_version"),
    config_version: requireString(value.config_version, "config_version"),
    cancel_reason: nullableString(value.cancel_reason, "cancel_reason"),
    cancelled_by: nullableString(value.cancelled_by, "cancelled_by"),
  }
}

export function parseHistory(value: unknown): ReputationHistory {
  if (!isRecord(value) || !Array.isArray(value.items)) invalid("history")
  const ledger = value.ledger
  if (ledger !== "usage" && ledger !== "arbitrator") invalid("ledger")
  const cursor = value.next_cursor
  if (cursor !== null && typeof cursor !== "string") invalid("next_cursor")
  return {
    address: requireAddress(value.address),
    chainId: requireChain(value.chainId),
    ledger,
    items: value.items.map(parseHistoryItem),
    next_cursor: cursor,
  }
}

function parseNumberSlot(value: unknown, field: string): DraftSlot<number> {
  if (!isRecord(value) || typeof value.status !== "string") invalid(field)
  return { value: requireNumber(value.value, field), status: value.status }
}

function parseStringSlot(value: unknown, field: string): DraftSlot<string> {
  if (!isRecord(value) || typeof value.status !== "string") invalid(field)
  return { value: requireString(value.value, field), status: value.status }
}

function parseNullableNumberSlot(value: unknown, field: string): DraftSlot<number | null> {
  if (!isRecord(value) || typeof value.status !== "string") invalid(field)
  return { value: nullableNumber(value.value, field), status: value.status }
}

export function parseConfig(value: unknown): ReputationConfig {
  if (!isRecord(value) || !isRecord(value.caps) || !isRecord(value.thresholds)) invalid("config")
  const caps: Record<string, DraftSlot<number>> = {}
  for (const [key, slot] of Object.entries(value.caps)) {
    caps[key] = parseNumberSlot(slot, `caps.${key}`)
  }
  const thresholds = value.thresholds
  return {
    chainId: requireChain(value.chainId),
    config_version: requireString(value.config_version, "config_version"),
    rule_version: requireString(value.rule_version, "rule_version"),
    product: requireString(value.product, "product"),
    product_title: requireString(value.product_title, "product_title"),
    status: requireString(value.status, "status"),
    caps,
    thresholds: {
      min_amount_wei: parseStringSlot(thresholds.min_amount_wei, "min_amount_wei"),
      o2_min_create_to_release_seconds: parseNumberSlot(
        thresholds.o2_min_create_to_release_seconds,
        "o2_min_create_to_release_seconds",
      ),
      o3_min_set_duration_seconds: parseNumberSlot(thresholds.o3_min_set_duration_seconds, "o3_min_set_duration_seconds"),
      o5_standalone_disputes_threshold: parseNumberSlot(
        thresholds.o5_standalone_disputes_threshold,
        "o5_standalone_disputes_threshold",
      ),
      o5_window_days: parseNumberSlot(thresholds.o5_window_days, "o5_window_days"),
      day_boundary: parseStringSlot(thresholds.day_boundary, "day_boundary"),
      season_length_days: parseNumberSlot(thresholds.season_length_days, "season_length_days"),
      season_start_block: parseNullableNumberSlot(thresholds.season_start_block, "season_start_block"),
      season_start_timestamp: parseNullableNumberSlot(thresholds.season_start_timestamp, "season_start_timestamp"),
    },
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function errorForStatus(status: number, body: unknown): ReputationRequestError {
  const code = isRecord(body) && typeof body.error === "string" ? body.error : "request_failed"
  if (status === 400) return new ReputationRequestError(REFUSED, 400, code)
  if (status === 429) return new ReputationRequestError(RATE_LIMITED, 429, code || "rate_limited")
  return new ReputationRequestError(NETWORK_ERROR, status, code)
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response
  try {
    response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" } })
  } catch {
    throw new ReputationRequestError(NETWORK_ERROR, null, "network")
  }
  const body = await readBody(response)
  if (!response.ok) throw errorForStatus(response.status, body)
  return body
}

function assertAddress(address: string): string {
  if (!ADDRESS.test(address)) {
    throw new ReputationRequestError(REFUSED, 400, "invalid_address")
  }
  return address.toLowerCase()
}

export async function fetchReputationBalance(
  root: string,
  address: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReputationBalance> {
  const wallet = assertAddress(address)
  return parseBalance(await getJson(reputationBalanceUrl(root, wallet), fetchImpl))
}

export async function fetchReputationConfig(
  root: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReputationConfig> {
  return parseConfig(await getJson(reputationConfigUrl(root), fetchImpl))
}

export async function fetchReputationHistory(
  root: string,
  address: string,
  ledger: ReputationLedgerName,
  cursor: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ReputationHistory> {
  if (!LEDGERS.has(ledger)) {
    throw new ReputationRequestError(REFUSED, 400, "invalid_ledger")
  }
  const wallet = assertAddress(address)
  return parseHistory(await getJson(reputationHistoryUrl(root, wallet, ledger, cursor), fetchImpl))
}
