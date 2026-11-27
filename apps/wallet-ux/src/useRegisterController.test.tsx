// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { encodeAbiParameters, encodeEventTopics, formatEther, getAddress, WaitForTransactionReceiptTimeoutError, type Address, type Hex } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { identityRegistry8004Abi } from "./abi"
import { WALLET_HINT_MS, WALLET_HINT_TEXT } from "./actionButton"
import { resetPendingStore } from "./pendingTx"
import { RegisterWizard } from "./RegisterWizard"
import { shortHex } from "./register/shortHex"
import { baseSepoliaAddChainParams, registryAddress } from "./registry/register"
import {
  CANCELLED,
  CHAIN_LEFT,
  CHECK_REGISTRATION,
  CONFIRM_IN_WALLET,
  CONNECT_REJECTED,
  CONNECT_WALLET,
  CONTINUE,
  CONTINUE_IDENTITY,
  DISCONNECTED,
  DROPPED,
  HUNG_PROMPT,
  OPEN_WIZARD,
  PASS_LINE,
  PENDING_TX,
  PICKING_UP,
  REPLACED_OTHER,
  REVIEW_AND_CONFIRM,
  SPED_UP,
  START_OVER,
  STILL_WAITING,
  SWITCH_TO_SEPOLIA,
  TAB_PASTE,
  WAITING_WALLET,
  basescanTxUrl,
  insufficientGas,
  ownsAfterReplacement,
  stayedOn,
  switchToOwner,
  walletOnChain,
  walletSwitched,
  ALREADY_PENDING,
} from "./registerCopy"
import { resetSubmitLock } from "./submitLock"
import { REGISTER_PENDING_KEY, REGISTER_PENDING_SLOW_MS, useRegisterController, type RegisterReader } from "./useRegisterController"
import { INSTALL_WALLET_HINT } from "./walletHint"

const ADDR = getAddress(`0x${"12".repeat(20)}`)
const OTHER = getAddress(`0x${"ab".repeat(20)}`)
const HASH_A = `0x${"cd".repeat(32)}` as Hex
const HASH_B = `0x${"ef".repeat(32)}` as Hex
const SEPOLIA_HEX = `0x${(84532).toString(16)}`
const MAINNET_HEX = `0x${(1).toString(16)}`
const BASE_MAINNET_HEX = `0x${(8453).toString(16)}`
const REGISTRATION = JSON.stringify({ type: "registration-v1", name: "Demo" })
const AGENT_URI = "data:application/json;base64,e30="
const GAS = 21_000n
const FEE = 1_000_000_000n

const wagmiHarness = vi.hoisted(() => {
  const sendTransactionAsync = vi.fn(async () => `0x${"cd".repeat(32)}` as `0x${string}`)
  const account = {
    address: undefined as `0x${string}` | undefined,
    isConnected: false,
    chainId: undefined as number | undefined,
    connector: undefined,
    status: "disconnected",
  }
  return { sendTransactionAsync, account }
})

vi.mock("wagmi", () => ({
  useAccount: () => wagmiHarness.account,
  useConnect: () => ({
    connectors: [{ id: "injected", name: "Injected" }],
    connectAsync: async () => {
      const eth = (window as Window & { ethereum?: { request: (args: { method: string }) => Promise<unknown> } }).ethereum
      if (!eth) throw Object.assign(new Error("no wallet"), { code: 4001 })
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[]
      const chain = (await eth.request({ method: "eth_chainId" })) as string
      const address = accounts[0]
      if (address) wagmiHarness.account.address = address as `0x${string}`
      wagmiHarness.account.isConnected = true
      wagmiHarness.account.chainId = Number.parseInt(chain, 16)
      wagmiHarness.account.status = "connected"
      return { accounts, chainId: wagmiHarness.account.chainId }
    },
  }),
  usePublicClient: () => null,
  useSendTransaction: () => ({ sendTransactionAsync: wagmiHarness.sendTransactionAsync, isPending: false }),
  useSwitchChain: () => ({ switchChain: () => undefined }),
  useWalletClient: () => ({ data: null }),
  useDisconnect: () => ({ disconnect: () => undefined }),
}))

