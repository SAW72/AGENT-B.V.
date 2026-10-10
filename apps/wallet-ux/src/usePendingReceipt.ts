import { useEffect, useRef, useSyncExternalStore } from "react"
import type { Hex } from "viem"
import { carryDisputeId, carryEscrowId } from "./carriedIds"
import {
  clearPending,
  listClockNotes,
  listPending,
  resetPendingStore,
  subscribePending,
  takeFreshPending,
  type PendingRecord,
} from "./pendingTx"
import {
  checkPendingReceipt,
  isPendingExpired,
  receiptWatchConfig,
  type ReceiptOutcome,
  type ReceiptReader,
} from "./pendingWatch"
import { releaseSubmit } from "./submitLock"

export type ReceiptPhase = "idle" | "pending" | "unconfirmed" | "confirmed"

export type PendingNotice = "may-confirm" | "not-found" | null

export type PendingBanner =
  | { kind: "reverted" }
  | { kind: "unknown"; hash: Hex }
  | { kind: "expired"; hash: Hex }
  | { kind: "clock"; hash: Hex }

export type PendingView = {
  record: PendingRecord
  phase: ReceiptPhase
  banner: PendingBanner | null
  notice: PendingNotice
}

type LockRef = { current: string }

let views = new Map<string, PendingView>()
let snapshot: readonly PendingView[] = []
let engineClient: ReceiptReader | null = null
let refs = 0
let syncing = false
const stops = new Map<string, () => void>()
const viewListeners = new Set<() => void>()
const confirmedListeners = new Map<string, Set<() => void>>()
let expiryTimer: number | null = null

function publish() {
  snapshot = [...views.values()]
  for (const listener of [...viewListeners]) listener()
}

function subscribeViews(listener: () => void) {
  viewListeners.add(listener)
  return () => viewListeners.delete(listener)
}

function getViews(): readonly PendingView[] {
  return snapshot
}

function stopTimer(slot: string) {
  stops.get(slot)?.()
  stops.delete(slot)
}

function carrySentId(record: PendingRecord) {
  if (!record.subjectId) return
  if (record.action === "dispute") carryDisputeId(record.subjectId)
  if (record.action === "createEscrow" || record.action === "release" || record.action === "refund") {
    carryEscrowId(record.subjectId)
  }
}

function put(record: PendingRecord, phase: ReceiptPhase, banner: PendingBanner | null, notice: PendingNotice = null) {
  views.set(record.slot, { record, phase, banner, notice })
  publish()
}

function finish(record: PendingRecord, phase: ReceiptPhase, banner: PendingBanner | null) {
  stopTimer(record.slot)
  clearPending(record.slot)
  if (phase === "confirmed") {
    carrySentId(record)
    for (const listener of confirmedListeners.get(record.slot) ?? []) listener()
  }
  put(record, phase, banner)
}

function apply(record: PendingRecord, outcome: ReceiptOutcome) {
  const current = views.get(record.slot)
  if (!current || current.record.hash !== record.hash) return
  if (outcome === "success") {
    finish(record, "confirmed", null)
    return
  }
  if (outcome === "reverted") {
    finish(record, "idle", { kind: "reverted" })
    return
  }
  if (outcome === "unknown") {
    if (current.phase !== "unconfirmed" || current.notice !== "not-found") {
      put(record, "unconfirmed", null, "not-found")
    }
    return
  }
  if (outcome === "unreadable") {
    if (current.notice === "not-found") return
    if (current.phase !== "unconfirmed") put(record, "unconfirmed", null, "may-confirm")
  }
}

function poll(record: PendingRecord) {
  let stopped = false
  const tick = () => {
    const reader = engineClient
    if (stopped || !reader) return
    void checkPendingReceipt(reader, record.hash, record.startedAt)
      .then((outcome) => {
        if (!stopped) apply(record, outcome)
      })
      .catch(() => {
        if (!stopped) apply(record, "unreadable")
      })
  }
  const timer = window.setInterval(tick, receiptWatchConfig.pollMs)
  stops.set(record.slot, () => {
    stopped = true
    window.clearInterval(timer)
  })
  tick()
}

function start(record: PendingRecord, mode: "wait" | "poll") {
  if (stops.has(record.slot)) return
  const stalled = Date.now() - record.startedAt >= receiptWatchConfig.waitMs
  put(record, stalled ? "unconfirmed" : "pending", null, stalled ? "may-confirm" : null)
  const reader = engineClient
  if (!reader) return
  if (mode === "poll" || stalled || !reader.waitForTransactionReceipt) {
    poll(record)
    return
  }
  let stopped = false
  stops.set(record.slot, () => {
    stopped = true
  })
  void reader.waitForTransactionReceipt({ hash: record.hash, timeout: receiptWatchConfig.waitMs }).then(
    (receipt) => {
      if (stopped) return
      apply(record, receipt.status === "success" ? "success" : "reverted")
    },
    () => {
      if (stopped) return
      stopped = true
      stops.delete(record.slot)
      put(record, "unconfirmed", null, "may-confirm")
      poll(record)
    },
  )
}

