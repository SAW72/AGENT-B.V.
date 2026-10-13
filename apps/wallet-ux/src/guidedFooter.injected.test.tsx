// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseEther, type Address, type Hex } from "viem"
import { disconnect } from "wagmi/actions"
import { useAccount, WagmiProvider } from "wagmi"
import { ADDRESSES } from "./addresses"
import { parseBytes32 } from "./bytes32"
import { DEFAULT_DURATION_SECONDS } from "./duration"
import { FlowPreview, FUND_ESCROW_STORAGE_KEY } from "./FlowPreview"
import { previewCreateEscrow } from "./preview"
import { navigate, useWalletRoute, walletHome } from "./routes"
import { useConnectorChainId } from "./useWalletChain"
import { wagmiConfig } from "./wagmi"

const ACCOUNT = "0x6dBe4B1c56494Ee00d6f97FFE9f853F42299D6Ac"
const PAYEE = "0x6C756dacfEcEeA12D5D39536d2eCC175f18bc5A4" as Address
const PAYER_BOT = "0x2c2859b9e712890799696d217e9fe2eec1151822ed1b7168785b38991dc42637" as Hex
const PAYEE_BOT = "0xc62c848cf38434b66945ed12b266365ef9390b0281b0ca6bc20ba7ab46a06d2f" as Hex
const CONNECT = "Connect a wallet to continue."
const SWITCH = "Switch your wallet to Base Sepolia to continue."
const AMOUNT = "Enter an amount to continue."
const SEND_METHODS = [
  "eth_sendTransaction",
  "eth_signTransaction",
  "personal_sign",
  "eth_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
]

type Wallet = {
  calls: string[]
  setChain: (chainId: string, notify: boolean) => void
}

