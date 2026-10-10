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
import { readPending } from "./pendingTx"
import { RELAYER_SERVICE_DOWN_TEXT } from "./relayer"
import { TX_RECEIPT_UNREADABLE_TEXT, TX_STILL_PENDING_TEXT } from "./walletCopy"
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

const { sendTransactionAsync, switchChain, releaseSend, escrowFixture, targetGate } = vi.hoisted(() => {
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
    escrowFixture: { expiresAt: 4_000_000_000n, state: 0 },
    sendTransactionAsync: vi.fn(async () => `0x${"11".repeat(32)}` as Hex),
    switchChain: vi.fn(),
    targetGate: { refuse: false },
  }
})

vi.mock("./submit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./submit")>()
  return {
    ...actual,
    assertSubmitTarget(
      to: Parameters<typeof actual.assertSubmitTarget>[0],
      allowed: Parameters<typeof actual.assertSubmitTarget>[1],
    ) {
      if (targetGate.refuse) throw new Error("Submit target is not the booked Base Sepolia escrow or dispute panel.")
      return actual.assertSubmitTarget(to, allowed)
    },
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
      return [escrow, escrow, claim, claim, 1n, 1_700_000_000n, escrowFixture.expiresAt, escrowFixture.state, `0x${"00".repeat(32)}`, ZERO]
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
  useBalance: () => ({ data: { value: 10n ** 18n }, isSuccess: true }),
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
  targetGate.refuse = false
  resetCarriedIds()
  localStorage.clear()
  sendTransactionAsync.mockReset()
  sendTransactionAsync.mockResolvedValue(`0x${"11".repeat(32)}` as Hex)
  switchChain.mockReset()
  escrowFixture.expiresAt = 4_000_000_000n
  escrowFixture.state = 0
  window.history.replaceState(null, "", "/")
})

afterEach(() => {
  cleanup()
  resetCarriedIds()
  localStorage.clear()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  window.history.replaceState(null, "", "/")
})