type RequestLog = { method: string; params?: unknown }

type WaitArgs = {
  hash: Hex
  onReplaced?: (response: { reason: string; transaction: { hash: Hex } }) => void
}

class World {
  accounts: string[] = []
  chainId = SEPOLIA_HEX
  connectMode: "ok" | "reject" | "pending" = "ok"
  switchMode: "ok" | "reject" | "missing" = "ok"
  switchCalls = 0
  log: RequestLog[] = []
  count = 0n
  balance = 10n ** 18n
  provisional = 424242n
  listeners = new Map<string, Set<(payload: unknown) => void>>()
  wait = vi.fn(async (args: WaitArgs) => successReceipt(args.hash, ADDR))
  reader: RegisterReader

  constructor() {
    const world = this
    this.reader = {
      chain: { id: 84532 },
      simulateContract: vi.fn(async () => ({ result: world.provisional })),
      estimateGas: vi.fn(async () => GAS),
      readContract: vi.fn(async () => world.count),
      getBalance: vi.fn(async () => world.balance),
      estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: FEE })),
      waitForTransactionReceipt: (args: WaitArgs) => world.wait(args),
      getTransactionReceipt: vi.fn(async () => ({ status: "success" as const })),
      call: vi.fn(async () => ({ data: "0x" })),
    } as unknown as RegisterReader
  }

  install() {
    const world = this
    const ethereum = {
      async request(args: { method: string; params?: unknown }) {
        world.log.push({ method: args.method, params: args.params })
        if (args.method === "eth_accounts") return [...world.accounts]
        if (args.method === "eth_chainId") return world.chainId
        if (args.method === "eth_requestAccounts") {
          if (world.connectMode === "reject") throw codeError(4001)
          if (world.connectMode === "pending") throw codeError(-32002)
          world.accounts = [ADDR]
          return [...world.accounts]
        }
        if (args.method === "wallet_switchEthereumChain") {
          world.switchCalls += 1
          const requested = chainParam(args.params)
          if (world.switchMode === "reject") throw codeError(4001)
          if (world.switchMode === "missing" && world.switchCalls === 1) throw codeError(4902)
          if (requested) world.chainId = requested
          wagmiHarness.account.chainId = Number.parseInt(world.chainId, 16)
          return null
        }
        if (args.method === "wallet_addEthereumChain") {
          world.switchMode = "ok"
          return null
        }
        throw new Error(`unexpected ${args.method}`)
      },
      on(event: string, listener: (payload: unknown) => void) {
        const set = world.listeners.get(event) ?? new Set()
        set.add(listener)
        world.listeners.set(event, set)
      },
      removeListener(event: string, listener: (payload: unknown) => void) {
        world.listeners.get(event)?.delete(listener)
      },
    }
    ;(window as Window & { ethereum?: typeof ethereum }).ethereum = ethereum
  }

  emit(event: string, payload: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload)
  }

  methods(): string[] {
    return this.log.map((entry) => entry.method)
  }
}

function codeError(code: number): Error {
  return Object.assign(new Error(`wallet ${code}`), { code })
}

function chainParam(params: unknown): string | null {
  if (!Array.isArray(params)) return null
  const first = params[0]
  if (!first || typeof first !== "object" || !("chainId" in first)) return null
  const chainId = (first as { chainId?: unknown }).chainId
  return typeof chainId === "string" ? chainId : null
}

function registeredLog(agentId: bigint, owner: Address) {
  const topics = encodeEventTopics({
    abi: identityRegistry8004Abi,
    eventName: "Registered",
    args: { agentId, owner },
  }).filter((topic): topic is Hex => typeof topic === "string")
  const data = encodeAbiParameters([{ type: "string", name: "agentURI" }], [AGENT_URI])
  return { address: registryAddress(), topics, data }
}

