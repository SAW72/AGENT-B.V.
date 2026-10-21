import { decodeFunctionData, type Hex } from "viem"
import { disputePanelAbi, escrowAbi } from "./abi"

const PREFIX = "agent-bv.pending."
const CLOCK_PREFIX = "agent-bv.clock."
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

export type ClockNote = {
  hash: Hex
  action: string
  subjectId: Hex | null
}

const listeners = new Set<() => void>()
const memoryRecords = new Map<string, PendingRecord>()
const clockNotes = new Map<string, ClockNote>()
/** Dismissals that must stick for this page even when removeItem throws. A reload clears this set. */
const dismissedHashes = new Set<string>()
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
  dismissedHashes.clear()
  freshSlots.clear()
  bumpStorageVersion()
}

function clockStorageKey(hash: Hex): string {
  return `${CLOCK_PREFIX}${hash.toLowerCase()}`
}

function rememberClockNote(note: ClockNote) {
  clockNotes.set(note.hash.toLowerCase(), note)
}

function parseClockNote(raw: string | null): ClockNote | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ClockNote>
    if (!isHex32(parsed.hash)) return null
    const subjectId = parsed.subjectId == null ? null : parsed.subjectId
    if (subjectId != null && !isHex32(subjectId)) return null
    const action = typeof parsed.action === "string" && parsed.action.trim() !== "" ? parsed.action : "unknown"
    return { hash: parsed.hash, action, subjectId }
  } catch {
    return null
  }
}

/**
 * A future clock is not treated as a live send, but the hash stays on disk and holds the lock
 * until the user dismisses it. Reloading must not drop the hash or open submit.
 */
function persistClockNote(note: ClockNote) {
  rememberClockNote(note)
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(clockStorageKey(note.hash), JSON.stringify(note))
  } catch {
    // The in-memory note still holds the lock for this page.
  }
}

export function listClockNotes(): ClockNote[] {
  const out = new Map<string, ClockNote>()
  if (typeof localStorage !== "undefined") {
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key?.startsWith(CLOCK_PREFIX)) keys.push(key)
    }
    for (const key of keys) {
      const note = parseClockNote(localStorage.getItem(key))
      if (!note || dismissedHashes.has(note.hash.toLowerCase())) continue
      out.set(note.hash.toLowerCase(), note)
    }
  }
  for (const note of clockNotes.values()) {
    if (dismissedHashes.has(note.hash.toLowerCase())) continue
    if (!out.has(note.hash.toLowerCase())) out.set(note.hash.toLowerCase(), note)
  }
  return [...out.values()]
}

export function hasClockHold(): boolean {
  return listClockNotes().length > 0
}

export function dismissClockNote(hash: Hex): void {
  const key = hash.toLowerCase()
  dismissedHashes.add(key)
  clockNotes.delete(key)
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(clockStorageKey(hash))
    } catch {
      // The dismissed set is checked before the stored copy, so the note stays gone until reload.
    }
  }
  bumpStorageVersion()
  emitPending()
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
      const subjectId = isHex32(parsed.subjectId) ? parsed.subjectId : null
      const action = typeof parsed.action === "string" && parsed.action.trim() !== "" ? parsed.action : "unknown"
      persistClockNote({ hash: parsed.hash, action, subjectId })
      try {
        localStorage.removeItem(pendingStorageKey(slot))
      } catch {
        // The clock note is already stored. The original row is still ignored.
      }
      bumpStorageVersion()
      emitPending()
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
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(pendingStorageKey(slot))
    } catch {
      // The in-memory record is already gone. A stuck row must not throw into the receipt watch.
    }
  }
  bumpStorageVersion()
  emitPending()
}

export type CallParties = {
  action: string
  escrowId: Hex | null
  disputeId: Hex | null
}

/** Ids encoded in a prepared call. Dispute carries both the escrow id and the dispute id. */
export function calldataParties(calldata: Hex): CallParties | null {
  try {
    const decoded = decodeFunctionData({ abi: CALL_ABI, data: calldata })
    const args = decoded.args ?? []
    switch (decoded.functionName) {
      case "createEscrow":
      case "release":
      case "refund":
        return { action: decoded.functionName, escrowId: args[0] as Hex, disputeId: null }
      case "dispute":
        return { action: "dispute", escrowId: args[0] as Hex, disputeId: args[1] as Hex }
      case "vote":
        return { action: "vote", escrowId: null, disputeId: args[0] as Hex }
      case "withdraw":
        return { action: "withdraw", escrowId: null, disputeId: null }
      default:
        return null
    }
  } catch {
    return null
  }
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left == null || right == null) return false
  return left.toLowerCase() === right.toLowerCase()
}

/** True only when the prepared call is this action and every id the caller passes is the one in the calldata. */
export function preparedMatches(
  calldata: Hex,
  expected: { action: string; escrowId?: string | null; disputeId?: string | null },
): boolean {
  const parties = calldataParties(calldata)
  if (!parties || parties.action !== expected.action) return false
  if (expected.escrowId != null && !sameId(parties.escrowId, expected.escrowId)) return false
  if (expected.disputeId != null && !sameId(parties.disputeId, expected.disputeId)) return false
  return true
}

/** Escrow id or dispute id taken from the calldata that was sent. Withdraw has none. */
export function subjectFromCalldata(calldata: Hex): { action: string; subjectId: Hex | null } | null {
  const parties = calldataParties(calldata)
  if (!parties) return null
  const subjectId = parties.action === "dispute" || parties.action === "vote" ? parties.disputeId : parties.escrowId
  return { action: parties.action, subjectId }
}

export function pendingSubjectLabel(action: string): "Escrow ID" | "Dispute ID" | null {
  if (action === "createEscrow" || action === "release" || action === "refund") return "Escrow ID"
  if (action === "dispute" || action === "vote") return "Dispute ID"
  return null
}
