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
}

const listeners = new Set<() => void>()

export function subscribePending(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emitPending() {
  for (const listener of [...listeners]) listener()
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
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingRecord>
    if (!isHex32(parsed.hash)) return null
    if (typeof parsed.startedAt !== "number" || !Number.isFinite(parsed.startedAt)) return null
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
    }
  } catch {
    return null
  }
}

export function listPending(): PendingRecord[] {
  if (typeof localStorage === "undefined") return []
  const out: PendingRecord[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (!key || !key.startsWith(PREFIX)) continue
    const record = readPending(key.slice(PREFIX.length))
    if (record) out.push(record)
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
  const record: PendingRecord = {
    slot,
    action: input.action,
    subjectId: input.subjectId,
    hash: input.hash,
    startedAt,
  }
  localStorage.setItem(
    pendingStorageKey(slot),
    JSON.stringify({
      action: record.action,
      subjectId: record.subjectId,
      hash: record.hash,
      startedAt: record.startedAt,
    }),
  )
  freshSlots.add(slot)
  emitPending()
  return record
}

/**
 * Relayer progress note. It is not a wallet pending record, so it does not hold the submit lock
 * and a reload does not treat it as a wallet transaction.
 */
export function writeRelayerPending(slot: string, hash: Hex, startedAt = Date.now()): { hash: Hex; startedAt: number } {
  localStorage.setItem(pendingStorageKey(slot), JSON.stringify({ hash, startedAt }))
  return { hash, startedAt }
}

export function clearPending(slot: string): void {
  if (typeof localStorage === "undefined") return
  freshSlots.delete(slot)
  localStorage.removeItem(pendingStorageKey(slot))
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
