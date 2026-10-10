import { decodeFunctionData, type Hex } from "viem"
import { disputePanelAbi, escrowAbi } from "./abi"

const PREFIX = "agent-bv.pending."
const HEX_32 = /^0x[0-9a-fA-F]{64}$/
const CALL_ABI = [...escrowAbi, ...disputePanelAbi]

export type PendingRecord = {
  slot: string
  action: string
  subjectId: Hex | null
  hash: Hex
  startedAt: number
  /** False when the wallet sent the transaction but the browser refused to store it. */
  saved: boolean
}

/** A stored clock more than a minute ahead is not a live transaction. */
export const PENDING_FUTURE_SKEW_MS = 60_000

const listeners = new Set<() => void>()
const memoryRecords = new Map<string, PendingRecord>()
const clockNotes = new Map<string, Hex>()
let storageVersion = 0

export function subscribePending(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emitPending() {
  for (const listener of [...listeners]) listener()
}

function bumpStorageVersion() {
  storageVersion += 1
}

/** Cache key for hasLivePending. Writes and other-tab storage events move it. */
export function pendingStorageVersion(): number {
  return storageVersion
}

export function resetPendingStore(): void {
  memoryRecords.clear()
  clockNotes.clear()
  freshSlots.clear()
  bumpStorageVersion()
}

function rememberClockNote(hash: Hex) {
  clockNotes.set(hash, hash)
}

/** Records dropped because their clock was in the future. Kept until the page reloads. */
export function listClockNotes(): Hex[] {
  return [...clockNotes.values()]
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", () => {
    bumpStorageVersion()
    emitPending()
  })
}

/** Fresh sends wait for the receipt. Restored records only poll. */
const freshSlots = new Set<string>()

export function takeFreshPending(slot: string): boolean {
  if (!freshSlots.has(slot)) return false
  freshSlots.delete(slot)
  return true
}

export function pendingStorageKey(slot: string): string {
  return `${PREFIX}${slot}`
}

/** One stored transaction per action and the escrow or dispute id that was sent. Withdraw has no id. */
export function pendingSlot(action: string, subjectId: Hex | null): string {
  return subjectId ? `${action}:${subjectId.toLowerCase()}` : action
}

function isHex32(value: unknown): value is Hex {
  return typeof value === "string" && HEX_32.test(value)
}

export function readPending(slot: string): PendingRecord | null {
  if (typeof localStorage === "undefined") return null
  try {
    const raw = localStorage.getItem(pendingStorageKey(slot))
    if (!raw) return memoryRecords.get(slot) ?? null
    const parsed = JSON.parse(raw) as Partial<PendingRecord>
    if (!isHex32(parsed.hash)) return null
    if (typeof parsed.startedAt !== "number" || !Number.isFinite(parsed.startedAt)) return null
    if (parsed.startedAt > Date.now() + PENDING_FUTURE_SKEW_MS) {
      try {
        localStorage.removeItem(pendingStorageKey(slot))
      } catch {
        // The record is still ignored when storage will not delete it.
      }
      if (isHex32(parsed.hash)) rememberClockNote(parsed.hash)
      bumpStorageVersion()
      return null
    }
    if (typeof parsed.action !== "string" || parsed.action.trim() === "") return null
    const subjectId = parsed.subjectId == null ? null : parsed.subjectId
    if (subjectId != null && !isHex32(subjectId)) return null
    if (parsed.action === "withdraw" && subjectId != null) return null
    if (parsed.action !== "withdraw" && subjectId == null) return null
    return {
      slot,
      action: parsed.action,
      subjectId,
      hash: parsed.hash,
      startedAt: parsed.startedAt,
      saved: true,
    }
  } catch {
    return memoryRecords.get(slot) ?? null
  }
}

export function listPending(): PendingRecord[] {
  const out: PendingRecord[] = []
  const seen = new Set<string>()
  if (typeof localStorage !== "undefined") {
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key?.startsWith(PREFIX)) keys.push(key)
    }
    for (const key of keys) {
      const record = readPending(key.slice(PREFIX.length))
      if (!record) continue
      out.push(record)
      seen.add(record.slot)
    }
  }
  for (const record of memoryRecords.values()) {
    if (seen.has(record.slot)) continue
    out.push(record)
  }
  return out
}

export function writePending(input: {
  action: string
  subjectId: Hex | null
  hash: Hex
  startedAt?: number
}): PendingRecord {
  const startedAt = input.startedAt ?? Date.now()
  const slot = pendingSlot(input.action, input.subjectId)
  let saved = true
  try {
    localStorage.setItem(
      pendingStorageKey(slot),
      JSON.stringify({
        action: input.action,
        subjectId: input.subjectId,
        hash: input.hash,
        startedAt,
      }),
    )
    memoryRecords.delete(slot)
  } catch {
    saved = false
  }
  const record: PendingRecord = {
    slot,
    action: input.action,
    subjectId: input.subjectId,
    hash: input.hash,
    startedAt,
    saved,
  }
  if (!saved) memoryRecords.set(slot, record)
  freshSlots.add(slot)
  bumpStorageVersion()
  emitPending()
  return record
}

/**
 * Relayer progress note. It is not a wallet pending record, so it does not hold the submit lock
 * and a reload does not treat it as a wallet transaction.
 */
export function writeRelayerPending(slot: string, hash: Hex, startedAt = Date.now()): { hash: Hex; startedAt: number } {
  try {
    localStorage.setItem(pendingStorageKey(slot), JSON.stringify({ hash, startedAt }))
  } catch {
    // A relayer note is not the wallet lock. A storage failure leaves the in-flight relayer state alone.
  }
  bumpStorageVersion()
  return { hash, startedAt }
}

export function clearPending(slot: string): void {
  freshSlots.delete(slot)
  memoryRecords.delete(slot)
  if (typeof localStorage !== "undefined") localStorage.removeItem(pendingStorageKey(slot))
  bumpStorageVersion()
  emitPending()
}

/** Escrow id or dispute id taken from the calldata that was sent. Withdraw has none. */
export function subjectFromCalldata(calldata: Hex): { action: string; subjectId: Hex | null } | null {
  try {
    const decoded = decodeFunctionData({ abi: CALL_ABI, data: calldata })
    const args = decoded.args ?? []
    switch (decoded.functionName) {
      case "createEscrow":
      case "release":
      case "refund":
        return { action: decoded.functionName, subjectId: args[0] as Hex }
      case "dispute":
        return { action: "dispute", subjectId: args[1] as Hex }
      case "vote":
        return { action: "vote", subjectId: args[0] as Hex }
      case "withdraw":
        return { action: "withdraw", subjectId: null }
      default:
        return null
    }
  } catch {
    return null
  }
}

export function pendingSubjectLabel(action: string): "Escrow ID" | "Dispute ID" | null {
  if (action === "createEscrow" || action === "release" || action === "refund") return "Escrow ID"
  if (action === "dispute" || action === "vote") return "Dispute ID"
  return null
}