function successReceipt(hash: Hex, owner: Address) {
  return {
    transactionHash: hash,
    status: "success",
    logs: [registeredLog(9001n, owner)],
  }
}

function Harness({ world, onRegistered }: { world: World; onRegistered: (id: string) => void }) {
  const wired = useRegisterController({ reader: world.reader, onRegistered })
  return (
    <>
      {wired.send}
      <RegisterWizard controller={wired.controller} onRegistered={onRegistered} />
    </>
  )
}

async function openPaste() {
  fireEvent.click(screen.getByRole("button", { name: OPEN_WIZARD }))
  fireEvent.click(screen.getByRole("tab", { name: TAB_PASTE }))
  fireEvent.change(screen.getByTestId("register-paste"), { target: { value: REGISTRATION } })
  fireEvent.click(screen.getByRole("button", { name: CHECK_REGISTRATION }))
  await screen.findByText(PASS_LINE)
}

async function connectWallet() {
  fireEvent.click(screen.getByRole("button", { name: CONNECT_WALLET }))
  await screen.findByRole("button", { name: CONTINUE })
}

async function reachDryRun() {
  await openPaste()
  await connectWallet()
  fireEvent.click(screen.getByRole("button", { name: CONTINUE }))
  await screen.findByTestId("provisional-id")
}

async function reachConfirm() {
  await reachDryRun()
  fireEvent.click(screen.getByRole("button", { name: REVIEW_AND_CONFIRM }))
  await screen.findByTestId("step-confirm")
  fireEvent.click(screen.getByTestId("register-ack"))
}

function switchChainIds(world: World): string[] {
  return world.log.filter((entry) => entry.method === "wallet_switchEthereumChain" || entry.method === "wallet_addEthereumChain").map((entry) => chainParam(entry.params) ?? "")
}

