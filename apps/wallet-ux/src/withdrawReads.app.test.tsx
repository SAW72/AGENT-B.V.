// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Address } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "./App"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { navigate, walletHome } from "./routes"
import { WITHDRAW_HIDDEN_TEXT, WITHDRAW_READING_TEXT } from "./walletCopy"

const ACCOUNT = "0x6dBe4B1c56494Ee00d6f97FFE9f853F42299D6Ac" as Address

const { world, publicClient } = vi.hoisted(() => {
  const world = {
    creditReads: 0,
    gate: null as Promise<number> | null,
    releaseChain: (_chainId: number) => {},
  }
  const publicClient = {
    getChainId: () => {
      if (!world.gate) {
        world.gate = new Promise<number>((resolve) => {
          world.releaseChain = resolve
        })
      }
      return world.gate
    },
    getCode: async () => "0x",
    call: async () => ({ data: "0x" }),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "pendingWithdrawals") {
        world.creditReads += 1
        return 10n ** 15n
      }
      if (functionName === "isArbitrator") return false
      if (functionName === "PANEL_SIZE") return 3n
      return 0n
    },
  }
  return { world, publicClient }
})

vi.mock("wagmi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wagmi")>()
  return {
    ...actual,
    useAccount: () => ({
      isConnected: true,
      address: ACCOUNT,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      connector: undefined,
    }),
    useConnect: () => ({ connect: vi.fn(), connectors: [], isPending: false, error: null }),
    useDisconnect: () => ({ disconnect: vi.fn() }),
    useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false, error: null }),
    usePublicClient: () => publicClient,
    useSendTransaction: () => ({ sendTransactionAsync: vi.fn(), isPending: false }),
    useWalletClient: () => ({ data: undefined }),
    useBalance: () => ({ data: { value: 10n ** 18n }, isSuccess: true }),
  }
})

vi.mock("./read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./read")>()
  return {
    ...actual,
    createSepoliaClient: () => publicClient,
  }
})

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  world.creditReads = 0
  world.gate = null
  world.releaseChain = () => {}
  navigate(walletHome())
})

afterEach(() => {
  cleanup()
})

describe("App withdraw reads", () => {
  it("keeps the withdraw footer on the reading text until a refused chain check finishes", async () => {
    navigate("/app/withdraw")
    renderApp()

    const reading = await waitFor(() => {
      const node = screen.getByTestId("footer-reason")
      expect(node.textContent).toBe(WITHDRAW_READING_TEXT)
      return node
    })
    const next = screen.getByRole("button", { name: "Next" })
    expect(next.getAttribute("aria-disabled")).toBe("true")
    expect(next.getAttribute("aria-describedby")).toBe(reading.id)
    expect(screen.getAllByText(WITHDRAW_READING_TEXT)).toHaveLength(1)
    expect(screen.queryByText(WITHDRAW_HIDDEN_TEXT)).toBeNull()
    expect(world.creditReads).toBe(0)

    await act(async () => {
      world.releaseChain(1)
      await world.gate
    })

    const refused = await waitFor(() => {
      const node = screen.getByTestId("footer-reason")
      expect(node.textContent).toBe(WITHDRAW_HIDDEN_TEXT)
      return node
    })
    expect(screen.getByRole("button", { name: "Next" }).getAttribute("aria-disabled")).toBe("true")
    expect(screen.getByRole("button", { name: "Next" }).getAttribute("aria-describedby")).toBe(refused.id)
    expect(screen.getAllByText(WITHDRAW_HIDDEN_TEXT)).toHaveLength(1)
    expect(screen.queryByText(WITHDRAW_READING_TEXT)).toBeNull()
    expect(world.creditReads).toBe(0)
  })
})
