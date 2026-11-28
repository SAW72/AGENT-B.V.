import { createWalletClient, custom, formatTransactionRequest, getAddress, numberToHex, type Hex } from "viem"
import { describe, expect, it } from "vitest"
import { registryAddress } from "./registry/register"
import { formatSepoliaTransactionRequest, sepoliaChain } from "./sepoliaChain"
import { wagmiConfig } from "./wagmi"

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

  it("registers the pinned chain object in the wagmi config, not the stock one", () => {
    expect(wagmiConfig.chains).toHaveLength(1)
    expect(wagmiConfig.chains[0]).toBe(sepoliaChain)
  })

  it("sends chainId 0x14a34 in eth_sendTransaction params through a real viem wallet client (in-memory stub, no key, no network)", async () => {
    const seen: { method: string; params?: unknown }[] = []
    const stub = {
      request: async (args: { method: string; params?: unknown }) => {
        seen.push(args)
        if (args.method === "eth_chainId") return "0x14a34"
        if (args.method === "eth_sendTransaction") return `0x${"ab".repeat(32)}`
        throw new Error(`unexpected ${args.method}`)
      },
    }
    const chain = wagmiConfig.chains[0]
    const client = createWalletClient({ chain, transport: custom(stub), account: FROM })
    await client.sendTransaction({ to: REGISTRY, data: DATA as Hex, value: 0n, chain })
    const sent = seen.find((entry) => entry.method === "eth_sendTransaction")
    const params = (sent?.params as Record<string, unknown>[] | undefined)?.[0]
    expect(params?.chainId).toBe("0x14a34")
    expect(params?.to).toBe(REGISTRY)
    expect(params?.value).toBe("0x0")
  })
})
