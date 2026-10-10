import { decodeFunctionData, type Address, type Hex } from "viem"
import {
  CLAIM_DEADLINE_SKEW_SECONDS,
  CLAIM_INTENT_ACTION_VALUES,
  CLAIM_INTENT_DOMAIN_NAME,
  CLAIM_INTENT_DOMAIN_VERSION,
  CLAIM_INTENT_PRIMARY_TYPE,
  CLAIM_INTENT_REFUSED_ACTIONS,
  CLAIM_INTENT_TYPES,
  claimActionIndex,
} from "./claimIntent"
import { escrowAbi } from "./abi"
import { BASE_SEPOLIA_CHAIN_ID, SUPERSEDED } from "./addresses"
import { presentError, presentRevertHex, type ErrorPresentation } from "./format"
import { BASE_MAINNET_CHAIN_ID, ETHEREUM_MAINNET_CHAIN_ID, type WalletChainId } from "./guard"
import { CLAIM_RELAYER_WALLET, submitRelayerAfterPreflight, type PreflightClient } from "./preflight"
import { RELEASE_NOT_RELAYABLE_TEXT, type CallPreview } from "./preview"
import { REVERT_FALLBACK_TEXT } from "./revert"
import { evaluateEscrowSubmit } from "./submit"

const RELAYER_ACTIONS = ["refund"] as const

export type RelayerAction = (typeof RELAYER_ACTIONS)[number]

export type RelayerConfig = {
  url: string | null
}

export type ClaimSignArgs = {
  domain: {
    name: typeof CLAIM_INTENT_DOMAIN_NAME
    version: typeof CLAIM_INTENT_DOMAIN_VERSION
    chainId: number
    verifyingContract: Address
  }
  types: typeof CLAIM_INTENT_TYPES
  primaryType: typeof CLAIM_INTENT_PRIMARY_TYPE
  message: {
    action: number
    escrowId: Hex
    sender: Address
    nonce: bigint
    deadline: bigint
  }
}

export type SignedLiveClaim = {
  live: true
  signature: Hex
  intent: {
    action: RelayerAction
    escrowId: Hex
    sender: Address
    nonce: string
    deadline: string
    chainId: number
    verifyingContract: Address
  }
}

export type LiveClaimBody = {
  action: RelayerAction
  claimId: Hex
  chainId: typeof BASE_SEPOLIA_CHAIN_ID
  live: true
}

export type LiveClaimResult = {
  txHash: Hex
  mode: "live"
  escrowAddress: Address | null
}

export const RELAYER_FETCH_TIMEOUT_MS = 30_000
export const RELAYER_RECEIPT_TIMEOUT_MS = 60_000
export const RELAYER_HEALTH_TIMEOUT_MS = 5_000

export const RELAYER_SUBMITTING_TEXT = "Submitting the refund request…"
export const RELAYER_WAITING_TEXT = "Waiting for confirmation…"
export const RELAYER_SUBMITTED_TEXT = "The refund relayer submitted this transaction."
export const RELAYER_CONFIRMED_TEXT = "The transaction is confirmed."
export const RELAYER_TX_LINK_LABEL = "View this transaction on Base Sepolia"
export const RELAYER_CHECK_WALLET_LABEL = "Check the relayer wallet on Base Sepolia"
export const RELAYER_PAUSED_NOTE = "The refund relayer is paused. Use your wallet to submit instead."
export const RELAYER_CHECKING_NOTE = "Checking whether the refund relayer is available."
export const RELAYER_DOWN_NOTE = "The refund relayer is unavailable. Use your wallet to submit instead."
export const RELAYER_CONNECT_NOTE = "Connect a wallet on Base Sepolia to sign this refund request."
export const RELAYER_SERVICE_DOWN_TEXT =
  "The refund service is not available right now. Nothing was sent. You can refund from your own wallet instead."
export const RELAYER_TIMEOUT_TEXT =
  "The refund relayer didn't answer in time. It may still have submitted this transaction. Check the relayer wallet on Base Sepolia before you try again."
export const RELAYER_RECEIPT_UNKNOWN_TEXT =
  "The refund relayer submitted this transaction, but this page could not confirm it. Check the transaction before you try again."
