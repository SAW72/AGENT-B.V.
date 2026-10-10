// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { encodeFunctionResult, type Address, type Hex } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { escrowAbi } from "./abi"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { FlowPreview } from "./FlowPreview"
import { PREPARING_LABEL } from "./prepareFeedback"
import { VoteScreen } from "./VoteScreen"
import { WithdrawScreen } from "./WithdrawScreen"

const ACCOUNT = "0x6dBe4B1c56494Ee00d6f97FFE9f853F42299D6Ac" as Address
const escrow = "0x3d660502D75f1e97b08c110255921b437A3C4C42" as Address
const panel = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb" as Address
const claim = `0x${"ab".repeat(32)}` as Hex
const disputeId = `0x${"cd".repeat(32)}` as Hex
const subject = `0x${"11".repeat(32)}` as Hex
const createdAt = 1_700_000_000n
const expiresAt = 4_000_000_000n
const REVEAL = { block: "nearest", behavior: "smooth" } as const

const { gate, publicClient, subjectCall } = vi.hoisted(() => ({
  gate: {
    holdCode: false,
    code: null as { promise: Promise<string>; release: (value: string) => void } | null,
    holdDisputes: false,
    disputes: null as { promise: Promise<unknown>; release: (value: unknown) => void } | null,
  },
  subjectCall: { data: "0x" },
  publicClient: {
    getCode: () => {
      if (gate.holdCode) {
        gate.code = defer<string>()
        return gate.code.promise
      }
      return Promise.resolve("0x60016000")
    },
    readContract: ({ functionName }: { functionName: string }) => {
      if (functionName === "isArbitrator") return Promise.resolve(true)
      if (functionName === "disputes") {
        if (gate.holdDisputes) {
          gate.disputes = defer<unknown>()
          return gate.disputes.promise
        }
        return Promise.resolve(disputeRow)
      }
      if (functionName === "PANEL_SIZE") return Promise.resolve(3n)
      if (functionName === "voted") return Promise.resolve(false)
      if (functionName === "pendingWithdrawals") return Promise.resolve(1_000_000_000_000_000n)
      if (functionName === "escrows") return Promise.resolve(escrowRow)
      return Promise.resolve(0n)
    },
    call: async () => ({ data: subjectCall.data }),
  },
}))

