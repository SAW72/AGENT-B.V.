/**
 * ERC-8004 register(string) helpers for the wallet register wizard.
 * This module builds calldata and reads through an injected viem client.
 * It does not send, sign, or open a transport.
 */

import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import { baseSepolia } from "viem/chains"
import { identityRegistry8004Abi } from "../abi"
import { isLowBalance, isWalletCancel, nodesOf } from "../revert"
import erc8004Config from "../../../../config/erc8004-base-sepolia.json" with { type: "json" }
import registrationExample from "../../../../scripts/erc8004/tcs-grokbot-registration.json" with { type: "json" }

/** Estimate of the largest registration JSON body, in bytes, not a re-serialized form. */
export const REGISTRATION_MAX_BYTES = 2048

/** Byte-for-byte `type` from scripts/erc8004/tcs-grokbot-registration.json. */
export const REGISTRATION_EIP_TYPE = registrationExample.type

export const REGISTRATION_BARE_TYPE = "registration-v1"

const DATA_URI_PREFIX = "data:application/json;base64,"

/** register(string) selector. Calldata from buildRegisterWrite starts with this. */
const REGISTER_STRING_SELECTOR = "0xf2c298be"

type ErrorOptions = { cause?: unknown }

export class RegisterError extends Error {
  readonly code: string
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = code
  }
}

export class InvalidJson extends RegisterError {
  declare readonly code: "InvalidJson"
  constructor(message = "The registration is not valid JSON.", options?: ErrorOptions) {
    super("InvalidJson", message, options)
  }
}

export class WrongType extends RegisterError {
  declare readonly code: "WrongType"
  constructor(message = "The registration type is not registration-v1.", options?: ErrorOptions) {
    super("WrongType", message, options)
  }
}

export class TooLarge extends RegisterError {
  declare readonly code: "TooLarge"
  constructor(message = "The registration is over the size cap.", options?: ErrorOptions) {
    super("TooLarge", message, options)
  }
}

export class BadUri extends RegisterError {
  declare readonly code: "BadUri"
  constructor(message = "The agent URI is not a data:application/json;base64 URI.", options?: ErrorOptions) {
    super("BadUri", message, options)
  }
}

export class WrongChain extends RegisterError {
  declare readonly code: "WrongChain"
  constructor(message = "The wallet is connected to a different chain.", options?: ErrorOptions) {
    super("WrongChain", message, options)
  }
}

export class DryRunReverted extends RegisterError {
  declare readonly code: "DryRunReverted"
  constructor(message = "The register dry run reverted.", options?: ErrorOptions) {
    super("DryRunReverted", message, options)
  }
}

export class NoRegisteredEvent extends RegisterError {
  declare readonly code: "NoRegisteredEvent"
  constructor(message = "The registry did not emit Registered.", options?: ErrorOptions) {
    super("NoRegisteredEvent", message, options)
  }
}

export class UserRejected extends RegisterError {
  declare readonly code: "UserRejected"
  constructor(message = "The wallet rejected the request.", options?: ErrorOptions) {
    super("UserRejected", message, options)
  }
}

export class InsufficientFunds extends RegisterError {
  declare readonly code: "InsufficientFunds"
  constructor(message = "The wallet balance does not cover gas.", options?: ErrorOptions) {
    super("InsufficientFunds", message, options)
  }
}

export class Replaced extends RegisterError {
  declare readonly code: "Replaced"
  constructor(message = "The register transaction was replaced.", options?: ErrorOptions) {
    super("Replaced", message, options)
  }
}

export class Cancelled extends RegisterError {
  declare readonly code: "Cancelled"
  constructor(message = "The register transaction was cancelled.", options?: ErrorOptions) {
    super("Cancelled", message, options)
  }
}

export class Unknown extends RegisterError {
  declare readonly code: "Unknown"
  constructor(message = "The wallet request failed.", options?: ErrorOptions) {
    super("Unknown", message, options)
  }
}

export type ValidatedRegistration = {
  type: string
  size: number
  uri: string
  name?: string
}

export type RegisterLog = {
  address: string
  data: Hex
  topics: readonly Hex[]
}

export type ParsedRegistered = {
  agentId: bigint
  owner: Address
  agentURI: string
}