function installProvider(initialChain: string): Wallet {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const wallet: Wallet & { chainId: string; accounts: string[] } = {
    calls: [],
    chainId: initialChain,
    accounts: [],
    setChain(chainId, notify) {
      wallet.chainId = chainId
      if (notify) emit("chainChanged", chainId)
    },
  }
  function emit(event: string, ...args: unknown[]) {
    for (const cb of listeners.get(event) ?? []) cb(...args)
  }
  const ethereum = {
    request: async ({ method }: { method: string; params?: unknown }) => {
      wallet.calls.push(method)
      if (method === "eth_chainId") return wallet.chainId
      if (method === "eth_accounts") return wallet.accounts.slice()
      if (method === "eth_requestAccounts") {
        wallet.accounts = [ACCOUNT]
        return wallet.accounts.slice()
      }
      if (method === "wallet_revokePermissions") {
        wallet.accounts = []
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
      const set = listeners.get(event) ?? new Set()
      set.add(cb)
      listeners.set(event, set)
    },
    removeListener(event: string, cb: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(cb)
    },
  }
  Object.defineProperty(window, "ethereum", { configurable: true, writable: true, value: ethereum })
  return wallet
}

function rpcResult(method: string): unknown {
  switch (method) {
    case "eth_chainId":
      return "0x14a34"
    case "net_version":
      return "84532"
    case "eth_getCode":
      return "0x60016000"
    case "eth_call":
      return "0x"
    case "eth_getBlockByNumber":
      return { number: "0x1", timestamp: "0x65000000", gasLimit: "0x1c9c380", baseFeePerGas: "0x1" }
    default:
      return "0x1"
  }
}

async function readRpcBody(input: RequestInfo | URL, init?: RequestInit): Promise<string | null> {
  if (typeof init?.body === "string") return init.body
  if (input instanceof Request) return input.clone().text()
  return null
}

function stubRpc() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = await readRpcBody(input, init)
    const parsed = raw ? (JSON.parse(raw) as { id?: number; method?: string } | { id?: number; method?: string }[]) : null
    const items = Array.isArray(parsed) ? parsed : [parsed ?? { id: 1, method: "eth_chainId" }]
    const body = items.map((item) => ({ jsonrpc: "2.0", id: item.id ?? 1, result: rpcResult(item.method ?? "") }))
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
  return <p data-testid="chain-probe">{`${account.isConnected ? "yes" : "no"}:${account.chainId ?? "none"}:${chain ?? "none"}`}</p>
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

function renderFund() {
  navigate("/app/fund")
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

async function connectWallet() {
  fireEvent.click(screen.getByTestId("journey-connect"))
  await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeTruthy())
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

async function goToBots() {
  fill("Payee wallet", PAYEE)
  fireEvent.click(screen.getByRole("button", { name: "Next" }))
  await waitFor(() => expect(screen.getByLabelText("Payer bot identifier")).toBeTruthy())
}

async function goToAmount() {
  await goToBots()
  fill("Payer bot identifier", PAYER_BOT)
  fill("Payee bot identifier", PAYEE_BOT)
  fireEvent.click(screen.getByRole("button", { name: "Next" }))
  await waitFor(() => expect(screen.getByLabelText("Amount in ETH")).toBeTruthy())
}

beforeEach(() => {
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

describe("guided footer with an injected connector", () => {
  it("prepares fund calldata on Base Sepolia and never sends", async () => {
    const wallet = installProvider("0x14a34")
    renderFund()
    await connectWallet()
    const escrowId = parseBytes32((screen.getByLabelText("Escrow ID") as HTMLInputElement).value)
    expect(escrowId).toBeTruthy()
    await goToAmount()
    fill("Amount in ETH", "0.0001")
    await waitFor(() => expect(screen.queryByTestId("footer-reason")).toBeNull())
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    const review = await waitFor(() => screen.getByTestId("review-step"))
    const escrow = ADDRESSES.botAttestationEscrow
    if (!escrow || !escrowId) throw new Error("missing escrow")
    const preview = previewCreateEscrow({
      escrow,
      escrowId,
      payee: PAYEE,
      payerBotId: PAYER_BOT,
      payeeBotId: PAYEE_BOT,
      durationSeconds: BigInt(DEFAULT_DURATION_SECONDS),
      valueWei: parseEther("0.0001"),
    })
    expect(review.querySelector("pre")?.textContent).toBe(preview.calldata)
    expect(screen.getByTestId("step-count").textContent).toBe("Step 4 of 4")
    expect(wallet.calls.some((method) => SEND_METHODS.includes(method))).toBe(false)
  })

  it("stays on step 1 and asks to switch when the wallet is on chain 1", async () => {
    installProvider("0x1")
    renderFund()
    fireEvent.click(screen.getByTestId("journey-connect"))
    const reason = await waitFor(() => reasonLine())
    expect(reason.textContent).toBe(SWITCH)
    expect(reason.getAttribute("role")).toBe("status")
    expect(reason.getAttribute("aria-live")).toBe("polite")
    const switchButton = screen.getByTestId("journey-switch")
    expect(switchButton.textContent).toBe("Switch to Base Sepolia")
    expect(switchButton.getAttribute("aria-describedby")).toBe(reason.id)
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull()
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 4")
    fireEvent.submit(document.getElementById("create-claim")!)
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 4")
    expect(screen.queryByTestId("review-step")).toBeNull()
  })

  it("shows the switch reason when the connector chain disagrees with the account", async () => {
    const wallet = installProvider("0x14a34")
    renderFund()
    await connectWallet()
    expect(screen.queryByTestId("footer-reason")).toBeNull()
    wallet.setChain("0x1", false)
    const reason = await waitFor(() => reasonLine(), { timeout: 8_000 })
    expect(reason.textContent).toBe(SWITCH)
    expect(screen.getByTestId("journey-switch").getAttribute("aria-describedby")).toBe(reason.id)
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull()
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 4")
    await waitFor(() => expect(screen.getByTestId("chain-probe").textContent).toBe("yes:84532:1"), { timeout: 8_000 })
    const current = wagmiConfig.state.current
    const connection = current ? wagmiConfig.state.connections.get(current) : undefined
    expect(connection?.chainId).toBe(84532)
    expect(await connection?.connector.getChainId()).toBe(1)
  }, 15_000)

  it("keeps the form when the chain changes on step 2 and restores Next on the way back", async () => {
    const wallet = installProvider("0x14a34")
    renderFund()
    await connectWallet()
    await goToBots()
    fill("Payer bot identifier", PAYER_BOT)
    fill("Payee bot identifier", PAYEE_BOT)
    await act(async () => {
      wallet.setChain("0x1", true)
    })
    const reason = await waitFor(() => reasonLine())
    expect(reason.textContent).toBe(SWITCH)
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull()
    expect(screen.getByTestId("chain-probe").textContent).toBe("yes:1:1")
    expect(screen.getByTestId("step-count").textContent).toBe("Step 2 of 4")
    expect((screen.getByLabelText("Payer bot identifier") as HTMLInputElement).value).toBe(PAYER_BOT)
    expect((screen.getByLabelText("Payee bot identifier") as HTMLInputElement).value).toBe(PAYEE_BOT)
    wallet.setChain("0x14a34", true)
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeTruthy())
    expect(screen.queryByTestId("footer-reason")).toBeNull()
    expect((screen.getByLabelText("Payer bot identifier") as HTMLInputElement).value).toBe(PAYER_BOT)
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect((screen.getByLabelText("Payee wallet") as HTMLInputElement).value).toBe(PAYEE)
  })

  it("asks to connect after disconnect and brings Next back with the form intact", async () => {
    installProvider("0x14a34")
    renderFund()
    await connectWallet()
    await goToBots()
    fill("Payer bot identifier", PAYER_BOT)
    await act(async () => {
      await disconnect(wagmiConfig)
    })
    const reason = await waitFor(() => reasonLine())
    expect(reason.textContent).toBe(CONNECT)
    expect(reason.getAttribute("aria-live")).toBe("polite")
    const connect = screen.getByTestId("journey-connect")
    expect(connect.textContent).toBe("Connect wallet")
    expect(connect.getAttribute("aria-describedby")).toBe(reason.id)
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull()
    expect(screen.getByTestId("step-count").textContent).toBe("Step 2 of 4")
    expect((screen.getByLabelText("Payer bot identifier") as HTMLInputElement).value).toBe(PAYER_BOT)
    fireEvent.click(connect)
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeTruthy())
    expect(screen.queryByTestId("footer-reason")).toBeNull()
    expect(screen.getByTestId("step-count").textContent).toBe("Step 2 of 4")
    expect((screen.getByLabelText("Payer bot identifier") as HTMLInputElement).value).toBe(PAYER_BOT)
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect((screen.getByLabelText("Payee wallet") as HTMLInputElement).value).toBe(PAYEE)
  })

  it("disables Next and ignores Enter while the amount is empty", async () => {
    const wallet = installProvider("0x14a34")
    renderFund()
    await connectWallet()
    await goToAmount()
    const reason = reasonLine()
    expect(reason.textContent).toBe(AMOUNT)
    const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement
    expect(next.disabled).toBe(true)
    expect(next.getAttribute("aria-describedby")).toBe(reason.id)
    fireEvent.click(next)
    fireEvent.submit(document.getElementById("create-claim")!)
    expect(screen.getByTestId("step-count").textContent).toBe("Step 3 of 4")
    expect(screen.queryByTestId("review-step")).toBeNull()
    expect(wallet.calls.some((method) => SEND_METHODS.includes(method))).toBe(false)
    fill("Amount in ETH", "0.0001")
    await waitFor(() => expect(screen.queryByTestId("footer-reason")).toBeNull())
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false)
  })
})
