import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  ChainMismatchError,
  encodeAbiParameters,
  encodeEventTopics,
  InsufficientFundsError,
  getAddress,
  toFunctionSelector,
  UserRejectedRequestError,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Hex,
} from "viem"
import { baseSepolia } from "viem/chains"
import { describe, expect, it, vi } from "vitest"
import { identityRegistry8004Abi } from "../abi"
import erc8004Config from "../../../../config/erc8004-base-sepolia.json" with { type: "json" }
import {
  BadUri,
  Cancelled,
  DryRunReverted,
  InsufficientFunds,
  InvalidJson,
  NoRegisteredEvent,
  RegisterError,
  Replaced,
  TooLarge,
  Unknown,
  UserRejected,
  WrongChain,
  WrongType,
  REGISTRATION_BARE_TYPE,
  REGISTRATION_EIP_TYPE,
  REGISTRATION_MAX_BYTES,
  assertChain84532,
  baseSepoliaAddChainParams,
  buildAgentUri,
  buildRegisterWrite,
  checkBalanceForGas,
  dryRunRegister,
  findExistingAgent,
  formatAgentId,
  normalizeWalletError,
  parseRegistered,
  registryAddress,
  validateRegistration,
  waitForRegisterReceipt,
  type BalanceClient,
  type DryRunClient,
  type FeeReader,
  type ReceiptClient,
  type RegisterLog,
} from "./register"

const EXAMPLE_PATH = fileURLToPath(
  new URL("../../../../scripts/erc8004/tcs-grokbot-registration.json", import.meta.url),
)
const EXAMPLE_BYTES = readFileSync(EXAMPLE_PATH)
const OWNER = getAddress(`0x${"12".repeat(20)}`)
const OTHER = getAddress(`0x${"34".repeat(20)}`)
const HASH_A = `0x${"ab".repeat(32)}` as Hex
const HASH_B = `0x${"cd".repeat(32)}` as Hex

function registration(type: string, name?: string): string {
  return JSON.stringify(name === undefined ? { type } : { type, name })
}

function jsonOfSize(size: number): string {
  const prefix = '{"type":"registration-v1","name":"'
  const suffix = '"}'
  const pad = size - prefix.length - suffix.length
  if (pad < 0) throw new Error("size smaller than the registration skeleton")
  return prefix + "n".repeat(pad) + suffix
}

function registeredLog(address: string, agentId: bigint, owner: Address, agentURI: string): RegisterLog {
  const topics = encodeEventTopics({
    abi: identityRegistry8004Abi,
    eventName: "Registered",
    args: { agentId, owner },
  })
  const data = encodeAbiParameters([{ type: "string", name: "agentURI" }], [agentURI])
  const hexTopics = topics.filter((topic): topic is Hex => typeof topic === "string")
  return { address, topics: hexTopics, data }
}

