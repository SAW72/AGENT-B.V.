// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WALLET_HINT_TEXT } from "../actionButton"
import { RegisterWizard, createStubController } from "../RegisterWizard"
import {
  ACK_CHECKBOX,
  CANCELLED,
  CHAIN_LEFT,
  FILE_HELPER,
  NETWORK_PILL,
  NO_EVENT,
  PASS_LINE,
  PROVISIONAL_LABEL,
  REGISTRY_ADDRESS,
  REGISTRY_BASESCAN_URL,
  REVERTED,
  USER_REJECTED,
  VALUES_CHANGED,
  registeredId,
  walletSwitched,
  wrongType,
} from "../registerCopy"
import { INSTALL_WALLET_HINT } from "../walletHint"
import type { ParsedRegistration, WizardController } from "./types"

const FROM = "0x1234567890abcdef1234567890abcdef12345678"
const PROVISIONAL = "424242"
const FINAL = "9001"
const GLOBAL = `eip155:84532:${REGISTRY_ADDRESS}:${FINAL}`

const parsed: ParsedRegistration = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Sample agent",
  sizeBytes: 120,
  sizeCap: 1000,
  agentURI: "data:application/json;base64,eyJuYW1lIjoiU2FtcGxlIn0=",
}

function renderWizard(overrides: Partial<WizardController> = {}) {
  const onRegistered = vi.fn()
  const controller = createStubController({ expanded: true, ...overrides })
  render(<RegisterWizard controller={controller} onRegistered={onRegistered} />)
  return { onRegistered, controller }
}

afterEach(() => {
  cleanup()
})

