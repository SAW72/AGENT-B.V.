import { describe, expect, it, vi } from "vitest"
import { assertLiveChain84532, parseRpcChainId } from "./preflight"

describe("assertLiveChain84532", () => {
  it("allows chain id 84532 and refuses any other id", async () => {
    const sepolia = vi.fn(async () => "0x14a34")
    await expect(assertLiveChain84532(sepolia)).resolves.toBeUndefined()
    expect(sepolia).toHaveBeenCalledWith({ method: "eth_chainId" })
    await expect(assertLiveChain84532(async () => "0x1")).rejects.toMatchObject({
      name: "ChainMismatchError",
      message: "This check only runs on the Base Sepolia network. Nothing was sent.",
    })
    await expect(assertLiveChain84532(async () => "0x2105")).rejects.toMatchObject({
      name: "ChainMismatchError",
      message: "This check only runs on the Base Sepolia network. Nothing was sent.",
    })
    expect(parseRpcChainId("0x14a34")).toBe(84532)
    expect(parseRpcChainId("0x1")).toBe(1)
  })
})
