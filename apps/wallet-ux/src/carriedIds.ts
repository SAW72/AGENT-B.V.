import { useSyncExternalStore } from "react"
import { parseBytes32 } from "./bytes32"

export type CarriedIds = {
  escrowId: string | null
  disputeId: string | null
}

let carried: CarriedIds = { escrowId: null, disputeId: null }
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function carryEscrowId(id: string) {
  if (carried.escrowId === id) return
  carried = { ...carried, escrowId: id }
  emit()
}

export function carryDisputeId(id: string) {
  if (carried.disputeId === id) return
  carried = { ...carried, disputeId: id }
  emit()
}

export function resetCarriedIds() {
  if (carried.escrowId == null && carried.disputeId == null) return
  carried = { escrowId: null, disputeId: null }
  emit()
}

export function useCarriedIds(): CarriedIds {
  return useSyncExternalStore(
    subscribe,
    () => carried,
    () => carried,
  )
}

export const ESCROW_URL_IGNORED = "The escrow in the link was ignored because it is not a valid id."
export const DISPUTE_URL_IGNORED = "The dispute in the link was ignored because it is not a valid id."

/** Read one untrusted query param. Invalid values are dropped. Nothing is submitted. */
export function readUrlBytes32(param: "escrow" | "dispute"): { value: `0x${string}` | null; notice: string | null } {
  if (typeof window === "undefined") return { value: null, notice: null }
  const raw = new URLSearchParams(window.location.search).get(param)
  if (raw == null || raw.trim() === "") return { value: null, notice: null }
  const parsed = parseBytes32(raw)
  if (!parsed) {
    return { value: null, notice: param === "escrow" ? ESCROW_URL_IGNORED : DISPUTE_URL_IGNORED }
  }
  return { value: parsed, notice: null }
}