export const RELAYER_RECEIPT_REVERTED_TEXT =
  "The transaction was sent but the contract rejected it. Network fees may have been charged; no escrow funds moved."

export type RelayerPhase = "idle" | "submitting" | "confirming"

export type RelayerHealth = "unknown" | "ok" | "paused" | "down"

export type RelayerButtonModel =
  | { visible: false }
  | { visible: true; disabled: boolean; label: string; note: string | null }

export type RelayerRunResult =
  | { ok: true; txHash: Hex }
  | { ok: false; txHash: Hex | null; code: string | null; presentation: ErrorPresentation }

export function relayerTxUrl(txHash: string): string {
  return `https://sepolia.basescan.org/tx/${txHash}`
}

export function relayerWalletUrl(): string {
  return `https://sepolia.basescan.org/address/${CLAIM_RELAYER_WALLET}`
}

export class RelayerRequestError extends Error {
  readonly status: number | null
  readonly code: string
  readonly body: Record<string, unknown> | null

  constructor(message: string, status: number | null, code: string, body: Record<string, unknown> | null = null) {
    super(message)
    this.name = "RelayerRequestError"
    this.status = status
    this.code = code
    this.body = body
  }
}

export const RELAYER_COULD_NOT_SUBMIT =
  "The refund relayer couldn't submit this transaction. Nothing was sent from your wallet."

export const RELAYER_UNAVAILABLE_TEXT = "The refund relayer is unavailable. Nothing was sent."

const RELAYER_VALIDATION_TEXT = "The refund relayer could not accept this submission. Nothing was sent."
const RELAYER_NOT_LIVE_TEXT = "The refund relayer isn't accepting live submissions right now. Nothing was sent."
const RELAYER_RETIRED_TEXT =
  "The refund relayer is pointed at a retired escrow, so this was not submitted. Use your wallet instead."
const RELAYER_RETIRED_SENT_TEXT =
  "The refund relayer used a retired escrow. Check the transaction before you try again."