function expire(record: PendingRecord) {
  stopTimer(record.slot)
  clearPending(record.slot)
  put(record, "idle", { kind: "expired", hash: record.hash })
}

export function syncPendingViews() {
  if (syncing) return
  syncing = true
  try {
    for (const record of listPending()) {
      if (isPendingExpired(record.startedAt)) {
        if (views.get(record.slot)?.banner?.kind !== "expired") expire(record)
        continue
      }
      if (stops.has(record.slot) || views.get(record.slot)?.phase === "confirmed") continue
      start(record, takeFreshPending(record.slot) ? "wait" : "poll")
    }
    for (const hash of listClockNotes()) {
      const slot = `clock:${hash}`
      if (views.has(slot)) continue
      put(
        { slot, action: "clock", subjectId: null, hash, startedAt: 0, saved: true },
        "idle",
        { kind: "clock", hash },
      )
    }
  } finally {
    syncing = false
  }
}

function stopExpiryTimer() {
  if (expiryTimer == null) return
  window.clearInterval(expiryTimer)
  expiryTimer = null
}

function startExpiryTimer() {
  if (expiryTimer != null) return
  expiryTimer = window.setInterval(() => syncPendingViews(), receiptWatchConfig.expiryTickMs)
}

function acquireEngine() {
  refs += 1
  if (refs === 1) {
    syncPendingViews()
    startExpiryTimer()
  }
  return () => {
    refs -= 1
    if (refs > 0) return
    stopExpiryTimer()
    for (const stop of stops.values()) stop()
    stops.clear()
    views = new Map()
    snapshot = []
    publish()
  }
}

/** Drop in-memory watches. Tests call this between renders. */
export function resetPendingRuntime() {
  stopExpiryTimer()
  for (const stop of stops.values()) stop()
  stops.clear()
  views = new Map()
  snapshot = []
  refs = 0
  engineClient = null
  resetPendingStore()
  publish()
}

export function dismissPending(slot: string) {
  stopTimer(slot)
  views.delete(slot)
  clearPending(slot)
  publish()
}

export function usePendingEngine(client: ReceiptReader | undefined) {
  if (client) engineClient = client
  useEffect(() => {
    if (!client) return
    engineClient = client
    const unsub = subscribePending(() => syncPendingViews())
    const release = acquireEngine()
    return () => {
      unsub()
      release()
    }
    // The client object identity changes between renders. Readiness is the signal that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(client)])
}

export function usePendingViews(client: ReceiptReader | undefined): readonly PendingView[] {
  usePendingEngine(client)
  return useSyncExternalStore(subscribeViews, getViews, getViews)
}

const EMPTY: PendingView = {
  record: {
    slot: "",
    action: "",
    subjectId: null,
    hash: "0x",
    startedAt: 0,
    saved: true,
  },
  phase: "idle",
  banner: null,
  notice: null,
}

/**
 * One action plus the id that was sent.
 * The watch lives in a module store, so unmounting the form does not drop the receipt or the lock.
 */
export function usePendingReceipt(
  slot: string,
  client: ReceiptReader | undefined,
  lockRef: LockRef,
  onConfirmed: () => void,
) {
  const viewsNow = usePendingViews(client)
  const view = viewsNow.find((item) => item.record.slot === slot) ?? null
  const onConfirmedRef = useRef(onConfirmed)
  onConfirmedRef.current = onConfirmed
  useEffect(() => {
    let bucket = confirmedListeners.get(slot)
    if (!bucket) {
      bucket = new Set()
      confirmedListeners.set(slot, bucket)
    }
    const listener = () => onConfirmedRef.current()
    bucket.add(listener)
    return () => {
      bucket?.delete(listener)
    }
  }, [slot])

  const shown = view ?? EMPTY
  const txHash =
    view && (view.phase !== "idle" || view.banner?.kind === "unknown" || view.banner?.kind === "expired")
      ? view.record.hash
      : null
  return {
    phase: shown.phase,
    txHash,
    startedAt: shown.phase === "pending" || shown.phase === "unconfirmed" ? shown.record.startedAt : null,
    banner: shown.banner,
    notice: shown.notice,
    unsaved: shown.record.saved === false,
    subjectId: shown.record.subjectId,
    holdLock: shown.phase === "pending" || shown.phase === "unconfirmed",
    tryAgain() {
      dismissPending(slot)
      if (lockRef.current) releaseSubmit(lockRef.current)
    },
    dismissBanner() {
      const current = views.get(slot)
      if (!current?.banner) return
      if (current.phase === "idle") views.delete(slot)
      else views.set(slot, { ...current, banner: null })
      publish()
    },
  }
}
