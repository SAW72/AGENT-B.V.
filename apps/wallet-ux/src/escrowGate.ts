import { useEffect, useState } from "react"
import type { Address, Hex } from "viem"
import { disputePanelAbi, escrowAbi } from "./abi"
import { ZERO_ADDRESS } from "./addresses"
import { parseBytes32 } from "./bytes32"
import { RULING_GRACE_SECONDS } from "./format"
import { currentNowSeconds } from "./nowClock"
import { panelSubject } from "./preview"

export const READING_ESCROW_TEXT = "Reading this escrow."
export const ESCROW_UNREAD_TEXT = "This escrow could not be read. The contract still checks the action."

export type GateDecision = { allowed: boolean; reason: string | null }

const OPEN = 0
const RELEASED = 1
const REFUNDED = 2
const DISPUTED = 3

export function decideReleaseRefund(input: {
  state: number
  expiresAt: bigint
  now: bigint
  upheld: boolean
  unresolved: boolean
  unwind: boolean
}): { release: GateDecision; refund: GateDecision } {
  if (input.state === RELEASED) {
    const reason = "This payment was already released."
    return { release: { allowed: false, reason }, refund: { allowed: false, reason } }
  }
  if (input.state === REFUNDED) {
    const reason = "This payment was already refunded."
    return { release: { allowed: false, reason }, refund: { allowed: false, reason } }
  }
  if (input.state === OPEN) {
    const expired = input.now > input.expiresAt
    return {
      release: expired
        ? { allowed: false, reason: "This escrow's time window has ended, so it can't be paid out that way." }
        : { allowed: true, reason: null },
      refund: expired
        ? { allowed: true, reason: null }
        : { allowed: false, reason: "This escrow can't be refunded yet. Its time window is still open." },
    }
  }
  if (input.state === DISPUTED) {
    const release: GateDecision = input.upheld
      ? { allowed: true, reason: null }
      : { allowed: false, reason: "Release stays blocked until the panel rules that the deal stands." }
    let refund: GateDecision
    if (input.upheld) {
      refund = { allowed: false, reason: "A refund stays blocked when the panel ruled that the deal stands." }
    } else if (input.now <= input.expiresAt) {
      refund = input.unwind
        ? { allowed: true, reason: null }
        : {
            allowed: false,
            reason: "A refund before the escrow ends stays blocked until the panel unwinds the deal.",
          }
    } else if (input.unresolved && input.now < input.expiresAt + RULING_GRACE_SECONDS) {
      refund = {
        allowed: false,
        reason: "A dispute ruling is pending. Refund opens 7 days after expiry if the panel has not ruled.",
      }
    } else {
      refund = { allowed: true, reason: null }
    }
    return { release, refund }
  }
  const reason = "This escrow is not in a state where that action is allowed."
  return { release: { allowed: false, reason }, refund: { allowed: false, reason } }
}

type GateStatus = "idle" | "reading" | "ready" | "unread"

const OPEN_DECISION: GateDecision = { allowed: true, reason: null }

function tupleField(value: unknown, index: number, name: string): unknown {
  if (Array.isArray(value)) return value[index]
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    if (name in record) return record[name]
    if (String(index) in record) return record[String(index)]
  }
  return undefined
}

function asAddress(value: unknown): Address | null {
  return typeof value === "string" && value.startsWith("0x") && value.length === 42 ? (value as Address) : null
}

function asBytes32(value: unknown): Hex | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? (value as Hex) : null
}

function asBigint(value: unknown): bigint | null {
  return typeof value === "bigint" ? value : null
}

function asState(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value
  if (typeof value === "bigint") return Number(value)
  return null
}

type EscrowReader = {
  readContract: (args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args: readonly [Hex]
  }) => Promise<unknown>
}

export function useEscrowActionGate(
  client: unknown,
  escrow: Address,
  panel: Address,
  rawId: string,
) {
  const reader = client as EscrowReader | undefined
  const id = parseBytes32(rawId)
  const [status, setStatus] = useState<GateStatus>(id ? "reading" : "idle")
  const [release, setRelease] = useState<GateDecision>(OPEN_DECISION)
  const [refund, setRefund] = useState<GateDecision>(OPEN_DECISION)

  useEffect(() => {
    if (!reader) {
      setStatus(id ? "unread" : "idle")
      setRelease(OPEN_DECISION)
      setRefund(OPEN_DECISION)
      return
    }
    if (!id) {
      setStatus("idle")
      setRelease(OPEN_DECISION)
      setRefund(OPEN_DECISION)
      return
    }
    let cancelled = false
    setStatus("reading")
    setRelease(OPEN_DECISION)
    setRefund(OPEN_DECISION)
    void (async () => {
      try {
        const row = await reader.readContract({
          address: escrow,
          abi: escrowAbi,
          functionName: "escrows",
          args: [id],
        })
        const payer = asAddress(tupleField(row, 0, "payer"))
        const createdAt = asBigint(tupleField(row, 5, "createdAt"))
        const expiresAt = asBigint(tupleField(row, 6, "expiresAt"))
        const state = asState(tupleField(row, 7, "state"))
        const disputeId = asBytes32(tupleField(row, 8, "disputeId"))
        if (!payer || createdAt == null || expiresAt == null || state == null || !disputeId) {
          throw new Error("unreadable escrow")
        }
        if (payer.toLowerCase() === ZERO_ADDRESS) {
          const missing = { allowed: false, reason: "This escrow is not on the contract yet." }
          if (!cancelled) {
            setRelease(missing)
            setRefund(missing)
            setStatus("ready")
          }
          return
        }
        let upheld = false
        let unresolved = false
        let unwind = false
        if (state === DISPUTED && disputeId !== `0x${"00".repeat(32)}`) {
          const outcome = await reader.readContract({
            address: panel,
            abi: disputePanelAbi,
            functionName: "outcome",
            args: [disputeId],
          })
          const exists = tupleField(outcome, 0, "exists") === true
          const resolved = tupleField(outcome, 1, "resolved") === true
          const upheldFlag = tupleField(outcome, 2, "upheld") === true
          const subject = asBytes32(tupleField(outcome, 3, "subjectHash"))
          const expected = panelSubject(escrow, id, createdAt)
          const matches = exists && subject != null && subject.toLowerCase() === expected.toLowerCase()
          upheld = matches && resolved && upheldFlag
          unresolved = matches && !resolved
          unwind = matches && resolved && !upheldFlag
        }
        const next = decideReleaseRefund({
          state,
          expiresAt,
          now: currentNowSeconds(),
          upheld,
          unresolved,
          unwind,
        })
        if (!cancelled) {
          setRelease(next.release)
          setRefund(next.refund)
          setStatus("ready")
        }
      } catch {
        if (!cancelled) {
          setRelease(OPEN_DECISION)
          setRefund(OPEN_DECISION)
          setStatus("unread")
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reader, escrow, panel, id])

  return { status, release, refund }
}
