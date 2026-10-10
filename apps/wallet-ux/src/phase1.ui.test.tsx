// @vitest-environment happy-dom

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { encodeFunctionResult, type Address, type Hex } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { escrowAbi } from "./abi"
import {
  AMOUNT_HINT,
  AMOUNT_PLACEHOLDER,
  CONFIRM_WALLET_LABEL,
  PAYEE_SELF_WARNING,
  WALLET_HINT_TEXT,
} from "./actionButton"
import { resetCarriedIds } from "./carriedIds"
import { FlowPreview } from "./FlowPreview"
import { FORM_ERRORS, durationValidationMessage } from "./submit"
import { MAX_DURATION_SECONDS } from "./preview"
import { VoteScreen } from "./VoteScreen"
import { WithdrawScreen } from "./WithdrawScreen"

const ACCOUNT = "0x6dBe4B1c56494Ee00d6f97FFE9f853F42299D6Ac" as Address
const escrow = "0x3d660502D75f1e97b08c110255921b437A3C4C42" as Address
const panel = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb" as Address
const claim = `0x${"ab".repeat(32)}` as Hex
const disputeId = `0x${"cd".repeat(32)}` as Hex
const payee = "0x6C756dacfEcEeA12D5D39536d2eCC175f18bc5A4" as Address
const ZERO = "0x0000000000000000000000000000000000000000" as Address

const { sendTransactionAsync, switchChain, releaseSend } = vi.hoisted(() => {
  let release: ((hash: Hex) => void) | null = null
  return {
    releaseSend: {
      arm() {
        return new Promise<Hex>((resolve) => {
          release = resolve
        })
      },
      go(hash: Hex) {
        release?.(hash)
        release = null
      },
    },
    sendTransactionAsync: vi.fn(async () => `0x${"11".repeat(32)}` as Hex),
    switchChain: vi.fn(),
  }
})

const publicClient = {
  getCode: async () => "0x60016000",
  call: async () => ({
    data: encodeFunctionResult({
      abi: escrowAbi,
      functionName: "panelSubject" as const,
      result: `0x${"11".repeat(32)}` as Hex,
    }),
  }),
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === "isArbitrator") return true
    if (functionName === "PANEL_SIZE") return 3n
    if (functionName === "voted") return false
    if (functionName === "pendingWithdrawals") return 1n
    if (functionName === "disputes") {
      return [`0x${"11".repeat(32)}`, ZERO, "reason", 1n, 0n, false, false, 10n]
    }
    if (functionName === "escrows") {
      return [escrow, escrow, claim, claim, 1n, 1_700_000_000n, 4_000_000_000n, 0, `0x${"00".repeat(32)}`, ZERO]
    }
    return 0n
  },
  waitForTransactionReceipt: async () => ({ status: "success" as const }),
}

vi.mock("wagmi", () => ({
  useAccount: () => ({
    isConnected: true,
    address: ACCOUNT,
    chainId: 84532,
    connector: undefined,
  }),
  usePublicClient: () => publicClient,
  useSendTransaction: () => ({ sendTransactionAsync, isPending: false }),
  useWalletClient: () => ({ data: undefined }),
  useSwitchChain: () => ({ switchChain, isPending: false, error: null }),
}))

function renderSurfaces() {
  return render(
    <>
      <FlowPreview escrow={escrow} panel={panel} />
      <VoteScreen panel={panel} />
      <WithdrawScreen escrow={escrow} readsEnabled />
    </>,
  )
}

function sectionOf(name: string) {
  const button = screen.getByRole("button", { name })
  const section = button.closest("section")
  if (!(section instanceof HTMLElement)) throw new Error(`no section for ${name}`)
  return within(section)
}

async function fillCreate(scope: ReturnType<typeof within>) {
  fireEvent.click(scope.getByRole("button", { name: "Use my own" }))
  fireEvent.change(scope.getByLabelText("Escrow ID"), { target: { value: claim } })
  fireEvent.change(scope.getByLabelText("Payee wallet"), { target: { value: payee } })
  fireEvent.change(scope.getByLabelText("Payer bot identifier"), { target: { value: claim } })
  fireEvent.change(scope.getByLabelText("Payee bot identifier"), { target: { value: disputeId } })
  fireEvent.change(scope.getByLabelText("Amount in ETH"), { target: { value: "0.001" } })
}

beforeEach(() => {
  resetCarriedIds()
  sendTransactionAsync.mockReset()
  sendTransactionAsync.mockResolvedValue(`0x${"11".repeat(32)}` as Hex)
  switchChain.mockReset()
  window.history.replaceState(null, "", "/")
})