export type DryRunClient = Pick<PublicClient, "simulateContract" | "estimateGas" | "chain">

export type BalanceClient = Pick<PublicClient, "readContract">

export type FeeReader = {
  getBalance: PublicClient["getBalance"]
  estimateFeesPerGas?: PublicClient["estimateFeesPerGas"]
  getGasPrice?: PublicClient["getGasPrice"]
}

export type ReceiptClient = Pick<PublicClient, "waitForTransactionReceipt">

export type RegisterWaitStatus =
  | { phase: "repriced"; hash: Hex }
  | { phase: "timeout"; hash: Hex }

export type RegisterStatusListener = (status: RegisterWaitStatus) => void

export type RegisterReceipt = {
  transactionHash: Hex
  logs?: readonly RegisterLog[] | null
  status?: string
}

export type RegisterWaitResult<TReceipt> = {
  receipt: TReceipt
  hash: Hex
  agentId: bigint
  owner: Address
  agentURI: string
}

type AbiItem = {
  type?: string
  name?: string
  inputs?: readonly { readonly type?: string }[]
}

function registerStringAbi() {
  const matches = identityRegistry8004Abi.filter((item) => {
    const fn = item as AbiItem
    return (
      fn.type === "function" &&
      fn.name === "register" &&
      fn.inputs?.length === 1 &&
      fn.inputs[0]?.type === "string"
    )
  })
  if (matches.length !== 1) {
    throw new Error("Identity registry ABI must include one register(string) function.")
  }
  return matches
}

const REGISTER_STRING_ABI = registerStringAbi()

export function registryAddress(): Address {
  return getAddress(erc8004Config.identityRegistry)
}

function hexChainId(chainId: number): string {
  return `0x${chainId.toString(16)}`
}

/**
 * EIP-3085 wallet_addEthereumChain parameters for the configured chain.
 * rpcUrls are copied from viem/chains baseSepolia, the chain object src/wagmi.ts already uses.
 * No hostname is written in this file. chainId is hex derived from config.chainId.
 * blockExplorerUrls comes from config.basescanSite (the explorer, not a transport).
 */
export const baseSepoliaAddChainParams = {
  chainId: hexChainId(erc8004Config.chainId),
  chainName: baseSepolia.name,
  nativeCurrency: {
    name: baseSepolia.nativeCurrency.name,
    symbol: baseSepolia.nativeCurrency.symbol,
    decimals: baseSepolia.nativeCurrency.decimals,
  },
  rpcUrls: [...baseSepolia.rpcUrls.default.http],
  blockExplorerUrls: [erc8004Config.basescanSite],
}

function encodeStandardBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let index = 0; index < bytes.length; index += 4096) {
    const chunk = bytes.subarray(index, Math.min(index + 4096, bytes.length))
    parts.push(String.fromCharCode(...chunk))
  }
  return btoa(parts.join(""))
}

function decodeStandardBase64(encoded: string): Uint8Array {
  if (encoded.length === 0) return new Uint8Array()
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new BadUri("The agent URI base64 payload is not standard base64.")
  }
  let binary: string
  try {
    binary = atob(encoded)
  } catch (error) {
    throw new BadUri("The agent URI base64 payload could not be decoded.", { cause: error })
  }
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index)
  return out
}

function jsonBytes(input: string | Uint8Array): Uint8Array {
  if (typeof input === "string" && input.startsWith(DATA_URI_PREFIX)) {
    return decodeStandardBase64(input.slice(DATA_URI_PREFIX.length))
  }
  if (typeof input === "string") return new TextEncoder().encode(input)
  return input
}

/**
 * Encode registration bytes as a data URI.
 * A string that already uses the exact data:application/json;base64, prefix is checked and returned unchanged.
 * Any other string or byte array is the JSON file bytes. Those bytes are standard Base64 with no line wraps,
 * the same shape as the README recipe: base64 of the file with newlines removed. The bytes are not parsed or re-serialized.
 */
export function buildAgentUri(input: string | Uint8Array): string {
  if (typeof input === "string" && input.startsWith("data:")) {
    if (!input.startsWith(DATA_URI_PREFIX)) {
      throw new BadUri("The agent URI must start with data:application/json;base64,")
    }
    decodeStandardBase64(input.slice(DATA_URI_PREFIX.length))
    return input
  }
  return DATA_URI_PREFIX + encodeStandardBase64(jsonBytes(input))
}

