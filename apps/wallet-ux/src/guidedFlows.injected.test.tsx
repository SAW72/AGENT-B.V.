// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { decodeFunctionData, encodeFunctionResult, getAddress, multicall3Abi, parseEther, type Address, type Hex } from "viem"
import { disconnect } from "wagmi/actions"
import { useAccount, WagmiProvider } from "wagmi"
import { escrowAbi } from "./abi"
import { ADDRESSES } from "./addresses"
import { FUND_ESCROW_STORAGE_KEY, FlowPreview } from "./FlowPreview"
import { previewDispute, previewRefund, previewRelease } from "./preview"
import { navigate, useWalletRoute, walletHome } from "./routes"
import { useConnectorChainId } from "./useWalletChain"
import { wagmiConfig } from "./wagmi"

const ACCOUNT = getAddress("0x6dBe4B1c56494Ee00d6f97FFE9f853F42299D6Ac")
const OTHER = getAddress("0x6C756dacfEcEeA12D5D39536d2eCC175f18bc5A4")
const ESCROW_ID = `0x${"ab".repeat(32)}` as Hex
const SUBJECT = `0x${"11".repeat(32)}` as Hex
const ZERO = "0x0000000000000000000000000000000000000000" as Address
const CONNECT = "Connect a wallet to continue."
const SWITCH = "Switch your wallet to Base Sepolia to continue."
const CHAIN_ERROR = "chain id request failed"
const CHAIN_REJECTED = "User rejected the request."
const SEND_METHODS = [
  "eth_sendTransaction",
  "eth_signTransaction",
  "personal_sign",
  "eth_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
]

type Flow = "release" | "refund" | "dispute"
type ChainMode = "ok" | "error" | "reject"

type Wallet = {
  calls: string[]
  setAccounts: (accounts: string[], notify: boolean) => void
  failChain: (mode: ChainMode) => void
}

const world = {
  expiresAt: 4_000_000_000n,
  state: 0,
}

// One provider object for the file. Wagmi's injected connector registers
// accountsChanged once and does not move that listener onto a replacement.
const providerState: { calls: string[]; chainId: string; accounts: string[]; chainMode: ChainMode } = {
  calls: [],
  chainId: "0x14a34",
  accounts: [],
  chainMode: "ok",
}
const providerListeners = new Map<string, Set<(...args: unknown[]) => void>>()

function emitProvider(event: string, ...args: unknown[]) {
  for (const cb of providerListeners.get(event) ?? []) cb(...args)
}

const stableEthereum = {
  request: async ({ method }: { method: string }) => {
    providerState.calls.push(method)
    if (method === "eth_chainId") {
      if (providerState.chainMode === "error") {
        const failed = new Error(CHAIN_ERROR) as Error & { code: number }
        failed.code = -32603
        throw failed
      }
      if (providerState.chainMode === "reject") {
        const rejected = new Error(CHAIN_REJECTED) as Error & { code: number }
        rejected.code = 4001
        throw rejected
      }
      return providerState.chainId
    }
    if (method === "eth_accounts") return providerState.accounts.slice()
    if (method === "eth_requestAccounts") {
      if (providerState.accounts.length === 0) providerState.accounts = [ACCOUNT]
      return providerState.accounts.slice()
    }
    if (method === "wallet_revokePermissions") {
      providerState.accounts = []
      return null
    }
    if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null
    if (SEND_METHODS.includes(method)) {
      const rejected = new Error("rejected") as Error & { code: number }
      rejected.code = 4001
      throw rejected
    }
    const unsupported = new Error("unsupported") as Error & { code: number }
    unsupported.code = -32601
    throw unsupported
  },
  on(event: string, cb: (...args: unknown[]) => void) {
    const set = providerListeners.get(event) ?? new Set()
    set.add(cb)
    providerListeners.set(event, set)
  },
  removeListener(event: string, cb: (...args: unknown[]) => void) {
    providerListeners.get(event)?.delete(cb)
  },
}

