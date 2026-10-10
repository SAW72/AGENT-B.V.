import type { Hex, TransactionReceipt } from "viem"

/** How often a stalled transaction is re-read while the page stays open. */
export const receiptWatchConfig = {
  pollMs: 15_000,
  waitMs: 180_000,
  unknownGraceMs: 3 * 60 * 1000,
  maxAgeMs: 30 * 60 * 1000,
  expiryTickMs: 30_000,
}

export type ReceiptReader = {
  getTransactionReceipt: (args: { hash: Hex }) => Promise<Pick<TransactionReceipt, "status"> | null | undefined>
  getTransaction: (args: { hash: Hex }) => Promise<unknown>
  waitForTransactionReceipt: (args: { hash: Hex; timeout?: number }) => Promise<Pick<TransactionReceipt, "status">>
}

export type ReceiptOutcome = "pending" | "success" | "reverted" | "unknown" | "unreadable"

const MISSING = new Set(["TransactionNotFoundError", "TransactionReceiptNotFoundError"])

function errorName(error: unknown): string {
  if (!error || typeof error !== "object" || !("name" in error)) return ""
  return String((error as { name: unknown }).name)
}

export function isMissingTransactionError(error: unknown): boolean {
  return MISSING.has(errorName(error))
}

export function isPendingExpired(startedAt: number, now = Date.now()): boolean {
  return now - startedAt > receiptWatchConfig.maxAgeMs
}

/**
 * One look at a stored hash.
 * A missing receipt stays pending. A missing transaction is unknown only after the grace period.
 * Unknown does not drop the record. A transport error stays unreadable so the entry is not dropped on a blip.
 */
export async function checkPendingReceipt(
  client: Pick<ReceiptReader, "getTransaction" | "getTransactionReceipt">,
  hash: Hex,
  startedAt: number,
  now = Date.now(),
): Promise<ReceiptOutcome> {
  try {
    const receipt = await client.getTransactionReceipt({ hash })
    if (receipt) return receipt.status === "success" ? "success" : "reverted"
  } catch (cause) {
    if (!isMissingTransactionError(cause)) return "unreadable"
  }

  try {
    const tx = await client.getTransaction({ hash })
    if (tx) return "pending"
  } catch (cause) {
    if (!isMissingTransactionError(cause)) return "unreadable"
  }

  if (now - startedAt >= receiptWatchConfig.unknownGraceMs) return "unknown"
  return "pending"
}

