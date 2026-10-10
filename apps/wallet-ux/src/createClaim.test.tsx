// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { decodeFunctionData, getAddress, type Address, type Hex } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { escrowAbi } from "./abi"
import { App } from "./App"
import { ADDRESSES, BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { FORM_ERRORS } from "./submit"

const ACCOUNT = "0x6dBe4B1c56494Ee00d6f97FFE9f853F42299D6Ac" as Address
const CLAIM = "0xb59bc20615394ea19f212ebc51ba457710829ae197b8686fb2406b201a7a461b" as Hex
const PAYEE = "0x6C756dacfEcEeA12D5D39536d2eCC175f18bc5A4" as Address
const PAYER_BOT = "0x2c2859b9e712890799696d217e9fe2eec1151822ed1b7168785b38991dc42637" as Hex
const PAYEE_BOT = "0xc62c848cf38434b66945ed12b266365ef9390b0281b0ca6bc20ba7ab46a06d2f" as Hex
const ZERO = "0x0000000000000000000000000000000000000000" as Address

const { world, publicClient } = vi.hoisted(() => ({
  world: { explode: null as string | null },
  publicClient: {
    getChainId: async () => 84532,
    getCode: async () => "0x60016000",
    call: async () => ({ data: "0x" }),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "isArbitrator") return false
      if (functionName === "pendingWithdrawals") return 0n
      if (functionName === "PANEL_SIZE") return 3n
      if (functionName === "voted") return false
      if (functionName === "disputes") {
        return [
          `0x${"11".repeat(32)}`,
          "0x0000000000000000000000000000000000000001",
          "",
          0n,
          0n,
          false,
          false,
          0n,
        ]
      }
      return 0n
    },
  },
}))

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

vi.mock("./preview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./preview")>()
  return {
    ...actual,
    previewCreateEscrow: (input: Parameters<typeof actual.previewCreateEscrow>[0]) => {
      if (world.explode) throw new Error(world.explode)
      return actual.previewCreateEscrow(input)
    },
  }
})

vi.mock("./read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./read")>()
  return {
    ...actual,
    createSepoliaClient: () => publicClient,
    readGateStatus: async () => ({
      chainId: BASE_SEPOLIA_CHAIN_ID,
      denylist: { owner: ZERO, pendingOwner: ZERO },
      vault: { owner: ZERO, pendingOwner: ZERO, denylist: ADDRESSES.denylist },
      disputePanel: { owner: ZERO, arbitratorCount: 0n, panelSize: 3n },
      liability: { owner: ZERO, insurance: ADDRESSES.insuranceFund, nativeBalanceWei: 0n },
      insuranceFund: {
        owner: ZERO,
        liability: ADDRESSES.liability,
        recordedBalanceWei: 0n,
        nativeBalanceWei: 0n,
      },
      escrow: {
        owner: ZERO,
        pendingOwner: ZERO,
        governance: ZERO,
        disputePanel: ADDRESSES.disputePanel,
        denylist: ADDRESSES.denylist,
        vault: ADDRESSES.vault,
        lockedValueWei: 0n,
        nativeBalanceWei: 0n,
        fundingOpen: false,
      },
    }),
  }
})

const EXACT = {
  "Escrow ID": CLAIM,
  "Payee wallet": PAYEE,
  "Payer bot identifier": PAYER_BOT,
  "Payee bot identifier": PAYEE_BOT,
  "Amount in ETH": "0.001",
} as const

function renderApp() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  )
}

function createScope() {
  const form = document.getElementById("create-claim")
  if (!form) throw new Error("missing create-claim form")
  return within(form)
}

function fillCreate(values: Record<string, string>) {
  const scope = createScope()
  fireEvent.click(scope.getByRole("button", { name: "Use my own" }))
  for (const [label, value] of Object.entries(values)) {
    fireEvent.change(scope.getByLabelText(label), { target: { value } })
  }
  return scope
}

function duplicateIds(): string[] {
  const counts = new Map<string, number>()
  for (const el of document.querySelectorAll("[id]")) {
    if (!el.id) continue
    counts.set(el.id, (counts.get(el.id) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id, count]) => `${id} ×${count}`)
}