function installProvider(initialChain: string): Wallet {
  providerState.calls = []
  providerState.chainId = initialChain
  providerState.accounts = []
  providerState.chainMode = "ok"
  Object.defineProperty(window, "ethereum", { configurable: true, writable: true, value: stableEthereum })
  return {
    get calls() {
      return providerState.calls
    },
    setAccounts(accounts, notify) {
      providerState.accounts = accounts
      if (notify) emitProvider("accountsChanged", accounts.slice())
    },
    failChain(mode) {
      providerState.chainMode = mode
    },
  }
}

function contractResult(data: Hex): Hex | null {
  try {
    const decoded = decodeFunctionData({ abi: escrowAbi, data })
    if (decoded.functionName === "escrows") {
      return encodeFunctionResult({
        abi: escrowAbi,
        functionName: "escrows",
        result: [
          ACCOUNT,
          OTHER,
          ESCROW_ID,
          SUBJECT,
          parseEther("0.0001"),
          1_700_000_000n,
          world.expiresAt,
          world.state,
          `0x${"00".repeat(32)}`,
          ZERO,
        ],
      })
    }
    if (decoded.functionName === "panelSubject") {
      return encodeFunctionResult({
        abi: escrowAbi,
        functionName: "panelSubject",
        result: SUBJECT,
      })
    }
  } catch {
    return null
  }
  return null
}

function ethCallResult(params: unknown): Hex {
  const data = callData(params)
  if (!data) return "0x"
  if (data.startsWith("0x82ad56cb")) {
    try {
      const decoded = decodeFunctionData({ abi: multicall3Abi, data })
      if (decoded.functionName !== "aggregate3") return "0x"
      const rows = decoded.args[0].map((call) => {
        const returnData = contractResult(call.callData)
        return returnData ? { success: true as const, returnData } : { success: false as const, returnData: "0x" as Hex }
      })
      return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: rows })
    } catch {
      return "0x"
    }
  }
  return contractResult(data) ?? "0x"
}

function escrowCallResult(method: string, params: unknown): unknown {
  if (method === "eth_chainId") return "0x14a34"
  if (method === "net_version") return "84532"
  if (method === "eth_getCode") return "0x60016000"
  if (method === "eth_getBlockByNumber") {
    return { number: "0x1", timestamp: "0x65000000", gasLimit: "0x1c9c380", baseFeePerGas: "0x1" }
  }
  if (method === "eth_call") return ethCallResult(params)
  return "0x1"
}

function callData(params: unknown): Hex | null {
  if (!Array.isArray(params)) return null
  const first = params[0]
  if (!first || typeof first !== "object" || !("data" in first)) return null
  const data = first.data
  return typeof data === "string" && data.startsWith("0x") ? (data as Hex) : null
}

async function readRpcBody(input: RequestInfo | URL, init?: RequestInit): Promise<string | null> {
  if (typeof init?.body === "string") return init.body
  if (input instanceof Request) return input.clone().text()
  return null
}

function stubRpc() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = await readRpcBody(input, init)
    const parsed = raw
      ? (JSON.parse(raw) as { id?: number; method?: string; params?: unknown } | { id?: number; method?: string; params?: unknown }[])
      : null
    const items = Array.isArray(parsed) ? parsed : [parsed ?? { id: 1, method: "eth_chainId" }]
    const body = items.map((item) => ({
      jsonrpc: "2.0",
      id: item.id ?? 1,
      result: escrowCallResult(item.method ?? "", item.params),
    }))
    const payload = Array.isArray(parsed) ? body : body[0]
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })
}

function ChainProbe() {
  const account = useAccount()
  const chain = useConnectorChainId(account.connector, account.isConnected)
  return (
    <p data-testid="chain-probe">
      {`${account.isConnected ? "yes" : "no"}:${account.address ?? "none"}:${account.chainId ?? "none"}:${chain ?? "none"}`}
    </p>
  )
}

