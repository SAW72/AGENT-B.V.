import { getAddress, isAddress, type Address } from "viem"
import { normalizeHexPrefix } from "./bytes32"

/**
 * Payee wallet. Same prefix rule as ids: `0x` and `0X` normalize to `0x`.
 * A prefix is required. Mixed-case bodies must be a valid checksum.
 * All-lowercase and all-uppercase bodies are accepted.
 */
export function parsePayeeAddress(raw: string): Address | null {
  const { prefixed, body } = normalizeHexPrefix(raw)
  if (!prefixed || !/^[0-9a-fA-F]{40}$/.test(body)) return null
  try {
    if (body === body.toLowerCase() || body === body.toUpperCase()) {
      return getAddress(`0x${body.toLowerCase()}`)
    }
    const checksummed = `0x${body}`
    if (!isAddress(checksummed, { strict: true })) return null
    return getAddress(checksummed)
  } catch {
    return null
  }
}
