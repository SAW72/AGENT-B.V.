// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { FirstRun } from "./firstRun"
import { Stepper } from "./steps"
import {
  BASE_SEPOLIA_FAUCET_DOCS_URL,
  CONNECT_NOTE,
  TEST_ETH_NOTE,
  WRONG_NETWORK_NOTE,
  journeyNow,
  walkthroughLabels,
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
    expect(walkthroughLabels("disconnected")).toEqual(["Connect your wallet", "Fill in the escrow", "Review and send"])
    expect(walkthroughLabels("ready")).toEqual(["Connect your wallet", "Fill in the escrow", "Review and send"])
    expect(walkthroughLabels("wrong-network")).toEqual(["Switch to Base Sepolia", "Fill in the escrow", "Review and send"])
    for (const chain of [1, null, "conflict" as const]) {
      const wallet = walletReadiness(true, chain)
      expect(wallet).toBe("wrong-network")
      expect(journeyNow(wallet, "home")).toBe("Now · Switch to Base Sepolia")
      expect(journeyNow(wallet, "funding")).toBe("Now · Switch to Base Sepolia")
    }
    expect(journeyNow("disconnected", "home")).toBe("Now · Connect your wallet")
    expect(journeyNow("ready", "home")).toBe("Now · Fill in the escrow")
    expect(journeyNow("ready", "funding")).toBe("Now · Fill in the escrow")
    expect(journeyNow("ready", "review")).toBe("Now · Review and send")
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
    expect(within(card).getAllByRole("listitem").map((item) => item.querySelector(".step-dot-word")?.textContent)).toEqual([
      "Now · Connect your wallet",
      "Later · Fill in the escrow",
      "Later · Review and send",
    ])
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
    expect(within(card).getAllByRole("listitem").map((item) => item.querySelector(".step-dot-word")?.textContent)).toEqual([
      "Now · Switch to Base Sepolia",
      "Later · Fill in the escrow",
      "Later · Review and send",
    ])
    expect(screen.getByTestId("wrong-network-note").textContent).toBe(WRONG_NETWORK_NOTE)
    expect(screen.queryByTestId("journey-connect")).toBeNull()
    expect(screen.queryByTestId("journey-fund")).toBeNull()
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull()
    fireEvent.click(screen.getByTestId("journey-switch"))
    expect(switchChain).toHaveBeenCalledWith({ chainId: BASE_SEPOLIA_CHAIN_ID })
  })

  it("uses the switch step when the connected chain is unknown", () => {
    world.connected = true
    world.chainId = undefined
    render(<FirstRun />)
    const words = within(screen.getByTestId("first-run"))
      .getAllByRole("listitem")
      .map((item) => item.querySelector(".step-dot-word")?.textContent)
    expect(words[0]).toBe("Now · Switch to Base Sepolia")
    expect(words).toHaveLength(3)
    expect(screen.getByTestId("journey-switch")).toBeTruthy()
  })

  it("offers fund as the only primary action once the wallet is on Base Sepolia", () => {
    world.connected = true
    render(<FirstRun />)
    const card = screen.getByTestId("first-run")
    expect(statesOf(card)).toEqual(["done", "current", "upcoming"])
    expect(within(card).getAllByRole("listitem").map((item) => item.querySelector(".step-dot-word")?.textContent)).toEqual([
      "Done · Connect your wallet",
      "Now · Fill in the escrow",
      "Later · Review and send",
    ])
    const note = screen.getByTestId("test-eth-note")
    expect(note.textContent).toBe(TEST_ETH_NOTE)
    const links = within(note).getAllByRole("link")
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute("href")).toBe(BASE_SEPOLIA_FAUCET_DOCS_URL)
    expect(links[0]?.getAttribute("href")).toBe("https://docs.base.org/get-started/get-funds")
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer")
    expect(links[0]?.getAttribute("target")).toBe("_blank")
    expect(links[0]?.textContent).toBe("Base Sepolia faucet")
    const fund = screen.getByTestId("journey-fund")
    expect(fund.getAttribute("href")).toBe("/app/fund")
    expect(screen.queryByTestId("journey-connect")).toBeNull()
    expect(screen.queryByTestId("journey-switch")).toBeNull()
    fireEvent.click(fund)
    expect(window.location.pathname).toBe("/app/fund")
  })
})
