// @vitest-environment happy-dom

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { encodeFunctionResult, type Address, type Hex } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { escrowAbi } from "./abi"
import { GAS_FEE_TEXT } from "./actionProgress"
import { FlowPreview } from "./FlowPreview"
import { previewCreateEscrow, previewDispute, previewRefund, previewRelease, previewVote, previewWithdraw } from "./preview"
import { PAGE_IGNORED, STEP_IGNORED, navigate, readWalletRoute, useWalletRoute } from "./routes"
import { resetCarriedIds } from "./carriedIds"
import { pendingSlot, pendingStorageKey, resetPendingStore } from "./pendingTx"
import { resetSubmitLock } from "./submitLock"
import { resetPendingRuntime } from "./usePendingReceipt"
import { VoteScreen } from "./VoteScreen"
import { WithdrawScreen } from "./WithdrawScreen"
import { DEAL_STANDS_LABEL } from "./walletCopy"

const ACCOUNT = "0x6dBe4B1c56494Ee00d6f97FFE9f853F42299D6Ac" as Address
const escrow = "0x3d660502D75f1e97b08c110255921b437A3C4C42" as Address
const panel = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb" as Address
const payee = "0x6C756dacfEcEeA12D5D39536d2eCC175f18bc5A4" as Address
const id = `0x${"ab".repeat(32)}` as Hex
const disputeId = `0x${"cd".repeat(32)}` as Hex
const ZERO = "0x0000000000000000000000000000000000000000" as Address

const PINNED = {
  createEscrow:
    "0x6acad9caabababababababababababababababababababababababababababababababab0000000000000000000000006c756dacfeceea12d5d39536d2ecc175f18bc5a4ababababababababababababababababababababababababababababababababcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd0000000000000000000000000000000000000000000000000000000000015180",
  release: "0x67d42a8babababababababababababababababababababababababababababababababab",
  refund: "0x7249fbb6abababababababababababababababababababababababababababababababab",
  dispute:
    "0x4b528670ababababababababababababababababababababababababababababababababcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd0000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000d6c6174652064656c697665727900000000000000000000000000000000000000",
  voteTrue:
    "0x9f2ce678cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd0000000000000000000000000000000000000000000000000000000000000001",
  withdraw: "0x3ccfd60b",
} as const

const { sendTransactionAsync, world } = vi.hoisted(() => ({
  sendTransactionAsync: vi.fn(async () => `0x${"11".repeat(32)}` as Hex),
  world: { arbitrator: true, state: 0, expiresAt: 4_000_000_000n, credit: 10n ** 15n },
}))

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
    if (functionName === "isArbitrator") return world.arbitrator
    if (functionName === "PANEL_SIZE") return 3n
    if (functionName === "voted") return false
    if (functionName === "pendingWithdrawals") return world.credit
    if (functionName === "disputes") {
      return [`0x${"11".repeat(32)}`, ZERO, "reason", 1n, 0n, false, false, 10n]
    }
    if (functionName === "escrows") {
      return [escrow, payee, id, disputeId, 10n ** 15n, 1_700_000_000n, world.expiresAt, world.state, `0x${"00".repeat(32)}`, ZERO]
    }
    return 0n
  },
  waitForTransactionReceipt: async () => ({ status: "success" as const }),
  getTransactionReceipt: async () => ({ status: "success" as const }),
  getTransaction: async () => ({ hash: `0x${"11".repeat(32)}` }),
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
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false, error: null }),
  useBalance: () => ({ data: { value: 10n ** 18n }, isSuccess: true }),
}))

function Host() {
  const route = useWalletRoute()
  if (route.flow === "vote") return <VoteScreen panel={panel} route={route} />
  if (route.flow === "withdraw") return <WithdrawScreen escrow={escrow} readsEnabled route={route} />
  if (route.flow == null) return <p data-testid="flow-home">Home</p>
  return <FlowPreview escrow={escrow} panel={panel} route={route} showStrip />
}

function compact(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, "")
}

function calldataOf(scope: HTMLElement): string {
  const text = scope.querySelector("pre")?.textContent
  if (!text) throw new Error("missing calldata")
  return text
}

