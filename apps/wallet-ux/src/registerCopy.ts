import { REGISTER_ERROR_CODES, type ParsedRegistration, type RegisterErrorCode, type RegisterUiNotice } from "./register/types"

export { REGISTER_ERROR_CODES }

/**
 * User-facing copy for the register wizard (spec Rev 3).
 * Install text is not here. The wizard imports INSTALL_WALLET_HINT from walletHint.ts.
 */

function textOf(value: string | number | bigint | null | undefined): string {
  if (value == null) return ""
  return typeof value === "bigint" ? value.toString() : String(value)
}

export const CARD_TITLE = "Register your bot"
export const CARD_LINE =
  "Your bot gets a public on-chain ID that anyone can look up. Registration writes a record to the blockchain. The record's ID and history can't be erased, but you (the owner) can update your bot's profile or transfer it. This is a testnet record and may be reset. Nothing here costs real money."
export const TRUST_LINE =
  "Anyone can check who registered this bot and when. Registration does not mean we, or anyone, have reviewed, verified, or endorsed the bot."
export const OPEN_WIZARD = "Start registering"

export const WHAT_YOU_NEED_TITLE = "What you need"
export const NEED_WALLET =
  "A browser wallet, such as a wallet extension in Chrome or Brave. Your wallet signs and sends the registration. This site never holds your keys."
export const NEED_TEST_ETH =
  "A little free Base Sepolia test ETH to pay the network fee. Get it from a Base Sepolia faucet. Test ETH has no cash value."
export const NEED_PROFILE =
  "Your bot's profile: a small file that says who your bot is. You can upload it or paste it as an agent URI."
export const FAUCET_LINK_LABEL = "Get free test ETH"
/** Official Base docs listing Base Sepolia faucets. Verified HTTP 200 on 2026-11-27. */
export const FAUCET_URL = "https://docs.base.org/get-started/get-funds"
export const CONNECT_NOTE = "Connect a browser wallet to register your bot on Base Sepolia testnet."


export const NETWORK_PILL = "Base Sepolia testnet (84532). Test ETH only."
export const NETWORK_VALUE = "Base Sepolia, 84532"

export const STEP_FILE = "Profile"
export const STEP_CHECK = "Check"
export const STEP_DRY_RUN = "Test run"
export const STEP_CONFIRM = "Confirm"
export const STEP_DONE = "Done"

export const WIZARD_STEP_LABELS = [STEP_FILE, STEP_CHECK, STEP_DRY_RUN, STEP_CONFIRM, STEP_DONE] as const

export function stepCount(step: number): string {
  return `Step ${textOf(step)} of 5`
}

export const FILE_TITLE = "Add your bot's profile"
export const TAB_UPLOAD = "Upload file"
export const TAB_PASTE = "Paste"
export const FILE_HELPER =
  "Upload your bot's profile file, or paste its agent URI. The agent URI is a link or text block that describes your bot. Nothing is sent yet. Don't put your name, email, or other personal info in your bot's profile. Parts of this record can never be deleted."
export const CHECK_REGISTRATION = "Check profile"


export const LABEL_TYPE = "Type"
export const LABEL_NAME = "Name"
export const LABEL_SIZE = "Size"
export const LABEL_AGENT_URI = "Agent URI"
export const LABEL_FROM = "From"
export const LABEL_PROVISIONAL_ID = "Provisional agent id"
export const LABEL_GAS = "Network fee (test ETH)"
export const LABEL_NETWORK = "Network"
export const LABEL_REGISTRY = "Registry"
export const LABEL_AGENT_ID = "Agent id"
export const LABEL_GLOBAL_ID = "Global id"
export const LABEL_OWNER = "Owner"
export const LABEL_TRANSACTION = "Transaction"
export const NAME_EMPTY = "(none)"
export const URI_EMPTY = "(empty)"
export const EXPAND = "Expand"
export const COLLAPSE = "Collapse"

export const PASS_LINE = "Looks good. This profile is in the right format."
export const CONTINUE = "Continue"
export const CONNECT_WALLET = "Connect wallet"
export const CONNECTING = "Connecting…"

export const DRY_RUN_RUNNING = "Doing a practice run with the registry. Nothing is sent and no test ETH is spent."
export const PROVISIONAL_LABEL = "Expected id. Your final id is set when the transaction goes through."
export const WRONG_CHAIN = "Switch to Base Sepolia to continue."
export const REVIEW_AND_CONFIRM = "Review and confirm"