describe("RegisterWizard steps", () => {
  it("starts collapsed and opens the file step without a wallet call", () => {
    const onRegistered = vi.fn()
    render(<RegisterWizard onRegistered={onRegistered} />)
    expect(screen.getByRole("heading", { name: "Register a new agent" })).toBeTruthy()
    expect(screen.getByTestId("register-card-line")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Register an agent" }))
    expect(screen.getByTestId("step-file")).toBeTruthy()
    expect(screen.getByText(NETWORK_PILL)).toBeTruthy()
    expect(screen.getByText("1 File")).toBeTruthy()
    expect(screen.getByText(FILE_HELPER)).toBeTruthy()
    expect(screen.getByTestId("register-file").getAttribute("accept")).toBe(".json")
    fireEvent.click(screen.getByRole("tab", { name: "Paste" }))
    fireEvent.change(screen.getByTestId("register-paste"), { target: { value: "{" } })
    fireEvent.click(screen.getByRole("button", { name: "Check registration" }))
    expect(screen.getByText("This isn't valid JSON.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    fireEvent.click(screen.getByRole("tab", { name: "Paste" }))
    fireEvent.change(screen.getByTestId("register-paste"), {
      target: { value: JSON.stringify({ type: "registration-v1", name: "A" }) },
    })
    fireEvent.click(screen.getByRole("button", { name: "Check registration" }))
    expect(screen.getByText(wrongType("registration-v1"))).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    fireEvent.click(screen.getByRole("tab", { name: "Paste" }))
    fireEvent.change(screen.getByTestId("register-paste"), {
      target: { value: JSON.stringify({ type: parsed.type, name: "Sample agent" }) },
    })
    fireEvent.click(screen.getByRole("button", { name: "Check registration" }))
    expect(screen.getByText(PASS_LINE)).toBeTruthy()
    expect(screen.getByTestId("size-row").textContent ?? "").not.toMatch(/limit \d+/)
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy()
    expect(onRegistered).not.toHaveBeenCalled()
  })

  it("shows the provisional label beside the provisional id on dry run and confirm", () => {
    const { unmount } = render(
      <RegisterWizard
        onRegistered={vi.fn()}
        controller={createStubController({
          expanded: true,
          step: 3,
          from: FROM,
          provisionalId: PROVISIONAL,
          gas: { units: "21000", estCostTestEth: "0.0001" },
          existingCount: 2n,
          parsed,
        })}
      />,
    )
    const dry = screen.getByTestId("provisional-row")
    expect(dry.textContent).toContain(PROVISIONAL)
    expect(dry.textContent).toContain(PROVISIONAL_LABEL)
    expect(screen.getByTestId("duplicate-warning").textContent).toContain("2 registered agents")
    expect(screen.queryByRole("link", { name: /look up/i })).toBeNull()
    expect(screen.queryByText(/Look up/)).toBeNull()
    unmount()

    renderWizard({
      step: 4,
      from: FROM,
      provisionalId: PROVISIONAL,
      gas: { units: "21000", estCostTestEth: "0.0001" },
      parsed,
      acknowledged: true,
    })
    const confirm = screen.getByTestId("provisional-row")
    expect(confirm.textContent).toContain(PROVISIONAL)
    expect(confirm.textContent).toContain(PROVISIONAL_LABEL)
    expect(screen.getByRole("link", { name: "View on Basescan" }).getAttribute("href")).toBe(REGISTRY_BASESCAN_URL)
  })

  it("does not show a duplicate warning for a zero count", () => {
    renderWizard({ step: 3, provisionalId: PROVISIONAL, existingCount: 0n, from: FROM, gas: { units: "1", estCostTestEth: "0" } })
    expect(screen.queryByTestId("duplicate-warning")).toBeNull()
  })

  it("shows one registered agent for a count of 1", () => {
    renderWizard({ step: 3, provisionalId: PROVISIONAL, existingCount: 1n, from: FROM })
    expect(screen.getByTestId("duplicate-warning").textContent).toContain("1 registered agent")
  })

  it("disables review when the dry run is rejected and when the chain changed", () => {
    const onDryRun = vi.fn()
    const { unmount } = render(
      <RegisterWizard
        onRegistered={vi.fn()}
        controller={createStubController({
          expanded: true,
          step: 3,
          provisionalId: PROVISIONAL,
          errorKind: "DryRunReverted",
          errorDetail: "execution stopped",
          onDryRun,
        })}
      />,
    )
    const review = screen.getByRole("button", { name: "Review and confirm" })
    expect((review as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText("The registry would reject this registration.")).toBeTruthy()
    unmount()

    renderWizard({ step: 3, notice: "chain-left", provisionalId: PROVISIONAL })
    expect(screen.getByText(CHAIN_LEFT)).toBeTruthy()
    expect((screen.getByRole("button", { name: "Review and confirm" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("tells the user to run the check again when the account changes", () => {
    renderWizard({ step: 3, notice: "account-changed", noticeDetail: "0x1234…abcd", provisionalId: PROVISIONAL })
    expect(screen.getByText(walletSwitched("0x1234…abcd"))).toBeTruthy()
  })

  it("requires the checkbox and calls onConfirm only", () => {
    const onConfirm = vi.fn()
    const onDryRun = vi.fn()
    const { unmount } = render(
      <RegisterWizard
        onRegistered={vi.fn()}
        controller={createStubController({
          expanded: true,
          step: 4,
          parsed,
          from: FROM,
          provisionalId: PROVISIONAL,
          acknowledged: false,
          onConfirm,
          onDryRun,
        })}
      />,
    )
    expect(screen.getByText(ACK_CHECKBOX)).toBeTruthy()
    const button = screen.getByRole("button", { name: "Confirm in wallet" }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onConfirm).not.toHaveBeenCalled()
    unmount()

    renderWizard({
      step: 4,
      parsed,
      provisionalId: PROVISIONAL,
      acknowledged: true,
      valuesChanged: true,
      onConfirm,
    })
    expect(screen.getByText(VALUES_CHANGED)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }))
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onDryRun).not.toHaveBeenCalled()
  })

  it("hides Back while the wallet prompt is open", () => {
    renderWizard({
      step: 4,
      parsed,
      provisionalId: PROVISIONAL,
      acknowledged: true,
      walletPending: true,
      promptSlow: true,
    })
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull()
    expect(screen.getByRole("button", { name: "Waiting for your wallet..." })).toBeTruthy()
    expect(screen.getByText(WALLET_HINT_TEXT)).toBeTruthy()
    expect(screen.getByText("Still waiting. If you closed the wallet window, open it again or reject the request there.")).toBeTruthy()
  })

  it("shows a rejected signature without leaving the confirm step", () => {
    renderWizard({ step: 4, parsed, provisionalId: PROVISIONAL, acknowledged: true, errorKind: "UserRejected" })
    expect(screen.getByText(USER_REJECTED)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Confirm in wallet" })).toBeTruthy()
  })

  it("shows the final id on confirm and never the provisional id when the event is missing", () => {
    const { unmount } = render(
      <RegisterWizard
        onRegistered={vi.fn()}
        controller={createStubController({
          expanded: true,
          step: 5,
          txStatus: "confirmed",
          finalId: FINAL,
          globalId: GLOBAL,
          owner: FROM,
          txHash: "0xabc123",
          provisionalId: PROVISIONAL,
        })}
      />,
    )
    expect(screen.getByText(registeredId(FINAL))).toBeTruthy()
    expect(screen.getByTestId("final-agent-id").textContent).toContain(FINAL)
    expect(screen.getByTestId("global-id").textContent).toContain(GLOBAL)
    expect(screen.queryByTestId("provisional-id")).toBeNull()
    expect(screen.queryByText(PROVISIONAL_LABEL)).toBeNull()
    expect(document.body.textContent).not.toContain(PROVISIONAL)
    unmount()

    renderWizard({
      step: 5,
      txStatus: "noEvent",
      txHash: "0xabc123",
      provisionalId: PROVISIONAL,
      finalId: null,
    })
    expect(screen.getByText(NO_EVENT)).toBeTruthy()
    expect(screen.queryByTestId("provisional-id")).toBeNull()
    expect(screen.queryByText(PROVISIONAL_LABEL)).toBeNull()
    expect(document.body.textContent).not.toContain(PROVISIONAL)
    expect(screen.queryByText(registeredId(FINAL))).toBeNull()
  })

  it("offers Start over when the transaction is reverted or cancelled", () => {
    const onStartOver = vi.fn()
    const { unmount } = render(
      <RegisterWizard
        onRegistered={vi.fn()}
        controller={createStubController({
          expanded: true,
          step: 5,
          txStatus: "reverted",
          errorDetail: "out of gas",
          provisionalId: PROVISIONAL,
          onStartOver,
        })}
      />,
    )
    expect(screen.getByText(REVERTED)).toBeTruthy()
    expect(screen.getByText("out of gas")).toBeTruthy()
    expect(document.body.textContent).not.toContain(PROVISIONAL)
    fireEvent.click(screen.getByRole("button", { name: "Start over" }))
    expect(onStartOver).toHaveBeenCalledOnce()
    unmount()

    renderWizard({ step: 5, txStatus: "cancelled", provisionalId: PROVISIONAL })
    expect(screen.getByText(CANCELLED)).toBeTruthy()
    expect(document.body.textContent).not.toContain(PROVISIONAL)
  })

  it("copies the global id and reports a missing clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    const { unmount } = render(
      <RegisterWizard
        onRegistered={vi.fn()}
        controller={createStubController({
          expanded: true,
          step: 5,
          txStatus: "confirmed",
          finalId: FINAL,
          globalId: GLOBAL,
          owner: FROM,
        })}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId("copy-global-id"))
    })
    expect(writeText).toHaveBeenCalledWith(GLOBAL)
    unmount()

    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
    renderWizard({ step: 5, txStatus: "confirmed", finalId: FINAL, globalId: GLOBAL, owner: FROM })
    fireEvent.click(screen.getByTestId("copy-global-id"))
    expect(screen.getByText("Copy failed")).toBeTruthy()
  })

  it("shows the shared install hint when no wallet is available", () => {
    renderWizard({ step: 2, parsed, connectNotice: "no-wallet", walletConnected: false })
    expect(screen.getByText(INSTALL_WALLET_HINT)).toBeTruthy()
    expect(INSTALL_WALLET_HINT).toBe("Install a browser wallet if no injected wallet is available.")
  })
})