beforeEach(() => {
  world.arbitrator = true
  world.state = 0
  world.expiresAt = 4_000_000_000n
  world.credit = 10n ** 15n
  resetCarriedIds()
  resetSubmitLock()
  resetPendingRuntime()
  localStorage.clear()
  sendTransactionAsync.mockClear()
  window.history.replaceState(null, "", "/")
  navigate("/")
})

afterEach(() => {
  cleanup()
  resetPendingStore()
})

describe("phase 2 guided flows", () => {
  it("reads a route without preparing or sending", () => {
    expect(readWalletRoute("http://localhost/fund?step=2")).toMatchObject({ flow: "fund", step: 2, stepNotice: null })
    expect(readWalletRoute("http://localhost/fund?step=+2")).toMatchObject({ flow: "fund", step: 1, stepNotice: STEP_IGNORED })
    expect(readWalletRoute("http://localhost/fund?step=9").stepNotice).toBe(STEP_IGNORED)
    expect(readWalletRoute("http://localhost/fund?step=review").stepNotice).toBe(STEP_IGNORED)
    expect(readWalletRoute("http://localhost/no-such").pageNotice).toBe(PAGE_IGNORED)
    expect(readWalletRoute(`http://localhost/release?escrow=${id}`).escrow.value).toBe(id)
    expect(readWalletRoute("http://localhost/release?escrow=nope").escrow.value).toBeNull()
    expect(readWalletRoute("http://localhost/release?escrow=nope").escrow.notice).toMatch(/ignored/i)
  })

  it("renders each route on its step and ignores a bad step or id", async () => {
    render(<Host />)
    navigate("/fund?step=2")
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 4")
    expect(screen.getByLabelText("Escrow ID")).toBeTruthy()
    expect(screen.queryByTestId("calldata-preview")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()

    navigate("/fund?step=9")
    expect(screen.getByTestId("url-step-notice").textContent).toBe(STEP_IGNORED)
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 4")

    navigate("/fund?step=4")
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 4")
    expect(screen.queryByTestId("review-empty")).toBeNull()
    expect(screen.queryByTestId("review-step")).toBeNull()
    expect(screen.queryByTestId("calldata-preview")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()

    navigate("/release?escrow=nope")
    expect(screen.getByTestId("url-escrow-notice").textContent).toMatch(/ignored/i)
    expect(screen.queryByTestId("filled-from-link")).toBeNull()
    expect(screen.queryByTestId("calldata-preview")).toBeNull()

    navigate(`/release?escrow=${id}`)
    expect(compact(screen.getByTestId("filled-from-link").textContent)).toContain(id)
    expect(screen.queryByTestId("calldata-preview")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()

    navigate(`/vote?dispute=${disputeId}`)
    expect(compact(screen.getByTestId("vote-filled").textContent)).toContain(disputeId)
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 2")
    expect(screen.queryByTestId("vote-preview")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()
  })

  it("counts steps and walks back and forward without leaving the flow", async () => {
    render(<Host />)
    navigate("/fund")
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 4")
    fireEvent.click(screen.getByRole("button", { name: "Use my own" }))
    fireEvent.change(screen.getByLabelText("Escrow ID"), { target: { value: id } })
    fireEvent.change(screen.getByLabelText("Payee wallet"), { target: { value: payee } })
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(screen.getByTestId("step-count").textContent).toBe("Step 2 of 4")
    expect(window.location.pathname).toBe("/fund")
    expect(window.location.search).toBe("?step=2")
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 4")
    window.history.back()
    await waitFor(() => expect(screen.getByTestId("step-count").textContent).toBe("Step 2 of 4"))
    window.history.forward()
    await waitFor(() => expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 4"))
    expect(window.location.pathname).toBe("/fund")
  })

  it("reviews a fund in plain words and carries the sent id to release", async () => {
    render(<Host />)
    navigate("/fund")
    fireEvent.click(screen.getByRole("button", { name: "Use my own" }))
    fireEvent.change(screen.getByLabelText("Escrow ID"), { target: { value: id } })
    fireEvent.change(screen.getByLabelText("Payee wallet"), { target: { value: payee } })
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    fireEvent.change(screen.getByLabelText("Payer bot identifier"), { target: { value: id } })
    fireEvent.change(screen.getByLabelText("Payee bot identifier"), { target: { value: disputeId } })
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    fireEvent.change(screen.getByLabelText("Amount in ETH"), { target: { value: "0.001" } })
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    const review = await waitFor(() => screen.getByTestId("review-step"))
    expect(screen.getByTestId("step-count").textContent).toBe("Step 4 of 4")
    expect(within(review).getByTestId("review-plain").textContent).toContain("0.001 test ETH")
    expect(within(review).getByTestId("review-amount").textContent).toContain("0.001 test ETH")
    expect(compact(within(review).getByTestId("review-payee").textContent)).toContain(payee)
    expect(within(review).getByTestId("review-payee").querySelector("button")?.textContent).toBe("Copy")
    expect(compact(within(review).getByTestId("review-contract-address").textContent)).toContain(escrow)
    expect(within(review).getByTestId("review-duration").textContent).toMatch(/1 day/)
    expect(within(review).getByTestId("review-gas").textContent).toBe(GAS_FEE_TEXT)
    expect(within(review).getByText("Details (raw transaction data)")).toBeTruthy()
    const built = previewCreateEscrow({
      escrow,
      escrowId: id,
      payee,
      payerBotId: id,
      payeeBotId: disputeId,
      durationSeconds: 86400n,
      valueWei: 10n ** 15n,
    })
    expect(calldataOf(review)).toBe(built.calldata)
    expect(built.calldata).toBe(PINNED.createEscrow)
    expect(sendTransactionAsync).not.toHaveBeenCalled()
    fireEvent.click(within(review).getByTestId("sepolia-submit"))
    const next = await waitFor(() => within(review).getByRole("link", { name: "Next: release the payment" }))
    expect(screen.getAllByRole("link", { name: "Next: release the payment" })).toHaveLength(1)
    expect(next.getAttribute("href")).toBe(`/release?escrow=${id}`)
    fireEvent.click(next)
    expect(compact(screen.getByTestId("filled-from-link").textContent)).toContain(id)
    expect(screen.queryByTestId("calldata-preview")).toBeNull()
    expect(sendTransactionAsync).toHaveBeenCalledTimes(1)
  })

  it("matches release, refund, and dispute calldata and gates the other action", async () => {
    render(<Host />)
    navigate(`/release?escrow=${id}`)
    await waitFor(() => expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByTestId("other-action").textContent).toMatch(/Refund a payment is unavailable/)
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    const releaseReview = await waitFor(() => screen.getByTestId("review-step"))
    expect(within(releaseReview).getByTestId("review-plain").textContent).toMatch(/releasing this payment/)
    expect(calldataOf(releaseReview)).toBe(previewRelease(escrow, id).calldata)
    expect(calldataOf(releaseReview)).toBe(PINNED.release)

    world.expiresAt = 1n
    navigate(`/refund?escrow=${id}`)
    await waitFor(() => expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByTestId("other-action").textContent).toMatch(/Release a payment is unavailable/)
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    const refundReview = await waitFor(() => screen.getByTestId("review-step"))
    expect(calldataOf(refundReview)).toBe(previewRefund(escrow, id).calldata)
    expect(calldataOf(refundReview)).toBe(PINNED.refund)

    world.expiresAt = 4_000_000_000n
    navigate(`/release?escrow=${id}`)
    await waitFor(() => expect(screen.getByTestId("other-action").textContent).toMatch(/Refund a payment is unavailable/))
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false)

    world.state = 1
    navigate(`/refund?escrow=${id}`)
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" }).getAttribute("disabled")).not.toBeNull())
    expect(screen.getByTestId("action-reason").textContent).toMatch(/already released/)
    expect(screen.queryByTestId("calldata-preview")).toBeNull()

    world.state = 0
    navigate("/dispute")
    fireEvent.click(screen.getByRole("button", { name: "Use my own" }))
    const disputeFields = screen.getAllByLabelText(/ID/)
    fireEvent.change(disputeFields[0]!, { target: { value: disputeId } })
    fireEvent.change(screen.getByLabelText("Escrow ID"), { target: { value: id } })
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "late delivery" } })
    await waitFor(() => expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    const disputeReview = await waitFor(() => screen.getByTestId("review-step"))
    expect(within(disputeReview).getByTestId("review-plain").textContent).toMatch(/opening a dispute/)
    expect(calldataOf(disputeReview)).toBe(previewDispute(escrow, id, disputeId, "late delivery").calldata)
    expect(calldataOf(disputeReview)).toBe(PINNED.dispute)
    expect(sendTransactionAsync).not.toHaveBeenCalled()
  })

  it("keeps vote and withdraw on the wallet, with vote hidden from non-arbitrators", async () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    for (const file of ["VoteScreen.tsx", "WithdrawScreen.tsx", "WalletOnlySubmit.tsx"]) {
      const source = readFileSync(join(dir, file), "utf8")
      expect(source).not.toContain('from "./relayer"')
      expect(source).not.toContain("relayer-submit")
      expect(source).not.toContain("signTypedData")
    }
    render(<Host />)
    world.arbitrator = false
    navigate(`/vote?dispute=${disputeId}`)
    await waitFor(() => expect(screen.getByTestId("vote-seat-reason").textContent).toMatch(/Only seated arbitrators can vote/))
    expect(screen.getByTestId("vote-seat-reason").textContent).toContain(ACCOUNT.slice(0, 6))
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId("relayer-submit")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()

    world.arbitrator = true
    navigate("/")
    navigate(`/vote?dispute=${disputeId}`)
    await waitFor(() => expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByLabelText(DEAL_STANDS_LABEL))
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    const voteReview = await waitFor(() => screen.getByTestId("review-step"))
    expect(calldataOf(voteReview)).toBe(previewVote(panel, disputeId, true).calldata)
    expect(calldataOf(voteReview)).toBe(PINNED.voteTrue)
    expect(within(voteReview).queryByTestId("relayer-submit")).toBeNull()

    navigate("/withdraw")
    await waitFor(() => expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    const withdrawReview = await waitFor(() => screen.getByTestId("review-step"))
    expect(within(withdrawReview).getByTestId("review-plain").textContent).toMatch(/test ETH/)
    expect(calldataOf(withdrawReview)).toBe(previewWithdraw(escrow).calldata)
    expect(calldataOf(withdrawReview)).toBe(PINNED.withdraw)
    expect(within(withdrawReview).queryByTestId("relayer-submit")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()
  })

  it("shows a Copy control on the pending strip escrow row", () => {
    const hash = `0x${"44".repeat(32)}` as Hex
    localStorage.setItem(
      pendingStorageKey(pendingSlot("release", id)),
      JSON.stringify({ hash, startedAt: Date.now(), action: "release", subjectId: id }),
    )
    render(<FlowPreview escrow={escrow} panel={panel} />)
    const subject = screen.getByTestId("pending-subject")
    expect(within(subject).getByRole("button", { name: "Copy" })).toBeTruthy()
    expect(subject.textContent).toContain(id.slice(0, 6))
  })

  it("drops a prepared review when Back returns to a different id", async () => {
    const other = `0x${"ef".repeat(32)}` as Hex
    render(<Host />)

    async function openRelease(escrowId: Hex) {
      navigate(`/release?escrow=${escrowId}`)
      await waitFor(() => expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false))
      fireEvent.click(screen.getByRole("button", { name: "Next" }))
      const review = await waitFor(() => screen.getByTestId("review-step"))
      expect(calldataOf(review)).toBe(previewRelease(escrow, escrowId).calldata)
      return review
    }

    await openRelease(id)
    await openRelease(other)
    window.history.back()
    window.history.back()
    await waitFor(() => expect(screen.queryByTestId("review-step")).toBeNull())
    expect(screen.queryByTestId("calldata-preview")).toBeNull()
    expect(screen.queryByTestId("sepolia-submit")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()
    expect(compact(screen.getByTestId("filled-from-link").textContent)).toContain(id)

    world.expiresAt = 1n
    async function openRefund(escrowId: Hex) {
      navigate(`/refund?escrow=${escrowId}`)
      await waitFor(() => expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false))
      fireEvent.click(screen.getByRole("button", { name: "Next" }))
      const review = await waitFor(() => screen.getByTestId("review-step"))
      expect(calldataOf(review)).toBe(previewRefund(escrow, escrowId).calldata)
    }
    await openRefund(id)
    await openRefund(other)
    window.history.back()
    window.history.back()
    await waitFor(() => expect(screen.queryByTestId("review-step")).toBeNull())
    expect(screen.queryByTestId("sepolia-submit")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()

    world.expiresAt = 4_000_000_000n
    world.state = 0
    async function openDispute(escrowId: Hex) {
      navigate(`/dispute?escrow=${escrowId}`)
      fireEvent.click(screen.getByRole("button", { name: "Use my own" }))
      fireEvent.change(screen.getByLabelText("Dispute ID"), { target: { value: disputeId } })
      fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "late delivery" } })
      await waitFor(() => expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false))
      fireEvent.click(screen.getByRole("button", { name: "Next" }))
      const review = await waitFor(() => screen.getByTestId("review-step"))
      expect(calldataOf(review)).toContain(escrowId.slice(2))
    }
    await openDispute(id)
    await openDispute(other)
    window.history.back()
    window.history.back()
    await waitFor(() => expect(screen.queryByTestId("review-step")).toBeNull())
    expect(screen.queryByTestId("sepolia-submit")).toBeNull()

    world.arbitrator = true
    async function openVote(dispute: Hex) {
      navigate(`/vote?dispute=${dispute}`)
      await waitFor(() => expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false))
      fireEvent.click(screen.getByLabelText(DEAL_STANDS_LABEL))
      fireEvent.click(screen.getByRole("button", { name: "Next" }))
      const review = await waitFor(() => screen.getByTestId("review-step"))
      expect(calldataOf(review)).toBe(previewVote(panel, dispute, true).calldata)
    }
    await openVote(id)
    await openVote(other)
    window.history.back()
    window.history.back()
    await waitFor(() => expect(screen.queryByTestId("review-step")).toBeNull())
    expect(screen.queryByTestId("sepolia-submit")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()

    navigate("/fund")
    fireEvent.click(screen.getByRole("button", { name: "Use my own" }))
    fireEvent.change(screen.getByLabelText("Escrow ID"), { target: { value: id } })
    fireEvent.change(screen.getByLabelText("Payee wallet"), { target: { value: payee } })
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    fireEvent.change(screen.getByLabelText("Payer bot identifier"), { target: { value: id } })
    fireEvent.change(screen.getByLabelText("Payee bot identifier"), { target: { value: disputeId } })
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    fireEvent.change(screen.getByLabelText("Amount in ETH"), { target: { value: "0.001" } })
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    const fundA = await waitFor(() => screen.getByTestId("review-step"))
    expect(calldataOf(fundA)).toBe(PINNED.createEscrow)
    window.history.back()
    window.history.back()
    window.history.back()
    await waitFor(() => expect(screen.getByLabelText("Escrow ID")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Use my own" }))
    fireEvent.change(screen.getByLabelText("Escrow ID"), { target: { value: other } })
    fireEvent.change(screen.getByLabelText("Payee wallet"), { target: { value: payee } })
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    fireEvent.change(screen.getByLabelText("Payer bot identifier"), { target: { value: id } })
    fireEvent.change(screen.getByLabelText("Payee bot identifier"), { target: { value: disputeId } })
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    const fundB = await waitFor(() => screen.getByTestId("review-step"))
    expect(calldataOf(fundB)).toContain(other.slice(2))
    expect(screen.queryByTestId("sepolia-submit")).toBeTruthy()
    window.history.back()
    window.history.back()
    window.history.back()
    await waitFor(() => expect(screen.queryByTestId("sepolia-submit")).toBeNull())
    expect(screen.queryByTestId("review-step")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()
  })

  it("serves client routes from the Pages SPA fallback", () => {
    const file = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../public/_redirects"), "utf8")
    expect(file).toMatch(/^\/\* \/index\.html 200$/m)
  })
})
