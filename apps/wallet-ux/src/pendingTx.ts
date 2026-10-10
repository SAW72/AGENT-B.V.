const PREFIX = "agent-bv.pending."

export type PendingRecord = {
  hash: `0x${string}`
  startedAt: number
}

export function pendingStorageKey(slot: string): string {
  return `${PREFIX}${slot}`
}

export function readPending(slot: string): PendingRecord | null {
  try {
    const raw = localStorage.getItem(pendingStorageKey(slot))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingRecord>
    if (typeof parsed.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(parsed.hash)) return null
    if (typeof parsed.startedAt !== "number" || !Number.isFinite(parsed.startedAt)) return null
    return { hash: parsed.hash, startedAt: parsed.startedAt }
  } catch {
    return null
  }
}

export function writePending(slot: string, hash: `0x${string}`, startedAt = Date.now()): PendingRecord {
  const record = { hash, startedAt }
  localStorage.setItem(pendingStorageKey(slot), JSON.stringify(record))
  return record
}

export function clearPending(slot: string): void {
  localStorage.removeItem(pendingStorageKey(slot))
}