describe("registration bytes", () => {
  it("accepts the example file and preserves its bytes in the data URI", () => {
    const expected = `data:application/json;base64,${Buffer.from(EXAMPLE_BYTES).toString("base64")}`
    expect(REGISTRATION_MAX_BYTES).toBe(2048)
    expect(REGISTRATION_EIP_TYPE).toBe(JSON.parse(EXAMPLE_BYTES.toString("utf8")).type)
    expect(buildAgentUri(EXAMPLE_BYTES)).toBe(expected)
    expect(buildAgentUri(new Uint8Array(EXAMPLE_BYTES))).toBe(expected)
    expect(buildAgentUri(EXAMPLE_BYTES.toString("utf8"))).toBe(expected)
    expect(buildAgentUri(expected)).toBe(expected)
    const validated = validateRegistration(EXAMPLE_BYTES)
    expect(validated.uri).toBe(expected)
    expect(validated.type).toBe(REGISTRATION_EIP_TYPE)
    expect(validated.name).toBe("TCS Grokbot")
    expect(validated.size).toBe(EXAMPLE_BYTES.length)
    const payload = Buffer.from(validated.uri.slice("data:application/json;base64,".length), "base64")
    expect(Buffer.compare(payload, EXAMPLE_BYTES)).toBe(0)
  })

  it("accepts the EIP type and the bare registration-v1 string with exact equality", () => {
    const eip = validateRegistration(registration(REGISTRATION_EIP_TYPE, "Named"))
    expect(eip.type).toBe(REGISTRATION_EIP_TYPE)
    expect(eip.name).toBe("Named")
    const bare = validateRegistration(registration(REGISTRATION_BARE_TYPE))
    expect(bare.type).toBe("registration-v1")
    expect(bare.name).toBeUndefined()
  })

  it("rejects type variants that are not exact", () => {
    const variants = [
      REGISTRATION_EIP_TYPE.toLowerCase(),
      REGISTRATION_EIP_TYPE.slice(0, -1),
      `${REGISTRATION_EIP_TYPE} `,
      ` ${REGISTRATION_BARE_TYPE}`,
      `${REGISTRATION_BARE_TYPE} `,
      REGISTRATION_BARE_TYPE.toUpperCase(),
      `x${REGISTRATION_BARE_TYPE}`,
      registration("registration-v2").slice(1),
    ]
    for (const type of variants) {
      expect(() => validateRegistration(registration(type))).toThrow(WrongType)
    }
    expect(() => validateRegistration("[]")).toThrow(WrongType)
    expect(() => validateRegistration("null")).toThrow(WrongType)
  })

  it("rejects invalid JSON", () => {
    expect(() => validateRegistration("{")).toThrow(InvalidJson)
    expect(() => validateRegistration("")).toThrow(InvalidJson)
    expect(() => validateRegistration(new Uint8Array([0xff]))).toThrow(InvalidJson)
    const encoded = Buffer.from("{", "utf8").toString("base64")
    expect(() => validateRegistration(`data:application/json;base64,${encoded}`)).toThrow(InvalidJson)
  })

  it("rejects a body one byte over the cap and accepts the cap", () => {
    const atCap = jsonOfSize(REGISTRATION_MAX_BYTES)
    const over = jsonOfSize(REGISTRATION_MAX_BYTES + 1)
    expect(new TextEncoder().encode(atCap).length).toBe(2048)
    expect(new TextEncoder().encode(over).length).toBe(2049)
    expect(validateRegistration(atCap).size).toBe(2048)
    expect(() => validateRegistration(over)).toThrow(TooLarge)
    expect(() => validateRegistration(atCap, 2047)).toThrow(TooLarge)
  })

  it("rejects a data URI that is not standard base64 JSON", () => {
    expect(() => validateRegistration("data:text/plain;base64,YQ==")).toThrow(BadUri)
    expect(() => buildAgentUri("data:application/json;base64,****")).toThrow(BadUri)
    expect(() => validateRegistration("data:application/json;base64,YQ")).toThrow(BadUri)
    expect(() => validateRegistration("data:application/json;base64,YQ==\n")).toThrow(BadUri)
  })
})

describe("chain id", () => {
  it("accepts the configured chain as a number or bigint", () => {
    expect(() => assertChain84532(erc8004Config.chainId)).not.toThrow()
    expect(() => assertChain84532(BigInt(erc8004Config.chainId))).not.toThrow()
  })

  it("rejects a different chain, including Base mainnet", () => {
    expect(() => assertChain84532(8453)).toThrow(WrongChain)
    expect(() => assertChain84532(1)).toThrow(WrongChain)
    expect(() => assertChain84532(0n)).toThrow(WrongChain)
  })
})

describe("register calldata", () => {
  it("encodes register(string) to the configured registry", () => {
    const uri = "ipfs://agent"
    const write = buildRegisterWrite(uri)
    expect(write.to).toBe(registryAddress())
    expect(write.data.slice(0, 10)).toBe("0xf2c298be")
    expect(write.data.slice(0, 10)).toBe(toFunctionSelector("register(string)"))
    expect(write.data.slice(0, 10)).not.toBe(toFunctionSelector("register()"))
    expect(write.data.slice(0, 10)).not.toBe(toFunctionSelector("register(string,(string,bytes)[])"))
  })
})

describe("dry run and balance", () => {
  it("returns the provisional id and gas from the injected client", async () => {
    const uri = buildAgentUri(registration(REGISTRATION_BARE_TYPE))
    const simulateContract = vi.fn(async () => ({ result: 9n }))
    const estimateGas = vi.fn(async (_args: { data?: Hex; to?: Address; account?: Address }) => 50_000n)
    const client = {
      chain: { id: erc8004Config.chainId },
      simulateContract,
      estimateGas,
    } as unknown as DryRunClient
    await expect(dryRunRegister(client, OWNER, uri)).resolves.toEqual({ provisionalId: 9n, gas: 50_000n })
    expect(simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "register",
        args: [uri],
        account: OWNER,
        address: registryAddress(),
      }),
    )
    const gasArgs = estimateGas.mock.calls[0]?.[0]
    expect(gasArgs?.to).toBe(registryAddress())
    expect(gasArgs?.account).toBe(OWNER)
    expect(gasArgs?.data?.slice(0, 10)).toBe("0xf2c298be")
  })

  it("wraps a reverted simulation and refuses the wrong chain before the call", async () => {
    const simulateContract = vi.fn(async () => {
      throw new Error("execution reverted")
    })
    const estimateGas = vi.fn()
    const reverted = { chain: { id: erc8004Config.chainId }, simulateContract, estimateGas } as unknown as DryRunClient
    await expect(dryRunRegister(reverted, OWNER, "uri")).rejects.toBeInstanceOf(DryRunReverted)
    const wrong = { chain: { id: 8453 }, simulateContract, estimateGas } as unknown as DryRunClient
    await expect(dryRunRegister(wrong, OWNER, "uri")).rejects.toBeInstanceOf(WrongChain)
    expect(simulateContract).toHaveBeenCalledTimes(1)
  })

  it("reads balanceOf and returns the count", async () => {
    const readContract = vi.fn(async () => 4n)
    const client = { readContract } as unknown as BalanceClient
    await expect(findExistingAgent(client, OWNER)).resolves.toEqual({ count: 4n })
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "balanceOf",
        args: [OWNER],
        address: registryAddress(),
      }),
    )
  })
})

