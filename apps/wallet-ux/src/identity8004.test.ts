import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createPublicClient, custom, hashTypedData, pad, toHex, type Address, type Hex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { baseSepolia } from "viem/chains"
import { describe, expect, it } from "vitest"
import { explorerUrl } from "./ui"
import {
  AGENT_BV_CHALLENGE_TYPES,
  CHECKED_IN_BROWSER,
  NO_ID_TEXT,
  WALLET_NOT_SET_TEXT,
  agentIdFromHref,
  basescanAgentUrl,
  basescanRegistryUrl,
  blockReason,
  buildChallenge,
  challengeRpcBody,
  challengeTypedData,
  eip1967ImplementationSlot,
  identityDomain,
  identityRegistryAddress,
  implementationFromStorage,
  isIdentityGatewayPath,
  onboardingNext,
  parseAgentId,
  pinnedImplementation,
  registryDomainFrom,
  registryDomainMatches,
  requestChallengeSignature,
  verifyAgentChallenge,
  type IdentityRecord,
} from "./identity8004"

const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e"
const NOW = 1_700_000_000

function record(overrides: Partial<IdentityRecord> = {}): IdentityRecord {
  const agentWallet = overrides.agentWallet ?? ("0x0000000000000000000000000000000000000001" as Address)
  return {
    agentId: 7n,
    owner: agentWallet,
    agentWallet,
    agentURI: "https://example.com/agent.json",
    implementation: pinnedImplementation(),
    implementationMatches: true,
    registryDomain: {
      name: "ERC8004IdentityRegistry",
      version: "1",
      chainId: 84532n,
      verifyingContract: identityRegistryAddress(),
    },
    registryDomainMatches: true,
    ...overrides,
  }
}

function verifierClient() {
  // viem's public verifyTypedData tries the ERC-6492 verifier, then EOA recovery,
  // and uses ERC-1271 or ERC-8010 when the account is a contract or a 7702 delegation.
  // This transport answers the verifier call immediately so the test does not dial a network.
  return createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: async () => "0x0",
    }),
  })
}

describe("erc8004 config", () => {
  it("pins the existing Base Sepolia identity registry and the browser route", () => {
    expect(identityRegistryAddress()).toBe(REGISTRY)
    expect(identityDomain()).toEqual({
      name: "Agent-BV Identity",
      version: "1",
      chainId: 84532,
      verifyingContract: REGISTRY,
    })
    expect(onboardingNext()).toEqual({
      action: "register_and_verify",
      register: {
        agentRegistry: `eip155:84532:${REGISTRY}`,
        function: "register(string)",
      },
      verify_url: "https://agent-bv.pages.dev/app/identity",
      retry: "call /v1/access/check again with agent_id",
    })
    expect(NO_ID_TEXT).toBe("Register here, get verified, come back.")
    expect(CHECKED_IN_BROWSER).toBe("checked in your browser")
    expect(WALLET_NOT_SET_TEXT).toBe("wallet_not_set / can't verify")
    expect(basescanRegistryUrl()).toBe(explorerUrl(REGISTRY))
    expect(basescanAgentUrl(7n)).toBe(`https://sepolia.basescan.org/nft/${REGISTRY}/7`)
  })

  it("derives the implementation slot instead of embedding it", () => {
    const slot = eip1967ImplementationSlot()
    expect(slot).toBe(eip1967ImplementationSlot())
    expect(slot.length).toBe(2 + 64)
    const word = pad(pinnedImplementation(), { size: 32 })
    expect(implementationFromStorage(word)).toBe(pinnedImplementation())
    expect(() => implementationFromStorage("0x1234")).toThrow(/implementation slot/)
  })
})

describe("route and agent id", () => {
  it("recognizes only the wallet identity path", () => {
    expect(isIdentityGatewayPath("https://agent-bv.pages.dev/app/identity")).toBe(true)
    expect(isIdentityGatewayPath("https://agent-bv.pages.dev/app/identity/")).toBe(true)
    expect(isIdentityGatewayPath("https://agent-bv.pages.dev/app/identity?agentId=7")).toBe(true)
    expect(isIdentityGatewayPath("https://agent-bv.pages.dev/app/")).toBe(false)
    expect(isIdentityGatewayPath("https://agent-bv.pages.dev/identity")).toBe(false)
    expect(isIdentityGatewayPath("https://agent-bv.pages.dev/app/fund")).toBe(false)
    expect(agentIdFromHref("https://agent-bv.pages.dev/app/identity?agentId=12")).toBe("12")
    expect(agentIdFromHref("https://agent-bv.pages.dev/app/identity")).toBe("")
  })

  it("parses a decimal agent id and rejects anything else", () => {
    expect(parseAgentId("0")).toBe(0n)
    expect(parseAgentId("10702")).toBe(10702n)
    expect(parseAgentId(" 15 ")).toBe(15n)
    expect(parseAgentId("")).toBeNull()
    expect(parseAgentId("1.5")).toBeNull()
    expect(parseAgentId("-1")).toBeNull()
    expect(parseAgentId("0x10")).toBeNull()
    expect(parseAgentId("1".repeat(80))).toBeNull()
  })
})