function defer<T>() {
  let release: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const escrowRow = [
  escrow,
  escrow,
  claim,
  claim,
  1n,
  createdAt,
  expiresAt,
  0,
  `0x${"00".repeat(32)}`,
  "0x0000000000000000000000000000000000000000",
]

const disputeRow = [
  subject,
  "0x0000000000000000000000000000000000000001",
  "reason",
  1n,
  0n,
  false,
  false,
  10n,
]

subjectCall.data = encodeFunctionResult({ abi: escrowAbi, functionName: "panelSubject", result: subject })

vi.mock("wagmi", () => ({
  useAccount: () => ({
    isConnected: true,
    address: ACCOUNT,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    connector: undefined,
  }),
  usePublicClient: () => publicClient,
  useSendTransaction: () => ({ sendTransactionAsync: vi.fn(), isPending: false }),
  useWalletClient: () => ({ data: undefined }),
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

function namedSection(name: string) {
  const button = screen.getByRole("button", { name })
  const section = button.closest("section")
  if (!(section instanceof HTMLElement)) throw new Error(`no section for ${name}`)
  return { button, section }
}

let scroll: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  gate.holdCode = false
  gate.code = null
  gate.holdDisputes = false
  gate.disputes = null
  scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined)
})

afterEach(() => {
  scroll.mockRestore()
  cleanup()
})

describe("prepare button feedback", () => {
  it("shows a busy create button, then focuses the preview directly under it", async () => {
    renderSurfaces()
    const { button, section } = namedSection("Prepare this claim")
    const scope = within(section)
    fireEvent.change(scope.getByLabelText("Claim identifier"), { target: { value: claim } })
    fireEvent.change(scope.getByLabelText("Payee wallet"), { target: { value: ACCOUNT } })
    fireEvent.change(scope.getByLabelText("Payer bot identifier"), { target: { value: claim } })
    fireEvent.change(scope.getByLabelText("Payee bot identifier"), { target: { value: disputeId } })
    fireEvent.change(scope.getByLabelText("Amount in ETH"), { target: { value: "0.001" } })

    fireEvent.click(button)
    const busy = scope.getByRole("button", { name: PREPARING_LABEL }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)

    await waitFor(() => expect(document.activeElement).toBe(scope.getByTestId("calldata-preview")))
    const preview = scope.getByTestId("calldata-preview")
    expect(button.nextElementSibling).toBe(preview)
    expect(section.contains(preview)).toBe(true)
    expect(preview.getAttribute("aria-label")).toBe("Prepared claim")
    expect(scroll).toHaveBeenCalledWith(REVEAL)
    expect(scope.getByRole("button", { name: "Prepare this claim" })).toBeTruthy()
  })

  it("focuses a create error under the button", async () => {
    renderSurfaces()
    const { button, section } = namedSection("Prepare this claim")
    fireEvent.click(button)
    expect((within(section).getByRole("button", { name: PREPARING_LABEL }) as HTMLButtonElement).disabled).toBe(true)

    await waitFor(() => expect(document.activeElement).toBe(within(section).getByRole("alert")))
    const alert = within(section).getByRole("alert")
    expect(button.nextElementSibling).toBe(alert)
    expect(alert.getAttribute("role")).toBe("alert")
    expect(section.contains(alert)).toBe(true)
    expect(scroll).toHaveBeenCalledWith(REVEAL)
  })

  it("renders release, refund, and dispute previews inside their own sections", async () => {
    gate.holdCode = true
    renderSurfaces()

    const release = namedSection("Prepare this payout")
    fireEvent.change(within(release.section).getByLabelText("Claim identifier"), { target: { value: claim } })
    fireEvent.click(release.button)
    expect((within(release.section).getByRole("button", { name: PREPARING_LABEL }) as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() => expect(document.activeElement).toBe(within(release.section).getByTestId("calldata-preview")))
    const releasePreview = within(release.section).getByTestId("calldata-preview")
    expect(release.button.nextElementSibling).toBe(releasePreview)
    expect(releasePreview.getAttribute("aria-label")).toBe("Prepared payout")
    expect(scroll).toHaveBeenCalledWith(REVEAL)

    scroll.mockClear()
    const refund = namedSection("Prepare this refund")
    fireEvent.change(within(refund.section).getByLabelText("Claim identifier"), { target: { value: claim } })
    fireEvent.click(refund.button)
    expect((within(refund.section).getByRole("button", { name: PREPARING_LABEL }) as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() => expect(document.activeElement).toBe(within(refund.section).getByTestId("calldata-preview")))
    const refundPreview = within(refund.section).getByTestId("calldata-preview")
    expect(refund.button.nextElementSibling).toBe(refundPreview)
    expect(refundPreview.getAttribute("aria-label")).toBe("Prepared refund")
    expect(release.section.querySelector('[data-testid="calldata-preview"]')).toBeNull()
    expect(scroll).toHaveBeenCalledWith(REVEAL)

    scroll.mockClear()
    const dispute = namedSection("Prepare this dispute")
    fireEvent.change(within(dispute.section).getByLabelText("Claim identifier"), { target: { value: claim } })
    fireEvent.change(within(dispute.section).getByLabelText("Reason"), { target: { value: "late delivery" } })
    await waitFor(() => expect(gate.code).toBeTruthy())
    fireEvent.click(dispute.button)
    const disputeBusy = within(dispute.section).getByRole("button", { name: PREPARING_LABEL }) as HTMLButtonElement
    expect(disputeBusy.disabled).toBe(true)
    expect(dispute.section.querySelector('[data-testid="calldata-preview"]')).toBeNull()
    gate.code?.release("0x60016000")
    await waitFor(() => expect(document.activeElement).toBe(within(dispute.section).getByTestId("calldata-preview")))
    const disputePreview = within(dispute.section).getByTestId("calldata-preview")
    expect(dispute.button.nextElementSibling).toBe(disputePreview)
    expect(disputePreview.getAttribute("aria-label")).toBe("Prepared dispute")
    expect(refund.section.querySelector('[data-testid="calldata-preview"]')).toBeNull()
    expect(scroll).toHaveBeenCalledWith(REVEAL)
  })

  it("keeps the vote button busy until the case read finishes, then focuses the preview", async () => {
    gate.holdDisputes = true
    renderSurfaces()
    const vote = within(screen.getByTestId("vote-screen"))
    await waitFor(() => expect((vote.getByRole("button", { name: "Prepare this vote" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.change(vote.getByLabelText("Dispute identifier"), { target: { value: disputeId } })
    fireEvent.click(vote.getByLabelText("The deal stands: the payee gets paid"))
    await waitFor(() => expect(gate.disputes).toBeTruthy())

    const button = vote.getByRole("button", { name: "Prepare this vote" })
    const section = button.closest("section")
    if (!(section instanceof HTMLElement)) throw new Error("missing vote section")
    fireEvent.click(button)
    expect((vote.getByRole("button", { name: PREPARING_LABEL }) as HTMLButtonElement).disabled).toBe(true)
    expect(vote.queryByTestId("vote-preview")).toBeNull()

    gate.disputes?.release(disputeRow)
    await waitFor(() => expect(document.activeElement).toBe(vote.getByTestId("vote-preview")))
    const preview = vote.getByTestId("vote-preview")
    expect(section.contains(preview)).toBe(true)
    expect(button.nextElementSibling).toBe(preview)
    expect(preview.getAttribute("aria-label")).toBe("Prepared vote")
    expect(scroll).toHaveBeenCalledWith(REVEAL)
  })

  it("shows Preparing… on withdraw, then focuses the preview in that section", async () => {
    renderSurfaces()
    const withdraw = within(screen.getByTestId("withdraw-screen"))
    await waitFor(() => expect((withdraw.getByRole("button", { name: "Prepare withdraw" }) as HTMLButtonElement).disabled).toBe(false))
    const button = withdraw.getByRole("button", { name: "Prepare withdraw" })
    const section = button.closest("section")
    if (!(section instanceof HTMLElement)) throw new Error("missing withdraw section")

    fireEvent.click(button)
    expect((withdraw.getByRole("button", { name: PREPARING_LABEL }) as HTMLButtonElement).disabled).toBe(true)

    await waitFor(() => expect(document.activeElement).toBe(withdraw.getByTestId("withdraw-preview")))
    const preview = withdraw.getByTestId("withdraw-preview")
    expect(section.contains(preview)).toBe(true)
    expect(button.nextElementSibling).toBe(preview)
    expect(preview.getAttribute("aria-label")).toBe("Prepared withdrawal")
    expect(scroll).toHaveBeenCalledWith(REVEAL)
  })
})
