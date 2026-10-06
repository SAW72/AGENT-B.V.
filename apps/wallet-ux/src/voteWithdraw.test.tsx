// @vitest-environment happy-dom

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { decodeFunctionData, getAddress, type Address, type Hex } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { disputePanelAbi, escrowAbi } from "./abi"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { TESTNET_LINE, WALLET_SIGNED_TEST_LINE } from "./brand"
import { FORM_ERRORS } from "./submit"
import { VoteScreen } from "./VoteScreen"
import { WithdrawScreen } from "./WithdrawScreen"

const escrow = "0x3d660502D75f1e97b08c110255921b437A3C4C42" as Address
const panel = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb" as Address
const voter = "0xD5ee9fA366C3698b34204722c635989E5197B018" as Address
const disputeId = `0x${"ab".repeat(32)}` as Hex
const destination = getAddress("0x1111111111111111111111111111111111111111")

const { fetchSpy, publicClient, sendTransactionAsync, signTypedData, relayerSpies } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  publicClient: {
    call: vi.fn(async () => ({ data: "0x" })),
    readContract: vi.fn(async () => 1_000_000_000_000_000_000n),
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
}))

vi.mock("wagmi", () => ({
  useAccount: () => ({
    isConnected: true,
    address: voter,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    connector: undefined,
  }),
  usePublicClient: () => publicClient,
  useSendTransaction: () => ({ sendTransactionAsync, isPending: false }),
  useWalletClient: () => ({ data: { signTypedData } }),
}))