const RELAYER_PLAIN: Record<string, string> = {
  unauthorized: "The refund relayer refused this request. Nothing was sent.",
  forbidden: "The refund relayer refused this request. Nothing was sent.",
  invalid_signature: "The wallet signature was not accepted. Nothing was sent.",
  intent_required: "The refund relayer needs a signed approval from your wallet. Nothing was sent.",
  not_a_party: "Only the payer or the payee on this escrow can ask the relayer to submit it. Nothing was sent.",
  escrow_not_found: "That escrow is not on the escrow yet, so nothing was sent.",
  deadline_expired: "This approval has expired. Sign it again. Nothing was sent.",
  deadline_too_far: "This approval lasts too long. Nothing was sent.",
  calldata_hash_mismatch: "The prepared transaction does not match the signed approval. Nothing was sent.",
  calldata_mismatch: "The prepared transaction doesn't match this action. Nothing was sent.",
  trailing_bytes: "The prepared transaction has extra data, so it was not submitted.",
  high_s: "This approval signature is not in the required form. Nothing was sent.",
  selector_not_allowed: "This step has to be sent from your wallet, not the refund relayer.",
  domain_mismatch: "This approval is for a different escrow than the one this relayer uses. Nothing was sent.",
  gas_budget_exhausted: "The refund relayer has reached its daily limit. Try again later. Nothing was sent.",
  escrow_cap: "This escrow has reached the relayer limit for now. Nothing was sent.",
  nonce_in_flight: "This approval is already being submitted. Wait for it to finish.",
  nonce_replay: "This approval was already used. Nothing was sent.",
  relayer_key_missing: "The refund relayer is not ready to submit refunds yet. Nothing was sent.",
  kill_switch: "The refund relayer is paused. Nothing was sent.",
  cors_or_network: "The refund relayer could not be reached. Nothing was sent.",
  mainnet_refused: "The refund relayer only submits on the Base Sepolia network. Nothing was sent.",
  wrong_chain: "The refund relayer only submits on the Base Sepolia network. Nothing was sent.",
  action_not_claim: "This step has to be sent from your wallet, not the refund relayer.",
  release_not_relayable: RELEASE_NOT_RELAYABLE_TEXT,
  ruling_pending:
    "A dispute ruling is pending. Refund opens 7 days after expiry if the panel has not ruled. Nothing was sent.",
  invalid_relayer_url: "The refund relayer address is not valid. Nothing was sent.",
  invalid_bytes32: "A required identifier is missing or not the right length. Nothing was sent.",
  invalid_claim_id: "The Escrow ID was not accepted. Nothing was sent.",
  invalid_address: "A required wallet address is missing. Nothing was sent.",
  invalid_duration: "The time window for this escrow is missing. Nothing was sent.",
  invalid_amount: "This escrow needs an amount greater than zero. Nothing was sent.",
  invalid_uint: "A required number was not accepted. Nothing was sent.",
  invalid_parties: "The payer and payee must be different wallets. Nothing was sent.",
  invalid_json: RELAYER_VALIDATION_TEXT,
  value_not_allowed: "This action cannot include a payment amount. Nothing was sent.",
  action_required: "This step is missing the action the refund relayer needs. Nothing was sent.",
  payload_too_large: "This submission is too large for the refund relayer. Nothing was sent.",
  validation: RELAYER_VALIDATION_TEXT,
  unprocessable: RELAYER_VALIDATION_TEXT,
  live_required: "The refund relayer only accepts a live submission. Nothing was sent.",
  missing_tx_hash: "The refund relayer did not confirm a transaction. Nothing was shown as sent.",
  not_found: "The refund relayer could not find that submission path. Nothing was sent.",
  live_submit_blocked: RELAYER_NOT_LIVE_TEXT,
  escrow_not_booked: "The refund relayer has no escrow configured, so it will not submit. Nothing was sent.",
  escrow_not_booked_sepolia: "The refund relayer is not pointed at the booked escrow, so it will not submit. Nothing was sent.",
  escrow_booked_spencer_run_auth_required: RELAYER_NOT_LIVE_TEXT,
  live_submit_off: RELAYER_NOT_LIVE_TEXT,
  quote_does_not_broadcast: RELAYER_NOT_LIVE_TEXT,
  rate_limited: "The refund relayer is limiting submissions. Wait a moment and try again. Nothing was sent.",
  too_many_requests: "The refund relayer is limiting submissions. Wait a moment and try again. Nothing was sent.",
  retired_or_superseded_address: RELAYER_RETIRED_TEXT,
  timeout_unknown: RELAYER_TIMEOUT_TEXT,
}

export const RELAYER_PLAIN_TEXT = [RELAYER_COULD_NOT_SUBMIT, RELAYER_UNAVAILABLE_TEXT, ...Object.values(RELAYER_PLAIN)]

export const RELAYER_USER_TEXT = [
  ...RELAYER_PLAIN_TEXT,
  RELAYER_SUBMITTING_TEXT,
  RELAYER_WAITING_TEXT,
  RELAYER_SUBMITTED_TEXT,
  RELAYER_CONFIRMED_TEXT,
  RELAYER_TX_LINK_LABEL,
  RELAYER_CHECK_WALLET_LABEL,
  RELAYER_PAUSED_NOTE,
  RELAYER_CHECKING_NOTE,
  RELAYER_DOWN_NOTE,
  RELAYER_SERVICE_DOWN_TEXT,
  RELAYER_CONNECT_NOTE,
  RELAYER_RECEIPT_UNKNOWN_TEXT,
  RELAYER_RECEIPT_REVERTED_TEXT,
  RELAYER_RETIRED_SENT_TEXT,
]

export function relayerConfigFromEnv(env: { VITE_CLAIM_RELAYER_URL?: string }): RelayerConfig {
  const url = String(env.VITE_CLAIM_RELAYER_URL ?? "").trim().replace(/\/$/, "")
  return { url: url.length > 0 ? url : null }
}

/** The relayer spends gas only after the connected wallet signs. The wallet must be on Base Sepolia. */
export function relayerSubmitAllowed(input: {
  walletConnected: boolean
  walletChainId: WalletChainId
}): { ok: true } | { ok: false; reason: string } {
  if (!input.walletConnected) return { ok: false, reason: RELAYER_CONNECT_NOTE }
  const decision = evaluateEscrowSubmit(input)
  if (!decision.ok) return { ok: false, reason: decision.reason }
  return { ok: true }
}