/**
 * Accept JSON text or bytes, or a data:application/json;base64, URI.
 * A bad prefix or undecodable Base64 throws BadUri.
 * JSON.parse failure throws InvalidJson. A parsed value that is not a non-array object,
 * or whose type is not exactly the example EIP URL or "registration-v1", throws WrongType.
 * Comparison is exact: no trim, no lowercase, no prefix match.
 * Size is the JSON byte length (decoded URI payload, or the raw input). Over the cap throws TooLarge.
 */
export function validateRegistration(
  input: string | Uint8Array,
  cap = REGISTRATION_MAX_BYTES,
): ValidatedRegistration {
  const uri = buildAgentUri(input)
  const bytes = jsonBytes(input)
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    throw new InvalidJson("The registration bytes are not UTF-8 JSON.", { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new InvalidJson("The registration is not valid JSON.", { cause: error })
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WrongType("The registration must be a JSON object.")
  }
  const record = parsed as Record<string, unknown>
  const type = record.type
  if (type !== REGISTRATION_EIP_TYPE && type !== REGISTRATION_BARE_TYPE) {
    throw new WrongType("The registration type is not registration-v1.")
  }
  if (bytes.length > cap) {
    throw new TooLarge(`The registration is ${bytes.length} bytes. The cap is ${cap} bytes.`)
  }
  const result: ValidatedRegistration = { type, size: bytes.length, uri }
  if (typeof record.name === "string") result.name = record.name
  return result
}

/**
 * Accept a number or bigint chain id only when it equals config.chainId.
 * Also requires config.caip2 to be "eip155:" plus that chain id.
 * There is no chain id literal in this function.
 */
export function assertChain84532(chainId: number | bigint): void {
  const expected = erc8004Config.chainId
  if (erc8004Config.caip2 !== `eip155:${String(expected)}`) {
    throw new WrongChain("Config caip2 does not match the configured chain id.")
  }
  const matches = typeof chainId === "bigint" ? chainId === BigInt(expected) : chainId === expected
  if (!matches) throw new WrongChain(`Chain ${String(chainId)} is not the configured chain.`)
}

export function buildRegisterWrite(uri: string): { to: Address; data: Hex } {
  const data = encodeFunctionData({
    abi: REGISTER_STRING_ABI,
    functionName: "register",
    args: [uri],
  })
  if (!data.startsWith(REGISTER_STRING_SELECTOR)) {
    throw new Error("register(string) calldata is missing selector 0xf2c298be.")
  }
  return { to: registryAddress(), data }
}

export async function dryRunRegister(
  client: DryRunClient,
  from: Address,
  uri: string,
): Promise<{ provisionalId: bigint; gas: bigint }> {
  if (client.chain?.id != null) assertChain84532(client.chain.id)
  const account = getAddress(from)
  const write = buildRegisterWrite(uri)
  try {
    const simulated = await client.simulateContract({
      address: write.to,
      abi: REGISTER_STRING_ABI,
      functionName: "register",
      args: [uri],
      account,
    })
    const gas = await client.estimateGas({
      account,
      to: write.to,
      data: write.data,
    })
    if (typeof simulated.result !== "bigint") {
      throw new DryRunReverted("The dry run did not return an agent id.")
    }
    return { provisionalId: simulated.result, gas }
  } catch (error) {
    if (error instanceof RegisterError) throw error
    const detail = error instanceof Error && error.message ? error.message : "The register dry run reverted."
    throw new DryRunReverted(detail, { cause: error })
  }
}

/** Count of identity NFTs owned by `owner`. balanceOf only. No log scan and no token id lookup. */
export async function findExistingAgent(client: BalanceClient, owner: Address): Promise<{ count: bigint }> {
  const account = getAddress(owner)
  const count = await client.readContract({
    address: registryAddress(),
    abi: identityRegistry8004Abi,
    functionName: "balanceOf",
    args: [account],
  })
  if (typeof count !== "bigint") throw new Unknown("balanceOf did not return a count.")
  return { count }
}

function sameRegistry(address: string): boolean {
  if (!isAddress(address)) return false
  return isAddressEqual(address, registryAddress())
}

/**
 * Read Registered logs whose address is the configured registry (checksum-insensitive).
 * Look-alike Registered logs from any other address are ignored.
 * When several registry logs match, the last one is used.
 * Returns null when none match. This function does not throw for a missing event.
 */
export function parseRegistered(receipt: { logs?: readonly RegisterLog[] | null }): ParsedRegistered | null {
  let last: ParsedRegistered | null = null
  for (const log of receipt.logs ?? []) {
    if (!sameRegistry(log.address) || log.topics.length === 0) continue
    try {
      const decoded = decodeEventLog({
        abi: identityRegistry8004Abi,
        eventName: "Registered",
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      })
      if (decoded.eventName !== "Registered") continue
      const args = decoded.args as { agentId?: unknown; owner?: unknown; agentURI?: unknown }
      if (typeof args.agentId !== "bigint") continue
      if (typeof args.owner !== "string" || !isAddress(args.owner)) continue
      if (typeof args.agentURI !== "string") continue
      last = { agentId: args.agentId, owner: getAddress(args.owner), agentURI: args.agentURI }
    } catch {
      continue
    }
  }
  return last
}

/** `eip155:<chainId>:<registry>:<id>` in decimal, with the registry text left as given. */
export function formatAgentId(chainId: number | bigint, registry: string, id: number | bigint): string {
  const chain = typeof chainId === "bigint" ? chainId.toString(10) : String(chainId)
  const agent = typeof id === "bigint" ? id.toString(10) : String(id)
  return `eip155:${chain}:${registry}:${agent}`
}

/**
 * EIP-1193 4902 means the wallet does not have this chain yet. That is Unknown, not WrongChain.
 * 4100, 4900, 4901, -32603, and -32002 are also Unknown.
 * WrongChain is a connected chain that does not match (ChainMismatchError, or a mismatch message without those codes).
 */
const UNKNOWN_WALLET_CODES = new Set([4902, 4100, 4900, 4901, -32603, -32002])

const USER_REJECT_TEXT = /user rejected|user denied|rejected the request|request rejected/i

const INSUFFICIENT_TEXT = /insufficient balance|islowbalance/i

const WRONG_CHAIN_TEXT = /chain mismatch|wrong chain|wrong network|network mismatch|unrecognized chain|does not match the target chain/i

const WRONG_CHAIN_NAMES = new Set(["ChainMismatchError", "ChainNotFoundError"])

function numericCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value)
  return null
}

