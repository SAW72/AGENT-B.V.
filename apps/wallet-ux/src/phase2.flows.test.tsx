// @vitest-environment happy-dom

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { encodeFunctionResult, type Address, type Hex } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { escrowAbi } from "./abi"
import { actionProgress, GAS_FEE_TEXT } from "./actionProgress"
import { FlowPreview, FUND_ESCROW_STORAGE_KEY } from "./FlowPreview"
import { previewCreateEscrow, previewDispute, previewRefund, previewRelease, previewVote, previewWithdraw } from "./preview"
import { DISPUTE_ZERO_IGNORED, ESCROW_ZERO_IGNORED, resetCarriedIds } from "./carriedIds"
import { ChainBanner, HeaderNetwork, HomeScreen } from "./homeChrome"
import {
  FLOW_CATALOG,
  FLOW_STEP_LABELS,
  FLOW_STEPS,
  FLOWS,
  PAGE_IGNORED,
  STEP_IGNORED,
  TASKS,
  flowHref,
  flowTitle,
  navigate,
  readWalletRoute,
  unavailableLine,
  useWalletRoute,
  walletHome,
} from "./routes"
import { TaskPicker } from "./taskPicker"
import { pendingSlot, pendingStorageKey, resetPendingStore } from "./pendingTx"
import { resetSubmitLock } from "./submitLock"
import { resetPendingRuntime } from "./usePendingReceipt"
import { VoteScreen } from "./VoteScreen"
import { WithdrawScreen, withdrawReadMode } from "./WithdrawScreen"
import {
  ALREADY_VOTED_TEXT,
  CASE_READING_TEXT,
  DEAL_STANDS_LABEL,
  NOTHING_TO_WITHDRAW_TEXT,
  WITHDRAW_HIDDEN_TEXT,
  WITHDRAW_READING_TEXT,
} from "./walletCopy"
import { FLOW_STEP_LABELS as WALKTHROUGH_STEP_LABELS, CONNECT_NOTE, TEST_ETH_NOTE, WRONG_NETWORK_NOTE } from "./walkthrough"

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
  world: {
    arbitrator: true,
    voted: false,
    state: 0,
    expiresAt: 4_000_000_000n,
    credit: 10n ** 15n,
    creditReads: 0,
    creditGate: null as Promise<void> | null,
    withdrawReads: "allowed" as "pending" | "allowed" | "refused",
    arbitratorReads: 0,
    caseReads: 0,
    caseGate: null as Promise<void> | null,
    chainId: 84532,
    connected: true,
    missing: false,
    switchChain: vi.fn(),
  },
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
    if (functionName === "isArbitrator") {
      world.arbitratorReads += 1
      return world.arbitrator
    }
    if (functionName === "PANEL_SIZE") return 3n
    if (functionName === "voted") return world.voted
    if (functionName === "pendingWithdrawals") {
      world.creditReads += 1
      if (world.creditGate) await world.creditGate
      return world.credit
    }
    if (functionName === "disputes") {
      world.caseReads += 1
      if (world.caseGate) await world.caseGate
      return [`0x${"11".repeat(32)}`, ZERO, "reason", 1n, 0n, false, false, 10n]
    }
    if (functionName === "escrows") {
      const payer = world.missing ? ZERO : escrow
      return [payer, payee, id, disputeId, 10n ** 15n, 1_700_000_000n, world.expiresAt, world.state, `0x${"00".repeat(32)}`, ZERO]
    }
    return 0n
  },
  waitForTransactionReceipt: async () => ({ status: "success" as const }),
  getTransactionReceipt: async () => ({ status: "success" as const }),
  getTransaction: async () => ({ hash: `0x${"11".repeat(32)}` }),
}

vi.mock("wagmi", () => ({
  useAccount: () => ({
    isConnected: world.connected,
    address: world.connected ? ACCOUNT : undefined,
    chainId: world.connected ? world.chainId : undefined,
    connector: undefined,
  }),
  useConnect: () => ({
    connect: vi.fn(),
    connectors: [{ id: "injected", name: "Injected", type: "injected", uid: "injected" }],
    isPending: false,
    error: null,
  }),
  usePublicClient: () => publicClient,
  useSendTransaction: () => ({ sendTransactionAsync, isPending: false }),
  useWalletClient: () => ({ data: undefined }),
  useSwitchChain: () => ({ switchChain: world.switchChain, isPending: false, error: null }),
  useBalance: () => ({ data: { value: 10n ** 18n }, isSuccess: true }),
}))

function Host() {
  const route = useWalletRoute()
  if (route.flow === "vote") return <VoteScreen panel={panel} route={route} />
  if (route.flow === "withdraw") return <WithdrawScreen escrow={escrow} reads={world.withdrawReads} route={route} />
  if (route.flow == null) return <p data-testid="flow-home">Home</p>
  return <FlowPreview escrow={escrow} panel={panel} route={route} showStrip />
}

function HomeTasks() {
  const route = useWalletRoute()
  if (route.flow === "vote") return <VoteScreen panel={panel} route={route} />
  if (route.flow == null) return <TaskPicker voteReason={null} />
  return <FlowPreview escrow={escrow} panel={panel} route={route} showStrip />
}

