import type { Address } from "viem"
import { ADDRESSES } from "./addresses"
import { isZeroAddress, sameAddress } from "./format"
import type { GateStatus } from "./read"

/** Plain words for the address-book field `governanceTimelock`. */
export const GOVERNANCE_TIMELOCK_ROLE = "governance timelock"

/** Row pin text for a live owner or escrow governance() check. */
export const GOVERNANCE_TIMELOCK_PIN = "the governance timelock"

export const GATE_OWNER_MATCH =
  "Owner is the governance timelock and pendingOwner is none on Denylist and Vault."

export const GATE_OWNER_MISMATCH = "Live ownership does not match the Gate A pin."

export const LINK_OWNER_MATCH = "Owners match the governance timelock and the liability link is mutual."

export const LINK_OWNER_MISMATCH = "Live link does not match the pin."

export const MISSING_GOVERNANCE_TIMELOCK = "The address book has no governance timelock."

/**
 * Expected owner of the live Denylist, Vault, Liability, InsuranceFund,
 * and of owner() and governance() on the live escrow.
 * Read from the address book (`governanceTimelock`). Null when that field
 * is absent, so the UI does not invent an address.
 */
export function liveExpectedOwner(): Address | null {
  return ADDRESSES.governanceTimelock
}

function ownerNote(name: string, actual: string, expected: Address | null): string | null {
  if (expected == null) return null
  if (!sameAddress(actual, expected)) return `${name} owner is not the governance timelock.`
  return null
}

export function gateAOwnershipNotes(status: GateStatus, expected: Address | null = liveExpectedOwner()): string[] {
  const notes: string[] = []
  if (expected == null) notes.push(MISSING_GOVERNANCE_TIMELOCK)
  const denylist = ownerNote("Denylist", status.denylist.owner, expected)
  if (denylist) notes.push(denylist)
  if (!isZeroAddress(status.denylist.pendingOwner)) notes.push("Denylist pendingOwner is set.")
  const vault = ownerNote("Vault", status.vault.owner, expected)
  if (vault) notes.push(vault)
  if (!isZeroAddress(status.vault.pendingOwner)) notes.push("Vault pendingOwner is set.")
  if (!sameAddress(status.vault.denylist, ADDRESSES.denylist)) {
    notes.push("Vault.denylist() does not match the pinned Denylist.")
  }
  return notes
}

export function liabilityLinkNotes(status: GateStatus, expected: Address | null = liveExpectedOwner()): string[] {
  const notes: string[] = []
  if (expected == null) notes.push(MISSING_GOVERNANCE_TIMELOCK)
  const liability = ownerNote("Liability", status.liability.owner, expected)
  if (liability) notes.push(liability)
  const insurance = ownerNote("InsuranceFund", status.insuranceFund.owner, expected)
  if (insurance) notes.push(insurance)
  if (!sameAddress(status.liability.insurance, ADDRESSES.insuranceFund)) {
    notes.push("Liability.insurance() does not match the pinned InsuranceFund.")
  }
  if (!sameAddress(status.insuranceFund.liability, ADDRESSES.liability)) {
    notes.push("InsuranceFund.liability() does not match the pinned Liability.")
  }
  return notes
}
