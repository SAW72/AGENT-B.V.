// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { App, INSTALL_WALLET_HINT } from "./App"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { navigate, walletHome } from "./routes"

const CONNECT_ERROR = new Error("the wallet refused the request")

const { publicClient } = vi.hoisted(() => ({
  publicClient: {
    getChainId: async () => BASE_SEPOLIA_CHAIN_ID,
    getCode: async () => "0x",
    call: async () => ({ data: "0x" }),
    readContract: async () => 0n,
  },
}))

vi.mock("wagmi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wagmi")>()
  return {
    ...actual,
    useAccount: () => ({
      isConnected: false,
      address: undefined,
      chainId: undefined,
      connector: undefined,
    }),
    useConnect: () => ({
      connect: vi.fn(),
      connectors: [],
      isPending: false,
      error: CONNECT_ERROR,
    }),
    useDisconnect: () => ({ disconnect: vi.fn() }),
    useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false, error: null }),
    usePublicClient: () => publicClient,
    useSendTransaction: () => ({ sendTransactionAsync: vi.fn(), isPending: false }),
    useWalletClient: () => ({ data: undefined }),
    useBalance: () => ({ data: undefined, isSuccess: false }),
  }
})

vi.mock("./read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./read")>()
  return {
    ...actual,
    createSepoliaClient: () => publicClient,
  }
})

afterEach(() => {
  cleanup()
})

describe("wallet-neutral connect-error hint", () => {
  it("keeps the exact wording, names no wallet brand, and shows the hint in the App UI", () => {
    expect(INSTALL_WALLET_HINT).toBe("Install a browser wallet if no injected wallet is available.")
    expect(INSTALL_WALLET_HINT).not.toMatch(/metamask|rabby|coinbase|phantom|brave/i)

    navigate(walletHome())
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    )
    const alert = screen.getByRole("alert")
    expect(alert.textContent).toContain(INSTALL_WALLET_HINT)
    expect(alert.textContent).not.toMatch(/metamask|rabby|coinbase|phantom|brave/i)
  })
})