function Host() {
  const route = useWalletRoute()
  const escrow = ADDRESSES.botAttestationEscrow
  const panel = ADDRESSES.disputePanel
  if (!escrow || !panel) throw new Error("address book is missing the escrow or the panel")
  return (
    <>
      <ChainProbe />
      <FlowPreview escrow={escrow} panel={panel} route={route} showStrip={false} />
    </>
  )
}

function renderFlow(flow: Flow) {
  navigate(`/app/${flow}?escrow=${ESCROW_ID}`)
  return render(
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Host />
      </QueryClientProvider>
    </WagmiProvider>,
  )
}

function resetMemory() {
  wagmiConfig.setState((current) => ({
    ...current,
    connections: new Map(),
    current: null,
    status: "disconnected",
  }))
}

function reasonLine(): HTMLElement {
  return screen.getByTestId("footer-reason")
}

function formElement(flow: Flow): HTMLFormElement {
  if (flow === "dispute") return document.getElementById("open-dispute") as HTMLFormElement
  const form = document.querySelector(`#${flow}-form form`)
  if (!(form instanceof HTMLFormElement)) throw new Error(`missing ${flow} form`)
  return form
}

async function connectWallet() {
  fireEvent.click(screen.getByTestId("journey-connect"))
  await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeTruthy())
}

function expectNoSend(wallet: Wallet) {
  expect(wallet.calls.some((method) => SEND_METHODS.includes(method))).toBe(false)
}

function escrowAddress(): Address {
  const escrow = ADDRESSES.botAttestationEscrow
  if (!escrow) throw new Error("missing escrow")
  return escrow
}

beforeEach(() => {
  world.expiresAt = 4_000_000_000n
  world.state = 0
  stubRpc()
  window.localStorage.clear()
  window.sessionStorage.clear()
  resetMemory()
})

afterEach(async () => {
  cleanup()
  if (wagmiConfig.state.current && "ethereum" in window) {
    await disconnect(wagmiConfig).catch(() => undefined)
  }
  navigate(walletHome())
  window.localStorage.clear()
  window.sessionStorage.removeItem(FUND_ESCROW_STORAGE_KEY)
  resetMemory()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, "ethereum")
})