describe("Registered logs", () => {
  it("reads the last registry log and ignores a look-alike from another address", () => {
    const registry = registryAddress()
    const first = registeredLog(registry, 1n, OWNER, "one")
    const lookAlike = registeredLog(OTHER, 2n, OWNER, "two")
    const last = registeredLog(registry.toLowerCase(), 3n, OWNER, "three")
    expect(parseRegistered({ logs: [first, lookAlike, last] })).toEqual({
      agentId: 3n,
      owner: OWNER,
      agentURI: "three",
    })
    expect(parseRegistered({ logs: [lookAlike] })).toBeNull()
    expect(parseRegistered({ logs: [] })).toBeNull()
    expect(parseRegistered({})).toBeNull()
  })

  it("formats the global agent id without rewriting the registry", () => {
    const registry = registryAddress().toLowerCase()
    expect(formatAgentId(erc8004Config.chainId, registry, 7n)).toBe(
      `eip155:${erc8004Config.chainId}:${registry}:7`,
    )
    expect(formatAgentId(BigInt(erc8004Config.chainId), registryAddress(), 8)).toBe(
      `eip155:${erc8004Config.chainId}:${registryAddress()}:8`,
    )
  })
})

describe("wallet errors", () => {
  it("maps reject, funds, chain, and the codes that stay unknown", () => {
    expect(normalizeWalletError({ code: 4001, message: "no" })).toBeInstanceOf(UserRejected)
    expect(normalizeWalletError(new UserRejectedRequestError(new Error("User rejected the request.")))).toBeInstanceOf(
      UserRejected,
    )
    expect(normalizeWalletError(new Error("user denied transaction signature"))).toBeInstanceOf(UserRejected)
    const funds = normalizeWalletError(new InsufficientFundsError())
    expect(funds).toBeInstanceOf(InsufficientFunds)
    expect(funds.message).not.toContain("amount plus gas")
    expect(normalizeWalletError(new Error("insufficient balance"))).toBeInstanceOf(InsufficientFunds)
    expect(normalizeWalletError(new ChainMismatchError({ chain: baseSepolia, currentChainId: 8453 }))).toBeInstanceOf(
      WrongChain,
    )
    expect(normalizeWalletError(new Error("wrong network"))).toBeInstanceOf(WrongChain)
    expect(normalizeWalletError({ code: 4902, message: "Unrecognized chain id" }).code).toBe("Unknown")
    for (const code of [-32603, -32002, 4100, 4900, 4901]) {
      expect(normalizeWalletError({ code }).code).toBe("Unknown")
    }
    expect(normalizeWalletError({ code: "4902", message: "unrecognized chain" }).code).toBe("Unknown")
    const same = new TooLarge()
    expect(normalizeWalletError(same)).toBe(same)
    expect(new InvalidJson()).toBeInstanceOf(RegisterError)
  })
})

describe("gas balance", () => {
  it("applies a 20 percent margin on maxFeePerGas and reports ok without throwing", async () => {
    const estimateFeesPerGas = vi.fn(async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }))
    const getGasPrice = vi.fn(async () => 99n)
    const getBalance = vi.fn(async () => 1200n)
    const client = { estimateFeesPerGas, getGasPrice, getBalance } as unknown as FeeReader
    const gas = 100n
    await expect(checkBalanceForGas(client, OWNER, gas)).resolves.toEqual({ ok: true, balance: 1200n, needed: 1200n })
    getBalance.mockResolvedValueOnce(1199n)
    await expect(checkBalanceForGas(client, OWNER, gas)).resolves.toEqual({ ok: false, balance: 1199n, needed: 1200n })
    expect(getGasPrice).not.toHaveBeenCalled()
  })

  it("uses gasPrice when fee estimation is absent", async () => {
    const getGasPrice = vi.fn(async () => 5n)
    const getBalance = vi.fn(async () => 600n)
    const client = { getGasPrice, getBalance } as unknown as FeeReader
    await expect(checkBalanceForGas(client, OWNER, 100n)).resolves.toEqual({ ok: true, balance: 600n, needed: 600n })
  })
})