export function assertRelayerChain(chainId: number): void {
  if (chainId === ETHEREUM_MAINNET_CHAIN_ID || chainId === BASE_MAINNET_CHAIN_ID) {
    throw new RelayerRequestError(
      `Chain id ${chainId} is mainnet. The refund relayer accepts Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}) only.`,
      null,
      "mainnet_refused",
    )
  }
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new RelayerRequestError(
      `Chain id ${chainId} is refused. The refund relayer accepts Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}) only.`,
      null,
      "wrong_chain",
    )
  }
}

function isRelayerAction(name: string): name is RelayerAction {
  return (RELAYER_ACTIONS as readonly string[]).includes(name)
}

export function previewSupportsRelayer(functionName: string): boolean {
  // Refund only. Release stays on the payer's wallet. Create, dispute, withdraw, and withdrawTo stay there too.
  return isRelayerAction(functionName)
}

export function relayerButtonModel(input: {
  url: string | null
  health: RelayerHealth
  phase: RelayerPhase
  gate: { ok: true } | { ok: false; reason: string }
  action: string
}): RelayerButtonModel {
  if (!input.url || !previewSupportsRelayer(input.action)) return { visible: false }
  if (!input.gate.ok) return { visible: true, disabled: true, label: input.gate.reason, note: null }
  if (input.phase === "submitting") {
    return { visible: true, disabled: true, label: RELAYER_SUBMITTING_TEXT, note: null }
  }
  if (input.phase === "confirming") {
    return { visible: true, disabled: true, label: RELAYER_WAITING_TEXT, note: null }
  }
  if (input.health === "paused") {
    return { visible: true, disabled: true, label: "Submit refund request", note: RELAYER_PAUSED_NOTE }
  }
  if (input.health === "down") {
    return { visible: true, disabled: true, label: "Submit refund request", note: RELAYER_DOWN_NOTE }
  }
  if (input.health !== "ok") {
    return { visible: true, disabled: true, label: "Submit refund request", note: RELAYER_CHECKING_NOTE }
  }
  return { visible: true, disabled: false, label: "Submit refund request", note: null }
}

function asHex32(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new RelayerRequestError(`Refund relayer needs a bytes32 ${field}.`, null, "invalid_bytes32")
  }
  return value as Hex
}

export function claimBodyFromPreview(preview: CallPreview): LiveClaimBody {
  assertRelayerChain(BASE_SEPOLIA_CHAIN_ID)
  if (preview.functionName === "release") {
    throw new RelayerRequestError(RELEASE_NOT_RELAYABLE_TEXT, null, "release_not_relayable")
  }
  if (!isRelayerAction(preview.functionName)) {
    throw new RelayerRequestError(
      "This step has to be sent from your wallet, not the refund relayer.",
      null,
      "action_not_claim",
    )
  }
  const decoded = decodeFunctionData({ abi: escrowAbi, data: preview.calldata })
  if (decoded.functionName !== preview.functionName) {
    throw new RelayerRequestError("Calldata does not match the preview action.", null, "calldata_mismatch")
  }
  const args = decoded.args ?? []
  return {
    action: preview.functionName,
    claimId: asHex32(args[0], "escrowId"),
    chainId: BASE_SEPOLIA_CHAIN_ID,
    live: true,
  }
}

