import { useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useAccount, useConnect, useDisconnect } from "wagmi"
import { ActionButton, type ActionButtonState } from "./actionButton"
import { visibleConnectors } from "./connectors"
import { ErrorNotice } from "./ErrorNotice"
import { errorText, isZeroAddress, sameAddress, shortAddress } from "./format"
import { resolveWalletChainId } from "./guard"
import {
  AGENT_ID_DECIMAL_TEXT,
  AGENT_ID_RANGE_TEXT,
  CHECKED_IN_BROWSER,
  NO_ID_TEXT,
  PUBLIC_RPC_HOST,
  WALLET_NOT_SET_TEXT,
  agentIdFromHref,
  agentIdIssue,
  basescanAddressUrl,
  basescanAgentUrl,
  basescanRegistryUrl,
  buildChallenge,
  onboardingNext,
  parseAgentId,
  providerFromConnector,
  pinnedImplementation,
  readAgentIdentity,
  requestChallengeSignature,
  verifyAgentChallenge,
  MissingAgentError,
  type IdentityRecord,
  type VerifyResult,
} from "./identity8004"
import { REVERT_FALLBACK_TEXT } from "./revert"
import { SwitchToSepoliaButton } from "./firstRun"
import type { SepoliaClient } from "./read"
import { AddressRow } from "./ui"
import { useConnectorChainId } from "./useWalletChain"
import { rpcUrl } from "./wagmi"
import { walletReadiness } from "./walkthrough"

const URI_PREVIEW = 96

function reasonText(reason: VerifyResult["reason"]): string {
  if (reason === "verified") return "Verified."
  if (reason === "wallet_not_set") return WALLET_NOT_SET_TEXT
  if (reason === "impl_changed") return "The identity registry implementation changed. This page will not mark it verified."
  if (reason === "registry_domain_changed") return "The identity registry domain changed. This page will not mark it verified."
  if (reason === "expired") return "This check expired. Sign it again."
  if (reason === "agent_mismatch") return "The signed agent id does not match this record."
  if (reason === "wallet_mismatch") return "The signed agent wallet does not match this record."
  if (reason === "bad_signature") return "Not verified. The signature does not match the agent wallet."
  return "Not verified. The owner or agent wallet changed. Sign again."
}

function readDetail(error: unknown): string {
  return errorText(error).split(REVERT_FALLBACK_TEXT).join("The registry read failed.")
}