describe("receipt wait", () => {
  it("follows a repriced replacement and returns that receipt", async () => {
    const statuses: { phase: string; hash: Hex }[] = []
    const log = registeredLog(registryAddress(), 11n, OWNER, "uri")
    const waitForTransactionReceipt = vi.fn(async (args: { hash: Hex; onReplaced?: (response: { reason: string; transaction: { hash: Hex } }) => void }) => {
      if (args.hash === HASH_A) {
        args.onReplaced?.({ reason: "repriced", transaction: { hash: HASH_B } })
        return { transactionHash: HASH_A, logs: [] }
      }
      return { transactionHash: HASH_B, logs: [log] }
    })
    const client = { waitForTransactionReceipt } as unknown as ReceiptClient
    const result = await waitForRegisterReceipt(client, HASH_A, (status) => statuses.push(status))
    expect(statuses).toEqual([{ phase: "repriced", hash: HASH_B }])
    expect(result.hash).toBe(HASH_B)
    expect(result.agentId).toBe(11n)
    expect(result.owner).toBe(OWNER)
    expect(result.agentURI).toBe("uri")
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(2)
  })

  it("throws when the replacement is replaced or cancelled", async () => {
    for (const reason of ["replaced", "cancelled"] as const) {
      let threw = false
      const waitForTransactionReceipt = vi.fn(async (args: { onReplaced?: (response: { reason: string; transaction: { hash: Hex } }) => void }) => {
        try {
          args.onReplaced?.({ reason, transaction: { hash: HASH_B } })
        } catch (error) {
          threw = error instanceof (reason === "replaced" ? Replaced : Cancelled)
        }
        return { transactionHash: HASH_B, logs: [registeredLog(registryAddress(), 1n, OWNER, "uri")] }
      })
      const client = { waitForTransactionReceipt } as unknown as ReceiptClient
      const expected = reason === "replaced" ? Replaced : Cancelled
      await expect(waitForRegisterReceipt(client, HASH_A)).rejects.toBeInstanceOf(expected)
      expect(threw).toBe(true)
    }
  })

  it("throws when the receipt has no registry Registered log", async () => {
    const waitForTransactionReceipt = vi.fn(async () => ({
      transactionHash: HASH_A,
      logs: [registeredLog(OTHER, 4n, OWNER, "other")],
    }))
    const client = { waitForTransactionReceipt } as unknown as ReceiptClient
    await expect(waitForRegisterReceipt(client, HASH_A)).rejects.toBeInstanceOf(NoRegisteredEvent)
  })

  it("maps a wait timeout to Unknown and reports it", async () => {
    const statuses: { phase: string; hash: Hex }[] = []
    const waitForTransactionReceipt = vi.fn(async () => {
      throw new WaitForTransactionReceiptTimeoutError({ hash: HASH_A })
    })
    const client = { waitForTransactionReceipt } as unknown as ReceiptClient
    const error = await waitForRegisterReceipt(client, HASH_A, (status) => statuses.push(status)).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Unknown)
    expect(error).toMatchObject({ code: "Unknown" })
    expect(statuses).toEqual([{ phase: "timeout", hash: HASH_A }])
  })
})

describe("add chain params", () => {
  it("derives the hex chain id and copies transport urls from viem chains", () => {
    expect(baseSepoliaAddChainParams.chainId).toBe(`0x${erc8004Config.chainId.toString(16)}`)
    expect(baseSepoliaAddChainParams.chainName).toBe(baseSepolia.name)
    expect(baseSepoliaAddChainParams.nativeCurrency).toEqual({
      name: baseSepolia.nativeCurrency.name,
      symbol: baseSepolia.nativeCurrency.symbol,
      decimals: baseSepolia.nativeCurrency.decimals,
    })
    expect([...baseSepoliaAddChainParams.rpcUrls]).toEqual([...baseSepolia.rpcUrls.default.http])
    expect(baseSepoliaAddChainParams.rpcUrls.length).toBeGreaterThan(0)
    expect(baseSepoliaAddChainParams.blockExplorerUrls).toEqual([erc8004Config.basescanSite])
    const registerSource = readFileSync(fileURLToPath(new URL("./register.ts", import.meta.url)), "utf8")
    const testSource = readFileSync(fileURLToPath(new URL("./register.test.ts", import.meta.url)), "utf8")
    expect(registerSource).not.toMatch(/[0-9a-fA-F]{64}/)
    expect(testSource).not.toMatch(/[0-9a-fA-F]{64}/)
    expect(registerSource).not.toMatch(/https?:\/\//)
    expect(testSource).not.toMatch(/https?:\/\//)
    expect(registerSource).not.toMatch(/(?<![A-Za-z])84532(?!\d)/)
  })
})
