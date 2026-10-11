// @vitest-environment happy-dom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { Hex } from "viem"
import { previewCreateEscrow, previewDispute, previewRelease, previewVote, previewWithdraw } from "./preview"
import {
  clearPending,
  dismissClockNote,
  listClockNotes,
  pendingSlot,
  pendingStorageKey,
  readPending,
  resetPendingStore,
  subjectFromCalldata,
  writePending,
} from "./pendingTx"
import { checkPendingReceipt, isPendingExpired, receiptWatchConfig } from "./pendingWatch"
import { hasLivePending, resetSubmitLock } from "./submitLock"

const hash = `0x${"ab".repeat(32)}` as Hex
const keyReads = { n: 0 }

beforeAll(() => {
  const original = Storage.prototype.key
  vi.spyOn(Storage.prototype, "key").mockImplementation(function (this: Storage, index: number) {
    keyReads.n += 1
    return original.call(this, index)
  })
})

function missing(name: string): Error {
  return Object.assign(new Error(name), { name })
}

describe("pending receipt checks", () => {
  it("keeps a missing transaction pending until the grace period ends", async () => {
    const client = {
      getTransactionReceipt: async () => {
        throw missing("TransactionReceiptNotFoundError")
      },
      getTransaction: async () => {
        throw missing("TransactionNotFoundError")
      },
    }
    const started = 1_000_000
    await expect(checkPendingReceipt(client, hash, started, started + receiptWatchConfig.unknownGraceMs - 1)).resolves.toBe(
      "pending",
    )
    await expect(checkPendingReceipt(client, hash, started, started + receiptWatchConfig.unknownGraceMs)).resolves.toBe(
      "unknown",
    )
  })

  it("reports success, revert, and a still-pending transaction", async () => {
    const started = Date.now()
    await expect(
      checkPendingReceipt(
        {
          getTransactionReceipt: async () => ({ status: "success" }) as never,
          getTransaction: async () => null,
        },
        hash,
        started,
      ),
    ).resolves.toBe("success")
    await expect(
      checkPendingReceipt(
        {
          getTransactionReceipt: async () => ({ status: "reverted" }) as never,
          getTransaction: async () => null,
        },
        hash,
        started,
      ),
    ).resolves.toBe("reverted")
    await expect(
      checkPendingReceipt(
        {
          getTransactionReceipt: async () => {
            throw missing("TransactionReceiptNotFoundError")
          },
          getTransaction: async () => ({ hash }) as never,
        },
        hash,
        started - receiptWatchConfig.unknownGraceMs,
      ),
    ).resolves.toBe("pending")
  })

  it("treats a transport error as unreadable and expires only past 30 minutes", async () => {
    const started = Date.now()
    await expect(
      checkPendingReceipt(
        {
          getTransactionReceipt: async () => {
            throw new Error("429")
          },
          getTransaction: async () => null,
        },
        hash,
        started,
      ),
    ).resolves.toBe("unreadable")
    const at = 5_000_000
    expect(isPendingExpired(at, at + receiptWatchConfig.maxAgeMs)).toBe(false)
    expect(isPendingExpired(at, at + receiptWatchConfig.maxAgeMs + 1)).toBe(true)
  })

  it("ignores a tampered stored value", () => {
    localStorage.setItem("agent-bv.pending.release", "not-json")
    localStorage.setItem("agent-bv.pending.withdraw", JSON.stringify({ hash: "0x12", startedAt: "yesterday" }))
    localStorage.setItem("agent-bv.pending.vote", JSON.stringify({ hash, startedAt: Number.NaN }))
    localStorage.setItem(
      "agent-bv.pending.release:0x" + "ab".repeat(32),
      JSON.stringify({ hash, startedAt: 1, action: "release" }),
    )
    expect(readPending("release")).toBeNull()
    expect(readPending("withdraw")).toBeNull()
    expect(readPending("vote")).toBeNull()
    expect(readPending(pendingSlot("release", hash))).toBeNull()
  })

  it("keys a pending record by the id in the sent calldata", () => {
    const escrow = "0x3d660502D75f1e97b08c110255921b437A3C4C42" as const
    const panel = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb" as const
    const escrowId = `0x${"11".repeat(32)}` as const
    const disputeId = `0x${"22".repeat(32)}` as const
    const created = previewCreateEscrow({
      escrow,
      escrowId,
      payee: "0x6C756dacfEcEeA12D5D39536d2eCC175f18bc5A4",
      payerBotId: escrowId,
      payeeBotId: disputeId,
      durationSeconds: 3600n,
      valueWei: 1n,
    })
    expect(subjectFromCalldata(created.calldata)).toEqual({ action: "createEscrow", subjectId: escrowId })
    expect(subjectFromCalldata(previewRelease(escrow, escrowId).calldata)?.subjectId).toBe(escrowId)
    expect(subjectFromCalldata(previewDispute(escrow, escrowId, disputeId, "late").calldata)).toEqual({
      action: "dispute",
      subjectId: disputeId,
    })
    expect(subjectFromCalldata(previewVote(panel, disputeId, true).calldata)?.subjectId).toBe(disputeId)
    expect(subjectFromCalldata(previewWithdraw(escrow).calldata)).toEqual({ action: "withdraw", subjectId: null })
    const stored = writePending({ action: "createEscrow", subjectId: escrowId, hash, startedAt: 10 })
    expect(readPending(pendingSlot("createEscrow", escrowId))).toEqual(stored)
    expect(readPending(pendingSlot("createEscrow", disputeId))).toBeNull()
  })

  it("keeps a future clock as a Basescan hold until it is dismissed", () => {
    const slot = pendingSlot("release", hash)
    localStorage.setItem(
      pendingStorageKey(slot),
      JSON.stringify({ hash, startedAt: Date.now() + 1e12, action: "release", subjectId: hash }),
    )
    expect(readPending(slot)).toBeNull()
    expect(localStorage.getItem(pendingStorageKey(slot))).toBeNull()
    expect(listClockNotes().map((note) => note.hash.toLowerCase())).toContain(hash.toLowerCase())
    expect(hasLivePending()).toBe(true)
    resetPendingStore()
    resetSubmitLock()
    expect(listClockNotes().map((note) => note.hash.toLowerCase())).toContain(hash.toLowerCase())
    expect(hasLivePending()).toBe(true)
    dismissClockNote(hash)
    expect(listClockNotes()).toEqual([])
    expect(hasLivePending()).toBe(false)
  })

  it("hides a dismissed clock note when removeItem throws", () => {
    const slot = pendingSlot("release", hash)
    localStorage.setItem(
      pendingStorageKey(slot),
      JSON.stringify({ hash, startedAt: Date.now() + 1e12, action: "release", subjectId: hash }),
    )
    expect(readPending(slot)).toBeNull()
    expect(listClockNotes().map((note) => note.hash.toLowerCase())).toContain(hash.toLowerCase())
    const spy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    try {
      expect(() => dismissClockNote(hash)).not.toThrow()
      expect(listClockNotes()).toEqual([])
      expect(hasLivePending()).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it("keeps a skew of under a minute as a normal pending record", () => {
    const slot = pendingSlot("release", hash)
    const startedAt = Date.now() + 59_000
    localStorage.setItem(
      pendingStorageKey(slot),
      JSON.stringify({ hash, startedAt, action: "release", subjectId: hash }),
    )
    expect(readPending(slot)?.startedAt).toBe(startedAt)
    expect(listClockNotes()).toEqual([])
    expect(hasLivePending()).toBe(true)
  })

  it("does not throw when clearing a pending row and storage refuses the delete", () => {
    writePending({ action: "release", subjectId: hash, hash, startedAt: Date.now() })
    const spy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    try {
      expect(() => clearPending(pendingSlot("release", hash))).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })

  it("keeps an in-memory pending record when storage throws", () => {
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    try {
      const stored = writePending({ action: "release", subjectId: hash, hash, startedAt: Date.now() })
      expect(stored.saved).toBe(false)
      expect(readPending(pendingSlot("release", hash))).toEqual(stored)
      expect(hasLivePending()).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it("reads pending storage once until a write or a storage event", () => {
    writePending({ action: "release", subjectId: hash, hash, startedAt: Date.now() })
    const before = keyReads.n
    expect(hasLivePending()).toBe(true)
    const after = keyReads.n
    expect(after).toBeGreaterThan(before)
    expect(hasLivePending()).toBe(true)
    expect(keyReads.n).toBe(after)
    window.dispatchEvent(new StorageEvent("storage", { key: pendingStorageKey(pendingSlot("release", hash)) }))
    expect(hasLivePending()).toBe(true)
    expect(keyReads.n).toBeGreaterThan(after)
  })
})

afterEach(() => {
  localStorage.clear()
  resetPendingStore()
  resetSubmitLock()
})