describe("release, refund, and dispute with an injected connector", () => {
  it("prepares release calldata on Base Sepolia and never sends", async () => {
    const wallet = installProvider("0x14a34")
    renderFlow("release")
    await connectWallet()
    await waitFor(() => expect(screen.getByTestId("face-amount").textContent).toContain("0.0001"))
    expect(reasonLine().textContent).toBe("")
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    const review = await waitFor(() => screen.getByTestId("review-step"))
    expect(review.querySelector("pre")?.textContent).toBe(previewRelease(escrowAddress(), ESCROW_ID).calldata)
    expect(screen.getByTestId("step-count").textContent).toBe("Step 2 of 2")
    expectNoSend(wallet)
  })

  it("prepares refund calldata on Base Sepolia and never sends", async () => {
    world.expiresAt = 1n
    const wallet = installProvider("0x14a34")
    renderFlow("refund")
    await connectWallet()
    await waitFor(() => expect(screen.getByTestId("face-amount").textContent).toContain("0.0001"))
    expect(reasonLine().textContent).toBe("")
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    const review = await waitFor(() => screen.getByTestId("review-step"))
    expect(review.querySelector("pre")?.textContent).toBe(previewRefund(escrowAddress(), ESCROW_ID).calldata)
    expect(screen.getByTestId("step-count").textContent).toBe("Step 2 of 2")
    expectNoSend(wallet)
  })

  it("prepares dispute calldata on Base Sepolia and never sends", async () => {
    const wallet = installProvider("0x14a34")
    renderFlow("dispute")
    await connectWallet()
    await waitFor(() => expect(screen.getByTestId("dispute-subject").textContent).toContain(SUBJECT))
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "late delivery" } })
    const disputeId = (screen.getByLabelText("Dispute ID") as HTMLInputElement).value as Hex
    expect(reasonLine().textContent).toBe("")
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    const review = await waitFor(() => screen.getByTestId("review-step"))
    expect(review.querySelector("pre")?.textContent).toBe(
      previewDispute(escrowAddress(), ESCROW_ID, disputeId, "late delivery").calldata,
    )
    expect(screen.getByTestId("step-count").textContent).toBe("Step 2 of 2")
    expectNoSend(wallet)
  })

  it("shows Switch and blocks release, refund, and dispute on chain 1", async () => {
    const wallet = installProvider("0x1")
    renderFlow("release")
    fireEvent.click(screen.getByTestId("journey-connect"))
    for (const flow of ["release", "refund", "dispute"] as const) {
      navigate(`/app/${flow}?escrow=${ESCROW_ID}`)
      expect(flow === "dispute" ? document.getElementById("open-dispute") : document.getElementById(`${flow}-form`)).toBeTruthy()
      const reason = await waitFor(() => reasonLine())
      expect(reason.textContent).toBe(SWITCH)
      expect(reason.getAttribute("role")).toBe("status")
      expect(reason.getAttribute("aria-live")).toBe("polite")
      const switchButton = screen.getByTestId("journey-switch")
      expect(switchButton.textContent).toBe("Switch to Base Sepolia")
      expect(switchButton.getAttribute("aria-describedby")).toBe(reason.id)
      expect(screen.queryByRole("button", { name: "Next" })).toBeNull()
      expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 2")
      fireEvent.submit(formElement(flow))
      expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 2")
      expect(screen.queryByTestId("review-step")).toBeNull()
    }
    expectNoSend(wallet)
  })

  it("keeps the release draft when the wallet account changes", async () => {
    const wallet = installProvider("0x14a34")
    renderFlow("release")
    await connectWallet()
    await waitFor(() => expect(screen.getByTestId("face-amount").textContent).toContain("0.0001"))
    await act(async () => {
      wallet.setAccounts([OTHER], true)
    })
    await waitFor(() => expect(screen.getByTestId("chain-probe").textContent).toContain(OTHER))
    expect(screen.getByTestId("filled-from-link").textContent).toContain(ESCROW_ID.slice(0, 6))
    expect(reasonLine().textContent).toBe("")
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 2")
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    const review = await waitFor(() => screen.getByTestId("review-step"))
    expect(review.querySelector("pre")?.textContent).toBe(previewRelease(escrowAddress(), ESCROW_ID).calldata)
    expectNoSend(wallet)
  })

  it("keeps the connect sentence when eth_chainId fails before the wallet connects", async () => {
    const wallet = installProvider("0x14a34")
    wallet.failChain("error")
    renderFlow("release")
    fireEvent.click(screen.getByTestId("journey-connect"))
    await waitFor(() => expect(screen.getByTestId("journey-connect").textContent).toBe("Connect wallet"))
    expect(reasonLine().textContent).toBe(CONNECT)
    expect(screen.getByTestId("chain-probe").textContent?.startsWith("no:")).toBe(true)
    expect(document.body.textContent).not.toContain(CHAIN_ERROR)
    wallet.failChain("reject")
    fireEvent.click(screen.getByTestId("journey-connect"))
    await waitFor(() => expect(screen.getByTestId("journey-connect").textContent).toBe("Connect wallet"))
    expect(reasonLine().textContent).toBe(CONNECT)
    expect(screen.getByTestId("chain-probe").textContent?.startsWith("no:")).toBe(true)
    expect(document.body.textContent).not.toContain(CHAIN_REJECTED)
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull()
    expect(screen.queryByTestId("review-step")).toBeNull()
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 2")
    expectNoSend(wallet)
  })
})
