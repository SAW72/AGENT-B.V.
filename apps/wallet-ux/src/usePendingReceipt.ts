import { useEffect, useRef, useState } from "react"
import type { Hex } from "viem"
import { clearPending, readPending, type PendingRecord } from "./pendingTx"
import {
  checkPendingReceipt,
  isPendingExpired,
  receiptWatchConfig,
  type ReceiptOutcome,
  type ReceiptReader,
} from "./pendingWatch"
import { releaseSubmit } from "./submitLock"
import { isReceiptTimeout } from "./walletCopy"

export type ReceiptPhase = "idle" | "pending" | "unconfirmed" | "confirmed"

export type PendingBanner =
  | { kind: "reverted" }
  | { kind: "unknown"; hash: Hex }
  | { kind: "expired"; hash: Hex }

type LockRef = { current: string }

/**
 * Watches one action's stored hash.
 * Submit stays disabled while the receipt is pending, stalled, or unreadable.
 * The stored entry and the shared lock are released on confirm, revert, unknown, expiry, or Try again anyway.
 */
export function usePendingReceipt(
  slot: string,
  client: ReceiptReader | undefined,
  lockRef: LockRef,
  onConfirmed: () => void,
) {
  const [phase, setPhase] = useState<ReceiptPhase>("idle")
  const [txHash, setTxHash] = useState<Hex | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [banner, setBanner] = useState<PendingBanner | null>(null)
  const clientRef = useRef(client)
  clientRef.current = client
  const onConfirmedRef = useRef(onConfirmed)
  onConfirmedRef.current = onConfirmed
  const stopRef = useRef<(() => void) | null>(null)
  const watching = useRef<Hex | null>(null)

  function releaseLock() {
    if (lockRef.current) releaseSubmit(lockRef.current)
  }

  function stop() {
    stopRef.current?.()
    stopRef.current = null
    watching.current = null
  }

  function finish(next: ReceiptPhase, hash: Hex | null, nextBanner: PendingBanner | null) {
    clearPending(slot)
    stop()
    releaseLock()
    setPhase(next)
    setTxHash(hash)
    setStartedAt(null)
    setBanner(nextBanner)
    if (next === "confirmed") onConfirmedRef.current()
  }

  function apply(hash: Hex, started: number, outcome: ReceiptOutcome) {
    if (watching.current !== hash) return
    if (outcome === "success") {
      finish("confirmed", hash, null)
      return
    }
    if (outcome === "reverted") {
      finish("idle", null, { kind: "reverted" })
      return
    }
    if (outcome === "unknown") {
      finish("idle", hash, { kind: "unknown", hash })
      return
    }
    if (outcome === "unreadable" || Date.now() - started >= receiptWatchConfig.waitMs) {
      setPhase("unconfirmed")
      setTxHash(hash)
      setStartedAt(started)
      return
    }
    setTxHash(hash)
    setStartedAt(started)
  }

  function poll(hash: Hex, started: number) {
    const reader = clientRef.current
    if (!reader) return
    let stopped = false
    const tick = () => {
      if (stopped || watching.current !== hash) return
      void checkPendingReceipt(reader, hash, started)
        .then((outcome) => {
          if (!stopped) apply(hash, started, outcome)
        })
        .catch(() => {
          if (!stopped) apply(hash, started, "unreadable")
        })
    }
    const timer = window.setInterval(tick, receiptWatchConfig.pollMs)
    stopRef.current = () => {
      stopped = true
      window.clearInterval(timer)
    }
    tick()
  }

  function watch(record: PendingRecord, mode: "wait" | "poll") {
    const reader = clientRef.current
    if (!reader) return
    if (watching.current === record.hash) return
    stop()
    watching.current = record.hash
    setBanner(null)
    setTxHash(record.hash)
    setStartedAt(record.startedAt)
    const stalled = Date.now() - record.startedAt >= receiptWatchConfig.waitMs
    setPhase(stalled ? "unconfirmed" : "pending")
    if (mode === "poll" || stalled || !reader.waitForTransactionReceipt) {
      poll(record.hash, record.startedAt)
      return
    }
    let stopped = false
    stopRef.current = () => {
      stopped = true
    }
    void reader.waitForTransactionReceipt({ hash: record.hash, timeout: receiptWatchConfig.waitMs }).then(
      (receipt) => {
        if (stopped) return
        apply(record.hash, record.startedAt, receipt.status === "success" ? "success" : "reverted")
      },
      (cause: unknown) => {
        if (stopped) return
        setPhase("unconfirmed")
        if (!isReceiptTimeout(cause)) setBanner(null)
        poll(record.hash, record.startedAt)
      },
    )
  }

  useEffect(() => {
    if (!client) return
    const saved = readPending(slot)
    if (!saved) return
    if (isPendingExpired(saved.startedAt)) {
      clearPending(slot)
      setPhase("idle")
      setTxHash(saved.hash)
      setStartedAt(null)
      setBanner({ kind: "expired", hash: saved.hash })
      return
    }
    watch(saved, "poll")
    return () => stop()
    // The client object identity changes between renders. Readiness is the signal that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(client), slot])

  return {
    phase,
    txHash,
    startedAt,
    banner,
    holdLock: phase === "pending" || phase === "unconfirmed",
    track(hash: Hex, started: number) {
      watch({ hash, startedAt: started }, "wait")
    },
    tryAgain() {
      finish("idle", null, null)
    },
    dismissBanner() {
      setBanner(null)
    },
  }
}
