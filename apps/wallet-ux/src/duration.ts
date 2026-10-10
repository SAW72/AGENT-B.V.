export const DURATION_PRESETS = [
  { id: "hour", label: "1 hour", seconds: 60 * 60 },
  { id: "day", label: "1 day", seconds: 24 * 60 * 60 },
  { id: "week", label: "7 days", seconds: 7 * 24 * 60 * 60 },
] as const

export const DEFAULT_DURATION_SECONDS = 24 * 60 * 60

/** Whole seconds only: digits, nothing else. Rejects hex, exponents, decimals, and signs. */
export function parseWholeSeconds(raw: string, maxSeconds: number): number | null {
  const trimmed = raw.trim()
  if (!/^[0-9]+$/.test(trimmed)) return null
  const seconds = Number(trimmed)
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > maxSeconds) return null
  return seconds
}
