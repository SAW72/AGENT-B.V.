import { useEffect, useId, useSyncExternalStore } from "react"
import { listPending, pendingStorageVersion, subscribePending, type PendingRecord } from "./pendingTx"
import { isPendingExpired } from "./pendingWatch"

let holder: string | null = null
const listeners = new Set<() => void>()
let cachedVersion = -1
let cachedRecords: PendingRecord[] = []

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function liveRecords(): readonly PendingRecord[] {
  const version = pendingStorageVersion()
  if (version !== cachedVersion) {
    cachedRecords = listPending()
    cachedVersion = pendingStorageVersion()
  }
  return cachedRecords
}

/** A stored transaction that has not expired holds the lock, even when its form is unmounted. */
export function hasLivePending(now = Date.now()): boolean {
  return liveRecords().some((record) => !isPendingExpired(record.startedAt, now))
}

/** Take the single in-flight transaction slot. A pending record or another caller refuses it. */
export function tryHoldSubmit(id: string): boolean {
  if (hasLivePending()) return false
  if (holder !== null && holder !== id) return false
  holder = id
  emit()
  return true
}

export function releaseSubmit(id: string) {
  if (holder !== id) return
  holder = null
  emit()
}

export function resetSubmitLock() {
  holder = null
  cachedVersion = -1
  cachedRecords = []
  emit()
}

function blockedNow(id: string): boolean {
  return hasLivePending() || (holder !== null && holder !== id)
}

/**
 * True when some other submit is in flight, or any pending record still owns the lock.
 * Unmount does not release that lock. A known receipt, Try again anyway, or the 30 minute expiry does.
 */
export function useSubmitBlocked(active: boolean): { id: string; blocked: boolean } {
  const id = useId()
  const blocked = useSyncExternalStore(
    (listener) => {
      const unsub = subscribe(listener)
      const unsubPending = subscribePending(listener)
      return () => {
        unsub()
        unsubPending()
      }
    },
    () => blockedNow(id),
    () => false,
  )
  useEffect(() => {
    if (active) tryHoldSubmit(id)
    else releaseSubmit(id)
  }, [active, id])
  return { id, blocked }
}
