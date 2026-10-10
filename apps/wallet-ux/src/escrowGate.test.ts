import { describe, expect, it } from "vitest"
import { decideReleaseRefund } from "./escrowGate"
import { RULING_GRACE_SECONDS } from "./format"

const now = 1_700_000_000n
const open = { state: 0, upheld: false, unresolved: false, unwind: false }

describe("release and refund gate", () => {
  it("allows release and blocks refund while an open escrow has time left", () => {
    const gate = decideReleaseRefund({ ...open, expiresAt: now + 10n, now })
    expect(gate.release.allowed).toBe(true)
    expect(gate.refund.allowed).toBe(false)
    expect(gate.refund.reason).toMatch(/time window is still open/)
  })

  it("allows refund and blocks release after an open escrow ends", () => {
    const gate = decideReleaseRefund({ ...open, expiresAt: now - 1n, now })
    expect(gate.release.allowed).toBe(false)
    expect(gate.refund.allowed).toBe(true)
  })

  it("allows only release after the panel rules that the deal stands", () => {
    const gate = decideReleaseRefund({
      state: 3,
      expiresAt: now - 1n,
      now,
      upheld: true,
      unresolved: false,
      unwind: false,
    })
    expect(gate.release.allowed).toBe(true)
    expect(gate.refund.allowed).toBe(false)
    expect(gate.refund.reason).toMatch(/deal stands/)
  })

  it("keeps refund blocked during the ruling grace while the case is unresolved", () => {
    const expiresAt = now - 10n
    const gate = decideReleaseRefund({
      state: 3,
      expiresAt,
      now,
      upheld: false,
      unresolved: true,
      unwind: false,
    })
    expect(now < expiresAt + RULING_GRACE_SECONDS).toBe(true)
    expect(gate.release.allowed).toBe(false)
    expect(gate.refund.allowed).toBe(false)
    expect(gate.refund.reason).toMatch(/7 days/)
  })
})