describe("phase 1 wallet forms", () => {
  it("does not show the word claim", () => {
    renderSurfaces()
    expect(document.body.textContent ?? "").not.toMatch(/\bclaim\b/i)
  })

  it("uses ActionButton for every prepare and submit control", async () => {
    renderSurfaces()
    for (const name of ["Prepare this escrow", "Prepare this payout", "Prepare this refund", "Prepare this dispute"]) {
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

  it("releases the submit lock when the target check throws", async () => {
    targetGate.refuse = true
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
    await waitFor(() => expect(release.getByRole("alert").textContent).toContain("Submit target"))
    targetGate.refuse = false
    await waitFor(() => expect((withdraw.getByTestId("sepolia-submit") as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(withdraw.getByTestId("sepolia-submit"))
    await waitFor(() => expect(sendTransactionAsync).toHaveBeenCalledTimes(1))

    cleanup()
    sendTransactionAsync.mockClear()
    targetGate.refuse = true
    renderSurfaces()
    const payout = sectionOf("Prepare this payout")
    fireEvent.change(payout.getByLabelText("Escrow ID"), { target: { value: claim } })
    fireEvent.click(payout.getByRole("button", { name: "Prepare this payout" }))
    await waitFor(() => expect(payout.getByTestId("sepolia-submit")).toBeTruthy())
    const second = within(screen.getByTestId("withdraw-screen"))
    await waitFor(() => expect((second.getByRole("button", { name: "Prepare withdraw" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(second.getByRole("button", { name: "Prepare withdraw" }))
    await waitFor(() => expect(second.getByTestId("sepolia-submit")).toBeTruthy())
    fireEvent.click(second.getByTestId("sepolia-submit"))
    await waitFor(() => expect(second.getByRole("alert").textContent).toContain("Submit target"))
    targetGate.refuse = false
    await waitFor(() => expect((payout.getByTestId("sepolia-submit") as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(payout.getByTestId("sepolia-submit"))
    await waitFor(() => expect(sendTransactionAsync).toHaveBeenCalledTimes(1))
  })

  it("keeps a receipt that is still pending after the 180 second wait", async () => {
    const original = publicClient.waitForTransactionReceipt
    publicClient.waitForTransactionReceipt = async () => {
      throw Object.assign(new Error("Timed out while waiting for transaction."), {
        name: "WaitForTransactionReceiptTimeoutError",
      })
    }
    try {
      renderSurfaces()
      const release = sectionOf("Prepare this payout")
      fireEvent.change(release.getByLabelText("Escrow ID"), { target: { value: claim } })
      fireEvent.click(release.getByRole("button", { name: "Prepare this payout" }))
      await waitFor(() => expect(release.getByTestId("sepolia-submit")).toBeTruthy())
      fireEvent.click(release.getByTestId("sepolia-submit"))
      await waitFor(() => expect(release.getByTestId("tx-still-pending").textContent).toBe(TX_STILL_PENDING_TEXT))
      expect(release.getByTestId("tx-explorer").getAttribute("href")).toContain("https://sepolia.basescan.org/tx/")
      expect(release.queryByText(TX_RECEIPT_UNREADABLE_TEXT)).toBeNull()
      expect(release.getByTestId("tx-pending")).toBeTruthy()
      expect(readPending("release")?.hash).toBe(`0x${"11".repeat(32)}`)
    } finally {
      publicClient.waitForTransactionReceipt = original
    }
  })

  it("shows a plain message when the refund service is not available", async () => {
    vi.stubEnv("VITE_CLAIM_RELAYER_URL", "https://relayer.example.test")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down")
      }),
    )
    escrowFixture.expiresAt = 1n
    renderSurfaces()
    const refund = sectionOf("Prepare this refund")
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: claim } })
    fireEvent.click(refund.getByRole("button", { name: "Prepare this refund" }))
    await waitFor(() => expect(refund.getByTestId("relayer-submit")).toBeTruthy())
    await waitFor(() => expect(refund.getByTestId("relayer-unavailable").textContent).toBe(RELAYER_SERVICE_DOWN_TEXT))
    const button = refund.getByTestId("relayer-submit") as HTMLButtonElement
    fireEvent.click(button)
    expect(refund.getByTestId("relayer-unavailable").textContent).toBe(RELAYER_SERVICE_DOWN_TEXT)
    expect(sendTransactionAsync).not.toHaveBeenCalled()
  })

  it("labels review addresses, shows the balance, and keeps one sticky testnet label", async () => {
    renderSurfaces()
    const create = sectionOf("Prepare this escrow")
    expect(create.getByTestId("wallet-balance").textContent).toBe("Balance: 1 test ETH")
    expect(create.getByRole("button", { name: "Generate" })).toBeTruthy()
    expect(sectionOf("Prepare this payout").queryByRole("button", { name: "Generate" })).toBeNull()
    expect(sectionOf("Prepare this payout").queryByRole("button", { name: "Use my own" })).toBeNull()
    expect(sectionOf("Prepare this refund").queryByRole("button", { name: "Use my own" })).toBeNull()
    expect(sectionOf("Prepare this dispute").getAllByRole("button", { name: "Generate" })).toHaveLength(1)
    const dir = dirname(fileURLToPath(import.meta.url))
    const css = readFileSync(join(dir, "styles.css"), "utf8")
    expect(css).toMatch(/\.site-header\s*\{[^}]*position:\s*sticky/)
    const mobile = css.slice(css.indexOf("@media (max-width: 640px)"))
    expect(mobile).not.toMatch(/\.site-header\s*\{[^}]*position:\s*static/)
    expect(css).toMatch(/\.chunk\s*\{[^}]*display:\s*inline-block/)
    expect(css).toMatch(/\.chunk\s*\{[^}]*white-space:\s*nowrap/)
    expect(css).toMatch(/\.preview\s*\{[^}]*padding:\s*14px/)
    expect(readFileSync(join(dir, "App.tsx"), "utf8")).toContain('data-testid="page-testnet"')
    expect(screen.queryByTestId("action-testnet")).toBeNull()
    await fillCreate(create)
    fireEvent.click(create.getByRole("button", { name: "Prepare this escrow" }))
    await waitFor(() => expect(create.getByTestId("calldata-preview")).toBeTruthy())
    const preview = create.getByTestId("calldata-preview")
    expect(within(preview).getByText("Contract")).toBeTruthy()
    expect(within(preview).getByText("Payee")).toBeTruthy()
    const payeeChunks = preview.querySelectorAll("[data-testid=review-payee] .chunk")
    expect(payeeChunks).toHaveLength(10)
    for (const chunk of payeeChunks) expect(chunk.textContent ?? "").not.toMatch(/\s/)
    expect(preview.querySelector("[data-testid=review-payee]")?.getAttribute("data-address")).toBe(payee)
    const details = within(preview).getByTestId("calldata-details") as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelector("summary")?.textContent).toBe("Details")
  })

  it("starts the amount empty and rejects a blank amount", async () => {
    renderSurfaces()
    const create = sectionOf("Prepare this escrow")
    const amount = create.getByLabelText("Amount in ETH") as HTMLInputElement
    expect(amount.value).toBe("")
    expect(amount.placeholder).toBe(AMOUNT_PLACEHOLDER)
    expect(create.getByText(AMOUNT_HINT)).toBeTruthy()
    await fillCreate(create)
    fireEvent.change(amount, { target: { value: "  " } })
    fireEvent.click(create.getByRole("button", { name: "Prepare this escrow" }))
    await waitFor(() => expect(create.getByRole("alert").textContent).toBe(FORM_ERRORS.valueEmpty))
    expect(create.queryByTestId("calldata-preview")).toBeNull()
    expect((create.getByLabelText("Amount in ETH") as HTMLInputElement).value).toBe("  ")
  })

  it("rejects custom durations that are not whole seconds", async () => {
    renderSurfaces()
    const create = sectionOf("Prepare this escrow")
    await fillCreate(create)
    fireEvent.click(create.getByRole("radio", { name: "Custom" }))
    for (const raw of ["0x15180", "8.64e4", "1.5", "-5"]) {
      fireEvent.change(create.getByLabelText("Time window in seconds"), { target: { value: raw } })
      fireEvent.click(create.getByRole("button", { name: "Prepare this escrow" }))
      await waitFor(() =>
        expect(create.getByRole("alert").textContent).toBe(durationValidationMessage(MAX_DURATION_SECONDS)),
      )
      expect(create.queryByTestId("calldata-preview")).toBeNull()
    }
    fireEvent.click(create.getByRole("radio", { name: "1 day" }))
    fireEvent.click(create.getByRole("button", { name: "Prepare this escrow" }))
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

  it("carries an escrow id only after funding is confirmed, and a dispute id when that dispute is prepared", async () => {
    renderSurfaces()
    const create = sectionOf("Prepare this escrow")
    await fillCreate(create)
    fireEvent.click(create.getByRole("button", { name: "Prepare this escrow" }))
    await waitFor(() => expect(create.getByTestId("calldata-preview")).toBeTruthy())
    const release = sectionOf("Prepare this payout")
    const refund = sectionOf("Prepare this refund")
    const dispute = sectionOf("Prepare this dispute")
    expect((release.getByLabelText("Escrow ID") as HTMLInputElement).value).toBe("")
    expect((refund.getByLabelText("Escrow ID") as HTMLInputElement).value).toBe("")
    expect((dispute.getByLabelText("Escrow ID") as HTMLInputElement).value).toBe("")
    expect(dispute.queryByTestId("calldata-preview")).toBeNull()
    fireEvent.click(create.getByTestId("sepolia-submit"))
    await waitFor(() => expect(create.getByTestId("tx-confirmed")).toBeTruthy())
    expect((release.getByLabelText("Escrow ID") as HTMLInputElement).value).toBe(claim)
    expect((refund.getByLabelText("Escrow ID") as HTMLInputElement).value).toBe(claim)
    expect((dispute.getByLabelText("Escrow ID") as HTMLInputElement).value).toBe(claim)

    fireEvent.change(dispute.getByLabelText("Reason"), { target: { value: "late delivery" } })
    fireEvent.click(dispute.getByRole("button", { name: "Prepare this dispute" }))
    await waitFor(() => expect(dispute.getByTestId("calldata-preview")).toBeTruthy())
    const vote = within(screen.getByTestId("vote-screen"))
    expect((vote.getByLabelText("Dispute ID") as HTMLInputElement).value).toMatch(/^0x[0-9a-f]{64}$/)
    expect(vote.queryByTestId("vote-preview")).toBeNull()
  })

  it("checks the payee, the bots, and the 0x prefix, and clears a preview on edit", async () => {
    renderSurfaces()
    const create = sectionOf("Prepare this escrow")
    await fillCreate(create)
    fireEvent.change(create.getByLabelText("Payee wallet"), { target: { value: ZERO } })
    fireEvent.click(create.getByRole("button", { name: "Prepare this escrow" }))
    await waitFor(() => expect(create.getByRole("alert").textContent).toBe(FORM_ERRORS.payeeZero))

    fireEvent.change(create.getByLabelText("Payee wallet"), { target: { value: ACCOUNT } })
    expect(create.getByTestId("payee-self-warning").textContent).toBe(PAYEE_SELF_WARNING)
    fireEvent.click(create.getByRole("button", { name: "Prepare this escrow" }))
    await waitFor(() => expect(create.getByTestId("calldata-preview")).toBeTruthy())

    fireEvent.change(create.getByLabelText("Payee bot identifier"), { target: { value: claim } })
    expect(create.queryByTestId("calldata-preview")).toBeNull()
    expect(create.queryByTestId("sepolia-submit")).toBeNull()
    fireEvent.click(create.getByRole("button", { name: "Prepare this escrow" }))
    await waitFor(() => expect(create.getByRole("alert").textContent).toBe(FORM_ERRORS.sameBots))

    fireEvent.change(create.getByLabelText("Payee bot identifier"), { target: { value: disputeId } })
    fireEvent.change(create.getByLabelText("Escrow ID"), { target: { value: `0X${claim.slice(2).toUpperCase()}` } })
    fireEvent.change(create.getByLabelText("Payee wallet"), { target: { value: `0X${payee.slice(2).toLowerCase()}` } })
    fireEvent.click(create.getByRole("button", { name: "Prepare this escrow" }))
    await waitFor(() => expect(create.getByTestId("calldata-preview")).toBeTruthy())

    fireEvent.change(create.getByLabelText("Payee wallet"), { target: { value: "0x6C756dacfEcEeA12D5D39536d2eCC175f18bc5a4" } })
    fireEvent.click(create.getByRole("button", { name: "Prepare this escrow" }))
    await waitFor(() => expect(create.getByRole("alert").textContent).toBe(FORM_ERRORS.payeeChecksum))
    expect(create.queryByTestId("calldata-preview")).toBeNull()
    expect(create.queryByTestId("sepolia-submit")).toBeNull()
  })

  it("clears the preview when create, release, refund, or dispute inputs change", async () => {
    renderSurfaces()
    const create = sectionOf("Prepare this escrow")
    await fillCreate(create)
    fireEvent.click(create.getByRole("button", { name: "Prepare this escrow" }))
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
    escrowFixture.expiresAt = 1n
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: `${claim.slice(0, -2)}11` } })
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: claim } })
    await waitFor(() => expect((refund.getByRole("button", { name: "Prepare this refund" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(refund.getByRole("button", { name: "Prepare this refund" }))
    await waitFor(() => expect(refund.getByTestId("calldata-preview")).toBeTruthy())
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: `${claim.slice(0, -2)}ef` } })
    expect(refund.queryByTestId("calldata-preview")).toBeNull()

    escrowFixture.expiresAt = 4_000_000_000n
    const dispute = sectionOf("Prepare this dispute")
    fireEvent.change(dispute.getByLabelText("Escrow ID"), { target: { value: `${claim.slice(0, -2)}22` } })
    fireEvent.change(dispute.getByLabelText("Escrow ID"), { target: { value: claim } })
    fireEvent.change(dispute.getByLabelText("Reason"), { target: { value: "late delivery" } })
    fireEvent.click(dispute.getByRole("button", { name: "Prepare this dispute" }))
    await waitFor(() => expect(dispute.getByTestId("calldata-preview")).toBeTruthy())
    fireEvent.change(dispute.getByLabelText("Reason"), { target: { value: "late delivery again" } })
    expect(dispute.queryByTestId("calldata-preview")).toBeNull()
    expect(dispute.queryByTestId("sepolia-submit")).toBeNull()
  })
})
