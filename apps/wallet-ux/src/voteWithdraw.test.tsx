// @vitest-environment happy-dom

import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { decodeFunctionData, type Address, type Hex } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { disputePanelAbi, escrowAbi } from "./abi"
import { ADDRESSES, BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { carryDisputeId, resetCarriedIds } from "./carriedIds"
import { resetSubmitLock } from "./submitLock"
import { resetPendingRuntime } from "./usePendingReceipt"
import { TESTNET_LINE, WALLET_SIGNED_TEST_LINE } from "./brand"
import { ERROR_GLOSSARY } from "./preview"
import { FORM_ERRORS } from "./submit"
import { VoteScreen } from "./VoteScreen"
import {
  ALREADY_VOTED_TEXT,
  CASE_UNREADABLE_TEXT,
  DEAL_STANDS_LABEL,
  NO_DISPUTE_TEXT,
  NOT_ARBITRATOR_TEXT,
  NOTHING_TO_WITHDRAW_TEXT,
  PANEL_SIZE_UNREADABLE_TEXT,
  RESOLVED_LEAD,
  TX_PENDING_TEXT,
  UNDO_DEAL_LABEL,
  VOTE_CHOICE_TEXT,
  VOTE_HEADING,
  VOTE_SENDER_NOTE,
  WITHDRAW_FAILED_TEXT,
  WITHDRAW_GAS_TEXT,
  WITHDRAW_HEADING,
  resolvedCaseText,
  voteTallyText,
} from "./walletCopy"
import { WithdrawScreen } from "./WithdrawScreen"

const escrow = "0x3d660502D75f1e97b08c110255921b437A3C4C42" as Address
const panel = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb" as Address
const voter = "0xD5ee9fA366C3698b34204722c635989E5197B018" as Address
const disputeId = `0x${"ab".repeat(32)}` as Hex
const txHash = `0x${"cd".repeat(32)}` as Hex

const { fetchSpy, publicClient, sendTransactionAsync, signTypedData, relayerSpies, world } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  publicClient: {
    call: vi.fn(async () => ({ data: "0x" })),
    readContract: vi.fn(async (_args: { functionName: string; args?: readonly unknown[] }) => 0n as unknown),
    waitForTransactionReceipt: vi.fn(
      async (_args: { hash: Hex }): Promise<{ status: "success" | "reverted" }> => ({ status: "success" }),
    ),
  },
  sendTransactionAsync: vi.fn(async (_tx: { to: Address; data: Hex; value: bigint; chainId: number }) => {
    return `0x${"cd".repeat(32)}` as Hex
  }),
  signTypedData: vi.fn(),
  relayerSpies: {
    runRelayerSubmission: vi.fn(),
    postLiveClaim: vi.fn(),
    readRelayerHealth: vi.fn(),
    readRelayerPaused: vi.fn(),
    submitRelayerAfterPreflight: vi.fn(),
  },
  world: {
    connected: true,
    arbitrator: true as boolean | "throw",
    votesFor: 1n,
    votesAgainst: 0n,
    resolved: false,
    dealStands: false,
    createdAt: 10n,
    alreadyVoted: false as boolean | "throw",
    panelSize: 3n as bigint | "throw",
    balance: 1_000_000_000_000_000_000n as bigint | "throw",
    receipts: [] as Array<(value: { status: "success" | "reverted" }) => void>,
  },
}))

publicClient.readContract.mockImplementation(async (args: { functionName: string }) => {
  switch (args.functionName) {
    case "isArbitrator":
      if (world.arbitrator === "throw") throw new Error("arbitrator unread")
      return world.arbitrator
    case "PANEL_SIZE":
      if (world.panelSize === "throw") throw new Error("panel size unread")
      return world.panelSize
    case "disputes":
      if (world.createdAt < 0n) throw new Error("dispute unread")
      return [
        `0x${"11".repeat(32)}`,
        "0x0000000000000000000000000000000000000001",
        "reason",
        world.votesFor,
        world.votesAgainst,
        world.resolved,
        world.dealStands,
        world.createdAt,
      ]
    case "voted":
      if (world.alreadyVoted === "throw") throw new Error("voted unread")
      return world.alreadyVoted
    case "pendingWithdrawals":
      if (world.balance === "throw") throw new Error("balance unread")
      return world.balance
    default:
      throw new Error(`unexpected read ${args.functionName}`)
  }
})

