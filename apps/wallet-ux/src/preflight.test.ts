import { describe, expect, it, vi } from "vitest"
import { assertLiveChain84532, parseRpcChainId } from "./preflight"

const MESSAGE = "This check only runs on the Base Sepolia network. Nothing was sent."

describe("assertLiveChain84532", () => {
  it("allows chain id 84532 and refuses any other id", async () => {
    const sepolia = vi.fn(async () => "0x14a34")
    await expect(assertLiveChain84532(sepolia)).resolves.toBeUndefined()
    expect(sepolia).toHaveBeenCalledWith({ method: "eth_chainId" })
    await expect(assertLiveChain84532(async () => "0x1")).rejects.toMatchObject({ name: "ChainMismatchError", message: MESSAGE })
    await expect(assertLiveChain84532(async () => "0x2105")).rejects.toMatchObject({ name: "ChainMismatchError", message: MESSAGE })
    expect(parseRpcChainId("0x14a34")).toBe(84532)
    expect(parseRpcChainId("0x1")).toBe(1)
  })

  it("fails closed when there is no request function", async () => {
    await expect(assertLiveChain84532(null)).rejects.toMatchObject({ name: "ChainMismatchError", message: MESSAGE })
  })

  it("fails closed on a missing, empty, or unparseable eth_chainId value", async () => {
    for (const bad of [undefined, null, "", "0x", "garbage", {}, [], Number.NaN, "0xzz", Number.POSITIVE_INFINITY]) {
      await expect(assertLiveChain84532(async () => bad), String(bad)).rejects.toMatchObject({ name: "ChainMismatchError" })
    }
  })

  it("lets the request error through when the wallet read throws, so nothing is sent", async () => {
    await expect(assertLiveChain84532(async () => { throw new Error("rpc down") })).rejects.toThrow("rpc down")
  })

  it("accepts a decimal string or number 84532 and refuses neighbours", async () => {
    await expect(assertLiveChain84532(async () => 84532)).resolves.toBeUndefined()
    await expect(assertLiveChain84532(async () => "84532")).resolves.toBeUndefined()
    await expect(assertLiveChain84532(async () => 84531)).rejects.toBeTruthy()
    await expect(assertLiveChain84532(async () => "0x14a35")).rejects.toBeTruthy()
  })
})
