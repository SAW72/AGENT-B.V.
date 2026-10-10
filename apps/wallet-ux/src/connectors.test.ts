import { describe, expect, it } from "vitest"
import { visibleConnectors } from "./connectors"

describe("visibleConnectors", () => {
  it("drops the generic injected button when the same wallet is announced over EIP-6963", () => {
    const injected = { id: "injected", name: "Injected", uid: "fallback" }
    const metaMask = { id: "io.metamask", name: "MetaMask", rdns: "io.metamask", uid: "mm" }
    const shown = visibleConnectors([injected, metaMask, { ...metaMask, uid: "mm-again" }])
    expect(shown.map((connector) => connector.name)).toEqual(["MetaMask"])
    expect(shown).toHaveLength(1)
  })

  it("keeps Connect wallet when no named wallet has announced", () => {
    const injected = { id: "injected", name: "Injected" }
    expect(visibleConnectors([injected])).toEqual([injected])
  })

  it("keeps two different announced wallets", () => {
    const names = visibleConnectors([
      { id: "injected", name: "Injected" },
      { id: "io.metamask", name: "MetaMask", rdns: "io.metamask" },
      { id: "io.rabby", name: "Rabby", rdns: "io.rabby" },
    ]).map((connector) => connector.name)
    expect(names).toEqual(["MetaMask", "Rabby"])
  })
})