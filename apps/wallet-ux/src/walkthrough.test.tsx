// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { FirstRun } from "./firstRun"
import { Stepper } from "./steps"
import {
  CONNECT_NOTE,
  TEST_ETH_NOTE,
  WALKTHROUGH_LABELS,
  WRONG_NETWORK_NOTE,
  journeyNow,
  walkthroughStates,
  walkthroughStep,
  walletReadiness,
  type WalkthroughState,
} from "./walkthrough"

const { switchChain, connect } = vi.hoisted(() => ({
  switchChain: vi.fn(),
  connect: vi.fn(),
}))

const world = {
  connected: false,
  chainId: 84532 as number | undefined,
}

vi.mock("wagmi", () => ({
  useAccount: () => ({
    isConnected: world.connected,
    address: world.connected ? "0x6dBe4B1c56494Ee00d6f97FFE9f853F42299D6Ac" : undefined,
    chainId: world.connected ? world.chainId : undefined,
    connector: undefined,
  }),
  useConnect: () => ({
    connect,
    connectors: [{ id: "injected", name: "Injected", type: "injected", uid: "injected" }],
    isPending: false,
    error: null,
  }),
  useSwitchChain: () => ({ switchChain, isPending: false, error: null }),
}))

function statesOf(scope: HTMLElement): string[] {
  return within(scope).getAllByRole("listitem").map((item) => item.getAttribute("data-step-state") ?? "")
}

function expectOneCurrent(states: readonly WalkthroughState[]) {
  expect(states.filter((state) => state === "current")).toHaveLength(1)
  const current = states.indexOf("current")
  expect(states.slice(0, current).every((state) => state === "done")).toBe(true)
  expect(states.slice(current + 1).every((state) => state === "upcoming")).toBe(true)
}

afterEach(() => {
  cleanup()
  world.connected = false
  world.chainId = 84532
  switchChain.mockClear()
  connect.mockClear()
})

describe("walkthrough states", () => {
  it("treats a missing or conflicting chain as the wrong network", () => {
    expect(walletReadiness(false, BASE_SEPOLIA_CHAIN_ID)).toBe("disconnected")
    expect(walletReadiness(false, null)).toBe("disconnected")
    expect(walletReadiness(true, BASE_SEPOLIA_CHAIN_ID)).toBe("ready")
    expect(walletReadiness(true, 1)).toBe("wrong-network")
    expect(walletReadiness(true, null)).toBe("wrong-network")
    expect(walletReadiness(true, "conflict")).toBe("wrong-network")
  })

  it("keeps exactly one current step, with done before it and upcoming after it", () => {
    const cases = [
      walkthroughStates("disconnected", "home"),
      walkthroughStates("wrong-network", "funding"),
      walkthroughStates("ready", "home"),
      walkthroughStates("ready", "funding"),
      walkthroughStates("ready", "review"),
    ] as const
    for (const states of cases) expectOneCurrent(states)
    expect(walkthroughStates("disconnected", "review")).toEqual(["current", "upcoming", "upcoming"])
    expect(walkthroughStates("ready", "home")).toEqual(["done", "current", "upcoming"])
    expect(walkthroughStates("ready", "review")).toEqual(["done", "done", "current"])
    expect(walkthroughStep(walkthroughStates("ready", "review"))).toBe(3)
    expect(journeyNow("wrong-network", "funding")).toBe("Now · Connect your wallet")
    expect(journeyNow("ready", "home")).toBe("Now · Fund an escrow")
    expect(journeyNow("ready", "review")).toBe("Now · Send the first transaction")
    expect(WALKTHROUGH_LABELS).toEqual(["Connect your wallet", "Fund an escrow", "Send the first transaction"])
  })

  it("keeps an unlabelled stepper on numbered state words", () => {
    render(<Stepper step={2} total={3} />)
    const dots = screen.getAllByRole("listitem")
    expect(statesOf(document.body)).toEqual(["done", "current", "upcoming"])
    expect(dots.map((dot) => dot.querySelector(".step-dot-word")?.textContent)).toEqual(["Done 1", "Now 2", "Later 3"])
    expect(dots[1]?.getAttribute("aria-current")).toBe("step")
    expect(dots[0]?.getAttribute("aria-current")).toBeNull()
  })

  it("asks a disconnected visitor to connect, and nothing else", () => {
    render(<FirstRun />)
    const card = screen.getByTestId("first-run")
    expect(statesOf(card)).toEqual(["current", "upcoming", "upcoming"])
    expect(within(card).getAllByRole("listitem")[0]?.querySelector(".step-dot-word")?.textContent).toBe("Now · Connect your wallet")
    expect(screen.getByTestId("connect-note").textContent).toBe(CONNECT_NOTE)
    expect(screen.getByTestId("journey-connect").textContent).toBe("Connect wallet")
    expect(screen.getAllByRole("button")).toHaveLength(1)
    expect(screen.queryByTestId("journey-switch")).toBeNull()
    expect(screen.queryByTestId("journey-fund")).toBeNull()
    expect(screen.queryByTestId("wrong-network-note")).toBeNull()
    expect(screen.queryByTestId("test-eth-note")).toBeNull()
    fireEvent.click(screen.getByTestId("journey-connect"))
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it("asks a wrong-network visitor to switch to Base Sepolia", () => {
    world.connected = true
    world.chainId = 1
    render(<FirstRun />)
    const card = screen.getByTestId("first-run")
    expect(statesOf(card)).toEqual(["current", "upcoming", "upcoming"])
    expect(screen.getByTestId("wrong-network-note").textContent).toBe(WRONG_NETWORK_NOTE)
    expect(screen.queryByTestId("journey-connect")).toBeNull()
    expect(screen.queryByTestId("journey-fund")).toBeNull()
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull()
    fireEvent.click(screen.getByTestId("journey-switch"))
    expect(switchChain).toHaveBeenCalledWith({ chainId: BASE_SEPOLIA_CHAIN_ID })
  })

  it("offers fund as the only primary action once the wallet is on Base Sepolia", () => {
    world.connected = true
    render(<FirstRun />)
    const card = screen.getByTestId("first-run")
    expect(statesOf(card)).toEqual(["done", "current", "upcoming"])
    expect(within(card).getAllByRole("listitem").map((item) => item.querySelector(".step-dot-word")?.textContent)).toEqual([
      "Done · Connect your wallet",
      "Now · Fund an escrow",
      "Later · Send the first transaction",
    ])
    expect(screen.getByTestId("test-eth-note").textContent).toBe(TEST_ETH_NOTE)
    const fund = screen.getByTestId("journey-fund")
    expect(fund.getAttribute("href")).toBe("/app/fund")
    expect(screen.queryByTestId("journey-connect")).toBeNull()
    expect(screen.queryByTestId("journey-switch")).toBeNull()
    fireEvent.click(fund)
    expect(window.location.pathname).toBe("/app/fund")
  })
})