export const CONFIRM_TITLE = "Confirm and register"
export const VALUES_CHANGED = "The registry changed since your check. Review the new values."
export const ACK_CHECKBOX = "I understand this sends a transaction from my wallet on Base Sepolia testnet, uses test ETH only, and writes a public record, parts of which can never be deleted."
export const CONFIRM_IN_WALLET = "Confirm in wallet"
export const BACK = "Back"
export const WAITING_WALLET = "Waiting for your wallet..."
export const CONFIRM_TX_LINE = "Your wallet will open. Check the details and approve. You can still say no there."

export const CHAIN_LEFT = "Your wallet changed networks. Run the check again."
export const SEND_FAILED = "The transaction did not go through."
export const REVERTED = "The transaction reverted. No agent was registered."

export const PENDING_TX = "Transaction sent. Waiting for confirmation."
export const VIEW_ON_BASESCAN = "View on Basescan"
export const NO_EVENT = "The transaction confirmed but the agent id could not be read. Check the transaction on Basescan."
export const START_OVER = "Start over"
export const CONTINUE_IDENTITY = "Sign a wallet check"
export const CONTINUE_HELPER = "Next, sign a quick check from your bot's wallet so people can confirm signatures come from that wallet. This is free and sends no transaction."
export const CHECK_AGAIN = "Check again"

export const INVALID_JSON = "This isn't valid JSON."
export const INVALID_JSON_DETAIL = "Check the file for a missing comma or bracket."
export const WRONG_TYPE = "This file isn't a bot profile we can read."
export const TOO_LARGE = "This registration is too large."
export const BAD_URI = "This agent URI can't be read."
export const BAD_URI_DETAIL = "Paste the agent URI that starts with data:application/json;base64, or upload the profile file."
export const DRY_RUN_REJECTED = "The registry would reject this registration."
export const USER_REJECTED = "You rejected the transaction. Nothing was sent."
export const INSUFFICIENT_FUNDS = "Your wallet needs a little more free test ETH for the network fee. Get some from a Base Sepolia faucet, then check again."
export const NOTHING_REGISTERED = "Nothing was registered."
export const CANCELLED = "You cancelled the transaction in your wallet. Nothing was registered."
export const UNKNOWN = "Something went wrong with the wallet."

export const ALREADY_PENDING = "Your wallet already has a request open. Open the wallet to finish or reject it."
export const CONNECT_REJECTED = "You didn't connect. Nothing was shared."
export const COULD_NOT_CONNECT = "Could not connect the wallet."
export const NOT_THIS_WALLET = "Not this wallet? Switch account in your wallet."
export const OPEN_WALLET_CONNECT = "Open your wallet to connect."
export const SWITCH_TO_SEPOLIA = "Switch to Base Sepolia"
export const CONFIRM_SWITCH = "Confirm the network switch in your wallet."
export const CANT_SWITCH = "Your wallet couldn't switch networks. Change it to Base Sepolia in the wallet app, then come back."
export const HUNG_PROMPT = "Still waiting. If you closed the wallet window, open it again or reject the request there."
export const STILL_WAITING = "Still waiting. Base Sepolia can be slow. Your transaction is still being tracked."
export const PICKING_UP = "Picking up your transaction..."
export const SPED_UP = "Your wallet sped up the transaction."
export const REPLACED_OTHER = "Your wallet replaced this transaction with a different one. No agent was registered by it."
export const DROPPED = "This transaction is no longer on the network. Nothing was registered."
export const DISCONNECTED = "Your wallet disconnected. Tracking continues here."

export const COPY_LABEL = "Copy"
export const COPIED_LABEL = "Copied"
export const COPY_FAILED = "Copy failed"

export const REGISTRY_ADDRESS = "0x8004A818BFB912233c491871b3d84c89A494BD9e"
export const REGISTRY_BASESCAN_URL = `https://sepolia.basescan.org/address/${REGISTRY_ADDRESS}`

export function basescanTxUrl(hash: string | number | bigint): string {
  return `https://sepolia.basescan.org/tx/${textOf(hash)}`
}

export function wrongType(value: string | number | bigint): string {
  return `The type field must be the ERC-8004 registration-v1 type (ends in #registration-v1). It is ${textOf(value)}.`
}

export function tooLarge(n: string | number | bigint, cap: string | number | bigint): string {
  return `${textOf(n)} bytes. The limit is ${textOf(cap)} bytes. Larger URIs cost more gas to store.`
}

