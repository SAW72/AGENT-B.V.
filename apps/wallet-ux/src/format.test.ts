import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ZERO_ADDRESS } from "./addresses"
import {
  PAYEE_OPEN_AFTER_EXPIRY_TEXT,
  PAYEE_OPEN_BEFORE_EXPIRY_TEXT,
  RULING_GRACE_SECONDS,
  payeeOpenExpiryNotice,
} from "./format"

const PAYEE = "0x1111111111111111111111111111111111111111"
const PAYER = "0x2222222222222222222222222222222222222222"
const ENDS = 1_700_000_000n

function notice(overrides: Partial<Parameters<typeof payeeOpenExpiryNotice>[0]> = {}) {
  return payeeOpenExpiryNotice({
    viewer: PAYEE,
    payee: PAYEE,
    payer: PAYER,
    state: 0,
    expiresAt: ENDS,
    used: true,
    createdAt: ENDS - 86_400n,
    nowSeconds: ENDS - 60n,
    ...overrides,
  })
}

describe("payee open expiry notice", () => {
  it("prompts the payee to dispute before an open claim ends", () => {
    const shown = notice()
    expect(shown).toEqual({
      beforeExpiry: true,
      urgent: true,
      endsLabel: "2023-11-14 22:13:20 UTC",
      graceEndsLabel: "2023-11-21 22:13:20 UTC",
      text: PAYEE_OPEN_BEFORE_EXPIRY_TEXT,
      cta: "Dispute before 2023-11-14 22:13:20 UTC.",
      urgentText: "Less than a day remains. Dispute before 2023-11-14 22:13:20 UTC.",
    })
    expect(RULING_GRACE_SECONDS).toBe(7n * 24n * 60n * 60n)
    expect(shown?.text).toContain("Open a dispute before this escrow ends")
    expect(shown?.text).toContain("anyone can trigger the refund to the payer unless a dispute is already open")
    expect(PAYEE_OPEN_AFTER_EXPIRY_TEXT).toContain("Anyone can trigger the refund to the payer")
    expect(PAYEE_OPEN_BEFORE_EXPIRY_TEXT).not.toContain("the payer can refund")
    expect(PAYEE_OPEN_AFTER_EXPIRY_TEXT).not.toContain("the payer can refund")
    expect(shown?.text).toContain("7 days after the escrow ends")
  })

  it("still treats the exact end second as before expiry", () => {
    const shown = notice({ nowSeconds: ENDS })
    expect(shown?.beforeExpiry).toBe(true)
    expect(shown?.urgent).toBe(true)
    expect(shown?.cta).toBe("Dispute before 2023-11-14 22:13:20 UTC.")
  })

  it("warns only when less than a day remains", () => {
    const day = 24n * 60n * 60n
    const calm = notice({ nowSeconds: ENDS - day })
    expect(calm?.beforeExpiry).toBe(true)
    expect(calm?.urgent).toBe(false)
    expect(calm?.urgentText).toBeNull()
    expect(calm?.cta).toBe("Dispute before 2023-11-14 22:13:20 UTC.")
    const soon = notice({ nowSeconds: ENDS - day + 1n })
    expect(soon?.urgent).toBe(true)
    expect(soon?.urgentText).toBe("Less than a day remains. Dispute before 2023-11-14 22:13:20 UTC.")
  })

  it("stops the dispute prompt once the open claim has ended", () => {
    const shown = notice({ nowSeconds: ENDS + 1n })
    expect(shown?.beforeExpiry).toBe(false)
    expect(shown?.text).toBe(PAYEE_OPEN_AFTER_EXPIRY_TEXT)
    expect(shown?.endsLabel).toBe("2023-11-14 22:13:20 UTC")
    expect(shown?.graceEndsLabel).toBe("2023-11-21 22:13:20 UTC")
  })

  it("matches the payee address without regard to case", () => {
    expect(notice({ viewer: PAYEE.toUpperCase() })?.beforeExpiry).toBe(true)
  })

  it("stays quiet for the payer, a stranger, a disconnected wallet, and a non-open claim", () => {
    expect(notice({ viewer: PAYER })).toBeNull()
    expect(notice({ viewer: "0x3333333333333333333333333333333333333333" })).toBeNull()
    expect(notice({ viewer: undefined })).toBeNull()
    expect(notice({ viewer: null })).toBeNull()
    expect(notice({ viewer: "" })).toBeNull()
    for (const state of [1, 2, 3]) {
      expect(notice({ state })).toBeNull()
    }
  })

  it("stays quiet for an empty escrow row", () => {
    expect(
      notice({
        viewer: ZERO_ADDRESS,
        payee: ZERO_ADDRESS,
        payer: ZERO_ADDRESS,
        used: false,
        createdAt: 0n,
        expiresAt: 0n,
        state: 0,
      }),
    ).toBeNull()
  })

  it("renders the prompt from the escrow lookup", () => {
    const panel = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "EscrowPanel.tsx"), "utf8")
    expect(panel).toContain('data-testid="payee-expiry-prompt"')
    expect(panel).toContain('data-testid="payee-dispute-cta"')
    expect(panel).toContain('data-testid="payee-expiry-urgent"')
    expect(panel).toContain('href="#open-dispute"')
    expect(panel).toContain("payeeOpenExpiryNotice")
    expect(panel).toContain("useAccount")
    expect(panel).toContain("startNowTicker")
    expect(panel).toContain("useEffect(() => startNowTicker(setNowSeconds, PAYEE_NOW_INTERVAL_MS), [])")
    expect(panel).not.toContain("Math.floor(Date.now() / 1000)")
  })
})
