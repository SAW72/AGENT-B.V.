// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react"
import { getAddress, type Address } from "viem"
import { afterEach, describe, expect, it } from "vitest"
import { BookOwners, LiveStatus, PageFooter } from "./App"
import { ADDRESSES } from "./addresses"
import { DISCLAIMER_LINE, PAGE_FOOTER } from "./brand"
import deploymentBook from "./base-sepolia.json"
import { EscrowReads } from "./EscrowPanel"
import {
  GATE_OWNER_MATCH,
  GATE_OWNER_MISMATCH,
  LINK_OWNER_MATCH,
  LINK_OWNER_MISMATCH,
  MISSING_GOVERNANCE_TIMELOCK,
  gateAOwnershipNotes,
  liabilityLinkNotes,
  liveExpectedOwner,
} from "./gate"
import type { EscrowStatus, GateStatus } from "./read"

const OTHER_OWNER = "0x1111111111111111111111111111111111111111" as Address
const ZERO = "0x0000000000000000000000000000000000000000" as Address

const OWNER_ROWS = [
  "denylist-owner",
  "vault-owner",
  "liability-owner",
  "insurance-owner",
  "escrow-owner",
  "escrow-governance",
] as const

const OLD_FOOTER = "This page does not sign EIP-712 claims."
const MISLEADING_SIGNING = "Signing alone moves no funds"

function escrowStatus(owner: Address, governance: Address): EscrowStatus {
  return {
    owner,
    pendingOwner: ZERO,
    governance,
    disputePanel: ADDRESSES.disputePanel,
    denylist: ADDRESSES.denylist,
    vault: ADDRESSES.vault,
    lockedValueWei: 0n,
    nativeBalanceWei: 0n,
    fundingOpen: owner.toLowerCase() === governance.toLowerCase(),
  }
}

function gateStatus(owner: Address, governance: Address = owner): GateStatus {
  return {
    chainId: 84532,
    denylist: { owner, pendingOwner: ZERO },
    vault: { owner, pendingOwner: ZERO, denylist: ADDRESSES.denylist },
    disputePanel: { owner, arbitratorCount: 3n, panelSize: 3n },
    liability: { owner, insurance: ADDRESSES.insuranceFund, nativeBalanceWei: 0n },
    insuranceFund: {
      owner,
      liability: ADDRESSES.liability,
      recordedBalanceWei: 0n,
      nativeBalanceWei: 0n,
    },
    escrow: escrowStatus(owner, governance),
  }
}

function renderOwners(owner: Address, governance?: Address) {
  const status = gateStatus(owner, governance)
  return render(
    <>
      <LiveStatus status={status} />
      {status.escrow ? <EscrowReads status={status.escrow} /> : null}
    </>,
  )
}

afterEach(() => {
  cleanup()
})