publicClient.waitForTransactionReceipt.mockImplementation(
  () =>
    new Promise((resolve) => {
      world.receipts.push(resolve)
    }),
)

vi.mock("wagmi", () => ({
  useAccount: () => ({
    isConnected: world.connected,
    address: world.connected ? voter : undefined,
    chainId: world.connected ? BASE_SEPOLIA_CHAIN_ID : undefined,
    connector: undefined,
  }),
  usePublicClient: () => publicClient,
  useSendTransaction: () => ({ sendTransactionAsync, isPending: false }),
  useWalletClient: () => ({ data: { signTypedData } }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false, error: null }),
  useBalance: () => ({ data: { value: 10n ** 18n }, isSuccess: true }),
}))

vi.mock("./useWalletChain", () => ({
  useConnectorChainId: () => (world.connected ? BASE_SEPOLIA_CHAIN_ID : null),
}))

vi.mock("./relayer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./relayer")>()
  return {
    ...actual,
    runRelayerSubmission: relayerSpies.runRelayerSubmission,
    postLiveClaim: relayerSpies.postLiveClaim,
    readRelayerHealth: relayerSpies.readRelayerHealth,
    readRelayerPaused: relayerSpies.readRelayerPaused,
  }
})

vi.mock("./preflight", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./preflight")>()
  return {
    ...actual,
    submitRelayerAfterPreflight: relayerSpies.submitRelayerAfterPreflight,
  }
})

import { postLiveClaim, readRelayerHealth, readRelayerPaused, runRelayerSubmission } from "./relayer"
import { submitRelayerAfterPreflight } from "./preflight"

const srcDir = dirname(fileURLToPath(import.meta.url))

function resetWorld() {
  world.connected = true
  world.arbitrator = true
  world.votesFor = 1n
  world.votesAgainst = 0n
  world.resolved = false
  world.dealStands = false
  world.createdAt = 10n
  world.alreadyVoted = false
  world.panelSize = 3n
  world.balance = 1_000_000_000_000_000_000n
  world.receipts.length = 0
}

function renderScreens() {
  const bookedEscrow = ADDRESSES.botAttestationEscrow
  if (!bookedEscrow) throw new Error("booked escrow missing")
  return render(
    <>
      <VoteScreen panel={ADDRESSES.disputePanel} />
      <WithdrawScreen escrow={bookedEscrow} readsEnabled />
    </>,
  )
}

async function enterDispute(scope = within(screen.getByTestId("vote-screen"))) {
  fireEvent.change(scope.getByLabelText("Dispute ID"), { target: { value: disputeId } })
  return scope
}

async function settleReceipt() {
  await waitFor(() => expect(world.receipts.length).toBeGreaterThan(0))
  const resolve = world.receipts.shift()
  if (!resolve) throw new Error("no receipt waiter")
  resolve({ status: "success" })
}

function readCalls(name: string) {
  return publicClient.readContract.mock.calls.filter((call) => call[0]?.functionName === name)
}

