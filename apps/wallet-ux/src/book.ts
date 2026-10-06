import { getAddress, isAddress, type Address } from "viem"

export const BASE_SEPOLIA_CHAIN_ID = 84532 as const
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const

/**
 * Corrected Gate A pin. Used only when src/base-sepolia.json is missing
 * or fails validation. These are the live slots, never book.superseded.
 */
export const FALLBACK_PIN = {
  chainId: BASE_SEPOLIA_CHAIN_ID,
  network: "base-sepolia",
  /** Pre-migration owner. The CORE EOA, not the TimelockController. */
  coreTimelock: "0x10CC9474b45625ADfd05C209f2518023484878D9",
  denylist: "0xeE76876bECcFc1B58fC06fF4E654a517d784B224",
  vault: "0x1463D664fA467FBCDA4B05443434494f05e565bc",
  disputePanel: "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb",
  liability: "0x554Caf5a214B8d70D675C09186C5EAE24FEB7307",
  insuranceFund: "0x19fc26B36Cb2031062eD90C19db64b3b09753ab8",
  botAttestationEscrow: "0x3d660502D75f1e97b08c110255921b437A3C4C42",
} as const

/** Previous Denylist, Vault, and retired escrows. Blocked as a read target. Not rendered and not called. */
export const SUPERSEDED = {
  denylist: "0xF0f260967D377E07Bdd7840862508ddB23C012b8",
  vault: "0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7",
  /** Pre-ESC-M-1 escrow. Retired 2026-09-26. */
  botAttestationEscrow: "0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c",
  /** ESC-M-1 escrow. Retired 2026-10-06 by the pull-payment redeploy. */
  botAttestationEscrowEscM1: "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d",
} as const

export type BookSource = "src/base-sepolia.json" | "fallback-pin"

export type AddressBook = {
  source: BookSource
  chainId: typeof BASE_SEPOLIA_CHAIN_ID
  network: "base-sepolia"
  /** Pre-migration owner. The CORE EOA, not the TimelockController. */
  coreTimelock: Address
  /** TimelockController from DeployTimelock. Null until that broadcast is recorded. */
  governanceTimelock: Address | null
  denylist: Address
  vault: Address
  disputePanel: Address
  liability: Address
  insuranceFund: Address
  botAttestationEscrow: Address | null
  bvt: Address | null
  bvtStaking: Address | null
  bvtFeeRouter: Address | null
  bvtTimelock: Address | null
  bvtGovernor: Address | null
}

