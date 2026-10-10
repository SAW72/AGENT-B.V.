export type ConnectChoice = {
  id: string
  name: string
  rdns?: string | readonly string[]
}

/**
 * Hide the generic injected fallback once an EIP-6963 wallet has announced itself,
 * and keep a single button when the same wallet is announced twice.
 */
export function visibleConnectors<T extends ConnectChoice>(connectors: readonly T[]): T[] {
  const discovered = connectors.filter((connector) => connector.id !== "injected")
  const pool = discovered.length > 0 ? discovered : [...connectors]
  const seen = new Set<string>()
  const unique: T[] = []
  for (const connector of pool) {
    const rdns = connector.rdns
    const key = (typeof rdns === "string" ? rdns : rdns?.[0]) ?? connector.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(connector)
  }
  return unique
}