export function alreadyOwns(count: string | number | bigint): string {
  const n = textOf(count)
  const noun = n === "1" ? "agent" : "agents"
  return `This wallet already owns ${n} registered ${noun}. You can still register another one.`
}

export function walletSwitched(short: string | number | bigint): string {
  return `Your wallet switched to ${textOf(short)}. Run the check again for this account.`
}

export function insufficientGas(needed: string, balance: string): string {
  return `This wallet doesn't have enough Base Sepolia test ETH for gas. You need about ${needed}, and you have ${balance}.`
}

export function ownsAfterReplacement(count: string | number | bigint): string {
  return `This wallet now owns ${textOf(count)} agents. One may have been registered by the replacement. Check the transaction on Basescan.`
}

export function registeredId(id: string | number | bigint): string {
  return `Done. Your bot is registered on Base Sepolia testnet. Its agent id is ${textOf(id)}.`
}

export function switchToOwner(short: string | number | bigint): string {
  return `Switch to the owner wallet ${textOf(short)} to sign the identity check.`
}

export function walletOnChain(chain: string | number | bigint): string {
  return `Your wallet is on ${textOf(chain)}. This page only works on Base Sepolia testnet (84532).`
}

export function stayedOn(chain: string | number | bigint): string {
  return `You stayed on ${textOf(chain)}. Switch to Base Sepolia to continue.`
}

export function sizeText(bytes: string | number | bigint, cap: string | number | bigint | null): string {
  if (cap == null) return `${textOf(bytes)} bytes`
  return `${textOf(bytes)} bytes (limit ${textOf(cap)} bytes)`
}

export function gasText(units: string | number | bigint, estCostTestEth: string | number | bigint): string {
  return `${textOf(units)} units, est. ${textOf(estCostTestEth)} test ETH`
}

export type ErrorDetail = string | ((...parts: string[]) => string)

export const ERROR_COPY: Record<RegisterErrorCode, { main: string; detail?: ErrorDetail }> = {
  InvalidJson: { main: INVALID_JSON, detail: INVALID_JSON_DETAIL },
  WrongType: { main: WRONG_TYPE, detail: wrongType },
  TooLarge: { main: TOO_LARGE, detail: (n: string, cap: string) => tooLarge(n, cap) },
  BadUri: { main: BAD_URI, detail: BAD_URI_DETAIL },
  WrongChain: { main: WRONG_CHAIN },
  DryRunReverted: { main: DRY_RUN_REJECTED },
  NoRegisteredEvent: { main: NO_EVENT },
  UserRejected: { main: USER_REJECTED },
  InsufficientFunds: { main: INSUFFICIENT_FUNDS },
  Replaced: { main: NOTHING_REGISTERED },
  Cancelled: { main: CANCELLED },
  Unknown: { main: UNKNOWN },
}

export function isRegisterErrorCode(value: unknown): value is RegisterErrorCode {
  return typeof value === "string" && (REGISTER_ERROR_CODES as readonly string[]).includes(value)
}

export function registerErrorView(
  kind: RegisterErrorCode | null,
  detail: string | null,
  parsed: ParsedRegistration | null,
): { main: string; detail?: string } | null {
  if (!isRegisterErrorCode(kind)) return null
  const copy = ERROR_COPY[kind]
  const runtime = detail != null && detail.trim() !== "" ? detail : undefined
  if (kind === "WrongType") {
    const value = runtime ?? parsed?.type ?? ""
    return { main: copy.main, detail: wrongType(value) }
  }
  if (kind === "TooLarge") {
    if (parsed != null && parsed.sizeCap != null) {
      return { main: copy.main, detail: tooLarge(parsed.sizeBytes, parsed.sizeCap) }
    }
    return { main: copy.main, detail: runtime }
  }
  if (kind === "DryRunReverted" || kind === "Unknown") {
    return { main: copy.main, detail: runtime }
  }
  if (kind === "InsufficientFunds" && runtime) {
    return { main: runtime }
  }
  const staticDetail = typeof copy.detail === "string" ? copy.detail : undefined
  return { main: copy.main, detail: runtime ?? staticDetail }
}

export function registerNoticeView(
  notice: RegisterUiNotice | null,
  detail: string | null,
): { main: string; detail?: string } | null {
  if (notice === "chain-left") return { main: CHAIN_LEFT }
  if (notice === "account-changed") return { main: walletSwitched(detail ?? "") }
  if (notice === "send-failed") return { main: SEND_FAILED, detail: detail ?? undefined }
  if (notice === "reverted") return { main: REVERTED, detail: detail ?? undefined }
  return null
}
