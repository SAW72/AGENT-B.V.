/**
 * Base Sepolia ERC-8004 identity read and browser check.
 * The wallet signs a free off-chain challenge. This module does not send a transaction.
 * Verification uses viem verifyTypedData, which covers EOAs, ERC-1271, and 7702 accounts.
 */

import {
  getAddress,
  isAddress,
  keccak256,
  toBytes,
  toHex,
  type Address,
  type Hex,
} from "viem"
import { identityRegistry8004Abi } from "./abi"
import { isZeroAddress, sameAddress } from "./format"
import type { SepoliaClient } from "./read"
import { revertDataOf } from "./revert"
import erc8004Config from "../../../config/erc8004-base-sepolia.json" with { type: "json" }

export const CHECKED_IN_BROWSER = "Checks run in your browser"
export const PUBLIC_RPC_HOST = "sepolia.base.org"
export const WALLET_NOT_SET_TEXT = "wallet_not_set / can't verify"
export const NO_ID_TEXT = "Register here, get verified, come back."
export const AGENT_ID_DECIMAL_TEXT = "Enter the agent id as a decimal integer."
export const AGENT_ID_RANGE_TEXT = "That agent id is outside the uint256 range."
export const IDENTITY_GATEWAY_PATH = erc8004Config.gatewayPath
const NONEXISTENT_TOKEN_SELECTOR = "0x7e273289"

const PINNED_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e"
const UINT256_MAX = (1n << 256n) - 1n

