const HEX_64 = /^[0-9a-fA-F]{64}$/

/**
 * Prefix rule for every hex field in this app: `0x` and `0X` are both
 * prefixes and are normalized to `0x`. Bare hex is still accepted for a
 * 32-byte id. The payee uses the same prefix rule and then the checksum rule.
 */
export function normalizeHexPrefix(raw: string): { prefixed: boolean; body: string } {
  const trimmed = raw.trim()
  if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
    return { prefixed: true, body: trimmed.slice(2) }
  }
  return { prefixed: false, body: trimmed }
}

/** 32 cryptographically random bytes. Not derived from an escrow id or the clock. */
export function randomBytes32(
  fill: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => {
    crypto.getRandomValues(bytes)
  },
): `0x${string}` {
  const bytes = new Uint8Array(32)
  fill(bytes)
  if (bytes.every((byte) => byte === 0)) bytes[31] = 1
  let hex = "0x"
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0")
  return hex as `0x${string}`
}

export function parseBytes32(raw: string): `0x${string}` | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const { body } = normalizeHexPrefix(trimmed)
  if (!HEX_64.test(body)) return null
  return `0x${body.toLowerCase()}`
}

const MATCH_LEVELS = ["None", "PromptBlock", "SignatureBlock", "ExactBlock"] as const

export function matchLevelLabel(level: number): string {
  return MATCH_LEVELS[level] ?? `Unknown(${level})`
}