describe("register wizard wallet states", () => {
  let world: World

  beforeEach(() => {
    world = new World()
    wagmiHarness.account.address = undefined
    wagmiHarness.account.isConnected = false
    wagmiHarness.account.chainId = undefined
    wagmiHarness.account.status = "disconnected"
    wagmiHarness.sendTransactionAsync.mockReset()
    wagmiHarness.sendTransactionAsync.mockImplementation(async () => HASH_A)
    sessionStorage.clear()
    localStorage.clear()
    resetSubmitLock()
    resetPendingStore()
    world.install()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    sessionStorage.clear()
    localStorage.clear()
    resetSubmitLock()
    resetPendingStore()
    delete (window as Window & { ethereum?: unknown }).ethereum
  })

  it("reads accounts and chain on load and does not request the wallet", async () => {
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await waitFor(() => {
      expect(world.methods()).toContain("eth_accounts")
      expect(world.methods()).toContain("eth_chainId")
    })
    expect(world.methods().every((method) => method === "eth_accounts" || method === "eth_chainId")).toBe(true)
    expect(wagmiHarness.sendTransactionAsync).not.toHaveBeenCalled()
  })

  it("shows the install hint when no wallet is injected", async () => {
    delete (window as Window & { ethereum?: unknown }).ethereum
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await openPaste()
    fireEvent.click(screen.getByRole("button", { name: CONNECT_WALLET }))
    expect(screen.getByText(INSTALL_WALLET_HINT).textContent).toBe(INSTALL_WALLET_HINT)
    expect(world.methods()).not.toContain("eth_requestAccounts")
  })

  it("shows the connect rejection and shares nothing", async () => {
    world.connectMode = "reject"
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await openPaste()
    fireEvent.click(screen.getByRole("button", { name: CONNECT_WALLET }))
    expect(await screen.findByText(CONNECT_REJECTED)).toBeTruthy()
    expect(world.methods().filter((method) => method === "eth_requestAccounts")).toEqual(["eth_requestAccounts"])
  })

  it("does not send a second connect request when one is already open", async () => {
    world.connectMode = "pending"
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await openPaste()
    fireEvent.click(screen.getByRole("button", { name: CONNECT_WALLET }))
    expect(await screen.findByText(ALREADY_PENDING)).toBeTruthy()
    const button = screen.getByRole("button", { name: WAITING_WALLET })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(world.methods().filter((method) => method === "eth_requestAccounts")).toEqual(["eth_requestAccounts"])
  })

  it("stays on the current chain when the switch is rejected", async () => {
    world.chainId = BASE_MAINNET_HEX
    world.switchMode = "reject"
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await openPaste()
    await connectWallet()
    fireEvent.click(screen.getByRole("button", { name: CONTINUE }))
    fireEvent.click(await screen.findByRole("button", { name: SWITCH_TO_SEPOLIA }))
    expect(await screen.findByText(stayedOn("chain 8453"))).toBeTruthy()
    expect(switchChainIds(world)).toEqual([SEPOLIA_HEX])
    expect(world.chainId).toBe(BASE_MAINNET_HEX)
    expect(wagmiHarness.sendTransactionAsync).not.toHaveBeenCalled()
  })

  it("adds Base Sepolia when the wallet does not have it, then switches once", async () => {
    world.chainId = `0x${(99).toString(16)}`
    world.switchMode = "missing"
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await openPaste()
    await connectWallet()
    fireEvent.click(screen.getByRole("button", { name: CONTINUE }))
    fireEvent.click(await screen.findByRole("button", { name: SWITCH_TO_SEPOLIA }))
    expect(await screen.findByTestId("provisional-id")).toBeTruthy()
    const added = world.log.find((entry) => entry.method === "wallet_addEthereumChain")
    expect(added?.params).toEqual([baseSepoliaAddChainParams])
    expect(switchChainIds(world).every((chainId) => chainId === SEPOLIA_HEX)).toBe(true)
    expect(switchChainIds(world)).not.toContain(MAINNET_HEX)
    expect(switchChainIds(world)).not.toContain(BASE_MAINNET_HEX)
    expect(world.switchCalls).toBe(2)
    expect(wagmiHarness.sendTransactionAsync).not.toHaveBeenCalled()
  })

  it("refuses Base mainnet and only offers the Sepolia switch", async () => {
    world.chainId = BASE_MAINNET_HEX
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await openPaste()
    await connectWallet()
    fireEvent.click(screen.getByRole("button", { name: CONTINUE }))
    expect(await screen.findByText(walletOnChain("chain 8453"))).toBeTruthy()
    expect(screen.queryByText(/mainnet/i)).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: SWITCH_TO_SEPOLIA }))
    await screen.findByTestId("provisional-id")
    expect(switchChainIds(world)).toEqual([SEPOLIA_HEX])
  })

  it("disables confirm when the wallet cannot pay for gas", async () => {
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await reachConfirm()
    world.balance = 0n
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_IN_WALLET }))
    const needed = (GAS * FEE * 120n) / 100n
    expect(await screen.findByText(insufficientGas(`${formatEther(needed)} test ETH`, `${formatEther(0n)} test ETH`))).toBeTruthy()
    expect((screen.getByRole("button", { name: CONFIRM_IN_WALLET }) as HTMLButtonElement).disabled).toBe(true)
    expect(wagmiHarness.sendTransactionAsync).not.toHaveBeenCalled()
  })

  it("returns to the dry run when the account changes before send", async () => {
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await reachDryRun()
    act(() => world.emit("accountsChanged", [OTHER]))
    expect(await screen.findByText(walletSwitched(shortHex(OTHER)))).toBeTruthy()
    expect(screen.queryByTestId("provisional-id")).toBeNull()
    expect((screen.getByRole("button", { name: REVIEW_AND_CONFIRM }) as HTMLButtonElement).disabled).toBe(true)

    cleanup()
    world = new World()
    world.install()
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await reachConfirm()
    act(() => world.emit("accountsChanged", [OTHER]))
    expect(await screen.findByText(walletSwitched(shortHex(OTHER)))).toBeTruthy()
    expect(screen.queryByTestId("step-confirm")).toBeNull()
    expect(screen.getByTestId("step-dry-run")).toBeTruthy()
  })

  it("returns to the dry run when the chain changes before send", async () => {
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await reachDryRun()
    act(() => world.emit("chainChanged", MAINNET_HEX))
    expect(await screen.findByText(CHAIN_LEFT)).toBeTruthy()
    expect(screen.getByText(walletOnChain("chain 1"))).toBeTruthy()
    expect((screen.getByRole("button", { name: REVIEW_AND_CONFIRM }) as HTMLButtonElement).disabled).toBe(true)

    cleanup()
    world = new World()
    world.install()
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await reachConfirm()
    act(() => world.emit("chainChanged", MAINNET_HEX))
    expect(await screen.findByText(CHAIN_LEFT)).toBeTruthy()
    expect(screen.queryByTestId("step-confirm")).toBeNull()
  })

  it("reads the chain again on confirm and does not send off Base Sepolia", async () => {
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await reachConfirm()
    world.chainId = BASE_MAINNET_HEX
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_IN_WALLET }))
    expect(await screen.findByText(walletOnChain("chain 8453"))).toBeTruthy()
    expect(wagmiHarness.sendTransactionAsync).not.toHaveBeenCalled()
    expect(world.methods()).not.toContain("eth_sendTransaction")
  })

  it("shows the send rejection and sends nothing", async () => {
    wagmiHarness.sendTransactionAsync.mockRejectedValueOnce(Object.assign(new Error("rejected"), { code: 4001 }))
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await reachConfirm()
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_IN_WALLET }))
    expect(await screen.findByText("You rejected the transaction. Nothing was sent.")).toBeTruthy()
    expect(wagmiHarness.sendTransactionAsync).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("step-done")).toBeNull()
  })

  it("sends exactly once for a double click and a re-render", async () => {
    let release: (hash: Hex) => void = () => undefined
    wagmiHarness.sendTransactionAsync.mockImplementation(() => new Promise<Hex>((resolve) => { release = resolve }))
    const view = render(<Harness world={world} onRegistered={vi.fn()} />)
    await reachConfirm()
    const button = screen.getByRole("button", { name: CONFIRM_IN_WALLET })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(wagmiHarness.sendTransactionAsync).toHaveBeenCalledTimes(1))
    view.rerender(<Harness world={world} onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: WAITING_WALLET }))
    expect(wagmiHarness.sendTransactionAsync).toHaveBeenCalledTimes(1)
    expect(world.methods()).not.toContain("eth_sendTransaction")
    await act(async () => {
      release(HASH_A)
    })
  })

  it("follows a sped-up transaction and takes the id from the registry event", async () => {
    let release: (receipt: ReturnType<typeof successReceipt>) => void = () => undefined
    let calls = 0
    world.wait.mockImplementation(async (args: { hash: Hex; onReplaced?: (response: { reason: string; transaction: { hash: Hex } }) => void }) => {
      calls += 1
      if (calls === 1) {
        args.onReplaced?.({ reason: "repriced", transaction: { hash: HASH_B } })
        return { transactionHash: args.hash, status: "success", logs: [] }
      }
      return new Promise((resolve) => {
        release = resolve
      })
    })
    const onRegistered = vi.fn()
    render(<Harness world={world} onRegistered={onRegistered} />)
    await reachConfirm()
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_IN_WALLET }))
    expect(await screen.findByText(SPED_UP)).toBeTruthy()
    expect(document.querySelector(`a[href="${basescanTxUrl(HASH_B)}"]`)).toBeTruthy()
    expect(document.querySelector(`a[href="${basescanTxUrl(HASH_A)}"]`)).toBeNull()
    await act(async () => {
      release(successReceipt(HASH_B, ADDR))
    })
    expect((await screen.findByTestId("final-agent-id")).textContent).toBe("9001")
    expect(screen.getByTestId("final-agent-id").textContent).not.toBe(world.provisional.toString())
    expect(onRegistered).toHaveBeenCalledWith("9001")
    expect(onRegistered).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: CONTINUE_IDENTITY }))
    // confirm prefill, then hook onContinueToIdentity, then RegisterWizard onRegistered
    expect(onRegistered).toHaveBeenCalledTimes(3)
    expect(onRegistered.mock.calls.every((call) => call[0] === "9001")).toBe(true)
  })

  it("reports a replaced transaction and warns when the wallet owns more agents", async () => {
    world.count = 1n
    world.wait.mockImplementation(async (args: { onReplaced?: (response: { reason: string; transaction: { hash: Hex } }) => void }) => {
      args.onReplaced?.({ reason: "replaced", transaction: { hash: HASH_B } })
      return successReceipt(HASH_A, ADDR)
    })
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await reachConfirm()
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_IN_WALLET }))
    expect(await screen.findByText(REPLACED_OTHER)).toBeTruthy()
    world.count = 2n
    fireEvent.click(screen.getByRole("button", { name: START_OVER }))
    expect(await screen.findByText(ownsAfterReplacement(2n))).toBeTruthy()
    expect(screen.getByText(REPLACED_OTHER)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: START_OVER }))
    expect(await screen.findByTestId("step-file")).toBeTruthy()
  })

  it("reports a cancelled transaction with start over", async () => {
    world.wait.mockImplementation(async (args: { onReplaced?: (response: { reason: string; transaction: { hash: Hex } }) => void }) => {
      args.onReplaced?.({ reason: "cancelled", transaction: { hash: HASH_B } })
      return successReceipt(HASH_A, ADDR)
    })
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await reachConfirm()
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_IN_WALLET }))
    expect(await screen.findByText(CANCELLED)).toBeTruthy()
    expect(screen.getByRole("button", { name: START_OVER })).toBeTruthy()
    expect(wagmiHarness.sendTransactionAsync).toHaveBeenCalledTimes(1)
  })

  it("reports a dropped transaction and does not treat a timeout as dropped", async () => {
    world.wait.mockImplementation(async (args: { hash: Hex; onReplaced?: (response: { reason: string; transaction: { hash: Hex } }) => void }) => {
      args.onReplaced?.({ reason: "dropped", transaction: { hash: HASH_B } })
      return successReceipt(args.hash, ADDR)
    })
    const view = render(<Harness world={world} onRegistered={vi.fn()} />)
    await reachConfirm()
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_IN_WALLET }))
    expect(await screen.findByText(DROPPED)).toBeTruthy()
    expect(screen.getByRole("button", { name: START_OVER })).toBeTruthy()

    cleanup()
    view.unmount()
    wagmiHarness.sendTransactionAsync.mockClear()
    world = new World()
    world.install()
    let waits = 0
    world.wait.mockImplementation((args: { hash: Hex }) => {
      waits += 1
      if (waits === 1) throw new WaitForTransactionReceiptTimeoutError({ hash: args.hash })
      return new Promise(() => undefined)
    })
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await reachConfirm()
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_IN_WALLET }))
    expect(await screen.findByText(STILL_WAITING)).toBeTruthy()
    expect(screen.queryByText(DROPPED)).toBeNull()
    expect(screen.getByText(PENDING_TX)).toBeTruthy()
    expect(wagmiHarness.sendTransactionAsync).toHaveBeenCalledTimes(1)
  })

  it("keeps tracking the hash when the account or chain changes after send", async () => {
    let release: (receipt: ReturnType<typeof successReceipt>) => void = () => undefined
    world.wait.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await reachConfirm()
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_IN_WALLET }))
    expect(await screen.findByText(PENDING_TX)).toBeTruthy()
    act(() => world.emit("accountsChanged", [OTHER]))
    expect(screen.getByTestId("step-done")).toBeTruthy()
    expect(document.querySelector(`a[href="${basescanTxUrl(HASH_A)}"]`)).toBeTruthy()
    act(() => world.emit("chainChanged", MAINNET_HEX))
    expect(screen.queryByText(CHAIN_LEFT)).toBeNull()
    expect(screen.getByText(PENDING_TX)).toBeTruthy()
    await act(async () => {
      release(successReceipt(HASH_A, ADDR))
    })
    expect(await screen.findByText(switchToOwner(shortHex(ADDR)))).toBeTruthy()
    expect(screen.getByRole("button", { name: CONTINUE_IDENTITY })).toBeTruthy()
    expect(screen.getByTestId("final-agent-id").textContent).toBe("9001")
  })

  it("keeps tracking after the wallet disconnects", async () => {
    let release: (receipt: ReturnType<typeof successReceipt>) => void = () => undefined
    world.wait.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await reachConfirm()
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_IN_WALLET }))
    expect(await screen.findByText(PENDING_TX)).toBeTruthy()
    act(() => world.emit("accountsChanged", []))
    expect(screen.getByText(DISCONNECTED)).toBeTruthy()
    expect(screen.getByText(PENDING_TX)).toBeTruthy()
    expect(wagmiHarness.sendTransactionAsync).toHaveBeenCalledTimes(1)
    await act(async () => {
      release(successReceipt(HASH_A, ADDR))
    })
    expect((await screen.findByTestId("final-agent-id")).textContent).toBe("9001")
  })

  it("resumes a stored transaction without asking the wallet again", async () => {
    world.accounts = [ADDR]
    let release: (receipt: ReturnType<typeof successReceipt>) => void = () => undefined
    world.wait.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    sessionStorage.setItem(REGISTER_PENDING_KEY, JSON.stringify({
      chainId: 84532,
      from: ADDR,
      hash: HASH_A,
      uriHash: `0x${"12".repeat(32)}`,
      startedAt: Date.now(),
      existingCount: "0",
    }))
    render(<Harness world={world} onRegistered={vi.fn()} />)
    expect(await screen.findByText(PICKING_UP)).toBeTruthy()
    expect(document.querySelector(`a[href="${basescanTxUrl(HASH_A)}"]`)).toBeTruthy()
    await waitFor(() => expect(world.wait).toHaveBeenCalled())
    expect(world.methods().every((method) => method === "eth_accounts" || method === "eth_chainId")).toBe(true)
    expect(wagmiHarness.sendTransactionAsync).not.toHaveBeenCalled()
    await act(async () => {
      release(successReceipt(HASH_A, ADDR))
    })
    expect((await screen.findByTestId("final-agent-id")).textContent).toBe("9001")
  })

  it("shows the slow notice for an old pending transaction without calling it dropped", async () => {
    world.wait.mockImplementation(() => new Promise(() => undefined))
    sessionStorage.setItem(REGISTER_PENDING_KEY, JSON.stringify({
      chainId: 84532,
      from: ADDR,
      hash: HASH_A,
      uriHash: `0x${"12".repeat(32)}`,
      startedAt: Date.now() - REGISTER_PENDING_SLOW_MS - 1,
      existingCount: "0",
    }))
    render(<Harness world={world} onRegistered={vi.fn()} />)
    expect(await screen.findByText(STILL_WAITING)).toBeTruthy()
    expect(screen.getByText(PICKING_UP)).toBeTruthy()
    expect(screen.queryByText(DROPPED)).toBeNull()
    expect(wagmiHarness.sendTransactionAsync).not.toHaveBeenCalled()
  })

  it("shows the wallet hint while the prompt is open and never a reset", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let release: (hash: Hex) => void = () => undefined
    wagmiHarness.sendTransactionAsync.mockImplementation(() => new Promise<Hex>((resolve) => { release = resolve }))
    render(<Harness world={world} onRegistered={vi.fn()} />)
    await reachConfirm()
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_IN_WALLET }))
    expect(await screen.findByText(WALLET_HINT_TEXT)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /reset|try again/i })).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WALLET_HINT_MS)
    })
    expect(screen.getByText(HUNG_PROMPT)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /reset|try again/i })).toBeNull()
    expect(wagmiHarness.sendTransactionAsync).toHaveBeenCalledTimes(1)
    await act(async () => {
      release(HASH_A)
    })
  })
})