function expectGuidedNextReady() {
  const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement
  expect(next.getAttribute("aria-disabled")).not.toBe("true")
  expect(next.hasAttribute("disabled")).toBe(false)
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
  world.voted = false
  world.state = 0
  world.expiresAt = 4_000_000_000n
  world.credit = 10n ** 15n
  world.creditReads = 0
  world.creditGate = null
  world.withdrawReads = "allowed"
  world.arbitratorReads = 0
  world.caseReads = 0
  world.caseGate = null
  resetCarriedIds()
  resetSubmitLock()
  resetPendingRuntime()
  localStorage.clear()
  sessionStorage.removeItem(FUND_ESCROW_STORAGE_KEY)
  sendTransactionAsync.mockClear()
  world.chainId = 84532
  world.connected = true
  world.missing = false
  world.switchChain.mockClear()
  window.history.replaceState(null, "", walletHome())
  navigate(walletHome())
})

afterEach(() => {
  cleanup()
  resetPendingStore()
})

describe("phase 2 guided flows", () => {
  it("reads a route without preparing or sending", () => {
    expect(readWalletRoute("http://localhost/app/fund?step=2")).toMatchObject({ flow: "fund", step: 2, stepNotice: null })
    expect(readWalletRoute("http://localhost/app/fund?step=+2")).toMatchObject({ flow: "fund", step: 1, stepNotice: STEP_IGNORED })
    expect(readWalletRoute("http://localhost/app/fund?step=9").stepNotice).toBe(STEP_IGNORED)
    expect(readWalletRoute("http://localhost/app/fund?step=review").stepNotice).toBe(STEP_IGNORED)
    expect(readWalletRoute("http://localhost/no-such").pageNotice).toBe(PAGE_IGNORED)
    expect(readWalletRoute("http://localhost/fund").pageNotice).toBe(PAGE_IGNORED)
    expect(readWalletRoute("http://localhost/app/").flow).toBeNull()
    expect(readWalletRoute("http://localhost/app").pageNotice).toBeNull()
    expect(readWalletRoute(`http://localhost/app/release?escrow=${id}`).escrow.value).toBe(id)
    expect(readWalletRoute("http://localhost/app/release?escrow=nope").escrow.value).toBeNull()
    expect(readWalletRoute("http://localhost/app/release?escrow=nope").escrow.notice).toMatch(/ignored/i)
  })

  it("renders each route on its step and ignores a bad step or id", async () => {
    render(<Host />)
    navigate("/app/fund?step=2")
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 4")
    expect(screen.getByLabelText("Escrow ID")).toBeTruthy()
    expect(screen.queryByTestId("calldata-preview")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()

    navigate("/app/fund?step=9")
    expect(screen.getByTestId("url-step-notice").textContent).toBe(STEP_IGNORED)
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 4")

    navigate("/app/fund?step=4")
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 4")
    expect(screen.queryByTestId("review-empty")).toBeNull()
    expect(screen.queryByTestId("review-step")).toBeNull()
    expect(screen.queryByTestId("calldata-preview")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()

    navigate("/app/release?escrow=nope")
    expect(screen.getByTestId("url-escrow-notice").textContent).toMatch(/ignored/i)
    expect(screen.queryByTestId("filled-from-link")).toBeNull()
    expect(screen.queryByTestId("calldata-preview")).toBeNull()

    navigate(`/app/release?escrow=${id}`)
    expect(compact(screen.getByTestId("filled-from-link").textContent)).toContain(id)
    expect(screen.queryByTestId("calldata-preview")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()

    navigate(`/app/vote?dispute=${disputeId}`)
    expect(compact(screen.getByTestId("vote-filled").textContent)).toContain(disputeId)
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 2")
    expect(screen.queryByTestId("vote-preview")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()
  })

  it("counts steps and walks back and forward without leaving the flow", async () => {
    render(<Host />)
    navigate("/app/fund")
    expect(screen.queryByTestId("journey-now")).toBeNull()
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 4")
    const first = within(screen.getByTestId("stepper")).getAllByRole("listitem")[0]
    expect(first?.querySelector(".step-dot-word")?.textContent).toBe("Now · Who is paid")
    expect(first?.getAttribute("aria-current")).toBe("step")
    fireEvent.click(screen.getByRole("button", { name: "Use my own" }))
    fireEvent.change(screen.getByLabelText("Escrow ID"), { target: { value: id } })
    fireEvent.change(screen.getByLabelText("Payee wallet"), { target: { value: payee } })
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(screen.getByTestId("step-count").textContent).toBe("Step 2 of 4")
    const dots = within(screen.getByTestId("stepper")).getAllByRole("listitem")
    expect(dots.map((dot) => dot.getAttribute("data-step-state"))).toEqual(["done", "current", "upcoming", "upcoming"])
    expect(dots[0]?.querySelector(".step-dot-word")?.textContent).toBe("Done · Who is paid")
    expect(dots[0]?.getAttribute("aria-current")).toBeNull()
    expect(dots[1]?.querySelector(".step-dot-word")?.textContent).toBe("Now · Which bots")
    expect(dots[1]?.getAttribute("aria-current")).toBe("step")
    expect(window.location.pathname).toBe("/app/fund")
    expect(window.location.search).toContain("step=2")
    expect(window.location.search).toContain(`escrow=${id}`)
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 4")
    window.history.back()
    await waitFor(() => expect(screen.getByTestId("step-count").textContent).toBe("Step 2 of 4"))
    window.history.forward()
    await waitFor(() => expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 4"))
    expect(window.location.pathname).toBe("/app/fund")
  })

  it("reviews a fund in plain words and carries the sent id to release", async () => {
    render(<Host />)
    navigate("/app/fund")
    fireEvent.click(screen.getByRole("button", { name: "Use my own" }))
    fireEvent.change(screen.getByLabelText("Escrow ID"), { target: { value: id } })
    fireEvent.change(screen.getByLabelText("Payee wallet"), { target: { value: payee } })
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    fireEvent.change(screen.getByLabelText("Payer bot identifier"), { target: { value: id } })
    fireEvent.change(screen.getByLabelText("Payee bot identifier"), { target: { value: disputeId } })
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    fireEvent.change(screen.getByLabelText("Amount in ETH"), { target: { value: "0.001" } })
    const ethNote = screen.getByTestId("test-eth-note")
    expect(ethNote.textContent).toBe(TEST_ETH_NOTE)
    const faucet = within(ethNote).getByRole("link", { name: "Base Sepolia faucet" })
    expect(faucet.getAttribute("href")).toBe("https://docs.base.org/get-started/get-funds")
    expect(faucet.getAttribute("rel")).toBe("noopener noreferrer")
    expect(faucet.getAttribute("target")).toBe("_blank")
    expect(within(ethNote).getAllByRole("link")).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    const review = await waitFor(() => screen.getByTestId("review-step"))
    expect(screen.queryByTestId("journey-now")).toBeNull()
    expect(screen.queryAllByText("Now · Review and send")).toHaveLength(1)
    const reviewChip = within(screen.getByTestId("stepper")).getAllByRole("listitem")[3]
    expect(reviewChip?.querySelector(".step-dot-word")?.textContent).toBe("Now · Review and send")
    expect(reviewChip?.getAttribute("aria-current")).toBe("step")
    expect(screen.queryByTestId("test-eth-note")).toBeNull()
    expect(screen.getByTestId("step-count").textContent).toBe("Step 4 of 4")
    expect(within(review).getByTestId("review-plain").textContent).toContain("0.001 test ETH")
    expect(within(review).getByTestId("review-amount").textContent).toContain("0.001 test ETH")
    expect(compact(within(review).getByTestId("review-id").textContent)).toContain(id)
    expect(within(review).getByTestId("review-id").querySelector("button")?.textContent).toBe("Copy")
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
    expect(screen.getAllByTestId("action-confirmed")).toHaveLength(1)
    expect(next.getAttribute("href")).toBe(`/app/release?escrow=${id}`)
    expect(next.getAttribute("href")?.includes("#")).toBe(false)
    fireEvent.click(next)
    expect(compact(screen.getByTestId("filled-from-link").textContent)).toContain(id)
    expect(screen.queryByTestId("calldata-preview")).toBeNull()
    expect(sendTransactionAsync).toHaveBeenCalledTimes(1)
  })

  it("matches release, refund, and dispute calldata and gates the other action", async () => {
    render(<Host />)
    navigate(`/app/release?escrow=${id}`)
    await waitFor(() => expectGuidedNextReady())
    expect(screen.getByTestId("other-action").textContent).toMatch(/Refund a payment is unavailable/)
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    const releaseReview = await waitFor(() => screen.getByTestId("review-step"))
    expect(within(releaseReview).getByTestId("review-plain").textContent).toMatch(/releasing this payment/)
    expect(calldataOf(releaseReview)).toBe(previewRelease(escrow, id).calldata)
    expect(calldataOf(releaseReview)).toBe(PINNED.release)

    world.expiresAt = 1n
    navigate(`/app/refund?escrow=${id}`)
    await waitFor(() => expectGuidedNextReady())
    expect(screen.getByTestId("other-action").textContent).toMatch(/Release a payment is unavailable/)
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    const refundReview = await waitFor(() => screen.getByTestId("review-step"))
    expect(calldataOf(refundReview)).toBe(previewRefund(escrow, id).calldata)
    expect(calldataOf(refundReview)).toBe(PINNED.refund)

    world.expiresAt = 4_000_000_000n
    navigate(`/app/release?escrow=${id}`)
    await waitFor(() => expect(screen.getByTestId("other-action").textContent).toMatch(/Refund a payment is unavailable/))
    expectGuidedNextReady()

    world.state = 1
    navigate(`/app/refund?escrow=${id}`)
    const released = unavailableLine("refund", "This payment was already released.")
    const releasedReason = await waitFor(() => {
      const node = screen.getByTestId("footer-reason")
      expect(node.textContent).toBe(released)
      return node
    })
    const releasedNext = screen.getByRole("button", { name: "Next" })
    expect(releasedNext.getAttribute("aria-disabled")).toBe("true")
    expect(releasedNext.hasAttribute("disabled")).toBe(false)
    expect(releasedNext.getAttribute("aria-describedby")).toBe(releasedReason.id)
    expect(screen.queryByTestId("action-reason")).toBeNull()
    expect(screen.getAllByText(released)).toHaveLength(1)
    expect(screen.queryByTestId("calldata-preview")).toBeNull()

    world.state = 0
    navigate("/app/dispute")
    fireEvent.click(screen.getByRole("button", { name: "Use my own" }))
    const disputeFields = screen.getAllByLabelText(/ID/)
    fireEvent.change(disputeFields[0]!, { target: { value: disputeId } })
    fireEvent.change(screen.getByLabelText("Escrow ID"), { target: { value: id } })
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "late delivery" } })
    await waitFor(() => expectGuidedNextReady())
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
    navigate(`/app/vote?dispute=${disputeId}`)
    const hiddenSeat = await waitFor(() => {
      const node = screen.getByTestId("footer-reason")
      expect(node.textContent).toMatch(/Only seated arbitrators can vote/)
      return node
    })
    expect(hiddenSeat.textContent).toContain(ACCOUNT.slice(0, 6))
    expect(screen.queryByTestId("vote-seat-reason")).toBeNull()
    expect(screen.getByRole("button", { name: "Next" }).getAttribute("aria-describedby")).toBe(hiddenSeat.id)
    expect(screen.getByRole("button", { name: "Next" }).getAttribute("aria-disabled")).toBe("true")
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false)
    expect(screen.queryByTestId("relayer-submit")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()

    world.arbitrator = true
    navigate(walletHome())
    navigate(`/app/vote?dispute=${disputeId}`)
    await waitFor(() => expectGuidedNextReady())
    fireEvent.click(screen.getByLabelText(DEAL_STANDS_LABEL))
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    const voteReview = await waitFor(() => screen.getByTestId("review-step"))
    expect(calldataOf(voteReview)).toBe(previewVote(panel, disputeId, true).calldata)
    expect(calldataOf(voteReview)).toBe(PINNED.voteTrue)
    expect(within(voteReview).queryByTestId("relayer-submit")).toBeNull()

    navigate("/app/withdraw")
    await waitFor(() => expectGuidedNextReady())
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    const withdrawReview = await waitFor(() => screen.getByTestId("review-step"))
    expect(within(withdrawReview).getByTestId("review-plain").textContent).toMatch(/test ETH/)
    expect(calldataOf(withdrawReview)).toBe(previewWithdraw(escrow).calldata)
    expect(calldataOf(withdrawReview)).toBe(PINNED.withdraw)
    expect(within(withdrawReview).queryByTestId("relayer-submit")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()
  })

  it("puts the vote and withdraw step reason in the footer only while Next is unavailable", async () => {
    render(<Host />)
    world.voted = true
    navigate(`/app/vote?dispute=${disputeId}`)
    const voteReason = await waitFor(() => {
      const node = screen.getByTestId("footer-reason")
      expect(node.textContent).toBe(ALREADY_VOTED_TEXT)
      return node
    })
    const voteNext = screen.getByRole("button", { name: "Next" })
    expect(voteNext.getAttribute("aria-disabled")).toBe("true")
    expect(voteNext.hasAttribute("disabled")).toBe(false)
    expect(voteNext.getAttribute("aria-describedby")).toBe(voteReason.id)
    expect(screen.getByTestId("vote-tally")).toBeTruthy()
    expect(screen.queryByTestId("vote-case")).toBeNull()
    expect(screen.getAllByText(ALREADY_VOTED_TEXT)).toHaveLength(1)

    world.voted = false
    navigate(walletHome())
    navigate(`/app/vote?dispute=${disputeId}`)
    await waitFor(() => expectGuidedNextReady())
    expect(screen.getByTestId("footer-reason").textContent).toBe("")
    expect(screen.queryByText(ALREADY_VOTED_TEXT)).toBeNull()
    expect(screen.getByRole("button", { name: "Next" }).getAttribute("aria-describedby")).toBeNull()

    world.credit = 0n
    navigate("/app/withdraw")
    const withdrawReason = await waitFor(() => {
      const node = screen.getByTestId("footer-reason")
      expect(node.textContent).toBe(NOTHING_TO_WITHDRAW_TEXT)
      return node
    })
    const withdrawNext = screen.getByRole("button", { name: "Next" })
    expect(withdrawNext.getAttribute("aria-disabled")).toBe("true")
    expect(withdrawNext.getAttribute("aria-describedby")).toBe(withdrawReason.id)
    expect(screen.getAllByText(NOTHING_TO_WITHDRAW_TEXT)).toHaveLength(1)

    world.credit = 10n ** 15n
    navigate(walletHome())
    navigate("/app/withdraw")
    await waitFor(() => expectGuidedNextReady())
    expect(screen.getByTestId("footer-reason").textContent).toBe("")
    expect(screen.queryByText(NOTHING_TO_WITHDRAW_TEXT)).toBeNull()
    expect(screen.getByRole("button", { name: "Next" }).getAttribute("aria-describedby")).toBeNull()
    expect(screen.getByTestId("withdraw-available").textContent).toMatch(/^Available to withdraw: /)
    expect(screen.getAllByText(/^Available to withdraw: /)).toHaveLength(1)
  })

  it("leaves vote Next available for a seated arbitrator with no dispute id", async () => {
    render(<Host />)
    navigate("/app/vote")
    await waitFor(() => expectGuidedNextReady())
    expect(screen.getByTestId("footer-reason").textContent).toBe("")
    expect(screen.getByRole("button", { name: "Next" }).getAttribute("aria-describedby")).toBeNull()
    expect(screen.queryByText(CASE_READING_TEXT)).toBeNull()
  })

  it("puts the non-arbitrator seat reason in the footer with or without a dispute id", async () => {
    const seatLine = `Only seated arbitrators can vote. Connected: ${ACCOUNT.slice(0, 6)}…${ACCOUNT.slice(-4)}.`
    render(<Host />)
    world.arbitrator = false

    async function expectSeatReason() {
      const reason = await waitFor(() => {
        const node = screen.getByTestId("footer-reason")
        expect(node.textContent).toBe(seatLine)
        return node
      })
      const next = screen.getByRole("button", { name: "Next" })
      expect(next.getAttribute("aria-disabled")).toBe("true")
      expect(next.hasAttribute("disabled")).toBe(false)
      expect(next.getAttribute("aria-describedby")).toBe(reason.id)
      expect(screen.getAllByText(seatLine)).toHaveLength(1)
      expect(screen.queryByTestId("vote-seat-reason")).toBeNull()
    }

    navigate("/app/vote")
    await expectSeatReason()

    navigate(walletHome())
    navigate(`/app/vote?dispute=${disputeId}`)
    await expectSeatReason()
  })

  it("explains a disabled vote Next while the dispute case is still loading", async () => {
    let releaseCase: () => void = () => {}
    world.caseGate = new Promise((resolve) => {
      releaseCase = resolve
    })
    world.arbitrator = true
    render(<Host />)
    navigate(`/app/vote?dispute=${disputeId}`)
    await waitFor(() => {
      expect(world.arbitratorReads).toBeGreaterThan(0)
      expect(world.caseReads).toBeGreaterThan(0)
    })
    await act(async () => {
      await Promise.resolve()
    })
    const reason = screen.getByTestId("footer-reason")
    const next = screen.getByRole("button", { name: "Next" })
    expect(next.getAttribute("aria-disabled")).toBe("true")
    expect(next.hasAttribute("disabled")).toBe(false)
    expect(reason.textContent).toBe(CASE_READING_TEXT)
    expect(screen.getAllByText(CASE_READING_TEXT)).toHaveLength(1)
    expect(next.getAttribute("aria-describedby")).toBe(reason.id)

    releaseCase()
    await waitFor(() => expectGuidedNextReady())
    expect(screen.getByTestId("footer-reason").textContent).toBe("")
    expect(screen.queryByText(CASE_READING_TEXT)).toBeNull()
    expect(screen.getByRole("button", { name: "Next" }).getAttribute("aria-describedby")).toBeNull()
  })

  it("explains a disabled withdraw Next while the credit is still loading", async () => {
    let releaseCredit: () => void = () => {}
    world.creditGate = new Promise((resolve) => {
      releaseCredit = resolve
    })
    render(<Host />)
    navigate("/app/withdraw")
    await waitFor(() => expect(world.creditReads).toBeGreaterThan(0))
    await act(async () => {
      await Promise.resolve()
    })
    const reason = screen.getByTestId("footer-reason")
    const next = screen.getByRole("button", { name: "Next" })
    expect(reason.textContent).toBe(WITHDRAW_READING_TEXT)
    expect(screen.getAllByText(WITHDRAW_READING_TEXT)).toHaveLength(1)
    expect(screen.queryByTestId("withdraw-available")).toBeNull()
    expect(next.getAttribute("aria-disabled")).toBe("true")
    expect(next.hasAttribute("disabled")).toBe(false)
    expect(next.getAttribute("aria-describedby")).toBe(reason.id)

    world.credit = 10n ** 15n
    releaseCredit()
    await waitFor(() => expectGuidedNextReady())
    expect(screen.getByTestId("footer-reason").textContent).toBe("")
    expect(screen.queryByText(WITHDRAW_READING_TEXT)).toBeNull()
    expect(screen.getByRole("button", { name: "Next" }).getAttribute("aria-describedby")).toBeNull()
    expect(screen.getByTestId("withdraw-available").textContent).toMatch(/^Available to withdraw: /)
  })

  it("keeps the refused withdraw sentence off until the RPC check fails", async () => {
    world.withdrawReads = withdrawReadMode(true, false)
    render(<Host />)
    navigate("/app/withdraw")
    const pending = await waitFor(() => {
      const node = screen.getByTestId("footer-reason")
      expect(node.textContent).toBe(WITHDRAW_READING_TEXT)
      return node
    })
    expect(screen.queryByText(/refused/i)).toBeNull()
    expect(screen.getAllByText(WITHDRAW_READING_TEXT)).toHaveLength(1)
    const pendingNext = screen.getByRole("button", { name: "Next" })
    expect(pendingNext.getAttribute("aria-disabled")).toBe("true")
    expect(pendingNext.getAttribute("aria-describedby")).toBe(pending.id)
    expect(world.creditReads).toBe(0)

    world.withdrawReads = withdrawReadMode(false, false)
    navigate(walletHome())
    navigate("/app/withdraw")
    const refused = await waitFor(() => {
      const node = screen.getByTestId("footer-reason")
      expect(node.textContent).toBe(WITHDRAW_HIDDEN_TEXT)
      return node
    })
    expect(screen.getAllByText(/refused/i)).toHaveLength(1)
    expect(screen.getAllByText(WITHDRAW_HIDDEN_TEXT)).toHaveLength(1)
    expect(screen.queryByText(WITHDRAW_READING_TEXT)).toBeNull()
    expect(screen.getByRole("button", { name: "Next" }).getAttribute("aria-disabled")).toBe("true")
    expect(screen.getByRole("button", { name: "Next" }).getAttribute("aria-describedby")).toBe(refused.id)
    expect(world.creditReads).toBe(0)
  })

  it("explains a refund Next while the escrow time window is still open", async () => {
    render(<Host />)
    navigate(`/app/refund?escrow=${id}`)
    const line = unavailableLine("refund", "This escrow can't be refunded yet. Its time window is still open.")
    const reason = await waitFor(() => {
      const node = screen.getByTestId("footer-reason")
      expect(node.textContent).toBe(line)
      return node
    })
    const next = screen.getByRole("button", { name: "Next" })
    expect(next.getAttribute("aria-disabled")).toBe("true")
    expect(next.hasAttribute("disabled")).toBe(false)
    expect(next.getAttribute("aria-describedby")).toBe(reason.id)
    expect(screen.getAllByText(line)).toHaveLength(1)
    expect(screen.queryByTestId("action-reason")).toBeNull()
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
      navigate(`/app/release?escrow=${escrowId}`)
      await waitFor(() => expectGuidedNextReady())
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
      navigate(`/app/refund?escrow=${escrowId}`)
      await waitFor(() => expectGuidedNextReady())
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
      navigate(`/app/dispute?escrow=${escrowId}`)
      fireEvent.click(screen.getByRole("button", { name: "Use my own" }))
      fireEvent.change(screen.getByLabelText("Dispute ID"), { target: { value: disputeId } })
      fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "late delivery" } })
      await waitFor(() => expectGuidedNextReady())
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
      navigate(`/app/vote?dispute=${dispute}`)
      await waitFor(() => expectGuidedNextReady())
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

    navigate("/app/fund")
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

  it("sends every confirmed Next to a real route", () => {
    const subject = `0x${"ab".repeat(32)}`
    const actions = ["createEscrow", "release", "refund", "dispute", "vote", "withdraw"]
    for (const action of actions) {
      const next = actionProgress(action, subject).next
      if (!next) {
        expect(action).toBe("withdraw")
        continue
      }
      expect(next.href.startsWith("/")).toBe(true)
      expect(next.href.includes("#")).toBe(false)
    }
    expect(actionProgress("createEscrow", subject).next).toEqual({
      href: `/app/release?escrow=${subject}`,
      label: "Next: release the payment",
    })
    expect(actionProgress("dispute", subject).next?.href).toBe(`/app/vote?dispute=${subject}`)
    expect(actionProgress("release", subject).next?.href).toBe("/app/withdraw")
    expect(actionProgress("refund", subject).next?.href).toBe("/app/withdraw")
    expect(actionProgress("vote", subject).next?.href).toBe("/app/release")
  })

  it("keeps one fund escrow id and stops a later step on the first invalid field", async () => {
    const zero = `0x${"00".repeat(32)}` as Hex
    render(<Host />)
    navigate("/app/fund")
    const first = (screen.getByLabelText("Escrow ID") as HTMLInputElement).value
    expect(window.location.search.toLowerCase()).toContain(`escrow=${first.toLowerCase()}`)
    cleanup()
    navigate(`/app/fund?step=3&escrow=${first}`)
    render(<Host />)
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 4")
    expect((screen.getByLabelText("Escrow ID") as HTMLInputElement).value.toLowerCase()).toBe(first.toLowerCase())
    expect(screen.getByTestId("step-error").textContent).toMatch(/payee/i)
    expect(screen.queryByTestId("review-step")).toBeNull()

    navigate(`/app/release?escrow=${zero}`)
    expect(screen.getByTestId("url-escrow-notice").textContent).toBe(ESCROW_ZERO_IGNORED)
    expect(screen.queryByTestId("filled-from-link")).toBeNull()
    navigate(`/app/vote?dispute=${zero}`)
    expect(screen.getByTestId("url-dispute-notice").textContent).toBe(DISPUTE_ZERO_IGNORED)
  })

  it("does not call the relayer for release or dispute", async () => {
    vi.stubEnv("VITE_CLAIM_RELAYER_URL", "https://relayer.example.test")
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, killSwitch: false }), { status: 200, headers: { "content-type": "application/json" } }),
    )
    const relayerCalls = () => fetchSpy.mock.calls.filter((call) => String(call[0]).includes("relayer.example.test"))
    render(<Host />)
    navigate(`/app/release?escrow=${id}`)
    await waitFor(() => expectGuidedNextReady())
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    await waitFor(() => screen.getByTestId("review-step"))
    expect(relayerCalls()).toEqual([])

    navigate("/app/dispute")
    fireEvent.click(screen.getByRole("button", { name: "Use my own" }))
    fireEvent.change(screen.getAllByLabelText(/ID/)[0]!, { target: { value: disputeId } })
    fireEvent.change(screen.getByLabelText("Escrow ID"), { target: { value: id } })
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "late delivery" } })
    await waitFor(() => expectGuidedNextReady())
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    await waitFor(() => screen.getByTestId("review-step"))
    expect(relayerCalls()).toEqual([])

    world.expiresAt = 1n
    navigate(`/app/refund?escrow=${id}`)
    await waitFor(() => expectGuidedNextReady())
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    await waitFor(() => screen.getByTestId("review-step"))
    await waitFor(() => expect(relayerCalls().some((call) => String(call[0]).includes("/health"))).toBe(true))
    fetchSpy.mockRestore()
    vi.unstubAllEnvs()
  })

  it("keeps flow names, step labels, hrefs, and unavailable lines on one catalog", () => {
    expect(WALKTHROUGH_STEP_LABELS).toBe(FLOW_STEP_LABELS)
    expect(TASKS.map((task) => task.flow)).toEqual(FLOWS)
    for (const flow of FLOWS) {
      const defined = FLOW_CATALOG[flow]
      expect(TASKS.find((task) => task.flow === flow)).toMatchObject({ title: defined.title, text: defined.text })
      expect(FLOW_STEP_LABELS[flow]).toBe(defined.stepLabels)
      expect(FLOW_STEPS[flow]).toBe(defined.stepLabels.length)
      expect(flowHref(flow, 1)).toBe(`/app/${flow}`)
      expect(flowTitle(flow)).toBe(defined.title)
      expect(unavailableLine(flow, "Blocked.")).toBe(`${defined.title} is unavailable. Blocked.`)
    }
    expect(FLOW_CATALOG.release.counterpart).toBe("refund")
    expect(FLOW_CATALOG.refund.counterpart).toBe("release")
  })

  it("names Release once when a carried escrow is not on the contract", async () => {
    world.missing = true
    render(<HomeTasks />)
    navigate(`/app/?escrow=${id}`)
    fireEvent.click(screen.getByRole("link", { name: flowTitle("release") }))
    const notice = await waitFor(() => screen.getByTestId("footer-reason"))
    expect(notice.textContent).toBe(unavailableLine("release", "This escrow is not on the contract yet."))
    expect(screen.getAllByText(/is unavailable/)).toHaveLength(1)
    expect(screen.queryByText(/Refund a payment is unavailable/)).toBeNull()
    expect(screen.queryByTestId("other-action")).toBeNull()
    expect(screen.queryByTestId("action-reason")).toBeNull()
    expect(notice.textContent).not.toContain("\u2013")
    const next = screen.getByRole("button", { name: "Next" })
    expect(next.getAttribute("aria-disabled")).toBe("true")
    expect(next.hasAttribute("disabled")).toBe(false)
    expect(next.getAttribute("aria-describedby")).toBe(notice.id)
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(flowTitle("release"))
    expect(compact(screen.getByTestId("filled-from-link").textContent)).toContain(id)
    expect(screen.queryByTestId("calldata-preview")).toBeNull()
    expect(screen.queryByTestId("review-step")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()
  })

  it("shows one Switch button on the wrong-network home, with a text banner and a status pill", () => {
    world.chainId = 1
    world.connected = true
    render(
      <>
        <HeaderNetwork connected chainId={1} />
        <ChainBanner reason="Wallet is on Ethereum mainnet (chain id 1). Switch to Base Sepolia (chain id 84532). Reads and writes are refused." />
        <HomeScreen voteReason={null} />
      </>,
    )
    const switches = screen.getAllByRole("button", { name: "Switch to Base Sepolia" })
    expect(switches).toHaveLength(1)
    expect(switches[0]?.getAttribute("data-testid")).toBe("journey-switch")
    expect(screen.queryByTestId("header-switch")).toBeNull()
    expect(screen.getByTestId("chain-banner").querySelector("button")).toBeNull()
    const pill = screen.getByTestId("header-network")
    expect(pill.tagName).toBe("SPAN")
    expect(pill.textContent).toBe("Not on Base Sepolia")
    expect(screen.getByTestId("task-release").querySelector("a")?.classList.contains("secondary")).toBe(true)
  })

  it("renders task picker controls as secondary while the first-run card shows", () => {
    render(<HomeScreen voteReason={null} />)
    expect(screen.getByTestId("first-run")).toBeTruthy()
    expect(screen.getByTestId("journey-fund").classList.contains("secondary")).toBe(false)
    for (const flow of FLOWS) {
      const control = screen.getByTestId(`task-${flow}`).querySelector("a, button")
      expect(control?.classList.contains("task-link")).toBe(true)
      expect(control?.classList.contains("secondary")).toBe(true)
    }
    cleanup()
    render(<HomeScreen voteReason="Not seated" />)
    expect(screen.getByTestId("task-vote").querySelector("button")?.classList.contains("secondary")).toBe(true)
  })

  it("carries a valid home escrow id into release, refund, and dispute without preparing", () => {
    render(<HomeTasks />)
    navigate(`/app/?escrow=${id}&dispute=${disputeId}`)
    expect(screen.getByRole("link", { name: "Release a payment" }).getAttribute("href")).toBe(`/app/release?escrow=${id}`)
    expect(screen.getByRole("link", { name: "Refund a payment" }).getAttribute("href")).toBe(`/app/refund?escrow=${id}`)
    expect(screen.getByRole("link", { name: "Open a dispute" }).getAttribute("href")).toBe(`/app/dispute?escrow=${id}`)
    expect(screen.getByRole("link", { name: "Vote (arbitrators)" }).getAttribute("href")).toBe(`/app/vote?dispute=${disputeId}`)
    expect(screen.getByRole("link", { name: "Fund an escrow" }).getAttribute("href")).toBe("/app/fund")
    expect(screen.getByRole("link", { name: "Withdraw" }).getAttribute("href")).toBe("/app/withdraw")
    fireEvent.click(screen.getByRole("link", { name: "Release a payment" }))
    expect(compact(screen.getByTestId("filled-from-link").textContent)).toContain(id)
    expect(screen.queryByTestId("calldata-preview")).toBeNull()
    expect(screen.queryByTestId("review-step")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()
  })

  it("carries a valid home dispute id into vote and ignores an invalid id", () => {
    render(<HomeTasks />)
    navigate(`/app/?dispute=${disputeId}`)
    expect(screen.getByRole("link", { name: "Vote (arbitrators)" }).getAttribute("href")).toBe(`/app/vote?dispute=${disputeId}`)
    expect(screen.getByRole("link", { name: "Release a payment" }).getAttribute("href")).toBe("/app/release")
    fireEvent.click(screen.getByRole("link", { name: "Vote (arbitrators)" }))
    expect(compact(screen.getByTestId("vote-filled").textContent)).toContain(disputeId)
    expect(screen.queryByTestId("vote-preview")).toBeNull()
    expect(sendTransactionAsync).not.toHaveBeenCalled()

    navigate("/app/?escrow=nope&dispute=0x1234")
    expect(screen.getByRole("link", { name: "Release a payment" }).getAttribute("href")).toBe("/app/release")
    expect(screen.getByRole("link", { name: "Vote (arbitrators)" }).getAttribute("href")).toBe("/app/vote")
    const zero = `0x${"00".repeat(32)}`
    navigate(`/app/?escrow=${zero}&dispute=${zero}`)
    expect(screen.getByRole("link", { name: "Open a dispute" }).getAttribute("href")).toBe("/app/dispute")
    expect(screen.getByRole("link", { name: "Vote (arbitrators)" }).getAttribute("href")).toBe("/app/vote")
  })

  it("replaces Next with a Base Sepolia switch when the wallet is on another network", () => {
    world.chainId = 1
    render(<Host />)
    navigate("/app/fund")
    expect(screen.queryByTestId("journey-now")).toBeNull()
    expect(screen.getByTestId("wrong-network-note").textContent).toBe(WRONG_NETWORK_NOTE)
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull()
    expect(screen.queryByTestId("journey-connect")).toBeNull()
    const dots = within(screen.getByTestId("stepper")).getAllByRole("listitem")
    expect(dots.map((dot) => dot.getAttribute("data-step-state"))).toEqual(["current", "upcoming", "upcoming", "upcoming"])
    expect(dots[0]?.getAttribute("aria-current")).toBe("step")
    fireEvent.click(screen.getByTestId("journey-switch"))
    expect(world.switchChain).toHaveBeenCalledWith({ chainId: 84532 })
    fireEvent.submit(document.getElementById("create-claim")!)
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 4")
    expect(screen.queryByTestId("review-step")).toBeNull()
  })

  it("replaces Next with connect when the fund flow has no wallet", () => {
    world.connected = false
    render(<Host />)
    navigate("/app/fund")
    expect(screen.queryByTestId("journey-now")).toBeNull()
    expect(within(screen.getByTestId("stepper")).getAllByRole("listitem")[0]?.getAttribute("aria-current")).toBe("step")
    expect(screen.getByTestId("connect-note").textContent).toBe(CONNECT_NOTE)
    expect(screen.getByTestId("journey-connect").textContent).toBe("Connect wallet")
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull()
    expect(screen.queryByTestId("journey-switch")).toBeNull()
    expect(screen.queryByTestId("wrong-network-note")).toBeNull()
    fireEvent.submit(document.getElementById("create-claim")!)
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 4")
  })

  function formFor(flow: (typeof FLOWS)[number]): HTMLFormElement {
    if (flow === "fund") return document.getElementById("create-claim") as HTMLFormElement
    if (flow === "dispute") return document.getElementById("open-dispute") as HTMLFormElement
    if (flow === "vote") return document.getElementById("vote-form") as HTMLFormElement
    if (flow === "withdraw") return document.getElementById("withdraw-form") as HTMLFormElement
    const form = document.getElementById(`${flow}-form`)?.querySelector("form")
    if (!(form instanceof HTMLFormElement)) throw new Error(`missing form for ${flow}`)
    return form
  }

  async function expectWalletBlocksFlow(flow: (typeof FLOWS)[number], mode: "disconnected" | "mainnet") {
    world.connected = mode === "mainnet"
    world.chainId = 8453
    if (flow === "refund") world.expiresAt = 1n
    render(<Host />)
    const href =
      flow === "release" || flow === "refund" || flow === "dispute"
        ? `/app/${flow}?escrow=${id}`
        : flow === "vote"
          ? `/app/vote?dispute=${disputeId}`
          : `/app/${flow}`
    navigate(href)
    if (flow === "fund") {
      fireEvent.change(screen.getByLabelText("Payee wallet"), { target: { value: payee } })
    }
    if (flow === "dispute") {
      fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "late delivery" } })
      await waitFor(() => expect(screen.getByTestId("dispute-subject").textContent).toMatch(/0x/i))
    }
    if (flow === "vote") {
      await waitFor(() => expect(screen.getByTestId("vote-tally")).toBeTruthy())
      fireEvent.click(screen.getByLabelText(DEAL_STANDS_LABEL))
    }
    if ((flow === "release" || flow === "refund") && mode === "mainnet") {
      await waitFor(() => expect(screen.getByTestId("other-action")).toBeTruthy())
    }
    if (flow === "withdraw" && mode === "mainnet") {
      await waitFor(() => expect(screen.getByTestId("withdraw-available").textContent).toMatch(/Available to withdraw/))
    }

    expect(screen.queryByRole("button", { name: "Next" })).toBeNull()
    if (mode === "disconnected") {
      expect(screen.getByTestId("journey-connect").textContent).toBe("Connect wallet")
      expect(screen.queryByRole("button", { name: "Switch to Base Sepolia" })).toBeNull()
    } else {
      const switches = screen.getAllByRole("button", { name: "Switch to Base Sepolia" })
      expect(switches).toHaveLength(1)
      expect(switches[0]?.getAttribute("data-testid")).toBe("journey-switch")
      expect(screen.queryByTestId("journey-connect")).toBeNull()
    }
    await act(async () => {
      fireEvent.submit(formFor(flow))
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(screen.queryByTestId("review-step")).toBeNull()
    expect(screen.getByTestId("step-count").textContent).toMatch(/^Step 1 of /)
    expect(sendTransactionAsync).not.toHaveBeenCalled()
  }

  for (const flow of FLOWS) {
    it(`replaces Next on ${flow} when the wallet is disconnected`, async () => {
      await expectWalletBlocksFlow(flow, "disconnected")
    })

    it(`replaces Next on ${flow} when the wallet is on Base mainnet`, async () => {
      await expectWalletBlocksFlow(flow, "mainnet")
    })
  }

  it("serves client routes from the Pages SPA fallback", () => {
    const file = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../landing/_redirects"), "utf8")
    expect(file).toMatch(/^\/app\/\* +\/app\/ +200$/m)
  })
})