function textOf(error: unknown): string {
  const parts: string[] = []
  for (const item of nodesOf(error)) {
    if (!item || typeof item !== "object") continue
    const record = item as { message?: unknown; shortMessage?: unknown; details?: unknown }
    for (const part of [record.shortMessage, record.message, record.details]) {
      if (typeof part === "string") parts.push(part)
    }
  }
  return parts.join("\n")
}

function codesOf(error: unknown): number[] {
  const codes: number[] = []
  for (const item of nodesOf(error)) {
    if (!item || typeof item !== "object" || !("code" in item)) continue
    const code = numericCode((item as { code?: unknown }).code)
    if (code != null) codes.push(code)
  }
  return codes
}

function namesOf(error: unknown): string[] {
  const names: string[] = []
  for (const item of nodesOf(error)) {
    if (!item || typeof item !== "object") continue
    const name = (item as { name?: unknown }).name
    if (typeof name === "string") names.push(name)
  }
  return names
}

export function normalizeWalletError(error: unknown): RegisterError {
  if (error instanceof RegisterError) return error
  if (isWalletCancel(error) || USER_REJECT_TEXT.test(textOf(error))) {
    return new UserRejected("The wallet rejected the request.", { cause: error })
  }
  if (isLowBalance(error) || namesOf(error).includes("InsufficientFundsError") || INSUFFICIENT_TEXT.test(textOf(error))) {
    return new InsufficientFunds("The wallet balance does not cover gas.", { cause: error })
  }
  if (codesOf(error).some((code) => UNKNOWN_WALLET_CODES.has(code))) {
    return new Unknown("The wallet returned an unrecognized error.", { cause: error })
  }
  if (namesOf(error).some((name) => WRONG_CHAIN_NAMES.has(name)) || WRONG_CHAIN_TEXT.test(textOf(error))) {
    return new WrongChain("The wallet is connected to a different chain.", { cause: error })
  }
  return new Unknown("The wallet request failed.", { cause: error })
}