beforeEach(() => {
  world.explode = null
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 500 })),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("prepare this escrow", () => {
  it("shows a preview under the button for the reported Base Sepolia inputs", async () => {
    renderApp()
    await waitFor(() => {
      expect(screen.getByTestId("vote-arbitrator")).toBeTruthy()
    })
    expect(duplicateIds()).toEqual([])

    const scope = fillCreate(EXACT)
    fireEvent.click(scope.getByRole("button", { name: "Prepare this escrow" }))
    await waitFor(() => expect(scope.getByTestId("calldata-preview")).toBeTruthy())

    const preview = scope.getByTestId("calldata-preview")
    const button = scope.getByRole("button", { name: "Prepare this escrow" })
    expect(button.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(scope.queryByRole("alert")).toBeNull()
    expect(document.querySelectorAll('[data-testid="calldata-preview"]')).toHaveLength(1)
    expect(preview.textContent).toContain("This prepares a new escrow.")
    expect(preview.textContent).toContain("0.001 ETH")

    const calldata = preview.querySelector("pre")?.textContent
    if (!calldata) throw new Error("missing calldata")
    const decoded = decodeFunctionData({ abi: escrowAbi, data: calldata as Hex })
    expect(decoded.functionName).toBe("createEscrow")
    expect(decoded.args?.[0]).toBe(CLAIM)
    expect(getAddress(String(decoded.args?.[1]))).toBe(getAddress(PAYEE))
    expect(decoded.args?.[2]).toBe(PAYER_BOT)
    expect(decoded.args?.[3]).toBe(PAYEE_BOT)
    expect(decoded.args?.[4]).toBe(86400n)
  })

  it("accepts lowercase, mixed-case, and surrounding whitespace", async () => {
    renderApp()
    const payees = [
      `  ${PAYEE}  `,
      `  ${PAYEE.toLowerCase()}  `,
      `  0x${PAYEE.slice(2).toUpperCase()}  `,
    ]
    for (const payee of payees) {
      const scope = fillCreate({
        "Escrow ID": `  ${CLAIM.toUpperCase()} \n`,
        "Payee wallet": payee,
        "Payer bot identifier": `\t${PAYER_BOT} `,
        "Payee bot identifier": ` ${PAYEE_BOT.toUpperCase()}\n`,
        "Amount in ETH": " 0.001 ",
      })
      fireEvent.click(scope.getByRole("radio", { name: "Custom" }))
      fireEvent.change(scope.getByLabelText("Time window in seconds"), { target: { value: " 86400 " } })
      fireEvent.click(scope.getByRole("button", { name: "Prepare this escrow" }))
      await waitFor(() => expect(scope.getByTestId("calldata-preview")).toBeTruthy())

      const preview = scope.getByTestId("calldata-preview")
      expect(scope.queryByRole("alert")).toBeNull()
      const calldata = preview.querySelector("pre")?.textContent
      if (!calldata) throw new Error("missing calldata")
      const decoded = decodeFunctionData({ abi: escrowAbi, data: calldata as Hex })
      expect(decoded.functionName).toBe("createEscrow")
      expect(decoded.args?.[0]).toBe(CLAIM)
      expect(getAddress(String(decoded.args?.[1]))).toBe(getAddress(PAYEE))
      expect(decoded.args?.[4]).toBe(86400n)
      expect(preview.textContent).toContain("0.001 ETH")
    }
  })

  it("rejects a mixed-case payee with a bad checksum", async () => {
    renderApp()
    const scope = fillCreate({
      ...EXACT,
      "Payee wallet": "0x6C756dacfEcEeA12D5D39536d2eCC175f18bc5a4",
    })
    fireEvent.click(scope.getByRole("button", { name: "Prepare this escrow" }))
    await waitFor(() => expect(scope.getByRole("alert").textContent).toBe(FORM_ERRORS.payeeChecksum))
    fireEvent.change(scope.getByLabelText("Payee wallet"), { target: { value: "not-an-address" } })
    fireEvent.click(scope.getByRole("button", { name: "Prepare this escrow" }))
    await waitFor(() => expect(scope.getByRole("alert").textContent).toBe(FORM_ERRORS.payee))
    expect(scope.queryByTestId("calldata-preview")).toBeNull()
    expect(scope.queryByTestId("sepolia-submit")).toBeNull()
    expect(scope.queryByTestId("submit-refused")).toBeNull()
    expect(scope.queryByRole("button", { name: "Submit on Base Sepolia" })).toBeNull()
    expect(document.querySelector('[data-testid="calldata-preview"]')).toBeNull()
  })

  it("renders a validation error under the button instead of leaving the form blank", async () => {
    renderApp()
    const scope = createScope()
    fireEvent.click(scope.getByRole("button", { name: "Prepare this escrow" }))
    await waitFor(() => expect(scope.getByRole("alert")).toBeTruthy())
    const alert = scope.getByRole("alert")
    const button = scope.getByRole("button", { name: "Prepare this escrow" })
    expect(alert.textContent).toBe(FORM_ERRORS.createIds)
    expect(button.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(scope.queryByTestId("calldata-preview")).toBeNull()
  })

  it("shows an injected prepare failure under the button", async () => {
    world.explode = "encoder blew up"
    renderApp()
    const scope = fillCreate(EXACT)
    fireEvent.click(scope.getByRole("button", { name: "Prepare this escrow" }))
    await waitFor(() => expect(scope.getByRole("alert")).toBeTruthy())
    const alert = scope.getByRole("alert")
    expect(alert.textContent).toBe("Couldn't prepare this escrow: encoder blew up")
    expect(scope.queryByTestId("calldata-preview")).toBeNull()
    expect(document.querySelector('[data-testid="calldata-preview"]')).toBeNull()
  })

  it("keeps element ids unique across the rendered app", async () => {
    renderApp()
    await waitFor(() => {
      expect(document.getElementById("create-claim")).toBeTruthy()
      expect(document.getElementById("vote-form")).toBeTruthy()
      expect(document.getElementById("withdraw-form")).toBeTruthy()
    })
    expect(duplicateIds()).toEqual([])
  })
})