function claimsEndpoint(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new RelayerRequestError("VITE_CLAIM_RELAYER_URL is not a valid URL.", null, "invalid_relayer_url")
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new RelayerRequestError("VITE_CLAIM_RELAYER_URL must be http or https.", null, "invalid_relayer_url")
  }
  if (parsed.username || parsed.password) {
    throw new RelayerRequestError("VITE_CLAIM_RELAYER_URL must not include credentials.", null, "invalid_relayer_url")
  }
  const base = `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`
  return base.endsWith("/v1/claims") ? base : `${base}/v1/claims`
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text()
  if (!text) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function errorFromResponse(status: number, body: Record<string, unknown> | null): RelayerRequestError {
  const error = typeof body?.error === "string" ? body.error : "request_failed"
  const reason = typeof body?.reason === "string" ? body.reason : ""
  if (status === 401 || error === "unauthorized") {
    return new RelayerRequestError(
      "Refund relayer refused the refund request (401 unauthorized).",
      401,
      error === "request_failed" ? "unauthorized" : error,
      body,
    )
  }
  if (status === 503 && error === "kill_switch") {
    return new RelayerRequestError(
      "Refund relayer kill switch is on (503). The refund request was not broadcast.",
      503,
      "kill_switch",
      body,
    )
  }
  if (status === 503) {
    return new RelayerRequestError(
      `Refund relayer is unavailable (503 ${error}). The refund request was not broadcast.`,
      503,
      error,
      body,
    )
  }
  const detail = reason ? `${error} (${reason})` : error
  return new RelayerRequestError(
    `Refund relayer rejected the refund request (${status} ${detail}).`,
    status,
    codeForStatus(status, error),
    body,
  )
}

function codeForStatus(status: number, error: string): string {
  if (error !== "request_failed") return error
  if (status === 400 || status === 422) return "validation"
  if (status === 401) return "unauthorized"
  if (status === 403) return "forbidden"
  if (status === 404) return "not_found"
  if (status === 409) return "live_submit_blocked"
  if (status === 413) return "payload_too_large"
  if (status === 429) return "rate_limited"
  return error
}

function isBlankRevertField(value: unknown): boolean {
  if (value == null) return true
  if (typeof value !== "string") return false
  const trimmed = value.trim()
  return trimmed === "" || trimmed === "0x"
}

/** First revert payload in revert_data, then revertData, then data. Blank values fall through. */
function bodyRevertHex(body: Record<string, unknown> | null): unknown {
  if (!body) return null
  const ordered: unknown[] = []
  if ("revert_data" in body) ordered.push(body.revert_data)
  if ("revertData" in body) ordered.push(body.revertData)
  if ("data" in body) ordered.push(body.data)
  for (const value of ordered) {
    if (!isBlankRevertField(value)) return value
  }
  return null
}

function withStatus(detail: string | null, status: number | null, code: string): string {
  const statusText = [status, code].filter((part) => part !== null && part !== "").join(" ")
  if (!detail) return `Details: ${statusText}`
  return `${detail} · ${statusText}`
}

function isRetiredEscrow(value: unknown): boolean {
  if (typeof value !== "string") return false
  const key = value.toLowerCase()
  return (
    key === SUPERSEDED.botAttestationEscrow.toLowerCase() ||
    key === SUPERSEDED.botAttestationEscrowEscM1.toLowerCase()
  )
}

function txHashFromBody(body: Record<string, unknown> | null): Hex | null {
  const txHash = body?.txHash
  if (typeof txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(txHash)) return txHash as Hex
  return null
}

function isRetiredResponse(error: RelayerRequestError): boolean {
  if (error.code === "retired_or_superseded_address") return true
  if (!error.body) return false
  return isRetiredEscrow(error.body.escrowAddress) || isRetiredEscrow(error.body.address)
}

function plainLine(code: string): string | null {
  return RELAYER_PLAIN[code] ?? null
}

function statusFallback(status: number | null): string | null {
  if (status === 400 || status === 422) return RELAYER_VALIDATION_TEXT
  if (status === 401 || status === 403) return plainLine("unauthorized")
  if (status === 404) return plainLine("not_found")
  if (status === 409) return RELAYER_NOT_LIVE_TEXT
  if (status === 413) return plainLine("payload_too_large")
  if (status === 429) return plainLine("rate_limited")
  if (status === 503) return RELAYER_UNAVAILABLE_TEXT
  return null
}

function plainFor(error: RelayerRequestError): string {
  if (error.code === "live_submit_blocked") {
    const reason = typeof error.body?.reason === "string" ? error.body.reason : ""
    const byReason = reason ? plainLine(reason) : null
    if (byReason) return byReason
  }
  return plainLine(error.code) ?? statusFallback(error.status) ?? RELAYER_COULD_NOT_SUBMIT
}

