import { formatTransactionRequest, getAddress, numberToHex } from "viem"
import { describe, expect, it } from "vitest"
import { registryAddress } from "./registry/register"
import { formatSepoliaTransactionRequest, sepoliaChain } from "./sepoliaChain"

const REGISTRY = registryAddress()
const DATA = "0xf2c298be"
const FROM = getAddress(`0x${"11".repeat(20)}`)

describe("sepolia eth_sendTransaction payload", () => {
  it("adds chainId 84532 to the formatted eth_sendTransaction params", () => {
    const payload = formatSepoliaTransactionRequest({
      to: REGISTRY,
      data: DATA,
      value: 0n,
      from: FROM,
    })
    expect(payload.to).toBe(REGISTRY)
    expect(payload.data).toBe(DATA)
    expect(payload.value).toBe(numberToHex(0n))
    expect(payload.chainId).toBe(numberToHex(84532))
    expect(payload.chainId).toBe("0x14a34")
    const stock = formatTransactionRequest({
      to: REGISTRY,
      data: DATA,
      value: 0n,
    })
    expect("chainId" in stock).toBe(false)
    expect(sepoliaChain.id).toBe(84532)
    expect(
      (sepoliaChain as unknown as { formatters: { transactionRequest: { format: typeof formatSepoliaTransactionRequest } } })
        .formatters.transactionRequest.format({ to: REGISTRY, data: DATA, value: 0n }).chainId,
    ).toBe("0x14a34")
  })
})