export function IdentityGateway({
  client,
  readsEnabled,
  readsPending = false,
  blockedReason,
}: {
  client: SepoliaClient
  readsEnabled: boolean
  readsPending?: boolean
  blockedReason: string | null
}) {
  const account = useAccount()
  const { connect, connectors, isPending: connectPending, error: connectError } = useConnect()
  const { disconnect } = useDisconnect()
  const connectorChainId = useConnectorChainId(account.connector, account.isConnected)
  const walletChainId = account.isConnected ? resolveWalletChainId(account.chainId, connectorChainId) : null
  const readiness = walletReadiness(account.isConnected, walletChainId)
  const [agentInput, setAgentInput] = useState(() =>
    agentIdFromHref(typeof window === "undefined" ? "http://localhost/" : window.location.href),
  )
  const [outcome, setOutcome] = useState<VerifyResult | null>(null)
  const [signError, setSignError] = useState<string | null>(null)
  const [button, setButton] = useState<ActionButtonState>({ status: "idle", label: "Sign the identity check" })
  const [staleHoldAt, setStaleHoldAt] = useState<number | null>(null)
  const signTicket = useRef(0)

  const parsed = parseAgentId(agentInput)
  const issue = agentIdIssue(agentInput)
  const identityQuery = useQuery({
    queryKey: ["erc8004-identity", rpcUrl, parsed?.toString() ?? ""],
    queryFn: () => readAgentIdentity(client, parsed as bigint),
    enabled: readsEnabled && parsed != null,
    retry: 1,
  })

  useEffect(() => {
    if (staleHoldAt == null) return
    if (identityQuery.dataUpdatedAt !== staleHoldAt) setStaleHoldAt(null)
  }, [identityQuery.dataUpdatedAt, staleHoldAt])

  const record = identityQuery.data ?? null
  const hideParties = staleHoldAt != null
  const onboarding = onboardingNext()
  const showOnboarding = agentInput.trim() === ""
  const zeroWallet = record != null && isZeroAddress(record.agentWallet)

  async function sign(current: IdentityRecord) {
    if (hideParties) return
    if (!account.address || !account.connector || readiness !== "ready") return
    if (!sameAddress(account.address, current.agentWallet)) return
    const ticket = signTicket.current + 1
    signTicket.current = ticket
    setSignError(null)
    setOutcome(null)
    setButton({ status: "waiting-wallet" })
    try {
      const issuedAt = Math.floor(Date.now() / 1000)
      const challenge = buildChallenge(current.agentId, current.agentWallet, issuedAt)
      const provider = await providerFromConnector(account.connector)
      const signature = await requestChallengeSignature(provider, account.address, challenge)
      const checkedAt = Math.floor(Date.now() / 1000)
      const checked = await verifyAgentChallenge({
        verifier: client,
        record: current,
        challenge,
        signature,
        nowSeconds: checkedAt,
        reread: () => readAgentIdentity(client, current.agentId),
      })
      if (signTicket.current !== ticket) return
      if (checked.reason === "stale") {
        setStaleHoldAt(identityQuery.dataUpdatedAt)
        void identityQuery.refetch()
      }
      setOutcome(checked)
      setButton({ status: "idle", label: "Sign the identity check" })
    } catch (error) {
      if (signTicket.current !== ticket) return
      setSignError(errorText(error))
      setButton({ status: "idle", label: "Sign the identity check" })
    }
  }

  const canSign =
    record != null &&
    !hideParties &&
    readiness === "ready" &&
    account.address != null &&
    sameAddress(account.address, record.agentWallet) &&
    record.implementationMatches &&
    record.registryDomainMatches &&
    !isZeroAddress(record.agentWallet)

  let signState = button
  if (button.status === "idle" && !zeroWallet && readiness === "disconnected") {
    signState = { status: "needs-wallet" }
  }
  const signReason = hideParties
    ? "Reading the registry again. Sign stays off until that read finishes."
    : !record
      ? null
      : isZeroAddress(record.agentWallet)
        ? WALLET_NOT_SET_TEXT
        : record.implementationMatches && record.registryDomainMatches
          ? readiness === "wrong-network"
            ? "Switch to Base Sepolia before signing."
            : readiness === "ready" && account.address && !sameAddress(account.address, record.agentWallet)
              ? "Connect the agent wallet. The signature has to come from that address."
              : null
          : "This registry no longer matches the pinned identity deployment."

  const missingAgent = identityQuery.error instanceof MissingAgentError ? identityQuery.error : null

  return (
    <section className="card identity-gateway" aria-labelledby="identity-heading" data-testid="identity-gateway">
      <h2 id="identity-heading">ERC-8004 identity</h2>
      <p className="muted" data-testid="checked-in-browser">
        {CHECKED_IN_BROWSER}. Base Sepolia only. Reads use {PUBLIC_RPC_HOST}. The signature is not a transaction.
      </p>
      <p>
        <a href={basescanRegistryUrl()} target="_blank" rel="noreferrer">
          View the registry on Basescan
        </a>
      </p>

      <label>
        Agent id
        <input
          value={agentInput}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          data-testid="agent-id"
          onChange={(event) => {
            signTicket.current += 1
            setAgentInput(event.target.value)
            setOutcome(null)
            setSignError(null)
            setStaleHoldAt(null)
            setButton({ status: "idle", label: "Sign the identity check" })
          }}
        />
      </label>
      {issue === "decimal" ? <p className="pill bad">{AGENT_ID_DECIMAL_TEXT}</p> : null}
      {issue === "range" ? <p className="pill bad">{AGENT_ID_RANGE_TEXT}</p> : null}
      {readsPending ? (
        <p className="banner info" data-testid="identity-loading">
          Reading the identity registry.
        </p>
      ) : !readsEnabled && blockedReason ? (
        <ErrorNotice main="Registry reads are off." detail={blockedReason} />
      ) : null}
      {identityQuery.isPending && parsed != null && readsEnabled ? (
        <p className="banner info">Reading the identity registry.</p>
      ) : null}
      {missingAgent ? (
        <p className="pill bad" data-testid="identity-missing">
          {missingAgent.message}
        </p>
      ) : identityQuery.isError ? (
        <ErrorNotice main="Could not read this agent id." detail={readDetail(identityQuery.error)} />
      ) : null}

      <div className="bar" data-testid="identity-actions">
        {account.isConnected ? (
          <button type="button" className="secondary" onClick={() => disconnect()}>
            Disconnect
          </button>
        ) : zeroWallet ? null : (
          visibleConnectors(connectors).map((connector) => (
            <button
              key={connector.uid}
              type="button"
              disabled={connectPending}
              onClick={() => connect({ connector })}
            >
              {connectPending ? "Connecting…" : connector.name === "Injected" ? "Connect wallet" : `Connect ${connector.name}`}
            </button>
          ))
        )}
        {readiness === "wrong-network" ? <SwitchToSepoliaButton /> : null}
        {record ? (
          <ActionButton
            testId="identity-sign"
            state={signState}
            disabled={!canSign || button.status === "waiting-wallet"}
            reason={signReason}
            onClick={() => {
              void sign(record)
            }}
          />
        ) : null}
      </div>
      {outcome ? (
        <p className={outcome.verified ? "pill ok" : "pill bad"} data-testid="identity-result">
          {reasonText(outcome.reason)}
        </p>
      ) : null}
      {signError ? <ErrorNotice main="The wallet did not complete the check." detail={signError} /> : null}
      {connectError ? <ErrorNotice main="Could not connect the wallet." detail={errorText(connectError)} /> : null}

      {showOnboarding ? (
        <div data-testid="identity-onboarding">
          <p>
            <strong>{NO_ID_TEXT}</strong>
          </p>
          <p className="muted">
            A bot with no agent id stays refused. The bot registers on the existing registry. The browser check is a
            badge. Server-side admission comes later.
          </p>
          <pre className="calldata" data-testid="identity-next">
            {JSON.stringify(onboarding, null, 2)}
          </pre>
        </div>
      ) : null}

      {record ? <IdentityRecordView record={record} hideParties={hideParties} /> : null}
    </section>
  )
}

