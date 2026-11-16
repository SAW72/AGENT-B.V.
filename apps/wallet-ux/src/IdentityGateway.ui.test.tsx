// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Address } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AGENT_ID_DECIMAL_TEXT, type IdentityRecord } from "./identity8004"
import { IdentityGateway } from "./IdentityGateway"
import type { SepoliaClient } from "./read"

const ZERO = "0x0000000000000000000000000000000000000000" as Address

const { readAgentIdentity } = vi.hoisted(() => ({
  readAgentIdentity: vi.fn(),
}))

vi.mock("./identity8004", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./identity8004")>()
  return {
    ...actual,
    readAgentIdentity,
  }
})

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
    useConnect: () => ({ connect: vi.fn(), connectors: [], isPending: false, error: null }),
    useDisconnect: () => ({ disconnect: vi.fn() }),
  }
})

function record(agentId: bigint): IdentityRecord {
  return {
    agentId,
    owner: ZERO,
    agentWallet: ZERO,
    agentURI: "",
    implementation: ZERO,
    implementationMatches: true,
    registryDomain: {
      name: "agent-bv",
      version: "1",
      chainId: 84532n,
      verifyingContract: ZERO,
    },
    registryDomainMatches: true,
  }
}

function renderGateway() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <IdentityGateway client={{} as SepoliaClient} readsEnabled readsPending={false} blockedReason={null} />
    </QueryClientProvider>,
  )
}

// happy-dom strips newlines from an input's native value. Keep the typed string,
// including "15\n", so the change handler sees what was typed.
function typeAgentId(value: string): HTMLInputElement {
  const input = screen.getByTestId("agent-id")
  if (!(input instanceof HTMLInputElement)) throw new Error("agent-id is not an input")
  let typed = value
  Object.defineProperty(input, "value", {
    configurable: true,
    get() {
      return typed
    },
    set(next: string) {
      typed = String(next)
    },
  })
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  return input
}

beforeEach(() => {
  window.history.replaceState(null, "", "/")
  readAgentIdentity.mockReset()
  readAgentIdentity.mockImplementation(async (_client: unknown, agentId: bigint) => record(agentId))
})

afterEach(() => {
  cleanup()
})

describe("IdentityGateway agent id", () => {
  it("trims whitespace and a trailing newline before lookup and keeps the typed text", async () => {
    for (const value of [" 15 ", "15\n"]) {
      readAgentIdentity.mockClear()
      renderGateway()
      const input = typeAgentId(value)
      expect(input.value).toBe(value)
      await waitFor(() => {
        expect(readAgentIdentity).toHaveBeenCalledWith(expect.anything(), 15n)
      })
      expect(screen.queryByText(AGENT_ID_DECIMAL_TEXT)).toBeNull()
      cleanup()
    }
  })

  it("still shows the decimal error for 1.5 and does not read the registry", async () => {
    renderGateway()
    const input = typeAgentId("1.5")
    expect(input.value).toBe("1.5")
    expect(screen.getByText(AGENT_ID_DECIMAL_TEXT)).toBeTruthy()
    await act(async () => {
      await Promise.resolve()
    })
    expect(readAgentIdentity).not.toHaveBeenCalled()
  })
})