afterEach(() => {
  cleanup()
  resetCarriedIds()
  vi.useRealTimers()
  window.history.replaceState(null, "", "/")
})

describe("phase 1 wallet forms", () => {
  it("uses ActionButton for every prepare and submit control", async () => {
    renderSurfaces()
    for (const name of ["Prepare this claim", "Prepare this payout", "Prepare this refund", "Prepare this dispute"]) {
      const button = screen.getByRole("button", { name })
      expect(button.getAttribute("data-action-button")).toBe("idle")
    }
    const withdraw = within(screen.getByTestId("withdraw-screen"))
    await waitFor(() => expect(withdraw.getByRole("button", { name: "Prepare withdraw" }).getAttribute("data-action-button")).toBe("idle"))
    const vote = within(screen.getByTestId("vote-screen"))
    await waitFor(() => expect(vote.getByRole("button", { name: "Prepare this vote" }).getAttribute("data-action-button")).toBe("idle"))
    expect(vote.getByTestId("vote-submit-blocked").getAttribute("data-action-button")).toBe("idle")

    const src = dirname(fileURLToPath(import.meta.url))
    for (const file of ["FlowPreview.tsx", "VoteScreen.tsx", "WithdrawScreen.tsx", "WalletOnlySubmit.tsx"]) {
      expect(readFileSync(join(src, file), "utf8")).toContain("ActionButton")
    }
    expect(readFileSync(join(src, "FlowPreview.tsx"), "utf8")).toContain('data-testid="relayer-submit"')
  })

  it("shows the MetaMask hint only after about 5 seconds with no wallet response", async () => {
    vi.useFakeTimers()
    sendTransactionAsync.mockImplementation(() => releaseSend.arm())
    renderSurfaces()
    const release = sectionOf("Prepare this payout")
    fireEvent.change(release.getByLabelText("Escrow ID"), { target: { value: claim } })
    fireEvent.click(release.getByRole("button", { name: "Prepare this payout" }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const submit = release.getByTestId("sepolia-submit")
    fireEvent.click(submit)
    await act(async () => {
      await Promise.resolve()
    })
    expect(release.getByRole("button", { name: CONFIRM_WALLET_LABEL }).getAttribute("aria-busy")).toBe("true")
    expect(release.queryByTestId("wallet-hint")).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999)
    })
    expect(release.queryByTestId("wallet-hint")).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(release.getByTestId("wallet-hint").textContent).toBe(WALLET_HINT_TEXT)
    releaseSend.go(`0x${"11".repeat(32)}`)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
  })

  it("disables other submit buttons while one transaction is in flight", async () => {
    sendTransactionAsync.mockImplementation(() => releaseSend.arm())
    renderSurfaces()
    const release = sectionOf("Prepare this payout")
    fireEvent.change(release.getByLabelText("Escrow ID"), { target: { value: claim } })
    fireEvent.click(release.getByRole("button", { name: "Prepare this payout" }))
    await waitFor(() => expect(release.getByTestId("sepolia-submit")).toBeTruthy())

    const withdraw = within(screen.getByTestId("withdraw-screen"))
    await waitFor(() => expect((withdraw.getByRole("button", { name: "Prepare withdraw" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(withdraw.getByRole("button", { name: "Prepare withdraw" }))
    await waitFor(() => expect(withdraw.getByTestId("sepolia-submit")).toBeTruthy())

    fireEvent.click(release.getByTestId("sepolia-submit"))
    await waitFor(() => expect(release.getByRole("button", { name: CONFIRM_WALLET_LABEL })).toBeTruthy())
    expect((withdraw.getByTestId("sepolia-submit") as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(withdraw.getByTestId("sepolia-submit"))
    expect(sendTransactionAsync).toHaveBeenCalledTimes(1)
    releaseSend.go(`0x${"22".repeat(32)}`)
    await waitFor(() => expect(withdraw.getByTestId("sepolia-submit")).toBeTruthy())
  })

  it("starts the amount empty and rejects a blank amount", async () => {
    renderSurfaces()
    const create = sectionOf("Prepare this claim")
    const amount = create.getByLabelText("Amount in ETH") as HTMLInputElement
    expect(amount.value).toBe("")
    expect(amount.placeholder).toBe(AMOUNT_PLACEHOLDER)
    expect(create.getByText(AMOUNT_HINT)).toBeTruthy()
    await fillCreate(create)
    fireEvent.change(amount, { target: { value: "  " } })
    fireEvent.click(create.getByRole("button", { name: "Prepare this claim" }))
    await waitFor(() => expect(create.getByRole("alert").textContent).toBe(FORM_ERRORS.valueEmpty))
    expect(create.queryByTestId("calldata-preview")).toBeNull()
    expect((create.getByLabelText("Amount in ETH") as HTMLInputElement).value).toBe("  ")
  })

  it("rejects custom durations that are not whole seconds", async () => {
    renderSurfaces()
    const create = sectionOf("Prepare this claim")
    await fillCreate(create)
    fireEvent.click(create.getByRole("radio", { name: "Custom" }))
    for (const raw of ["0x15180", "8.64e4", "1.5", "-5"]) {
      fireEvent.change(create.getByLabelText("Time window in seconds"), { target: { value: raw } })
      fireEvent.click(create.getByRole("button", { name: "Prepare this claim" }))
      await waitFor(() =>
        expect(create.getByRole("alert").textContent).toBe(durationValidationMessage(MAX_DURATION_SECONDS)),
      )
      expect(create.queryByTestId("calldata-preview")).toBeNull()
    }
    fireEvent.click(create.getByRole("radio", { name: "1 day" }))
    fireEvent.click(create.getByRole("button", { name: "Prepare this claim" }))
    await waitFor(() => expect(create.getByTestId("calldata-preview")).toBeTruthy())
  })

  it("shows a valid escrow and dispute from the URL and does not prepare or submit", async () => {
    window.history.replaceState(null, "", `/?escrow=${claim}&dispute=${disputeId}`)
    renderSurfaces()
    expect((sectionOf("Prepare this payout").getByLabelText("Escrow ID") as HTMLInputElement).value).toBe(claim)
    expect((sectionOf("Prepare this refund").getByLabelText("Escrow ID") as HTMLInputElement).value).toBe(claim)
    expect((sectionOf("Prepare this dispute").getByLabelText("Escrow ID") as HTMLInputElement).value).toBe(claim)
    const vote = within(screen.getByTestId("vote-screen"))
    expect((vote.getByLabelText("Dispute ID") as HTMLInputElement).value).toBe(disputeId)
    expect(screen.queryByTestId("calldata-preview")).toBeNull()
    expect(screen.queryByTestId("vote-preview")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()
  })

  it("ignores an invalid URL id and says so", () => {
    window.history.replaceState(null, "", "/?escrow=nope&dispute=0x1234")
    renderSurfaces()
    expect(screen.getByTestId("url-escrow-notice").textContent).toMatch(/ignored/i)
    expect(screen.getByTestId("url-dispute-notice").textContent).toMatch(/ignored/i)
    expect((sectionOf("Prepare this payout").getByLabelText("Escrow ID") as HTMLInputElement).value).toBe("")
    expect((within(screen.getByTestId("vote-screen")).getByLabelText("Dispute ID") as HTMLInputElement).value).toBe("")
    expect(screen.queryByTestId("calldata-preview")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()
  })

  it("carries a prepared Escrow ID and Dispute ID forward without preparing the next form", async () => {
    renderSurfaces()
    const create = sectionOf("Prepare this claim")
    await fillCreate(create)
    fireEvent.click(create.getByRole("button", { name: "Prepare this claim" }))
    await waitFor(() => expect(create.getByTestId("calldata-preview")).toBeTruthy())
    expect((sectionOf("Prepare this payout").getByLabelText("Escrow ID") as HTMLInputElement).value).toBe(claim)
    expect((sectionOf("Prepare this refund").getByLabelText("Escrow ID") as HTMLInputElement).value).toBe(claim)
    const dispute = sectionOf("Prepare this dispute")
    expect((dispute.getByLabelText("Escrow ID") as HTMLInputElement).value).toBe(claim)
    expect(dispute.queryByTestId("calldata-preview")).toBeNull()

    fireEvent.change(dispute.getByLabelText("Reason"), { target: { value: "late delivery" } })
    fireEvent.click(dispute.getByRole("button", { name: "Prepare this dispute" }))
    await waitFor(() => expect(dispute.getByTestId("calldata-preview")).toBeTruthy())
    const vote = within(screen.getByTestId("vote-screen"))
    expect((vote.getByLabelText("Dispute ID") as HTMLInputElement).value).toMatch(/^0x[0-9a-f]{64}$/)
    expect(vote.queryByTestId("vote-preview")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()
  })

  it("checks the payee, the bots, and the 0x prefix, and clears a preview on edit", async () => {
    renderSurfaces()
    const create = sectionOf("Prepare this claim")
    await fillCreate(create)
    fireEvent.change(create.getByLabelText("Payee wallet"), { target: { value: ZERO } })
    fireEvent.click(create.getByRole("button", { name: "Prepare this claim" }))
    await waitFor(() => expect(create.getByRole("alert").textContent).toBe(FORM_ERRORS.payeeZero))

    fireEvent.change(create.getByLabelText("Payee wallet"), { target: { value: ACCOUNT } })
    expect(create.getByTestId("payee-self-warning").textContent).toBe(PAYEE_SELF_WARNING)
    fireEvent.click(create.getByRole("button", { name: "Prepare this claim" }))
    await waitFor(() => expect(create.getByTestId("calldata-preview")).toBeTruthy())

    fireEvent.change(create.getByLabelText("Payee bot identifier"), { target: { value: claim } })
    expect(create.queryByTestId("calldata-preview")).toBeNull()
    expect(create.queryByTestId("sepolia-submit")).toBeNull()
    fireEvent.click(create.getByRole("button", { name: "Prepare this claim" }))
    await waitFor(() => expect(create.getByRole("alert").textContent).toBe(FORM_ERRORS.sameBots))

    fireEvent.change(create.getByLabelText("Payee bot identifier"), { target: { value: disputeId } })
    fireEvent.change(create.getByLabelText("Escrow ID"), { target: { value: `0X${claim.slice(2).toUpperCase()}` } })
    fireEvent.change(create.getByLabelText("Payee wallet"), { target: { value: `0X${payee.slice(2).toLowerCase()}` } })
    fireEvent.click(create.getByRole("button", { name: "Prepare this claim" }))
    await waitFor(() => expect(create.getByTestId("calldata-preview")).toBeTruthy())

    fireEvent.change(create.getByLabelText("Payee wallet"), { target: { value: "0x6C756dacfEcEeA12D5D39536d2eCC175f18bc5a4" } })
    fireEvent.click(create.getByRole("button", { name: "Prepare this claim" }))
    await waitFor(() => expect(create.getByRole("alert").textContent).toBe(FORM_ERRORS.payeeChecksum))
    expect(create.queryByTestId("calldata-preview")).toBeNull()
    expect(create.queryByTestId("sepolia-submit")).toBeNull()
  })

  it("clears the preview when create, release, refund, or dispute inputs change", async () => {
    renderSurfaces()
    const create = sectionOf("Prepare this claim")
    await fillCreate(create)
    fireEvent.click(create.getByRole("button", { name: "Prepare this claim" }))
    await waitFor(() => expect(create.getByTestId("calldata-preview")).toBeTruthy())
    fireEvent.change(create.getByLabelText("Amount in ETH"), { target: { value: "0.002" } })
    expect(create.queryByTestId("calldata-preview")).toBeNull()

    const release = sectionOf("Prepare this payout")
    fireEvent.change(release.getByLabelText("Escrow ID"), { target: { value: claim } })
    fireEvent.click(release.getByRole("button", { name: "Prepare this payout" }))
    await waitFor(() => expect(release.getByTestId("calldata-preview")).toBeTruthy())
    fireEvent.change(release.getByLabelText("Escrow ID"), { target: { value: `${claim.slice(0, -2)}cd` } })
    expect(release.queryByTestId("calldata-preview")).toBeNull()

    const refund = sectionOf("Prepare this refund")
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: claim } })
    fireEvent.click(refund.getByRole("button", { name: "Prepare this refund" }))
    await waitFor(() => expect(refund.getByTestId("calldata-preview")).toBeTruthy())
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: `${claim.slice(0, -2)}ef` } })
    expect(refund.queryByTestId("calldata-preview")).toBeNull()

    const dispute = sectionOf("Prepare this dispute")
    fireEvent.change(dispute.getByLabelText("Escrow ID"), { target: { value: claim } })
    fireEvent.change(dispute.getByLabelText("Reason"), { target: { value: "late delivery" } })
    fireEvent.click(dispute.getByRole("button", { name: "Prepare this dispute" }))
    await waitFor(() => expect(dispute.getByTestId("calldata-preview")).toBeTruthy())
    fireEvent.change(dispute.getByLabelText("Reason"), { target: { value: "late delivery again" } })
    expect(dispute.queryByTestId("calldata-preview")).toBeNull()
    expect(dispute.queryByTestId("sepolia-submit")).toBeNull()
  })
})