/**
 * Report whether `from` can pay `gas` at the current fee, with a 20% margin.
 * needed = gas * maxFeePerGas, then needed = needed * 120 / 100.
 * When estimateFeesPerGas has no maxFeePerGas, gasPrice is used in its place.
 * Division floors. This function does not throw InsufficientFunds. ok is false when the balance is short.
 */
export async function checkBalanceForGas(
  client: FeeReader,
  from: Address,
  gas: bigint,
): Promise<{ ok: boolean; balance: bigint; needed: bigint }> {
  const account = getAddress(from)
  let fee: bigint | null = null
  if (client.estimateFeesPerGas) {
    try {
      const quoted = await client.estimateFeesPerGas()
      if (quoted && typeof quoted === "object" && "maxFeePerGas" in quoted && typeof quoted.maxFeePerGas === "bigint") {
        fee = quoted.maxFeePerGas
      }
    } catch (error) {
      if (!client.getGasPrice) throw new Unknown("Fee data could not be read.", { cause: error })
    }
  }
  if (fee == null) {
    if (!client.getGasPrice) throw new Unknown("The client did not offer a gas fee.")
    fee = await client.getGasPrice()
  }
  const needed = (gas * fee * 120n) / 100n
  const balance = await client.getBalance({ address: account })
  return { ok: balance >= needed, balance, needed }
}

function isWaitTimeout(error: unknown): boolean {
  if (error instanceof WaitForTransactionReceiptTimeoutError) return true
  return namesOf(error).includes("WaitForTransactionReceiptTimeoutError")
}

type WaitReceipt = Awaited<ReturnType<ReceiptClient["waitForTransactionReceipt"]>>

/**
 * Wait for the register receipt.
 * repriced: record the replacement hash, call onStatus, and do not throw.
 * viem resolves waitForTransactionReceipt with the replacement receipt when onReplaced does not throw.
 * If that receipt is still the original hash, wait once more on the replacement hash.
 * replaced throws Replaced. cancelled throws Cancelled.
 * A timeout throws Unknown. There is no Dropped class. onStatus is invoked with phase "timeout" first.
 * A receipt with no registry Registered log throws NoRegisteredEvent.
 */
export async function waitForRegisterReceipt(
  client: ReceiptClient,
  hash: Hex,
  onStatus?: RegisterStatusListener,
): Promise<RegisterWaitResult<WaitReceipt>> {
  let followed = hash
  let decided: RegisterError | null = null
  let receipt: WaitReceipt
  try {
    receipt = await client.waitForTransactionReceipt({
      hash,
      onReplaced(response) {
        if (response.reason === "repriced") {
          followed = response.transaction.hash
          onStatus?.({ phase: "repriced", hash: followed })
          return
        }
        if (response.reason === "replaced") {
          decided = new Replaced("The register transaction was replaced.")
          throw decided
        }
        if (response.reason === "cancelled") {
          decided = new Cancelled("The register transaction was cancelled.")
          throw decided
        }
        decided = new Unknown("The register transaction changed in an unexpected way.")
        throw decided
      },
    })
  } catch (error) {
    if (decided) throw decided
    if (error instanceof RegisterError) throw error
    if (isWaitTimeout(error)) {
      onStatus?.({ phase: "timeout", hash: followed })
      throw new Unknown("Timed out waiting for the register receipt.", { cause: error })
    }
    throw new Unknown("The register receipt could not be loaded.", { cause: error })
  }
  if (decided) throw decided
  if (followed.toLowerCase() !== hash.toLowerCase() && receipt.transactionHash.toLowerCase() !== followed.toLowerCase()) {
    receipt = await client.waitForTransactionReceipt({ hash: followed })
  }
  const parsed = parseRegistered(receipt)
  if (!parsed) throw new NoRegisteredEvent("The registry did not emit Registered.")
  return { receipt, hash: receipt.transactionHash, ...parsed }
}