const REQUIRED_SLOTS = ["Denylist", "Vault", "DisputePanel", "Liability", "InsuranceFund"] as const
const NULLABLE_SLOTS = [
  "BotAttestationEscrow",
  "BVT",
  "BVTStaking",
  "BVTFeeRouter",
  "BVTTimelock",
  "BVTGovernor",
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function checksum(value: unknown): Address | null {
  if (typeof value !== "string" || !isAddress(value)) return null
  return getAddress(value)
}

function addBlocked(blocked: Set<string>, container: unknown, keys: readonly string[]) {
  if (!isRecord(container)) return
  for (const key of keys) {
    const row = container[key]
    if (!isRecord(row)) continue
    const address = checksum(row.address)
    if (address) blocked.add(address.toLowerCase())
  }
}

function forbiddenAddresses(raw: Record<string, unknown>): Set<string> {
  const blocked = new Set<string>([
    SUPERSEDED.denylist.toLowerCase(),
    SUPERSEDED.vault.toLowerCase(),
    SUPERSEDED.botAttestationEscrow.toLowerCase(),
    SUPERSEDED.botAttestationEscrowEscM1.toLowerCase(),
  ])
  addBlocked(blocked, raw.superseded, ["Denylist", "Vault", "BotAttestationEscrow"])
  addBlocked(blocked, raw.retired, ["BotAttestationEscrow", "BotAttestationEscrowEscM1"])
  return blocked
}

function requiredSlot(raw: Record<string, unknown>, key: string): Address | null {
  const slot = raw[key]
  if (!isRecord(slot)) return null
  return checksum(slot.address)
}

function nullableSlot(raw: Record<string, unknown>, key: string): Address | null | "bad" {
  const slot = raw[key]
  if (!isRecord(slot) || !("address" in slot)) return "bad"
  if (slot.address === null) return null
  return checksum(slot.address) ?? "bad"
}

export function fallbackBook(): AddressBook {
  return {
    source: "fallback-pin",
    chainId: BASE_SEPOLIA_CHAIN_ID,
    network: "base-sepolia",
    coreTimelock: getAddress(FALLBACK_PIN.coreTimelock),
    governanceTimelock: null,
    denylist: getAddress(FALLBACK_PIN.denylist),
    vault: getAddress(FALLBACK_PIN.vault),
    disputePanel: getAddress(FALLBACK_PIN.disputePanel),
    liability: getAddress(FALLBACK_PIN.liability),
    insuranceFund: getAddress(FALLBACK_PIN.insuranceFund),
    botAttestationEscrow: getAddress(FALLBACK_PIN.botAttestationEscrow),
    bvt: null,
    bvtStaking: null,
    bvtFeeRouter: null,
    bvtTimelock: null,
    bvtGovernor: null,
  }
}

/** Null, blank, or the zero address means the TimelockController is not recorded yet. */
function readGovernanceTimelock(raw: Record<string, unknown>): Address | null | "bad" {
  if (!("governanceTimelock" in raw)) return null
  const value = raw.governanceTimelock
  if (value === null || value === "") return null
  const address = checksum(value)
  if (!address) return "bad"
  if (address === ZERO_ADDRESS) return null
  return address
}

function usesForbidden(address: Address | null, blocked: Set<string>): boolean {
  return address != null && blocked.has(address.toLowerCase())
}

/**
 * Read live slots from the deployment book. `superseded` is consulted only so
 * those addresses cannot become a read target. Any failure returns the pin.
 */
export function resolveAddressBook(raw: unknown): AddressBook {
  const fallback = fallbackBook()
  if (!isRecord(raw)) return fallback
  if (raw.chainId !== BASE_SEPOLIA_CHAIN_ID || raw.network !== "base-sepolia") return fallback

  const blocked = forbiddenAddresses(raw)
  const coreTimelock = checksum(raw.coreTimelock)
  const governanceTimelock = readGovernanceTimelock(raw)
  const denylist = requiredSlot(raw, "Denylist")
  const vaultSlot = raw.Vault
  const vault = requiredSlot(raw, "Vault")
  const vaultDenylist = isRecord(vaultSlot) ? checksum(vaultSlot.denylist) : null
  const disputePanel = requiredSlot(raw, "DisputePanel")
  const liability = requiredSlot(raw, "Liability")
  const insuranceFund = requiredSlot(raw, "InsuranceFund")

  if (
    governanceTimelock === "bad" ||
    !coreTimelock ||
    !denylist ||
    !vault ||
    !vaultDenylist ||
    !disputePanel ||
    !liability ||
    !insuranceFund
  ) {
    return fallback
  }
  if (vaultDenylist !== denylist) return fallback
  if (coreTimelock === ZERO_ADDRESS) return fallback
  if (usesForbidden(governanceTimelock, blocked)) return fallback

  const nullable: Record<(typeof NULLABLE_SLOTS)[number], Address | null> = {
    BotAttestationEscrow: null,
    BVT: null,
    BVTStaking: null,
    BVTFeeRouter: null,
    BVTTimelock: null,
    BVTGovernor: null,
  }
  for (const key of NULLABLE_SLOTS) {
    const address = nullableSlot(raw, key)
    if (address === "bad") return fallback
    nullable[key] = address
  }

  const live = [coreTimelock, denylist, vault, disputePanel, liability, insuranceFund, ...Object.values(nullable)]
  if (live.some((address) => usesForbidden(address, blocked))) return fallback
  for (const key of REQUIRED_SLOTS) {
    if (!isRecord(raw[key])) return fallback
  }

  return {
    source: "src/base-sepolia.json",
    chainId: BASE_SEPOLIA_CHAIN_ID,
    network: "base-sepolia",
    coreTimelock,
    governanceTimelock,
    denylist,
    vault,
    disputePanel,
    liability,
    insuranceFund,
    botAttestationEscrow: nullable.BotAttestationEscrow,
    bvt: nullable.BVT,
    bvtStaking: nullable.BVTStaking,
    bvtFeeRouter: nullable.BVTFeeRouter,
    bvtTimelock: nullable.BVTTimelock,
    bvtGovernor: nullable.BVTGovernor,
  }
}
