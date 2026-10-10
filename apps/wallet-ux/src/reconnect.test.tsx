// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it } from "vitest"
import { reconnect } from "wagmi/actions"
import { useAccount, useConnect, WagmiProvider } from "wagmi"
import { useConnectorChainId } from "./useWalletChain"
import { wagmiConfig } from "./wagmi"

const ACCOUNT = "0x6dBe4B1c56494Ee00d6f97FFE9f853F42299D6Ac"

function installProvider() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const ethereum = {
    request: async ({ method }: { method: string }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [ACCOUNT]
      if (method === "eth_chainId") return "0x14a34"
      if (method === "wallet_switchEthereumChain" || method === "wallet_revokePermissions") return null
      return null
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
}

function Probe() {
  const account = useAccount()
  const chain = useConnectorChainId(account.connector, account.isConnected)
  const { connect, connectors } = useConnect()
  const connector = connectors[0]
  return (
    <div>
      <h1>Agent-BV (Agent Bot Verifier)</h1>
      <button
        type="button"
        onClick={() => {
          if (!connector) throw new Error("missing injected connector")
          connect({ connector })
        }}
      >
        Connect
      </button>
      <p data-testid="probe-status">
        {account.isConnected ? `connected ${account.chainId ?? "none"} ${chain ?? "none"}` : "disconnected"}
      </p>
    </div>
  )
}

function renderProbe() {
  return render(
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={new QueryClient()}>
        <Probe />
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

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  resetMemory()
})

describe("injected reconnect", () => {
  it("keeps the page up when a realistic provider reconnects without its own getChainId", async () => {
    const failures: string[] = []
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason
      failures.push(reason instanceof Error ? reason.message : String(reason))
    }
    window.addEventListener("unhandledrejection", onRejection)
    installProvider()
    renderProbe()
    await waitFor(() => expect(screen.getByTestId("probe-status").textContent).toBe("disconnected"))
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() => expect(screen.getByTestId("probe-status").textContent).toContain("connected 84532 84532"))

    resetMemory()
    await reconnect(wagmiConfig)

    await waitFor(() => expect(screen.getByTestId("probe-status").textContent).toContain("connected 84532 84532"))
    expect(screen.getByRole("heading", { name: "Agent-BV (Agent Bot Verifier)" })).toBeTruthy()
    expect(failures.join("\n")).not.toContain("getChainId is not a function")
    window.removeEventListener("unhandledrejection", onRejection)
  })

  it("stays up when a reload restores a connector that has no methods", async () => {
    const failures: string[] = []
    const onError = (event: ErrorEvent) => {
      failures.push(event.error instanceof Error ? event.error.message : event.message)
    }
    window.addEventListener("error", onError)
    installProvider()
    wagmiConfig.setState((current) => ({
      ...current,
      chainId: 84532,
      status: "connected",
      current: "plain",
      connections: new Map([
        [
          "plain",
          {
            accounts: [ACCOUNT],
            chainId: 84532,
            connector: { id: "injected", name: "Injected", type: "injected", uid: "plain" } as never,
          },
        ],
      ]),
    }))
    renderProbe()
    await waitFor(() => expect(screen.getByTestId("probe-status").textContent).toContain("connected"))
    expect(screen.getByRole("heading", { name: "Agent-BV (Agent Bot Verifier)" })).toBeTruthy()
    expect(failures.join("\n")).not.toContain("getChainId is not a function")
    window.removeEventListener("error", onError)
  })
})