function IdentityRecordView({ record, hideParties }: { record: IdentityRecord; hideParties: boolean }) {
  return (
    <>
      {!record.implementationMatches ? (
        <ErrorNotice
          main="The identity registry implementation changed."
          detail={`Pinned ${shortAddress(pinnedImplementation())}. Live ${shortAddress(record.implementation)}.`}
          link={{ href: basescanAddressUrl(record.implementation), label: "View the live implementation on Basescan" }}
        />
      ) : null}
      {!record.registryDomainMatches ? (
        <ErrorNotice
          main="The identity registry domain changed."
          detail={`${record.registryDomain.name} version ${record.registryDomain.version}, chain ${record.registryDomain.chainId.toString()}.`}
        />
      ) : null}
      {isZeroAddress(record.agentWallet) ? <ErrorNotice main={WALLET_NOT_SET_TEXT} /> : null}
      {hideParties ? (
        <p className="muted" data-testid="identity-stale-hold">
          Reading the registry again. Sign stays off until that read finishes.
        </p>
      ) : (
        <>
          <AddressRow label="Owner" value={record.owner} testId="identity-owner" />
          <AgentWalletRow value={record.agentWallet} />
        </>
      )}
      <AgentUriRow value={record.agentURI} />
      <p>
        <a href={basescanAgentUrl(record.agentId)} target="_blank" rel="noreferrer">
          View this agent id on Basescan
        </a>
      </p>
    </>
  )
}

function AgentWalletRow({ value }: { value: string }) {
  if (isZeroAddress(value)) {
    return (
      <div className="kv-row">
        <div className="kv-label">Agent wallet</div>
        <div className="kv-value">
          <span className="mono" title={value} data-testid="identity-wallet">
            {shortAddress(value)}
          </span>
          <span className="muted"> none</span>
        </div>
      </div>
    )
  }
  return <AddressRow label="Agent wallet" value={value} testId="identity-wallet" />
}

function AgentUriRow({ value }: { value: string }) {
  const [open, setOpen] = useState(false)
  const shown = value === "" ? "(empty)" : value
  const long = shown.length > URI_PREVIEW
  const text = !long || open ? shown : `${shown.slice(0, URI_PREVIEW)}...`
  return (
    <div className="kv-row">
      <div className="kv-label">Agent URI</div>
      <div className="kv-value identity-uri">
        <span className="identity-uri-text" title={shown} data-testid="identity-uri">
          {text}
        </span>
        {long ? (
          <button type="button" className="secondary" onClick={() => setOpen((current) => !current)}>
            {open ? "Collapse" : "Expand"}
          </button>
        ) : null}
      </div>
    </div>
  )
}
