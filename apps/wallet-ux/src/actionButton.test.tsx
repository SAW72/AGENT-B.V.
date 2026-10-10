// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import {
  ActionButton,
  ActionStatus,
  CHECKING_LABEL,
  CONFIRM_WALLET_LABEL,
  DONE_LABEL,
  NEEDS_WALLET_LABEL,
  PENDING_NETWORK_LABEL,
  WALLET_HINT_TEXT,
  WRONG_NETWORK_LABEL,
  type ActionButtonState,
} from "./actionButton"
import { PENDING_SLOW_TEXT } from "./actionProgress"
import { shortAddress } from "./format"

const HASH = `0x${"ab".repeat(32)}`

afterEach(() => {
  cleanup()
})

const states: ActionButtonState[] = [
  { status: "idle", label: "Prepare this escrow" },
  { status: "needs-wallet" },
  { status: "wrong-network" },
  { status: "busy", label: "Preparing…" },
  { status: "busy", label: CHECKING_LABEL },
  { status: "waiting-wallet" },
  { status: "pending", hash: HASH },
  { status: "confirmed", hash: HASH },
  { status: "error", message: "Enter an amount of test ETH, such as 0.001." },
]

describe("ActionButton states", () => {
  it.each(states)("renders $status", (state) => {
    render(
      <>
        <ActionButton state={state} />
        <ActionStatus state={state} walletHint={state.status === "waiting-wallet"} />
      </>,
    )
    const button = document.querySelector("[data-action-button]") as HTMLButtonElement
    expect(button.getAttribute("data-action-button")).toBe(state.status)
    if (state.status === "idle") {
      expect(button.textContent).toBe(state.label)
      expect(button.disabled).toBe(false)
    }
    if (state.status === "needs-wallet") {
      expect(button.textContent).toBe(NEEDS_WALLET_LABEL)
      expect(button.disabled).toBe(true)
    }
    if (state.status === "wrong-network") {
      expect(button.textContent).toBe(WRONG_NETWORK_LABEL)
      expect(button.disabled).toBe(false)
    }
    if (state.status === "busy") {
      expect(button.textContent).toBe(state.label)
      expect(button.disabled).toBe(true)
      expect(button.getAttribute("aria-busy")).toBe("true")
    }
    if (state.status === "waiting-wallet") {
      expect(button.textContent).toBe(CONFIRM_WALLET_LABEL)
      expect(button.disabled).toBe(true)
      expect(button.getAttribute("aria-busy")).toBe("true")
      expect(screen.getByTestId("wallet-hint").textContent).toBe(WALLET_HINT_TEXT)
    }
    if (state.status === "pending") {
      expect(button.textContent).toBe(PENDING_NETWORK_LABEL)
      expect(screen.getByTestId("tx-pending").textContent).toBe(PENDING_NETWORK_LABEL)
      expect(screen.getByTestId("tx-hash").textContent).toBe(HASH)
      expect(screen.getByTestId("tx-explorer").getAttribute("href")).toBe(`https://sepolia.basescan.org/tx/${HASH}`)
    }
    if (state.status === "confirmed") {
      expect(button.textContent).toBe(DONE_LABEL)
      expect(screen.getByTestId("action-confirmed").textContent).toContain("✓")
      expect(screen.getByTestId("tx-confirmed").textContent).toBe(DONE_LABEL)
      expect(screen.getByTestId("tx-explorer").getAttribute("href")).toContain(HASH)
    }
    if (state.status === "error") {
      const alert = screen.getByRole("alert")
      expect(alert.textContent).toBe(state.message)
      expect(button.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it("shows one warning icon on a slow pending note", () => {
    render(<ActionStatus state={{ status: "pending", hash: HASH, startedAt: Date.now() - 70_000 }} />)
    const note = screen.getByTestId("pending-slow")
    expect(note.textContent).toBe(PENDING_SLOW_TEXT)
    expect(note.querySelector(".mark")).toBeNull()
    expect(note.classList.contains("warn-note")).toBe(true)
  })

  it("shows a confirmed result as labeled body-size rows", () => {
    const escrowId = `0x${"cd".repeat(32)}`
    render(
      <ActionStatus
        state={{
          status: "confirmed",
          hash: HASH,
          label: "Escrow funded",
          resultId: escrowId,
          resultLabel: "Escrow ID",
          nextHref: "#release-form",
          nextLabel: "Next: release the payment",
        }}
      />,
    )
    const id = screen.getByTestId("result-id")
    expect(id.textContent).toContain("Escrow ID")
    expect(id.className).not.toContain("result-id")
    expect(id.querySelectorAll(".chunk").length).toBeGreaterThan(1)
    for (const chunk of id.querySelectorAll(".chunk")) {
      expect(chunk.textContent ?? "").not.toMatch(/\s/)
    }
    expect(screen.getByTestId("tx-hash").textContent).toBe(shortAddress(HASH))
    expect(screen.getByTestId("tx-explorer").getAttribute("href")).toBe(`https://sepolia.basescan.org/tx/${HASH}`)
    const next = screen.getByTestId("next-step")
    expect(next.textContent).toBe("Next step")
    expect(next.getAttribute("href")).toBe("#release-form")
    expect(screen.getByTestId("tx-confirmed").textContent).toBe("Escrow funded")
  })
})
