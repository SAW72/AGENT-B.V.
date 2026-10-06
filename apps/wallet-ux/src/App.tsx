import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi"
import { ADDRESSES, addressBook, BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { DenylistLookup } from "./DenylistLookup"
import { EscrowPanel } from "./EscrowPanel"
import { errorText, formatEth, shortAddress } from "./format"
import { PAGE_FOOTER } from "./brand"
import {
  GATE_OWNER_MATCH,
  GATE_OWNER_MISMATCH,
  GOVERNANCE_TIMELOCK_PIN,
  GOVERNANCE_TIMELOCK_ROLE,
  LINK_OWNER_MATCH,
  LINK_OWNER_MISMATCH,
  gateAOwnershipNotes,
  liabilityLinkNotes,
  liveExpectedOwner,
} from "./gate"
import { evaluateReadGuard, resolveWalletChainId } from "./guard"
import { createSepoliaClient, panelNotSeated, readGateStatus, rpcHost, type GateStatus } from "./read"
import { relayerConfigFromEnv } from "./relayer"
import { ReputationView } from "./reputation/ReputationView"
import { useConnectorChainId } from "./useWalletChain"
import { AddressRow, NoteList, TextRow } from "./ui"
import { rpcUrl } from "./wagmi"

function BvtSlots() {
  const slots = [
    ["BVT", ADDRESSES.bvt],
    ["BVTStaking", ADDRESSES.bvtStaking],
    ["BVTFeeRouter", ADDRESSES.bvtFeeRouter],
    ["BVTTimelock", ADDRESSES.bvtTimelock],
    ["BVTGovernor", ADDRESSES.bvtGovernor],
  ] as const
  const undeployed = slots.every(([, address]) => address == null)
  return (
    <>
      {undeployed ? (
        <div className="empty" data-testid="bvt-empty" role="status">
          <strong>Not deployed on Sepolia yet.</strong>
          <p>BVT, BVTStaking, BVTFeeRouter, BVTTimelock, and BVTGovernor are null.</p>
        </div>
      ) : null}
      <ul className="plain">
        {slots.map(([name, address]) => (
          <li key={name}>{address == null ? `${name}: not deployed` : `${name}: ${address}`}</li>
        ))}
      </ul>
    </>
  )
}

export function BookOwners() {
  const liveOwner = liveExpectedOwner()
  return (
    <section className="card" aria-labelledby="timelock-heading">
      <h2 id="timelock-heading">{GOVERNANCE_TIMELOCK_ROLE}</h2>
      <p className="muted" data-testid="address-source">
        {addressBook.source === "src/base-sepolia.json"
          ? "Addresses from src/base-sepolia.json. Superseded contracts are not read."
          : "Deployment book failed validation. Using the corrected Gate A pin."}
      </p>
      {liveOwner ? (
        <AddressRow label={GOVERNANCE_TIMELOCK_ROLE} value={liveOwner} testId="governance-timelock" />
      ) : (
        <p className="pill bad">The address book has no governance timelock.</p>
      )}
      <AddressRow label="coreTimelock" value={ADDRESSES.coreTimelock} testId="core-timelock" />
    </section>
  )
}

export function PageFooter() {
  return (
    <footer>
      <p>{PAGE_FOOTER}</p>
    </footer>
  )
}

function walletStatus(connected: boolean, chainId: number | null | "conflict"): string {
  if (!connected) return "Disconnected"
  if (chainId === "conflict") return "Connected, chain id conflict"
  if (chainId == null) return "Connected, chain unknown"
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return "Connected on Base Sepolia"
  return `Connected on chain ${chainId}`
}

export function LiveStatus({ status }: { status: GateStatus }) {
  const gateNotes = gateAOwnershipNotes(status)
  const linkNotes = liabilityLinkNotes(status)
  const unseated = panelNotSeated(status.disputePanel.arbitratorCount, status.disputePanel.panelSize)
  const liveOwner = liveExpectedOwner() ?? undefined

  return (
    <>
      <section className="card" aria-labelledby="gate-heading" data-testid="gate-status">
        <h2 id="gate-heading">Gate A</h2>
        {gateNotes.length === 0 ? (
          <p className="pill ok">{GATE_OWNER_MATCH}</p>
        ) : (
          <p className="pill bad">{GATE_OWNER_MISMATCH}</p>
        )}
        <NoteList notes={gateNotes} />
        <h3>Denylist</h3>
        <AddressRow label="Contract" value={ADDRESSES.denylist} />
        <AddressRow
          label="owner()"
          value={status.denylist.owner}
          expected={liveOwner}
          pinName={GOVERNANCE_TIMELOCK_PIN}
          testId="denylist-owner"
        />
        <AddressRow label="pendingOwner()" value={status.denylist.pendingOwner} testId="denylist-pending" />
        <h3>Vault</h3>
        <AddressRow label="Contract" value={ADDRESSES.vault} />
        <AddressRow
          label="owner()"
          value={status.vault.owner}
          expected={liveOwner}
          pinName={GOVERNANCE_TIMELOCK_PIN}
          testId="vault-owner"
        />
        <AddressRow label="pendingOwner()" value={status.vault.pendingOwner} />
        <AddressRow
          label="denylist()"
          value={status.vault.denylist}
          expected={ADDRESSES.denylist}
          testId="vault-denylist"
        />
      </section>

      <section className="card" aria-labelledby="panel-heading">
        <h2 id="panel-heading">DisputePanel</h2>
        {unseated ? (
          <div className="callout" data-testid="panel-empty" role="status">
            <strong>Panel not seated. Gate B is not seated.</strong>
            <p>
              arbitratorCount is {status.disputePanel.arbitratorCount.toString()} and PANEL_SIZE is{" "}
              {status.disputePanel.panelSize.toString()}. A dispute can't be filed until the panel is seated.
            </p>
          </div>
        ) : (
          <p className="pill ok" data-testid="panel-seated">
            Gate B seated. arbitratorCount is {status.disputePanel.arbitratorCount.toString()} and PANEL_SIZE is{" "}
            {status.disputePanel.panelSize.toString()}. The contract does not expose an arbitrator index, so this
            count is the seated status.
          </p>
        )}
        <AddressRow label="Contract" value={ADDRESSES.disputePanel} />
        <AddressRow label="owner()" value={status.disputePanel.owner} />
        <TextRow label="arbitratorCount()" value={status.disputePanel.arbitratorCount.toString()} testId="arbitrator-count" />
        <TextRow label="PANEL_SIZE()" value={status.disputePanel.panelSize.toString()} />
      </section>

      <section className="card" aria-labelledby="liability-heading">
        <h2 id="liability-heading">Liability and InsuranceFund</h2>
        <p className="muted">
          Read-only owner, insurance link, and balance. Recorded balance is InsuranceFund.balance(). Native ETH is
          the address balance. No claim signing.
        </p>
        {linkNotes.length === 0 ? (
          <p className="pill ok">{LINK_OWNER_MATCH}</p>
        ) : (
          <p className="pill bad">{LINK_OWNER_MISMATCH}</p>
        )}
        <NoteList notes={linkNotes} />
        <h3>Liability</h3>
        <AddressRow label="Contract" value={ADDRESSES.liability} />
        <AddressRow
          label="owner()"
          value={status.liability.owner}
          expected={liveOwner}
          pinName={GOVERNANCE_TIMELOCK_PIN}
          testId="liability-owner"
        />
        <AddressRow label="insurance()" value={status.liability.insurance} expected={ADDRESSES.insuranceFund} />
        <TextRow label="Native ETH" value={formatEth(status.liability.nativeBalanceWei)} />
        <h3>InsuranceFund</h3>
        <AddressRow label="Contract" value={ADDRESSES.insuranceFund} />
        <AddressRow
          label="owner()"
          value={status.insuranceFund.owner}
          expected={liveOwner}
          pinName={GOVERNANCE_TIMELOCK_PIN}
          testId="insurance-owner"
        />
        <AddressRow label="liability()" value={status.insuranceFund.liability} expected={ADDRESSES.liability} />
        <TextRow label="balance()" value={formatEth(status.insuranceFund.recordedBalanceWei)} />
        <TextRow label="Native ETH" value={formatEth(status.insuranceFund.nativeBalanceWei)} />
      </section>
    </>
  )
}

export function App() {
  const account = useAccount()
  const { connect, connectors, isPending: connectPending, error: connectError } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain, isPending: switchPending, error: switchError } = useSwitchChain()
  const connectorChainId = useConnectorChainId(account.connector, account.isConnected)
  const walletChainId = account.isConnected
    ? resolveWalletChainId(account.chainId, connectorChainId)
    : null
  const client = useMemo(() => createSepoliaClient(rpcUrl), [])

  const chainQuery = useQuery({
    queryKey: ["rpc-chain", rpcUrl],
    queryFn: () => client.getChainId(),
    retry: 1,
  })

  const guard = evaluateReadGuard({
    rpcChainId: chainQuery.data ?? null,
    walletConnected: account.isConnected,
    walletChainId,
  })

  const rpcFailed = chainQuery.isError
  const blockedReason = rpcFailed
    ? `RPC request failed. ${errorText(chainQuery.error)}`
    : guard.ok
      ? null
      : guard.reason

  const statusQuery = useQuery({
    queryKey: ["gate-status", rpcUrl],
    queryFn: () => readGateStatus(client),
    enabled: guard.ok && chainQuery.isSuccess,
    retry: 1,
    refetchInterval: 15_000,
  })

  const showSwitch = account.isConnected && walletChainId !== BASE_SEPOLIA_CHAIN_ID

  return (
    <div className="wrap">
      <header>
        <h1>Agent-BV</h1>
        <p className="lede">Agent Auditor · Base Sepolia only · chain id {BASE_SEPOLIA_CHAIN_ID}</p>
      </header>

      <section className="card" aria-labelledby="connection-heading">
        <h2 id="connection-heading">Connection</h2>
        <div className="bar">
          {account.isConnected ? (
            <button type="button" className="secondary" onClick={() => disconnect()}>
              Disconnect
            </button>
          ) : (
            connectors.map((connector) => (
              <button
                key={connector.uid}
                type="button"
                data-testid="connect"
                disabled={connectPending}
                onClick={() => connect({ connector })}
              >
                {connectPending ? "Connecting…" : connector.name === "Injected" ? "Connect wallet" : `Connect ${connector.name}`}
              </button>
            ))
          )}
          <span data-testid="wallet-status">{walletStatus(account.isConnected, walletChainId)}</span>
          {account.address ? (
            <span className="mono" title={account.address}>
              {shortAddress(account.address)}
            </span>
          ) : null}
        </div>
        {connectError ? (
          <p className="bad" role="alert">
            {errorText(connectError)} Install MetaMask if no injected wallet is available.
          </p>
        ) : null}
        <dl className="status-list">
          <div>
            <dt>Wallet</dt>
            <dd>{walletStatus(account.isConnected, walletChainId)}</dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd data-testid="network-status">
              {account.isConnected
                ? walletChainId === BASE_SEPOLIA_CHAIN_ID
                  ? `Base Sepolia (${BASE_SEPOLIA_CHAIN_ID})`
                  : walletChainId === "conflict" || walletChainId == null
                    ? "Unconfirmed"
                    : `Chain ${walletChainId} — not Base Sepolia`
                : "No wallet network yet"}
            </dd>
          </div>
          <div>
            <dt>RPC</dt>
            <dd>
              {rpcHost(rpcUrl)}
              {chainQuery.isPending ? " · checking chain id" : null}
              {chainQuery.isSuccess ? ` · chain ${chainQuery.data}` : null}
              {chainQuery.isError ? " · chain check failed" : null}
            </dd>
          </div>
        </dl>
      </section>

      {chainQuery.isPending ? <p className="banner info">Checking the Base Sepolia RPC.</p> : null}
      {rpcFailed ? (
        <p className="banner" role="alert" data-testid="chain-banner">
          RPC request failed. {errorText(chainQuery.error)} Contract reads are off.
        </p>
      ) : null}
      {!rpcFailed && !guard.ok && guard.code !== "rpc-pending" ? (
        <div className="banner" role="alert" data-testid="chain-banner">
          <p>{guard.reason}</p>
          {showSwitch ? (
            <button
              type="button"
              onClick={() => switchChain({ chainId: BASE_SEPOLIA_CHAIN_ID })}
              disabled={switchPending}
            >
              {switchPending ? "Switching…" : "Switch wallet to Base Sepolia"}
            </button>
          ) : null}
          {switchError ? <p>{errorText(switchError)}</p> : null}
        </div>
      ) : null}

      <BookOwners />

      {guard.ok && statusQuery.isPending ? <p className="banner info">Reading Base Sepolia contracts.</p> : null}
      {guard.ok && statusQuery.isError ? (
        <div className="banner" role="alert">
          <p>Could not read contracts. {errorText(statusQuery.error)}</p>
          <button type="button" onClick={() => void statusQuery.refetch()}>
            Retry read
          </button>
        </div>
      ) : null}
      {guard.ok && statusQuery.data ? <LiveStatus status={statusQuery.data} /> : null}
      {!guard.ok && !chainQuery.isPending && !rpcFailed ? (
        <p className="muted">Live owner and balance rows stay hidden while reads are refused.</p>
      ) : null}

      <EscrowPanel
        client={client}
        status={guard.ok && statusQuery.data ? statusQuery.data.escrow : null}
        readsEnabled={guard.ok}
      />

      <section className="card" aria-labelledby="bvt-heading">
        <h2 id="bvt-heading">BVT stack</h2>
        <BvtSlots />
      </section>

      <DenylistLookup client={client} enabled={guard.ok} blockedReason={blockedReason} />

      <ReputationView
        connected={account.isConnected}
        chainId={walletChainId}
        address={account.address ?? null}
        relayerUrl={relayerConfigFromEnv({ VITE_CLAIM_RELAYER_URL: import.meta.env.VITE_CLAIM_RELAYER_URL }).url}
      />

      <PageFooter />
    </div>
  )
}