describe("live owner pin", () => {
  it("reads the governance timelock from the address book", () => {
    expect(deploymentBook.governanceTimelock).toBe("0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33")
    expect(liveExpectedOwner()).toBe(getAddress(deploymentBook.governanceTimelock))
    expect(liveExpectedOwner()).toBe(ADDRESSES.governanceTimelock)
    expect(liveExpectedOwner()).not.toBe(ADDRESSES.coreTimelock)
  })

  it("shows a match on every live owner row when owners are the governance timelock", () => {
    const owner = liveExpectedOwner()
    if (!owner) throw new Error("address book has no governanceTimelock")
    renderOwners(owner)

    expect(screen.queryByText(GATE_OWNER_MISMATCH)).toBeNull()
    expect(screen.queryByText(LINK_OWNER_MISMATCH)).toBeNull()
    expect(screen.getByText(GATE_OWNER_MATCH).textContent).toBe(GATE_OWNER_MATCH)
    expect(screen.getByText(LINK_OWNER_MATCH).textContent).toBe(LINK_OWNER_MATCH)
    expect(document.body.textContent).not.toContain("CORE_TIMELOCK")
    expect(document.body.textContent).not.toContain("does not match")

    for (const id of OWNER_ROWS) {
      const pin = screen.getByTestId(`${id}-pin`)
      expect(pin.textContent).toContain("matches the governance timelock")
      expect(pin.className).toBe("pin-match")
    }
    expect(screen.getByTestId("vault-denylist-pin").textContent).toContain("matches pin")
    expect(screen.getByTestId("escrow-panel-pin").textContent).toContain("matches pin")
  })

  it("shows the mismatch box when a live owner is not the governance timelock", () => {
    renderOwners(ADDRESSES.coreTimelock)

    expect(screen.getByText(GATE_OWNER_MISMATCH)).toBeTruthy()
    expect(screen.getByText(LINK_OWNER_MISMATCH)).toBeTruthy()
    expect(screen.queryByText(GATE_OWNER_MATCH)).toBeNull()
    expect(screen.queryByText(LINK_OWNER_MATCH)).toBeNull()
    expect(document.body.textContent).toContain("Denylist owner is not the governance timelock.")
    expect(document.body.textContent).toContain("Vault owner is not the governance timelock.")
    expect(document.body.textContent).toContain("Liability owner is not the governance timelock.")
    expect(document.body.textContent).toContain("InsuranceFund owner is not the governance timelock.")
    expect(document.body.textContent).not.toContain("CORE_TIMELOCK")
    expect(document.body.textContent).not.toContain("is not CORE_TIMELOCK")

    for (const id of OWNER_ROWS) {
      const pin = screen.getByTestId(`${id}-pin`)
      expect(pin.textContent).toContain("does not match the governance timelock")
      expect(pin.className).toBe("bad")
    }
  })

  it("still shows the mismatch box for an unrelated owner", () => {
    renderOwners(OTHER_OWNER)
    expect(screen.getByText(GATE_OWNER_MISMATCH)).toBeTruthy()
    expect(screen.getByTestId("denylist-owner-pin").textContent).toContain("does not match the governance timelock")
    expect(screen.getByTestId("escrow-governance-pin").textContent).toContain("does not match the governance timelock")
  })

  it("pins live book owners to the governance timelock", () => {
    expect(deploymentBook.Denylist.owner).toBe(liveExpectedOwner())
    expect(deploymentBook.Vault.owner).toBe(liveExpectedOwner())
    expect(deploymentBook.BotAttestationEscrow.owner).toBe(liveExpectedOwner())
    expect(deploymentBook.BotAttestationEscrow.constructorArgs.governance).toBe(liveExpectedOwner())
  })

  it("fails closed when the address book has no governance timelock", () => {
    const owner = liveExpectedOwner()
    if (!owner) throw new Error("address book has no governanceTimelock")
    const status = gateStatus(owner)
    expect(gateAOwnershipNotes(status, null)).toEqual([MISSING_GOVERNANCE_TIMELOCK])
    expect(liabilityLinkNotes(status, null)).toEqual([MISSING_GOVERNANCE_TIMELOCK])

    render(
      <>
        <LiveStatus status={status} expectedOwner={null} />
        {status.escrow ? <EscrowReads status={status.escrow} expectedOwner={null} /> : null}
      </>,
    )

    expect(screen.getAllByText(MISSING_GOVERNANCE_TIMELOCK)).toHaveLength(2)
    expect(screen.getByText(GATE_OWNER_MISMATCH)).toBeTruthy()
    expect(screen.getByText(LINK_OWNER_MISMATCH)).toBeTruthy()
    expect(screen.queryByText(GATE_OWNER_MATCH)).toBeNull()
    expect(screen.queryByText(LINK_OWNER_MATCH)).toBeNull()
    expect(document.body.textContent).not.toContain("matches the governance timelock")
    for (const id of OWNER_ROWS) {
      expect(screen.queryByTestId(`${id}-pin`)).toBeNull()
    }
  })

  it("names the governance timelock from the book and still lists coreTimelock", () => {
    render(<BookOwners />)
    expect(screen.getByRole("heading", { name: "governance timelock" }).textContent).toBe("governance timelock")
    expect(screen.queryByRole("heading", { name: "CORE_TIMELOCK" })).toBeNull()
    const governance = screen.getByTestId("governance-timelock")
    expect(governance.getAttribute("title")).toBe(liveExpectedOwner())
    const core = screen.getByTestId("core-timelock")
    expect(core.getAttribute("title")).toBe(ADDRESSES.coreTimelock)
    expect(core.getAttribute("title")).not.toBe(liveExpectedOwner())
  })
})

describe("footer", () => {
  it("pins the relayer signing sentence and drops the old claim denial", () => {
    render(<PageFooter />)
    const footer = document.querySelector("footer")
    expect(footer?.textContent).toBe(PAGE_FOOTER)
    expect(PAGE_FOOTER).toBe(
      "Experimental Base Sepolia view. Not a certification or an insurance product. Escrow and dispute calls can be submitted from a connected Base Sepolia wallet. Ethereum mainnet and Base mainnet are refused. To send a refund through the relayer, your wallet signs a typed (EIP-712) request for one escrow. The signature is not a transaction. The relayer can only submit the refund call that request names, sends it from its own wallet, and pays the gas. That refund settles the escrow and credits the escrowed amount to the payer, who withdraws it separately.",
    )
    expect(PAGE_FOOTER).not.toContain(OLD_FOOTER)
    expect(PAGE_FOOTER).not.toContain(MISLEADING_SIGNING)
    expect(DISCLAIMER_LINE).not.toContain(OLD_FOOTER)
    expect(DISCLAIMER_LINE).not.toContain(MISLEADING_SIGNING)
    expect(footer?.textContent).not.toContain(OLD_FOOTER)
    expect(footer?.textContent).not.toContain(MISLEADING_SIGNING)
    expect(document.body.textContent).not.toContain(OLD_FOOTER)
    expect(document.body.textContent).not.toContain(MISLEADING_SIGNING)
  })
})