vi.mock("./useWalletChain", () => ({
  useConnectorChainId: () => BASE_SEPOLIA_CHAIN_ID,
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

function renderScreens() {
  return render(
    <>
      <VoteScreen panel={panel} />
      <WithdrawScreen escrow={escrow} readsEnabled />
    </>,
  )
}

beforeEach(() => {
  fetchSpy.mockReset()
  publicClient.call.mockClear()
  publicClient.readContract.mockClear()
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
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("vote and withdraw screens", () => {
  it("pins the Base Sepolia test-only labels on both screens", () => {
    renderScreens()

    expect(TESTNET_LINE).toBe("Base Sepolia testnet only")
    expect(WALLET_SIGNED_TEST_LINE).toBe(
      "Test only. Votes and withdrawals are real Base Sepolia transactions signed by your own wallet.",
    )

    const voteHeading = screen.getByRole("heading", { name: /Vote/ })
    const withdrawHeading = screen.getByRole("heading", { name: /Withdraw/ })
    expect(within(voteHeading).getByTestId("vote-testnet-pill").textContent).toBe("Base Sepolia testnet only")
    expect(within(withdrawHeading).getByTestId("withdraw-testnet-pill").textContent).toBe("Base Sepolia testnet only")
    expect(screen.getByTestId("vote-test-only").textContent).toBe(WALLET_SIGNED_TEST_LINE)
    expect(screen.getByTestId("withdraw-test-only").textContent).toBe(WALLET_SIGNED_TEST_LINE)

    const voteSource = readFileSync(join(srcDir, "VoteScreen.tsx"), "utf8")
    const withdrawSource = readFileSync(join(srcDir, "WithdrawScreen.tsx"), "utf8")
    for (const source of [voteSource, withdrawSource]) {
      expect(source).toContain("TESTNET_LINE")
      expect(source).toContain("WALLET_SIGNED_TEST_LINE")
    }
  })

  it("signs vote and withdraw from the connected wallet and does not call the relayer", async () => {
    renderScreens()
    const vote = within(screen.getByTestId("vote-screen"))
    const withdraw = within(screen.getByTestId("withdraw-screen"))

    expect(vote.queryByLabelText(/private key/i)).toBeNull()
    expect(vote.queryByLabelText(/mnemonic/i)).toBeNull()
    expect(vote.queryByLabelText(/seed phrase|recovery phrase/i)).toBeNull()
    expect(withdraw.queryByLabelText(/private key/i)).toBeNull()
    expect(withdraw.queryByLabelText(/mnemonic/i)).toBeNull()
    expect(withdraw.queryByLabelText(/seed phrase|recovery phrase/i)).toBeNull()
    expect(document.querySelector('input[type="password"]')).toBeNull()
    expect(screen.queryByRole("button", { name: /relayer/i })).toBeNull()
    expect(screen.queryByTestId("relayer-submit")).toBeNull()
    expect(screen.queryByTestId("relayer-panel")).toBeNull()

    fireEvent.click(vote.getByRole("button", { name: "Prepare this vote" }))
    expect(vote.getByRole("alert").textContent).toBe(FORM_ERRORS.voteId)
    expect(vote.queryByTestId("sepolia-submit")).toBeNull()

    fireEvent.change(vote.getByLabelText("Dispute identifier"), { target: { value: disputeId } })
    fireEvent.click(vote.getByLabelText("Uphold the original decision"))
    fireEvent.click(vote.getByRole("button", { name: "Prepare this vote" }))
    const voteSubmit = vote.getByTestId("sepolia-submit") as HTMLButtonElement
    expect(voteSubmit.disabled).toBe(false)
    fireEvent.click(voteSubmit)

    await waitFor(() => expect(sendTransactionAsync).toHaveBeenCalledTimes(1))

    fireEvent.click(withdraw.getByRole("button", { name: "Prepare withdraw to this address" }))
    expect(withdraw.getByRole("alert").textContent).toBe(FORM_ERRORS.withdrawDestination)

    fireEvent.click(withdraw.getByRole("button", { name: "Prepare withdraw" }))
    fireEvent.click(withdraw.getByTestId("sepolia-submit"))
    await waitFor(() => expect(sendTransactionAsync).toHaveBeenCalledTimes(2))

    fireEvent.change(withdraw.getByLabelText("Destination wallet"), { target: { value: destination } })
    fireEvent.click(withdraw.getByRole("button", { name: "Prepare withdraw to this address" }))
    fireEvent.click(withdraw.getByTestId("sepolia-submit"))
    await waitFor(() => expect(sendTransactionAsync).toHaveBeenCalledTimes(3))

    const voteCall = sendTransactionAsync.mock.calls[0]?.[0]
    const withdrawCall = sendTransactionAsync.mock.calls[1]?.[0]
    const withdrawToCall = sendTransactionAsync.mock.calls[2]?.[0]
    if (!voteCall || !withdrawCall || !withdrawToCall) throw new Error("wallet send was not recorded")
    expect(voteCall).toMatchObject({ to: panel, value: 0n, chainId: BASE_SEPOLIA_CHAIN_ID })
    expect(withdrawCall).toMatchObject({ to: escrow, value: 0n, chainId: BASE_SEPOLIA_CHAIN_ID })
    expect(withdrawToCall).toMatchObject({ to: escrow, value: 0n, chainId: BASE_SEPOLIA_CHAIN_ID })
    expect(decodeFunctionData({ abi: disputePanelAbi, data: voteCall.data }).args).toEqual([disputeId, true])
    expect(decodeFunctionData({ abi: escrowAbi, data: withdrawCall.data }).functionName).toBe("withdraw")
    expect(decodeFunctionData({ abi: escrowAbi, data: withdrawToCall.data }).args).toEqual([destination])

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(runRelayerSubmission).not.toHaveBeenCalled()
    expect(postLiveClaim).not.toHaveBeenCalled()
    expect(readRelayerHealth).not.toHaveBeenCalled()
    expect(readRelayerPaused).not.toHaveBeenCalled()
    expect(submitRelayerAfterPreflight).not.toHaveBeenCalled()
    expect(signTypedData).not.toHaveBeenCalled()
    expect(screen.queryByTestId("relayer-submit")).toBeNull()
  })

  it("keeps key inputs and the relayer out of the vote and withdraw sources", () => {
    const files = ["VoteScreen.tsx", "WithdrawScreen.tsx", "WalletOnlySubmit.tsx"]
    for (const file of files) {
      const source = readFileSync(join(srcDir, file), "utf8")
      expect(source).not.toMatch(/from ["']\.\/relayer["']/)
      expect(source).not.toContain("runRelayerSubmission")
      expect(source).not.toContain("postLiveClaim")
      expect(source).not.toContain("readRelayerHealth")
      expect(source).not.toContain("VITE_CLAIM_RELAYER_URL")
      expect(source).not.toContain("signTypedData")
      expect(source).not.toContain("privateKey")
      expect(source).not.toContain("mnemonic")
      expect(source).not.toContain("PRIVATE_KEY")
      expect(source).not.toMatch(/type="password"/)
    }
    expect(readFileSync(join(srcDir, "WalletOnlySubmit.tsx"), "utf8")).toContain("sendTransactionAsync")
    expect(readFileSync(join(srcDir, "VoteScreen.tsx"), "utf8")).toContain("WalletOnlySubmit")
    expect(readFileSync(join(srcDir, "WithdrawScreen.tsx"), "utf8")).toContain("WalletOnlySubmit")
  })
})
