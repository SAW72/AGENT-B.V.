// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import type { Hex } from "viem"
import { readPending } from "./pendingTx"
import { checkPendingReceipt, isPendingExpired, receiptWatchConfig } from "./pendingWatch"

const hash = `0x${"ab".repeat(32)}` as Hex

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
    expect(readPending("release")).toBeNull()
    expect(readPending("withdraw")).toBeNull()
    expect(readPending("vote")).toBeNull()
  })
})
