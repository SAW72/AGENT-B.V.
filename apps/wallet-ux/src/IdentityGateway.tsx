import { useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useAccount, useConnect, useDisconnect } from "wagmi"
import { ActionButton, type ActionButtonState } from "./actionButton"
import { visibleConnectors } from "./connectors"
import { ErrorNotice } from "./ErrorNotice"
import { errorText, isZeroAddress, sameAddress, shortAddress } from "./format"
import { resolveWalletChainId } from "./guard"
import {
  CHECKED_IN_BROWSER,
  NO_ID_TEXT,
  WALLET_NOT_SET_TEXT,
  agentIdFromHref,
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
  type IdentityRecord,
  type VerifyResult,
} from "./identity8004"
import { rpcHost, type SepoliaClient } from "./read"
import { AddressRow, TextRow } from "./ui"
import { useConnectorChainId } from "./useWalletChain"
import { rpcUrl } from "./wagmi"
import { walletReadiness } from "./walkthrough"

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

export function IdentityGateway({
  client,
  readsEnabled,
  blockedReason,
}: {
  client: SepoliaClient
  readsEnabled: boolean
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
  const signTicket = useRef(0)

  const parsed = parseAgentId(agentInput)
  const identityQuery = useQuery({
    queryKey: ["erc8004-identity", rpcUrl, parsed?.toString() ?? ""],
    queryFn: () => readAgentIdentity(client, parsed as bigint),
    enabled: readsEnabled && parsed != null,
    retry: 1,
  })

  const record = identityQuery.data ?? null
  const onboarding = onboardingNext()
  const showOnboarding = agentInput.trim() === ""

  async function sign(current: IdentityRecord) {
    if (!account.address || !account.connector || readiness !== "ready") return
    if (!sameAddress(account.address, current.agentWallet)) return
    const ticket = signTicket.current + 1
    signTicket.current = ticket
    setSignError(null)
    setOutcome(null)
    setButton({ status: "waiting-wallet" })
    try {
      const nowSeconds = Math.floor(Date.now() / 1000)
      const challenge = buildChallenge(current.agentId, current.agentWallet, nowSeconds)
      const provider = await providerFromConnector(account.connector)
      const signature = await requestChallengeSignature(provider, account.address, challenge)
      const checked = await verifyAgentChallenge({
        verifier: client,
        record: current,
        challenge,
        signature,
        nowSeconds,
        reread: () => readAgentIdentity(client, current.agentId),
      })
      if (signTicket.current !== ticket) return
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
    readiness === "ready" &&
    account.address != null &&
    sameAddress(account.address, record.agentWallet) &&
    record.implementationMatches &&
    record.registryDomainMatches &&
    !isZeroAddress(record.agentWallet)

  let signState = button
  if (button.status === "idle") {
    if (readiness === "disconnected") signState = { status: "needs-wallet" }
    else if (readiness === "wrong-network") signState = { status: "wrong-network" }
  }
  const signReason = !record
    ? null
    : isZeroAddress(record.agentWallet)
      ? WALLET_NOT_SET_TEXT
      : record.implementationMatches && record.registryDomainMatches
        ? readiness === "ready" && account.address && !sameAddress(account.address, record.agentWallet)
          ? "Connect the agent wallet. The signature has to come from that address."
          : null
        : "This registry no longer matches the pinned identity deployment."

  return (
    <section className="card" aria-labelledby="identity-heading" data-testid="identity-gateway">
      <h2 id="identity-heading">ERC-8004 identity</h2>
      <p className="muted" data-testid="checked-in-browser">
        {CHECKED_IN_BROWSER}. Base Sepolia only. Reads use {rpcHost(rpcUrl)}. The signature is not a transaction.
      </p>
      <p>
        <a href={basescanRegistryUrl()} target="_blank" rel="noreferrer">
          View the registry on Basescan
        </a>
      </p>

      {showOnboarding ? (
        <div data-testid="identity-onboarding">
          <p>
            <strong>{NO_ID_TEXT}</strong>
          </p>
          <p className="muted">
            A bot with no agent id stays refused. Register on the existing registry, open this page to get verified,
            then call the access check again with agent_id.
          </p>
          <pre className="calldata" data-testid="identity-next">
            {JSON.stringify(onboarding, null, 2)}
          </pre>
        </div>
      ) : null}

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
            setButton({ status: "idle", label: "Sign the identity check" })
          }}
        />
      </label>
      {agentInput.trim() !== "" && parsed == null ? (
        <p className="pill bad">Enter the agent id as a decimal integer.</p>
      ) : null}
      {!readsEnabled && blockedReason ? <ErrorNotice main="Registry reads are off." detail={blockedReason} /> : null}
      {identityQuery.isPending && parsed != null && readsEnabled ? <p className="banner info">Reading the identity registry.</p> : null}
      {identityQuery.isError ? <ErrorNotice main="Could not read this agent id." detail={errorText(identityQuery.error)} /> : null}

      {record ? <IdentityRecordView record={record} /> : null}
      {outcome ? (
        <p className={outcome.verified ? "pill ok" : "pill bad"} data-testid="identity-result">
          {outcome.verified ? "Verified" : "Not verified"}. {CHECKED_IN_BROWSER}. {reasonText(outcome.reason)}
        </p>
      ) : null}
      {signError ? <ErrorNotice main="The wallet did not complete the check." detail={signError} /> : null}

      <div className="bar">
        {account.isConnected ? (
          <button type="button" className="secondary" onClick={() => disconnect()}>
            Disconnect
          </button>
        ) : (
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
      {connectError ? <ErrorNotice main="Could not connect the wallet." detail={errorText(connectError)} /> : null}
    </section>
  )
}

function IdentityRecordView({ record }: { record: IdentityRecord }) {
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
      <AddressRow label="Owner" value={record.owner} testId="identity-owner" />
      <AddressRow label="Agent wallet" value={record.agentWallet} testId="identity-wallet" />
      <TextRow label="Agent URI" value={record.agentURI === "" ? "(empty)" : record.agentURI} testId="identity-uri" />
      <p>
        <a href={basescanAgentUrl(record.agentId)} target="_blank" rel="noreferrer">
          View this agent id on Basescan
        </a>
      </p>
    </>
  )
}
