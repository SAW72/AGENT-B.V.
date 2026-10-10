import { useEffect, useState, type FormEvent } from "react"
import { type Address } from "viem"
import { useAccount } from "wagmi"
import { ADDRESSES } from "./addresses"
import { GOVERNANCE_TIMELOCK_PIN, liveExpectedOwner } from "./gate"
import { parseBytes32 } from "./bytes32"
import { FlowPreview } from "./FlowPreview"
import { errorText, formatEth, isZeroAddress, payeeOpenExpiryNotice } from "./format"
import { PAYEE_NOW_INTERVAL_MS, nowSecondsFrom, startNowTicker } from "./nowClock"
import { escrowStateLabel, readEscrowById, type EscrowRecord, type EscrowStatus, type SepoliaClient } from "./read"
import { AddressRow, TextRow } from "./ui"

export function EscrowPanel({
  client,
  status,
  readsEnabled,
}: {
  client: SepoliaClient
  status: EscrowStatus | null
  readsEnabled: boolean
}) {
  const address = ADDRESSES.botAttestationEscrow
  if (address == null) {
    return (
      <section className="card" aria-labelledby="escrow-heading">
        <h2 id="escrow-heading">BotAttestationEscrow</h2>
        <div className="empty" data-testid="escrow-empty" role="status">
          <strong>Not deployed on Sepolia yet.</strong>
          <p>The escrow address is null. There is no contract to read.</p>
        </div>
      </section>
    )
  }

  return (
    <section className="card" aria-labelledby="escrow-heading">
      <h2 id="escrow-heading">BotAttestationEscrow</h2>
      <AddressRow label="Contract" value={address} testId="escrow-address" />
      {status ? <EscrowReads status={status} /> : <p className="muted">Escrow reads follow the Base Sepolia contract read.</p>}
      <EscrowLookup client={client} address={address} enabled={readsEnabled} />
      <FlowPreview escrow={address} panel={ADDRESSES.disputePanel} />
    </section>
  )
}

export function EscrowReads({
  status,
  expectedOwner = liveExpectedOwner(),
}: {
  status: EscrowStatus
  expectedOwner?: Address | null
}) {
  const liveOwner = expectedOwner ?? undefined
  return (
    <>
      <AddressRow
        label="owner()"
        value={status.owner}
        expected={liveOwner}
        pinName={GOVERNANCE_TIMELOCK_PIN}
        testId="escrow-owner"
      />
      <AddressRow label="pendingOwner()" value={status.pendingOwner} />
      <AddressRow
        label="governance()"
        value={status.governance}
        expected={liveOwner}
        pinName={GOVERNANCE_TIMELOCK_PIN}
        testId="escrow-governance"
      />
      <AddressRow
        label="disputePanel()"
        value={status.disputePanel}
        expected={ADDRESSES.disputePanel}
        testId="escrow-panel"
      />
      <AddressRow label="denylist()" value={status.denylist} expected={ADDRESSES.denylist} />
      <AddressRow label="vault()" value={status.vault} expected={ADDRESSES.vault} />
      <TextRow label="lockedValue()" value={formatEth(status.lockedValueWei)} />
      <TextRow label="Native ETH" value={formatEth(status.nativeBalanceWei)} />
      {status.fundingOpen ? (
        <p className="pill ok" data-testid="funding-gate">
          Funding gate open: owner() is governance. createEscrow is not blocked by FundingBeforeGovernance. The connected wallet still must be the payer's Vault operator.
        </p>
      ) : (
        <p className="pill bad" data-testid="funding-gate">
          FundingBeforeGovernance: owner() is not governance. createEscrow will revert.
        </p>
      )}
    </>
  )
}

function EscrowLookup({
  client,
  address,
  enabled,
}: {
  client: SepoliaClient
  address: Address
  enabled: boolean
}) {
  const account = useAccount()
  const [id, setId] = useState("")
  const [row, setRow] = useState<EscrowRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [nowSeconds, setNowSeconds] = useState(() => nowSecondsFrom(Date.now()))

  useEffect(() => startNowTicker(setNowSeconds, PAYEE_NOW_INTERVAL_MS), [])

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setRow(null)
    setError(null)
    const parsed = parseBytes32(id)
    if (!parsed) {
      setError("Enter a bytes32 escrow id.")
      return
    }
    if (!enabled) {
      setError("Escrow reads are paused.")
      return
    }
    setPending(true)
    try {
      setRow(await readEscrowById(client, address, parsed))
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setPending(false)
    }
  }

  const empty = row != null && !row.used && isZeroAddress(row.payer) && row.createdAt === 0n
  const expiryNotice =
    row == null
      ? null
      : payeeOpenExpiryNotice({
          viewer: account.address,
          payee: row.payee,
          payer: row.payer,
          state: row.state,
          expiresAt: row.expiresAt,
          used: row.used,
          createdAt: row.createdAt,
          nowSeconds,
        })

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <h3>Lookup escrow id</h3>
      <p className="muted">Reads escrows(id) and usedEscrowIds(id). Nothing is sent.</p>
      <div className="field">
        <label htmlFor="escrow-lookup-id">escrowId</label>
        <input
          id="escrow-lookup-id"
          value={id}
          spellCheck={false}
          autoComplete="off"
          disabled={!enabled || pending}
          onChange={(event) => setId(event.target.value)}
        />
      </div>
      <button type="submit" disabled={!enabled || pending}>
        {pending ? "Reading…" : "Read escrow"}
      </button>
      {error ? (
        <p className="bad" role="alert">
          {error}
        </p>
      ) : null}
      {row ? (
        <div data-testid="escrow-lookup">
          {empty ? (
            <p>No escrow stored for this id.</p>
          ) : (
            <>
              {expiryNotice ? (
                <div className="callout" data-testid="payee-expiry-prompt" role="status">
                  {expiryNotice.urgent && expiryNotice.urgentText ? (
                    <div className="banner" data-testid="payee-expiry-urgent" role="alert">
                      <p>{expiryNotice.urgentText}</p>
                    </div>
                  ) : null}
                  <strong>{expiryNotice.beforeExpiry ? "Dispute before this escrow ends" : "This escrow has ended"}</strong>
                  <p data-testid="payee-expiry-time">
                    {expiryNotice.beforeExpiry ? "This escrow ends" : "This escrow ended"} {expiryNotice.endsLabel}.
                  </p>
                  <p>{expiryNotice.text}</p>
                  {expiryNotice.cta ? (
                    <p>
                      <a href="#open-dispute" data-testid="payee-dispute-cta">
                        {expiryNotice.cta}
                      </a>
                    </p>
                  ) : null}
                  <p data-testid="payee-grace-time">
                    While a dispute is unresolved, a refund stays blocked until {expiryNotice.graceEndsLabel}.
                  </p>
                </div>
              ) : null}
              <dl className="result">
              <div>
                <dt>usedEscrowIds</dt>
                <dd>{row.used ? "used" : "unused"}</dd>
              </div>
              <div>
                <dt>state</dt>
                <dd>{escrowStateLabel(row.state)}</dd>
              </div>
              <div>
                <dt>amount</dt>
                <dd>{formatEth(row.amountWei)}</dd>
              </div>
              <div>
                <dt>payer</dt>
                <dd className="mono">{row.payer}</dd>
              </div>
              <div>
                <dt>payee</dt>
                <dd className="mono">{row.payee}</dd>
              </div>
              </dl>
            </>
          )}
        </div>
      ) : null}
    </form>
  )
}