function withLink(presentation: ErrorPresentation, href: string, label: string): ErrorPresentation {
  return { ...presentation, link: { href, label } }
}

/** User-facing relayer failure. Raw status and codes stay in the details line. */
export function presentRelayerError(error: unknown): ErrorPresentation {
  if (!(error instanceof RelayerRequestError)) return presentError(error)
  const detail = withStatus(null, error.status, error.code)
  if (error.code === "broadcast_failed") {
    const decoded = presentRevertHex(bodyRevertHex(error.body))
    if (decoded) return { main: decoded.main, detail: withStatus(decoded.detail, error.status, error.code) }
    return { main: RELAYER_COULD_NOT_SUBMIT, detail }
  }
  if (isRetiredResponse(error)) {
    const hash = txHashFromBody(error.body)
    if (hash) {
      return withLink(
        { main: RELAYER_RETIRED_SENT_TEXT, detail },
        relayerTxUrl(hash),
        RELAYER_TX_LINK_LABEL,
      )
    }
    return { main: RELAYER_RETIRED_TEXT, detail }
  }
  if (error.code === "timeout_unknown") {
    return withLink({ main: RELAYER_TIMEOUT_TEXT, detail }, relayerWalletUrl(), RELAYER_CHECK_WALLET_LABEL)
  }
  return { main: plainFor(error), detail }
}

export function relayerErrorText(error: unknown): string {
  if (error instanceof RelayerRequestError) return error.message
  if (error instanceof Error && error.message.length > 0) return error.message
  return "Refund relayer request failed."
}

/**
 * POST /v1/claims with a signed intent. Chain id must be Base Sepolia (84532).
 * Mainnet is refused before fetch. No shared secret is sent.
 */
function isAbort(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("name" in error)) return false
  const name = String((error as { name: unknown }).name)
  return name === "AbortError" || name === "TimeoutError"
}

function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }))
    }, timeoutMs)
    fetchImpl(url, { ...init, signal: controller.signal }).then(
      (response) => {
        clearTimeout(timer)
        resolve(response)
      },
      (cause: unknown) => {
        clearTimeout(timer)
        if (isAbort(cause) || controller.signal.aborted) {
          reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }))
          return
        }
        reject(cause)
      },
    )
  })
}

function addressOrNull(value: unknown): Address | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null
  return value as Address
}

export async function postLiveClaim(input: {
  url: string
  body: SignedLiveClaim
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<LiveClaimResult> {
  assertRelayerChain(input.body.intent.chainId)
  if (input.body.live !== true) {
    throw new RelayerRequestError("Relayer submits must set live: true.", null, "live_required")
  }
  const endpoint = claimsEndpoint(input.url)
  const headers: Record<string, string> = { "content-type": "application/json" }
  const fetchImpl = input.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      endpoint,
      {
        method: "POST",
        headers,
        body: JSON.stringify(input.body),
      },
      input.timeoutMs ?? RELAYER_FETCH_TIMEOUT_MS,
    )
  } catch (cause) {
    if (cause instanceof RelayerRequestError) throw cause
    if (isAbort(cause)) {
      throw new RelayerRequestError(
        "The refund relayer did not answer before the page stopped waiting. The submission may still have been accepted.",
        null,
        "timeout_unknown",
      )
    }
    throw new RelayerRequestError(
      "Could not reach the refund relayer. If this is the Pages site, CORS on Render must allow this origin (https://agent-a-wallet-ux.pages.dev).",
      null,
      "cors_or_network",
    )
  }
  const json = await readJson(response)
  if (!response.ok) throw errorFromResponse(response.status, json)
  const txHash = json?.txHash
  if (json?.ok !== true || json.mode !== "live" || typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new RelayerRequestError("Refund relayer did not return a live transaction hash.", response.status, "missing_tx_hash")
  }
  const escrowAddress = addressOrNull(json.escrowAddress)
  if (escrowAddress && isRetiredEscrow(escrowAddress)) {
    throw new RelayerRequestError(
      "Refund relayer targeted a retired escrow.",
      response.status,
      "retired_or_superseded_address",
      json,
    )
  }
  return { txHash: txHash as Hex, mode: "live", escrowAddress }
}

