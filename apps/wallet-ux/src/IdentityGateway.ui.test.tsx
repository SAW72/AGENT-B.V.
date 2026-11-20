// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Address } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { AGENT_ID_DECIMAL_TEXT, AGENT_ID_RANGE_TEXT, type IdentityRecord } from "./identity8004"
import { IdentityGateway } from "./IdentityGateway"
import type { SepoliaClient } from "./read"

const ZERO = "0x0000000000000000000000000000000000000000" as Address
const AGENT_WALLET = "0x1111111111111111111111111111111111111111" as Address
const OTHER_WALLET = "0x2222222222222222222222222222222222222222" as Address

const { readAgentIdentity, wallet } = vi.hoisted(() => ({
  readAgentIdentity: vi.fn(),
  wallet: {
    isConnected: false,
    address: undefined as Address | undefined,
    chainId: undefined as number | undefined,
  },
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
      isConnected: wallet.isConnected,
      address: wallet.address,
      chainId: wallet.chainId,
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

function signButton(): HTMLButtonElement | null {
  const found = screen.queryByTestId("identity-sign")
  if (found == null) return null
  if (!(found instanceof HTMLButtonElement)) throw new Error("identity-sign is not a button")
  return found
}

function expectNoEnabledSignButton() {
  const button = signButton()
  if (button == null) {
    expect(screen.queryByTestId("identity-sign")).toBeNull()
    return
  }
  expect(button.disabled).toBe(true)
}

beforeEach(() => {
  window.history.replaceState(null, "", "/")
  wallet.isConnected = false
  wallet.address = undefined
  wallet.chainId = undefined
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

  it("shows the range error for 79 digits and for 2^256 and does not offer an enabled sign button", async () => {
    const two256 = (1n << 256n).toString()
    for (const value of ["1".repeat(79), two256]) {
      readAgentIdentity.mockClear()
      renderGateway()
      typeAgentId(value)
      expect(screen.getByText(AGENT_ID_RANGE_TEXT)).toBeTruthy()
      expectNoEnabledSignButton()
      await act(async () => {
        await Promise.resolve()
      })
      expect(readAgentIdentity).not.toHaveBeenCalled()
      cleanup()
    }
  })

  it("renders a disabled sign button when the connected wallet is not the agent wallet", async () => {
    wallet.isConnected = true
    wallet.address = OTHER_WALLET
    wallet.chainId = BASE_SEPOLIA_CHAIN_ID
    readAgentIdentity.mockImplementation(async (_client: unknown, agentId: bigint) => ({
      ...record(agentId),
      agentWallet: AGENT_WALLET,
    }))
    renderGateway()
    typeAgentId("15")
    await waitFor(() => {
      expect(readAgentIdentity).toHaveBeenCalledWith(expect.anything(), 15n)
      expect(signButton()).not.toBeNull()
    })
    const button = signButton()
    if (button == null) throw new Error("identity-sign was not rendered")
    expect(button.disabled).toBe(true)
  })

  it("leaves no enabled sign button after a valid id is replaced with an invalid one", async () => {
    wallet.isConnected = true
    wallet.address = OTHER_WALLET
    wallet.chainId = BASE_SEPOLIA_CHAIN_ID
    readAgentIdentity.mockImplementation(async (_client: unknown, agentId: bigint) => ({
      ...record(agentId),
      agentWallet: AGENT_WALLET,
    }))
    renderGateway()
    typeAgentId("15")
    await waitFor(() => {
      const button = signButton()
      expect(button).not.toBeNull()
      expect(button?.disabled).toBe(true)
    })
    typeAgentId("1.5")
    await waitFor(() => {
      expect(screen.getByText(AGENT_ID_DECIMAL_TEXT)).toBeTruthy()
      expectNoEnabledSignButton()
    })
    typeAgentId("1".repeat(79))
    await waitFor(() => {
      expect(screen.getByText(AGENT_ID_RANGE_TEXT)).toBeTruthy()
      expectNoEnabledSignButton()
    })
  })
})