export const AGENT_BV_CHALLENGE_TYPES = {
  AgentBVChallenge: [
    { name: "agentId", type: "uint256" },
    { name: "agentWallet", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const

export type VerifyReason =
  | "verified"
  | "wallet_not_set"
  | "impl_changed"
  | "registry_domain_changed"
  | "expired"
  | "agent_mismatch"
  | "wallet_mismatch"
  | "bad_signature"
  | "stale"

export type Challenge = {
  agentId: bigint
  agentWallet: Address
  nonce: Hex
  deadline: bigint
}

export type RegistryDomain = {
  name: string
  version: string
  chainId: bigint
  verifyingContract: Address
}

export type IdentityRecord = {
  agentId: bigint
  owner: Address
  agentWallet: Address
  agentURI: string
  implementation: Address
  implementationMatches: boolean
  registryDomain: RegistryDomain
  registryDomainMatches: boolean
}

export type VerifyResult = {
  owner: Address
  agentWallet: Address
  agentURI: string
  verified: boolean
  reason: VerifyReason
}

export type TypedDataVerifier = {
  verifyTypedData: (args: {
    address: Address
    domain: ReturnType<typeof identityDomain>
    types: typeof AGENT_BV_CHALLENGE_TYPES
    primaryType: "AgentBVChallenge"
    message: {
      agentId: bigint
      agentWallet: Address
      nonce: Hex
      deadline: bigint
    }
    signature: Hex
  }) => Promise<boolean>
}

type Eip1193Provider = {
  request: (args: { method: string; params?: readonly unknown[] }) => Promise<unknown>
}

function assertBaseSepoliaConfig(): void {
  if (erc8004Config.chainId !== 84532 || erc8004Config.eip712.chainId !== 84532) {
    throw new Error("ERC-8004 identity gateway is Base Sepolia (84532) only.")
  }
  if (erc8004Config.eip712.name !== "Agent-BV Identity" || erc8004Config.eip712.version !== "1") {
    throw new Error("ERC-8004 challenge domain must be Agent-BV Identity version 1.")
  }
  if (erc8004Config.eip712.primaryType !== "AgentBVChallenge") {
    throw new Error("ERC-8004 challenge type must be AgentBVChallenge.")
  }
  if (getAddress(erc8004Config.identityRegistry) !== getAddress(PINNED_REGISTRY)) {
    throw new Error("ERC-8004 config must use the existing Base Sepolia Identity Registry.")
  }
  if (erc8004Config.agentRegistry !== `eip155:84532:${PINNED_REGISTRY}`) {
    throw new Error("ERC-8004 config must use the existing Base Sepolia Identity Registry.")
  }
  if (getAddress(erc8004Config.eip712.verifyingContract) !== getAddress(PINNED_REGISTRY)) {
    throw new Error("ERC-8004 challenge domain must bind the existing Identity Registry.")
  }
}

assertBaseSepoliaConfig()

export function identityRegistryAddress(): Address {
  return getAddress(erc8004Config.identityRegistry)
}

export function pinnedImplementation(): Address {
  return getAddress(erc8004Config.identityRegistryImpl)
}

export function identityDomain() {
  return {
    name: erc8004Config.eip712.name,
    version: erc8004Config.eip712.version,
    chainId: erc8004Config.eip712.chainId,
    verifyingContract: getAddress(erc8004Config.eip712.verifyingContract),
  } as const
}

/** EIP-1967 implementation slot, derived so the source does not embed the slot word. */
export function eip1967ImplementationSlot(): Hex {
  const hashed = BigInt(keccak256(toBytes("eip1967.proxy.implementation")))
  return toHex(hashed - 1n, { size: 32 })
}

export function implementationFromStorage(raw: string): Address {
  if (!/^0x[0-9a-fA-F]+$/.test(raw) || raw.length < 42) {
    throw new Error("Identity registry implementation slot was not an address.")
  }
  const body = raw.slice(2)
  if (body.length % 2 !== 0) throw new Error("Identity registry implementation slot was not an address.")
  const addr = `0x${body.slice(-40)}`
  if (!isAddress(addr)) throw new Error("Identity registry implementation slot was not an address.")
  return getAddress(addr)
}

export function registryDomainFrom(value: unknown): RegistryDomain {
  const row = Array.isArray(value)
    ? {
        name: value[1],
        version: value[2],
        chainId: value[3],
        verifyingContract: value[4],
      }
    : value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null
  if (!row || typeof row.name !== "string" || typeof row.version !== "string") {
    throw new Error("Identity registry eip712Domain did not return a name and version.")
  }
  const chainRaw = row.chainId
  const chainId = typeof chainRaw === "bigint" ? chainRaw : typeof chainRaw === "number" ? BigInt(chainRaw) : null
  if (chainId == null || typeof row.verifyingContract !== "string" || !isAddress(row.verifyingContract)) {
    throw new Error("Identity registry eip712Domain did not return a contract.")
  }
  return {
    name: row.name,
    version: row.version,
    chainId,
    verifyingContract: getAddress(row.verifyingContract),
  }
}

export function registryDomainMatches(domain: RegistryDomain): boolean {
  return (
    domain.name === erc8004Config.registryEip712.name &&
    domain.version === erc8004Config.registryEip712.version &&
    domain.chainId === BigInt(erc8004Config.registryEip712.chainId) &&
    sameAddress(domain.verifyingContract, identityRegistryAddress())
  )
}

export function parseAgentId(raw: string): bigint | null {
  if (agentIdIssue(raw) != null) return null
  const trimmed = raw.trim()
  if (trimmed === "") return null
  return BigInt(trimmed)
}

/** `decimal` is not an integer. `range` is an integer above uint256. Null means empty or in range. */
export function agentIdIssue(raw: string): "decimal" | "range" | null {
  const trimmed = raw.trim()
  if (trimmed === "") return null
  if (!/^[0-9]+$/.test(trimmed)) return "decimal"
  if (BigInt(trimmed) > UINT256_MAX) return "range"
  return null
}

export function missingAgentMessage(agentId: bigint): string {
  return `No agent with id ${agentId.toString()} on this registry.`
}

export class MissingAgentError extends Error {
  readonly agentId: bigint

  constructor(agentId: bigint) {
    super(missingAgentMessage(agentId))
    this.name = "MissingAgentError"
    this.agentId = agentId
  }
}

export function isNonexistentTokenRevert(error: unknown): boolean {
  const data = revertDataOf(error)
  if (data && data.toLowerCase().startsWith(NONEXISTENT_TOKEN_SELECTOR)) return true
  if (error instanceof MissingAgentError) return true
  const text = error instanceof Error ? error.message : ""
  return text.toLowerCase().includes(NONEXISTENT_TOKEN_SELECTOR)
}

export function isIdentityGatewayPath(href: string): boolean {
  let url: URL
  try {
    url = new URL(href, "http://localhost")
  } catch {
    return false
  }
  const parts = url.pathname.split("/").filter((part) => part.length > 0)
  const expected = IDENTITY_GATEWAY_PATH.split("/").filter((part) => part.length > 0)
  return parts.length === expected.length && parts.every((part, index) => part === expected[index])
}

export function agentIdFromHref(href: string): string {
  try {
    return new URL(href, "http://localhost").searchParams.get("agentId")?.trim() ?? ""
  } catch {
    return ""
  }
}

export function onboardingNext() {
  return {
    action: "register_and_verify" as const,
    register: {
      agentRegistry: erc8004Config.agentRegistry,
      function: erc8004Config.registerFunction,
    },
    verify_url: erc8004Config.verifyUrl,
    retry: erc8004Config.retry,
  }
}

export function basescanRegistryUrl(): string {
  return `${erc8004Config.basescanSite}/address/${identityRegistryAddress()}`
}

export function basescanAgentUrl(agentId: bigint): string {
  return `${erc8004Config.basescanSite}/nft/${identityRegistryAddress()}/${agentId.toString()}`
}

export function basescanAddressUrl(address: Address): string {
  return `${erc8004Config.basescanSite}/address/${getAddress(address)}`
}

function asAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`Expected an address from ${label}.`)
  }
  return getAddress(value)
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Expected a string from ${label}.`)
  return value
}

export async function readAgentIdentity(client: SepoliaClient, agentId: bigint): Promise<IdentityRecord> {
  const registry = identityRegistryAddress()
  const abi = identityRegistry8004Abi
  let owner: unknown
  let agentWallet: unknown
  let agentURI: unknown
  let domainValue: unknown
  let implWord: string | undefined
  try {
    ;[owner, agentWallet, agentURI, domainValue, implWord] = await Promise.all([
      client.readContract({ address: registry, abi, functionName: "ownerOf", args: [agentId] }),
      client.readContract({ address: registry, abi, functionName: "getAgentWallet", args: [agentId] }),
      client.readContract({ address: registry, abi, functionName: "tokenURI", args: [agentId] }),
      client.readContract({ address: registry, abi, functionName: "eip712Domain" }),
      client.getStorageAt({ address: registry, slot: eip1967ImplementationSlot() }),
    ])
  } catch (error) {
    if (isNonexistentTokenRevert(error)) throw new MissingAgentError(agentId)
    throw error
  }
  if (implWord == null) throw new Error("Identity registry implementation slot was empty.")
  const implementation = implementationFromStorage(implWord)
  const registryDomain = registryDomainFrom(domainValue)
  const wallet = asAddress(agentWallet, "getAgentWallet")
  return {
    agentId,
    owner: asAddress(owner, "ownerOf"),
    agentWallet: wallet,
    agentURI: asString(agentURI, "agent URI"),
    implementation,
    implementationMatches: sameAddress(implementation, pinnedImplementation()),
    registryDomain,
    registryDomainMatches: registryDomainMatches(registryDomain),
  }
}

export function buildChallenge(agentId: bigint, agentWallet: Address, nowSeconds: number, nonce?: Hex): Challenge {
  if (!Number.isInteger(nowSeconds) || nowSeconds < 0) {
    throw new Error("Challenge time must be a unix second.")
  }
  const random = new Uint8Array(32)
  crypto.getRandomValues(random)
  return {
    agentId,
    agentWallet: getAddress(agentWallet),
    nonce: nonce ?? toHex(random),
    deadline: BigInt(nowSeconds) + BigInt(erc8004Config.challengeTtlSeconds),
  }
}

export function challengeTypedData(challenge: Challenge) {
  return {
    domain: identityDomain(),
    types: AGENT_BV_CHALLENGE_TYPES,
    primaryType: "AgentBVChallenge" as const,
    message: {
      agentId: challenge.agentId,
      agentWallet: challenge.agentWallet,
      nonce: challenge.nonce,
      deadline: challenge.deadline,
    },
  }
}

/** JSON body for eth_signTypedData_v4. uint256 values are decimal strings. */
export function challengeRpcBody(challenge: Challenge): string {
  const domain = identityDomain()
  return JSON.stringify({
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      AgentBVChallenge: AGENT_BV_CHALLENGE_TYPES.AgentBVChallenge,
    },
    primaryType: "AgentBVChallenge",
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    message: {
      agentId: challenge.agentId.toString(10),
      agentWallet: challenge.agentWallet,
      nonce: challenge.nonce,
      deadline: challenge.deadline.toString(10),
    },
  })
}

export function blockReason(record: IdentityRecord, challenge: Challenge, nowSeconds: number): VerifyReason | null {
  if (!record.implementationMatches) return "impl_changed"
  if (!record.registryDomainMatches) return "registry_domain_changed"
  if (challenge.agentId !== record.agentId) return "agent_mismatch"
  if (isZeroAddress(record.agentWallet)) return "wallet_not_set"
  if (!sameAddress(challenge.agentWallet, record.agentWallet)) return "wallet_mismatch"
  if (!Number.isInteger(nowSeconds) || nowSeconds < 0) return "expired"
  const now = BigInt(nowSeconds)
  const ttl = BigInt(erc8004Config.challengeTtlSeconds)
  const skew = BigInt(erc8004Config.challengeClockSkewSeconds)
  if (challenge.deadline < now) return "expired"
  if (challenge.deadline > now + ttl + skew) return "expired"
  return null
}

function resultFrom(record: IdentityRecord, verified: boolean, reason: VerifyReason): VerifyResult {
  return {
    owner: record.owner,
    agentWallet: record.agentWallet,
    agentURI: record.agentURI,
    verified,
    reason,
  }
}

export async function verifyAgentChallenge(args: {
  verifier: TypedDataVerifier
  record: IdentityRecord
  challenge: Challenge
  signature: Hex
  nowSeconds: number
  reread: () => Promise<IdentityRecord>
}): Promise<VerifyResult> {
  const blocked = blockReason(args.record, args.challenge, args.nowSeconds)
  if (blocked) return resultFrom(args.record, false, blocked)
  let signatureOk = false
  try {
    signatureOk = await args.verifier.verifyTypedData({
      address: args.record.agentWallet,
      signature: args.signature,
      ...challengeTypedData(args.challenge),
    })
  } catch {
    signatureOk = false
  }
  const fresh = await args.reread()
  if (!signatureOk) return resultFrom(fresh, false, "bad_signature")
  if (!sameAddress(fresh.owner, args.record.owner) || !sameAddress(fresh.agentWallet, args.record.agentWallet)) {
    return resultFrom(fresh, false, "stale")
  }
  if (!fresh.implementationMatches) return resultFrom(fresh, false, "impl_changed")
  if (!fresh.registryDomainMatches) return resultFrom(fresh, false, "registry_domain_changed")
  // The caller passes the clock taken after the signature returns. A deadline
  // behind that clock is expired even when the signature itself is valid.
  if (!Number.isInteger(args.nowSeconds) || args.nowSeconds < 0 || args.challenge.deadline < BigInt(args.nowSeconds)) {
    return resultFrom(fresh, false, "expired")
  }
  return resultFrom(fresh, true, "verified")
}

/**
 * Ask the connected wallet to sign the challenge.
 * The JSON-RPC method is used directly. wallet-ux already limits the ClaimIntent
 * helper call to the refund flow, and this check must not send a transaction.
 */
export async function requestChallengeSignature(
  provider: Eip1193Provider,
  account: Address,
  challenge: Challenge,
): Promise<Hex> {
  const signature = await provider.request({
    method: "eth_signTypedData_v4",
    params: [account, challengeRpcBody(challenge)],
  })
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error("The wallet did not return a signature.")
  }
  return signature as Hex
}

export async function providerFromConnector(connector: {
  getProvider: () => Promise<unknown>
}): Promise<Eip1193Provider> {
  const provider = await connector.getProvider()
  if (
    !provider ||
    typeof provider !== "object" ||
    !("request" in provider) ||
    typeof (provider as { request?: unknown }).request !== "function"
  ) {
    throw new Error("This wallet cannot sign the identity check.")
  }
  return provider as Eip1193Provider
}