beforeEach(() => {
  resetCarriedIds()
  resetSubmitLock()
  resetPendingRuntime()
  resetWorld()
  localStorage.clear()
  fetchSpy.mockReset()
  publicClient.call.mockClear()
  publicClient.readContract.mockClear()
  publicClient.waitForTransactionReceipt.mockClear()
  sendTransactionAsync.mockClear()
  signTypedData.mockClear()
  relayerSpies.runRelayerSubmission.mockClear()
  relayerSpies.postLiveClaim.mockClear()
  relayerSpies.readRelayerHealth.mockClear()
  relayerSpies.readRelayerPaused.mockClear()
  relayerSpies.submitRelayerAfterPreflight.mockClear()
  vi.stubGlobal("fetch", fetchSpy)
  vi.stubEnv("VITE_CLAIM_RELAYER_URL", "https://relayer.example.test")
})

afterEach(() => {
  cleanup()
  resetCarriedIds()
  resetSubmitLock()
  resetPendingRuntime()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("vote and withdraw screens", () => {
  it("pins the Base Sepolia test-only labels and Agent-BV copy on both screens", async () => {
    renderScreens()
    expect(TESTNET_LINE).toBe("Base Sepolia testnet only")
    expect(WALLET_SIGNED_TEST_LINE).toBe(
      "Test only. Votes and withdrawals are real Base Sepolia transactions signed by your own wallet.",
    )
    expect(ADDRESSES.disputePanel).toBe(panel)
    expect(ADDRESSES.botAttestationEscrow).toBe(escrow)

    const voteHeading = screen.getByRole("heading", { name: /arbitrator vote/ })
    const withdrawHeading = screen.getByRole("heading", { name: /withdraw/i })
    expect(voteHeading.textContent).toContain(VOTE_HEADING)
    expect(withdrawHeading.textContent).toContain(WITHDRAW_HEADING)
    expect(within(voteHeading).queryByTestId("vote-testnet-pill")).toBeNull()
    expect(within(withdrawHeading).queryByTestId("withdraw-testnet-pill")).toBeNull()
    expect(screen.queryByTestId("action-testnet")).toBeNull()
    expect(screen.getByTestId("vote-test-only").textContent).toBe(WALLET_SIGNED_TEST_LINE)
    expect(screen.getByTestId("withdraw-test-only").textContent).toBe(WALLET_SIGNED_TEST_LINE)

    const vote = within(screen.getByTestId("vote-screen"))
    await enterDispute(vote)
    await waitFor(() => expect(vote.getByTestId("vote-tally").textContent).toBe(voteTallyText(1n, 0n, 3n)))
    const voteText = screen.getByTestId("vote-screen").textContent ?? ""
    const withdrawText = screen.getByTestId("withdraw-screen").textContent ?? ""
    expect(voteText).toContain("Agent-BV")
    expect(withdrawText).toContain("Agent-BV")
    expect(voteText.toLowerCase()).not.toContain("uphold")
    expect(withdrawText.toLowerCase()).not.toContain("uphold")
    expect(voteText).toContain(DEAL_STANDS_LABEL)
    expect(voteText).toContain(UNDO_DEAL_LABEL)
    expect(voteText.toLowerCase()).not.toMatch(/\bagainst\b/)
    expect(FORM_ERRORS.voteChoice).toBe(VOTE_CHOICE_TEXT)
    expect(VOTE_SENDER_NOTE.toLowerCase()).not.toContain("uphold")
    expect(screen.getByTestId("withdraw-gas").textContent).toBe(WITHDRAW_GAS_TEXT)
  })

  it("disables voting when the wallet is not an arbitrator or is disconnected", async () => {
    world.arbitrator = false
    renderScreens()
    const vote = within(screen.getByTestId("vote-screen"))
    await waitFor(() => expect(vote.getByTestId("vote-arbitrator").textContent).toBe(NOT_ARBITRATOR_TEXT))
    expect((vote.getByRole("button", { name: "Prepare this vote" }) as HTMLButtonElement).disabled).toBe(true)
    expect((vote.getByTestId("vote-submit-blocked") as HTMLButtonElement).disabled).toBe(true)
    expect(readCalls("isArbitrator").some((call) => call[0]?.args?.[0] === voter)).toBe(true)
    expect(readCalls("canVote")).toHaveLength(0)

    cleanup()
    resetWorld()
    world.connected = false
    publicClient.readContract.mockClear()
    renderScreens()
    const disconnected = within(screen.getByTestId("vote-screen"))
    expect(disconnected.getByTestId("vote-arbitrator").textContent).toBe(NOT_ARBITRATOR_TEXT)
    expect((disconnected.getByRole("button", { name: "Prepare this vote" }) as HTMLButtonElement).disabled).toBe(true)
    expect(readCalls("isArbitrator")).toHaveLength(0)
  })

  it("shows unknown, already voted, and resolved cases and disables submit", async () => {
    world.createdAt = 0n
    renderScreens()
    const vote = within(screen.getByTestId("vote-screen"))
    await enterDispute(vote)
    await waitFor(() => expect(vote.getByTestId("vote-case").textContent).toBe(NO_DISPUTE_TEXT))
    expect(vote.queryByTestId("vote-tally")).toBeNull()
    expect((vote.getByRole("button", { name: "Prepare this vote" }) as HTMLButtonElement).disabled).toBe(true)

    cleanup()
    resetWorld()
    world.alreadyVoted = true
    renderScreens()
    const voted = within(screen.getByTestId("vote-screen"))
    await enterDispute(voted)
    await waitFor(() => expect(voted.getByTestId("vote-case").textContent).toBe(ALREADY_VOTED_TEXT))
    expect(voted.getByTestId("vote-tally").textContent).toBe(voteTallyText(1n, 0n, 3n))
    expect((voted.getByRole("button", { name: "Prepare this vote" }) as HTMLButtonElement).disabled).toBe(true)

    cleanup()
    resetWorld()
    world.resolved = true
    world.dealStands = true
    world.votesFor = 2n
    world.votesAgainst = 1n
    renderScreens()
    const stands = within(screen.getByTestId("vote-screen"))
    await enterDispute(stands)
    await waitFor(() => expect(stands.getByTestId("vote-case").textContent).toBe(resolvedCaseText(true)))
    expect(stands.getByTestId("vote-case").textContent).toContain(RESOLVED_LEAD)
    expect((stands.getByRole("button", { name: "Prepare this vote" }) as HTMLButtonElement).disabled).toBe(true)

    cleanup()
    resetWorld()
    world.resolved = true
    world.dealStands = false
    world.votesFor = 1n
    world.votesAgainst = 2n
    renderScreens()
    const undo = within(screen.getByTestId("vote-screen"))
    await enterDispute(undo)
    await waitFor(() => expect(undo.getByTestId("vote-case").textContent).toBe(resolvedCaseText(false)))
    expect((undo.getByRole("button", { name: "Prepare this vote" }) as HTMLButtonElement).disabled).toBe(true)
    expect(undo.queryByTestId("sepolia-submit")).toBeNull()
  })

  it("renders the tally and a plain unreadable fallback", async () => {
    renderScreens()
    const vote = within(screen.getByTestId("vote-screen"))
    await enterDispute(vote)
    await waitFor(() => expect(vote.getByTestId("vote-tally").textContent).toBe("Votes so far: 1 for the payee, 0 for the payer (3 votes resolve the case)."))

    cleanup()
    resetWorld()
    world.panelSize = "throw"
    renderScreens()
    const missingSize = within(screen.getByTestId("vote-screen"))
    await enterDispute(missingSize)
    await waitFor(() => expect(missingSize.getByTestId("vote-tally").textContent).toBe(voteTallyText(1n, 0n, null)))
    expect(missingSize.getByTestId("vote-panel-size").textContent).toBe(PANEL_SIZE_UNREADABLE_TEXT)

    cleanup()
    resetWorld()
    world.createdAt = -1n
    renderScreens()
    const unread = within(screen.getByTestId("vote-screen"))
    await enterDispute(unread)
    await waitFor(() => expect(unread.getByTestId("vote-case").textContent).toBe(CASE_UNREADABLE_TEXT))
    expect((unread.getByRole("button", { name: "Prepare this vote" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("maps the contract revert strings to the plain sentences", () => {
    const panelSource = readFileSync(join(srcDir, "../../../contracts/DisputePanel.sol"), "utf8")
    const escrowSource = readFileSync(join(srcDir, "../../../contracts/BotAttestationEscrow.sol"), "utf8")
    expect(panelSource).toContain('require(isArbitrator[msg.sender], "not authorized")')
    expect(panelSource).toContain('require(d.createdAt != 0, "no dispute")')
    expect(panelSource).toContain('require(!d.resolved, "resolved")')
    expect(panelSource).toContain('require(!voted[disputeId][msg.sender], "already voted")')
    expect(escrowSource).toContain('require(amt > 0, "nothing to withdraw")')
    expect(escrowSource).toContain("revert WithdrawFailed()")
    const meaning = (name: string) => ERROR_GLOSSARY.find((entry) => entry.name === name)?.meaning
    expect(meaning("not authorized")).toBe(NOT_ARBITRATOR_TEXT)
    expect(meaning("no dispute")).toBe(NO_DISPUTE_TEXT)
    expect(meaning("resolved")).toBe(RESOLVED_LEAD)
    expect(meaning("already voted")).toBe(ALREADY_VOTED_TEXT)
    expect(meaning("nothing to withdraw")).toBe(NOTHING_TO_WITHDRAW_TEXT)
    expect(meaning("WithdrawFailed")).toBe(WITHDRAW_FAILED_TEXT)
  })

  it("signs true and false votes and withdraw from the connected wallet and does not call the relayer", async () => {
    renderScreens()
    const vote = within(screen.getByTestId("vote-screen"))
    const withdraw = within(screen.getByTestId("withdraw-screen"))
    expect(vote.queryByLabelText(/private key/i)).toBeNull()
    expect(vote.queryByLabelText(/mnemonic/i)).toBeNull()
    expect(withdraw.queryByLabelText(/private key/i)).toBeNull()
    expect(withdraw.queryByLabelText(/destination/i)).toBeNull()
    expect(document.querySelector('input[type="password"]')).toBeNull()
    expect(screen.queryByRole("button", { name: /relayer/i })).toBeNull()

    await enterDispute(vote)
    await waitFor(() => expect((vote.getByRole("button", { name: "Prepare this vote" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(vote.getByRole("button", { name: "Prepare this vote" }))
    await waitFor(() => expect(vote.getByRole("alert").textContent).toBe(VOTE_CHOICE_TEXT))

    fireEvent.click(vote.getByLabelText(DEAL_STANDS_LABEL))
    fireEvent.click(vote.getByRole("button", { name: "Prepare this vote" }))
    await waitFor(() => expect(vote.getByTestId("sepolia-submit")).toBeTruthy())
    fireEvent.click(vote.getByTestId("sepolia-submit"))
    await waitFor(() => expect(sendTransactionAsync).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(vote.getByTestId("tx-pending").textContent).toBe(TX_PENDING_TEXT))
    await settleReceipt()
    await waitFor(() => expect(vote.getByTestId("tx-confirmed")).toBeTruthy())

    fireEvent.click(vote.getByLabelText(UNDO_DEAL_LABEL))
    fireEvent.click(vote.getByRole("button", { name: "Prepare this vote" }))
    await waitFor(() => expect(vote.getByTestId("sepolia-submit")).toBeTruthy())
    fireEvent.click(vote.getByTestId("sepolia-submit"))
    await waitFor(() => expect(sendTransactionAsync).toHaveBeenCalledTimes(2))
    await settleReceipt()

    await waitFor(() => expect(withdraw.getByTestId("withdraw-available").textContent).toBe("Available to withdraw: 1 ETH"))
    fireEvent.click(withdraw.getByRole("button", { name: "Prepare withdraw" }))
    await waitFor(() => expect(withdraw.getByTestId("sepolia-submit")).toBeTruthy())
    fireEvent.click(withdraw.getByTestId("sepolia-submit"))
    await waitFor(() => expect(sendTransactionAsync).toHaveBeenCalledTimes(3))

    const payeeVote = sendTransactionAsync.mock.calls[0]?.[0]
    const payerVote = sendTransactionAsync.mock.calls[1]?.[0]
    const withdrawCall = sendTransactionAsync.mock.calls[2]?.[0]
    if (!payeeVote || !payerVote || !withdrawCall) throw new Error("wallet send was not recorded")
    expect(payeeVote).toMatchObject({ to: panel, value: 0n, chainId: BASE_SEPOLIA_CHAIN_ID })
    expect(payerVote).toMatchObject({ to: panel, value: 0n, chainId: BASE_SEPOLIA_CHAIN_ID })
    expect(withdrawCall).toMatchObject({ to: escrow, value: 0n, chainId: BASE_SEPOLIA_CHAIN_ID })
    expect(decodeFunctionData({ abi: disputePanelAbi, data: payeeVote.data }).args).toEqual([disputeId, true])
    expect(decodeFunctionData({ abi: disputePanelAbi, data: payerVote.data }).args).toEqual([disputeId, false])
    expect(decodeFunctionData({ abi: escrowAbi, data: withdrawCall.data }).functionName).toBe("withdraw")
    expect(decodeFunctionData({ abi: escrowAbi, data: withdrawCall.data }).args ?? []).toEqual([])

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(runRelayerSubmission).not.toHaveBeenCalled()
    expect(postLiveClaim).not.toHaveBeenCalled()
    expect(readRelayerHealth).not.toHaveBeenCalled()
    expect(readRelayerPaused).not.toHaveBeenCalled()
    expect(submitRelayerAfterPreflight).not.toHaveBeenCalled()
    expect(signTypedData).not.toHaveBeenCalled()
    expect(screen.queryByTestId("relayer-submit")).toBeNull()
    expect(screen.queryByTestId("relayer-panel")).toBeNull()
  })

  it("disables withdraw at zero credit and enables it when credit is available", async () => {
    world.balance = 0n
    render(<WithdrawScreen escrow={escrow} readsEnabled />)
    await waitFor(() => expect(screen.getByTestId("withdraw-available").textContent).toBe("Available to withdraw: 0 ETH"))
    const blocked = screen.getByRole("button", { name: NOTHING_TO_WITHDRAW_TEXT }) as HTMLButtonElement
    expect(blocked.disabled).toBe(true)
    expect(screen.queryByRole("button", { name: "Prepare withdraw" })).toBeNull()
    expect(screen.getByTestId("withdraw-gas").textContent).toBe(WITHDRAW_GAS_TEXT)

    cleanup()
    resetWorld()
    world.balance = 2_000_000_000_000_000_000n
    render(<WithdrawScreen escrow={escrow} readsEnabled />)
    await waitFor(() => expect(screen.getByTestId("withdraw-available").textContent).toBe("Available to withdraw: 2 ETH"))
    const prepare = screen.getByRole("button", { name: "Prepare withdraw" }) as HTMLButtonElement
    expect(prepare.disabled).toBe(false)
    fireEvent.click(prepare)
    await waitFor(() => expect(screen.getByTestId("withdraw-preview")).toBeTruthy())
    const calldata = screen.getByTestId("withdraw-preview").querySelector("pre")?.textContent ?? ""
    const decoded = decodeFunctionData({ abi: escrowAbi, data: calldata as Hex })
    expect(decoded.functionName).toBe("withdraw")
    expect(screen.getByTestId("withdraw-preview").querySelector("[data-testid=review-contract-address]")?.getAttribute("data-address")).toBe(escrow)
  })

  it("clears a prepared vote when a carried dispute id replaces the one on screen", async () => {
    const first = `0x${"ab".repeat(32)}` as Hex
    const second = `0x${"ef".repeat(32)}` as Hex
    carryDisputeId(first)
    renderScreens()
    const vote = within(screen.getByTestId("vote-screen"))
    await waitFor(() => expect((vote.getByLabelText("Dispute ID") as HTMLInputElement).value).toBe(first))
    await waitFor(() => expect(vote.getByTestId("vote-tally")).toBeTruthy())
    fireEvent.click(vote.getByLabelText(DEAL_STANDS_LABEL))
    fireEvent.click(vote.getByRole("button", { name: "Prepare this vote" }))
    await waitFor(() => expect(vote.getByTestId("vote-preview")).toBeTruthy())
    expect(vote.getByTestId("vote-preview").querySelector("pre")?.textContent).toContain(first.slice(2))
    carryDisputeId(second)
    await waitFor(() => expect((vote.getByLabelText("Dispute ID") as HTMLInputElement).value).toBe(second))
    expect(vote.queryByTestId("vote-preview")).toBeNull()
    expect(vote.queryByTestId("sepolia-submit")).toBeNull()
  })

  it("waits for the receipt, then shows the confirmed hash and re-reads", async () => {
    renderScreens()
    const vote = within(screen.getByTestId("vote-screen"))
    await enterDispute(vote)
    await waitFor(() => expect(vote.getByTestId("vote-tally")).toBeTruthy())
    const disputesBefore = readCalls("disputes").length
    fireEvent.click(vote.getByLabelText(DEAL_STANDS_LABEL))
    fireEvent.click(vote.getByRole("button", { name: "Prepare this vote" }))
    await waitFor(() => expect(vote.getByTestId("sepolia-submit")).toBeTruthy())
    fireEvent.click(vote.getByTestId("sepolia-submit"))
    await waitFor(() => expect(vote.getByTestId("tx-pending").textContent).toBe(TX_PENDING_TEXT))
    expect(vote.getByTestId("tx-hash").textContent).toBe(txHash)
    expect(vote.getByTestId("tx-explorer").getAttribute("href")).toBe(`https://sepolia.basescan.org/tx/${txHash}`)
    await settleReceipt()
    await waitFor(() => expect(vote.getByTestId("tx-confirmed").textContent).toBe("Vote cast"))
    await waitFor(() => expect(readCalls("disputes").length).toBeGreaterThan(disputesBefore))
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: txHash, timeout: 180_000 })

    const withdraw = within(screen.getByTestId("withdraw-screen"))
    await waitFor(() => expect(withdraw.getByRole("button", { name: "Prepare withdraw" })).toBeTruthy())
    const balanceBefore = readCalls("pendingWithdrawals").length
    fireEvent.click(withdraw.getByRole("button", { name: "Prepare withdraw" }))
    await waitFor(() => expect(withdraw.getByTestId("sepolia-submit")).toBeTruthy())
    fireEvent.click(withdraw.getByTestId("sepolia-submit"))
    await waitFor(() => expect(withdraw.getByTestId("tx-pending")).toBeTruthy())
    await settleReceipt()
    await waitFor(() => expect(withdraw.getByTestId("tx-confirmed").textContent).toBe("Withdrawn"))
    await waitFor(() => expect(readCalls("pendingWithdrawals").length).toBeGreaterThan(balanceBefore))
  })

  it("keeps withdrawTo out of the wallet screens and preview helpers", () => {
    function files(dir: string): string[] {
      const out: string[] = []
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          if (name === "abi") continue
          out.push(...files(path))
          continue
        }
        if (name === "relayer.ts" || name.endsWith(".test.ts") || name.endsWith(".test.tsx")) continue
        if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(path)
      }
      return out
    }
    const hits = files(srcDir).filter((path) => readFileSync(path, "utf8").includes("withdrawTo"))
    expect(hits).toEqual([])
  })
})