describe("registry domain", () => {
  it("accepts the pinned registry domain from a named or positional result", () => {
    const named = registryDomainFrom({
      fields: "0x0f",
      name: "ERC8004IdentityRegistry",
      version: "1",
      chainId: 84532n,
      verifyingContract: REGISTRY,
      salt: "0x00",
      extensions: [],
    })
    expect(registryDomainMatches(named)).toBe(true)
    const positional = registryDomainFrom(["0x0f", "ERC8004IdentityRegistry", "1", 84532, REGISTRY])
    expect(registryDomainMatches(positional)).toBe(true)
    expect(registryDomainMatches({ ...named, name: "Other" })).toBe(false)
    expect(registryDomainMatches({ ...named, chainId: 1n })).toBe(false)
  })
})

describe("challenge verification", () => {
  it("rejects a zero agent wallet before a signature check", () => {
    const zero = "0x0000000000000000000000000000000000000000" as Address
    const challenge = buildChallenge(7n, zero, NOW, toHex(new Uint8Array(32)))
    const row = record({ agentWallet: zero, owner: "0x0000000000000000000000000000000000000001" })
    expect(blockReason(row, challenge, NOW)).toBe("wallet_not_set")
  })

  it("rejects an expired challenge, a changed implementation, and a stale reread", async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const row = record({ agentWallet: account.address, owner: account.address })
    const challenge = buildChallenge(row.agentId, account.address, NOW, toHex(Uint8Array.from({ length: 32 }, (_, i) => i + 1)))
    expect(blockReason(row, challenge, NOW + 601)).toBe("expired")
    expect(blockReason({ ...row, implementationMatches: false }, challenge, NOW)).toBe("impl_changed")
    expect(blockReason({ ...row, registryDomainMatches: false }, challenge, NOW)).toBe("registry_domain_changed")

    const signature = await account.signTypedData(challengeTypedData(challenge))
    const moved = record({
      agentWallet: "0x0000000000000000000000000000000000000002",
      owner: account.address,
    })
    const stale = await verifyAgentChallenge({
      verifier: verifierClient(),
      record: row,
      challenge,
      signature,
      nowSeconds: NOW,
      reread: async () => moved,
    })
    expect(stale.verified).toBe(false)
    expect(stale.reason).toBe("stale")
  })

  it("verifies an EOA signature with viem and rejects a different signer", async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const other = privateKeyToAccount(generatePrivateKey())
    const row = record({ agentWallet: account.address, owner: account.address })
    const challenge = buildChallenge(row.agentId, account.address, NOW, toHex(Uint8Array.from({ length: 32 }, () => 7)))
    const signature = await account.signTypedData(challengeTypedData(challenge))
    const rpc = JSON.parse(challengeRpcBody(challenge)) as {
      domain: { name: string; version: string; chainId: number; verifyingContract: Address }
      message: { agentId: string; agentWallet: Address; nonce: Hex; deadline: string }
    }
    expect(
      hashTypedData({
        domain: rpc.domain,
        types: AGENT_BV_CHALLENGE_TYPES,
        primaryType: "AgentBVChallenge",
        message: {
          agentId: BigInt(rpc.message.agentId),
          agentWallet: rpc.message.agentWallet,
          nonce: rpc.message.nonce,
          deadline: BigInt(rpc.message.deadline),
        },
      }),
    ).toBe(hashTypedData(challengeTypedData(challenge)))

    const ok = await verifyAgentChallenge({
      verifier: verifierClient(),
      record: row,
      challenge,
      signature,
      nowSeconds: NOW,
      reread: async () => row,
    })
    expect(ok).toMatchObject({ verified: true, reason: "verified", agentWallet: account.address })

    const wrong = await verifyAgentChallenge({
      verifier: verifierClient(),
      record: row,
      challenge,
      signature: await other.signTypedData(challengeTypedData(challenge)),
      nowSeconds: NOW,
      reread: async () => row,
    })
    expect(wrong.verified).toBe(false)
    expect(wrong.reason).toBe("bad_signature")
  })

  it("asks the wallet through the typed-data RPC and does not add a second helper call", async () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    for (const file of ["identity8004.ts", "IdentityGateway.tsx"]) {
      const source = readFileSync(join(dir, file), "utf8")
      expect(source.includes("signTypedData(")).toBe(false)
      expect(source.includes("useWriteContract")).toBe(false)
      expect(source.includes("writeContract(")).toBe(false)
      expect(source.includes("wallet_sendTransaction")).toBe(false)
    }
    const account = privateKeyToAccount(generatePrivateKey())
    const challenge = buildChallenge(1n, account.address, NOW, toHex(new Uint8Array(32)))
    const seen: { method?: string; params?: readonly unknown[] } = {}
    const signature = await requestChallengeSignature(
      {
        request: async (args) => {
          seen.method = args.method
          seen.params = args.params
          return account.signTypedData(challengeTypedData(challenge))
        },
      },
      account.address,
      challenge,
    )
    expect(seen.method).toBe("eth_signTypedData_v4")
    expect(seen.params?.[0]).toBe(account.address)
    expect(typeof seen.params?.[1]).toBe("string")
    const checked = await verifyAgentChallenge({
      verifier: verifierClient(),
      record: record({ agentWallet: account.address, owner: account.address, agentId: 1n }),
      challenge,
      signature,
      nowSeconds: NOW,
      reread: async () => record({ agentWallet: account.address, owner: account.address, agentId: 1n }),
    })
    expect(checked.verified).toBe(true)
  })
})
