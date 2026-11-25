/** Short display for an address. Uses an ellipsis, same shape as the rest of the wallet app. */
export function shortHex(value: string): string {
  if (value.includes("…")) return value
  if (value.length < 12) return value
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}