export async function readRelayerHealth(input: {
  url: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<RelayerHealth> {
  let endpoint: string
  try {
    const parsed = new URL(input.url)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "down"
    if (parsed.username || parsed.password) return "down"
    endpoint = `${parsed.origin}/health`
  } catch {
    return "down"
  }
  try {
    const response = await fetchWithTimeout(
      input.fetchImpl ?? fetch,
      endpoint,
      { method: "GET" },
      input.timeoutMs ?? RELAYER_HEALTH_TIMEOUT_MS,
    )
    if (!response.ok) return "down"
    const json = await readJson(response)
    if (!json || json.ok !== true || typeof json.killSwitch !== "boolean") return "down"
    return json.killSwitch ? "paused" : "ok"
  } catch {
    return "down"
  }
}

export async function readRelayerPaused(input: {
  url: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<boolean | null> {
  const health = await readRelayerHealth(input)
  if (health === "down") return null
  if (health === "unknown") return null
  return health === "paused"
}

export type RelayerReceiptClient = {
  waitForTransactionReceipt: (args: { hash: Hex; timeout?: number }) => Promise<{ status: "success" | "reverted" }>
}

function isReceiptTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const name = "name" in error ? String((error as { name: unknown }).name) : ""
  return name === "WaitForTransactionReceiptTimeoutError" || name === "TimeoutError" || name === "AbortError"
}

function presentReceiptRevert(cause: unknown | null): ErrorPresentation {
  if (!cause) return { main: RELAYER_RECEIPT_REVERTED_TEXT, detail: null }
  const presented = presentError(cause)
  if (presented.main === REVERT_FALLBACK_TEXT || presented.main === "Something went wrong. Nothing was sent.") {
    return { main: RELAYER_RECEIPT_REVERTED_TEXT, detail: presented.detail }
  }
  return presented
}

export async function confirmRelayerReceipt(input: {
  client: RelayerReceiptClient & Partial<PreflightClient>
  hash: Hex
  timeoutMs?: number
  replay?: { to: Address; data: Hex; value: bigint }
}): Promise<{ status: "success" } | { status: "reverted"; cause: unknown | null } | { status: "unknown" }> {
  let receipt: { status: "success" | "reverted" }
  try {
    receipt = await input.client.waitForTransactionReceipt({
      hash: input.hash,
      timeout: input.timeoutMs ?? RELAYER_RECEIPT_TIMEOUT_MS,
    })
  } catch (cause) {
    if (isReceiptTimeout(cause) || cause instanceof Error) return { status: "unknown" }
    return { status: "unknown" }
  }
  if (receipt.status === "success") return { status: "success" }
  if (receipt.status !== "reverted") return { status: "unknown" }
  if (!input.replay || !input.client.call) return { status: "reverted", cause: null }
  try {
    await input.client.call({
      account: CLAIM_RELAYER_WALLET,
      to: input.replay.to,
      data: input.replay.data,
      value: input.replay.value,
    })
    return { status: "reverted", cause: null }
  } catch (cause) {
    return { status: "reverted", cause }
  }
}

/**
 * Reject actions the relayer does not accept, then simulate as the relayer
 * wallet, POST /v1/claims, and wait for the receipt. A timed-out POST does
 * not claim that nothing was broadcast.
 */
function randomNonce(): bigint {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value === 0n ? 1n : value
}

export function claimSignArgs(input: {
  preview: CallPreview
  sender: Address
  verifyingContract: Address
  nowSeconds?: number
  nonce?: bigint
}): ClaimSignArgs {
  const previewBody = claimBodyFromPreview(input.preview)
  const nonce = input.nonce ?? randomNonce()
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  const deadline = BigInt(nowSeconds + CLAIM_DEADLINE_SKEW_SECONDS)
  return {
    domain: {
      name: CLAIM_INTENT_DOMAIN_NAME,
      version: CLAIM_INTENT_DOMAIN_VERSION,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      verifyingContract: input.verifyingContract,
    },
    types: CLAIM_INTENT_TYPES,
    primaryType: CLAIM_INTENT_PRIMARY_TYPE,
    message: {
      action: claimActionIndex(previewBody.action),
      escrowId: previewBody.claimId,
      sender: input.sender,
      nonce,
      deadline,
    },
  }
}

function actionFromSignedIndex(index: number): RelayerAction {
  if (index === CLAIM_INTENT_REFUSED_ACTIONS.release) {
    throw new RelayerRequestError(RELEASE_NOT_RELAYABLE_TEXT, null, "release_not_relayable")
  }
  if (index === CLAIM_INTENT_ACTION_VALUES.refund) return "refund"
  throw new RelayerRequestError(
    "This step has to be sent from your wallet, not the refund relayer.",
    null,
    "action_not_claim",
  )
}

/** POST body is the typed-data message the wallet just signed. Deadline and nonce are not recomputed. */
export function signedClaimFromPreview(input: { signature: Hex; signArgs: ClaimSignArgs }): SignedLiveClaim {
  const message = input.signArgs.message
  return {
    live: true,
    signature: input.signature,
    intent: {
      action: actionFromSignedIndex(message.action),
      escrowId: message.escrowId,
      sender: message.sender,
      nonce: message.nonce.toString(),
      deadline: message.deadline.toString(),
      chainId: input.signArgs.domain.chainId,
      verifyingContract: input.signArgs.domain.verifyingContract,
    },
  }
}

export async function runRelayerSubmission(input: {
  url: string
  preview: CallPreview
  sender: Address
  verifyingContract: Address
  signTypedData: (args: ClaimSignArgs) => Promise<Hex>
  client: PreflightClient & RelayerReceiptClient
  fetchImpl?: typeof fetch
  fetchTimeoutMs?: number
  receiptTimeoutMs?: number
  nowSeconds?: number
  nonce?: bigint
  onPhase?: (phase: RelayerPhase, txHash?: Hex) => void
}): Promise<RelayerRunResult> {
  input.onPhase?.("submitting")
  let signArgs: ClaimSignArgs
  try {
    claimBodyFromPreview(input.preview)
    signArgs = claimSignArgs({
      preview: input.preview,
      sender: input.sender,
      verifyingContract: input.verifyingContract,
      nowSeconds: input.nowSeconds,
      nonce: input.nonce,
    })
  } catch (cause) {
    return {
      ok: false,
      txHash: null,
      code: cause instanceof RelayerRequestError ? cause.code : null,
      presentation: presentRelayerError(cause),
    }
  }
  let posted: LiveClaimResult
  try {
    posted = await submitRelayerAfterPreflight({
      client: input.client,
      to: input.preview.to,
      data: input.preview.calldata,
      value: input.preview.valueWei,
      post: async () => {
        const signature = await input.signTypedData(signArgs)
        return postLiveClaim({
          url: input.url,
          body: signedClaimFromPreview({ signature, signArgs }),
          fetchImpl: input.fetchImpl,
          timeoutMs: input.fetchTimeoutMs,
        })
      },
    })
  } catch (cause) {
    return {
      ok: false,
      txHash: txHashFromBody(cause instanceof RelayerRequestError ? cause.body : null),
      code: cause instanceof RelayerRequestError ? cause.code : null,
      presentation: presentRelayerError(cause),
    }
  }

  input.onPhase?.("confirming", posted.txHash)
  const receipt = await confirmRelayerReceipt({
    client: input.client,
    hash: posted.txHash,
    timeoutMs: input.receiptTimeoutMs,
    replay: { to: input.preview.to, data: input.preview.calldata, value: input.preview.valueWei },
  })
  if (receipt.status === "success") return { ok: true, txHash: posted.txHash }
  if (receipt.status === "reverted") {
    return {
      ok: false,
      txHash: posted.txHash,
      code: "receipt_reverted",
      presentation: withLink(presentReceiptRevert(receipt.cause), relayerTxUrl(posted.txHash), RELAYER_TX_LINK_LABEL),
    }
  }
  return {
    ok: false,
    txHash: posted.txHash,
    code: "receipt_unknown",
    presentation: withLink(
      { main: RELAYER_RECEIPT_UNKNOWN_TEXT, detail: null },
      relayerTxUrl(posted.txHash),
      RELAYER_TX_LINK_LABEL,
    ),
  }
}
