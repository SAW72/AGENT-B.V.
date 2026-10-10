import { formatEther, getAddress } from "viem"
import { ZERO_ADDRESS } from "./addresses"
import { presentError } from "./revert"

export {
  decodeRevert,
  LOW_BALANCE_TEXT,
  presentError,
  presentRevertHex,
  type DecodedRevert,
  type ErrorPresentation,
} from "./revert"

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export function shortAddress(address: string): string {
  if (address.length < 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/** Groups of four hex characters. The first group keeps the 0x prefix so a line wraps only between groups. */
export function chunkHex(value: string): string[] {
  const prefixed = value.startsWith("0x") || value.startsWith("0X")
  const body = prefixed ? value.slice(2) : value
  if (body.length === 0) return [value]
  const parts: string[] = []
  for (let index = 0; index < body.length; index += 4) {
    const slice = body.slice(index, index + 4)
    parts.push(index === 0 && prefixed ? `0x${slice}` : slice)
  }
  return parts
}

/** Full checksummed address in groups of four hex characters. Copy uses the unspaced form. */
export function chunkAddress(address: string): { checksummed: string; chunks: string; parts: string[] } {
  const checksummed = getAddress(address)
  const parts = chunkHex(checksummed)
  return { checksummed, chunks: parts.join(" "), parts }
}

export function formatLocalTimestamp(seconds: bigint): string {
  const ms = seconds * 1000n
  if (ms < 0n || ms > BigInt(Number.MAX_SAFE_INTEGER)) return "an unknown time"
  return new Date(Number(ms)).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

export function formatEth(wei: bigint): string {
  return `${formatEther(wei)} ETH`
}

export function isZeroAddress(address: string): boolean {
  return sameAddress(address, ZERO_ADDRESS)
}

/** Seven days. Refund stays blocked for this long after the escrow ends while a dispute is unresolved. */
export const RULING_GRACE_SECONDS = 7n * 24n * 60n * 60n

export const PAYEE_OPEN_BEFORE_EXPIRY_TEXT =
  "Open a dispute before this escrow ends. After that time, anyone can trigger the refund to the payer unless a dispute is already open. While a dispute is unresolved, a refund stays blocked until 7 days after the escrow ends."

export const PAYEE_OPEN_AFTER_EXPIRY_TEXT =
  "This escrow has ended, so a dispute can no longer be opened. Anyone can trigger the refund to the payer unless a dispute is already open. While a dispute is unresolved, a refund stays blocked until 7 days after the escrow ends."

export const PAYEE_EXPIRY_URGENT_LEAD = "Less than a day remains."

const ONE_DAY_SECONDS = 24n * 60n * 60n

export function payeeDisputeBeforeCta(endsLabel: string): string {
  return `Dispute before ${endsLabel}.`
}

export function payeeExpiryUrgentText(endsLabel: string): string {
  return `${PAYEE_EXPIRY_URGENT_LEAD} Dispute before ${endsLabel}.`
}

export type PayeeExpiryNotice = {
  beforeExpiry: boolean
  urgent: boolean
  endsLabel: string
  graceEndsLabel: string
  text: string
  cta: string | null
  urgentText: string | null
}

const OPEN_ESCROW_STATE = 0

export function formatUnixUtc(seconds: bigint): string {
  const ms = seconds * 1000n
  if (ms < 0n || ms > BigInt(Number.MAX_SAFE_INTEGER)) return "an unknown time"
  const iso = new Date(Number(ms)).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`
}

export function payeeOpenExpiryNotice(input: {
  viewer?: string | null
  payee: string
  payer: string
  state: number
  expiresAt: bigint
  used: boolean
  createdAt: bigint
  nowSeconds: bigint
}): PayeeExpiryNotice | null {
  if (!input.viewer) return null
  if (input.state !== OPEN_ESCROW_STATE) return null
  if (!input.used && isZeroAddress(input.payer) && input.createdAt === 0n) return null
  if (!sameAddress(input.viewer, input.payee)) return null
  const beforeExpiry = input.nowSeconds <= input.expiresAt
  const endsLabel = formatUnixUtc(input.expiresAt)
  const remaining = input.expiresAt - input.nowSeconds
  const urgent = beforeExpiry && remaining < ONE_DAY_SECONDS
  return {
    beforeExpiry,
    urgent,
    endsLabel,
    graceEndsLabel: formatUnixUtc(input.expiresAt + RULING_GRACE_SECONDS),
    text: beforeExpiry ? PAYEE_OPEN_BEFORE_EXPIRY_TEXT : PAYEE_OPEN_AFTER_EXPIRY_TEXT,
    cta: beforeExpiry ? payeeDisputeBeforeCta(endsLabel) : null,
    urgentText: urgent ? payeeExpiryUrgentText(endsLabel) : null,
  }
}

export function errorText(error: unknown): string {
  const presented = presentError(error)
  if (!presented.detail) return presented.main
  return `${presented.main}\n${presented.detail}`
}
