import { useAccount, useConnect, useSwitchChain } from "wagmi"
import { WRONG_NETWORK_LABEL } from "./actionButton"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { visibleConnectors } from "./connectors"
import { resolveWalletChainId } from "./guard"
import { flowHref, navigate } from "./routes"
import { Stepper } from "./steps"
import { useConnectorChainId } from "./useWalletChain"
import {
  CONNECT_NOTE,
  TEST_ETH_NOTE,
  WALKTHROUGH_LABELS,
  WRONG_NETWORK_NOTE,
  walkthroughStates,
  walkthroughStep,
  walletReadiness,
} from "./walkthrough"

function connectLabel(name: string): string {
  return name === "Injected" ? "Connect wallet" : `Connect ${name}`
}

export function SwitchToSepoliaButton() {
  const { switchChain, isPending } = useSwitchChain()
  return (
    <button
      type="button"
      data-testid="journey-switch"
      disabled={isPending}
      onClick={() => switchChain({ chainId: BASE_SEPOLIA_CHAIN_ID })}
    >
      {isPending ? "Switching…" : WRONG_NETWORK_LABEL}
    </button>
  )
}

export function ConnectWalletButton() {
  const { connect, connectors, isPending } = useConnect()
  const choices = visibleConnectors(connectors)
  const first = choices[0]
  if (!first) {
    return (
      <button type="button" data-testid="journey-connect" disabled>
        Connect wallet
      </button>
    )
  }
  return (
    <>
      <button
        type="button"
        data-testid="journey-connect"
        disabled={isPending}
        onClick={() => connect({ connector: first })}
      >
        {isPending ? "Connecting…" : connectLabel(first.name)}
      </button>
      {choices.slice(1).map((connector) => (
        <button
          key={connector.uid}
          type="button"
          className="secondary"
          disabled={isPending}
          onClick={() => connect({ connector })}
        >
          {connectLabel(connector.name)}
        </button>
      ))}
    </>
  )
}

/** Three steps for a first visit: connect, fund, then send. One primary action. */
export function FirstRun() {
  const account = useAccount()
  const connectorChainId = useConnectorChainId(account.connector, account.isConnected)
  const chainId = account.isConnected ? resolveWalletChainId(account.chainId, connectorChainId) : null
  const wallet = walletReadiness(account.isConnected, chainId)
  const states = walkthroughStates(wallet, "home")
  return (
    <section className="card first-run" data-testid="first-run" aria-label="Start here">
      <h2>Start here</h2>
      <Stepper step={walkthroughStep(states)} total={WALKTHROUGH_LABELS.length} labels={WALKTHROUGH_LABELS} />
      {wallet === "wrong-network" ? (
        <p className="banner" role="status" data-testid="wrong-network-note">
          {WRONG_NETWORK_NOTE}
        </p>
      ) : null}
      {wallet === "disconnected" ? (
        <p className="hint" data-testid="connect-note">
          {CONNECT_NOTE}
        </p>
      ) : null}
      {wallet === "ready" ? (
        <p className="hint" data-testid="test-eth-note">
          {TEST_ETH_NOTE}
        </p>
      ) : null}
      {wallet === "wrong-network" ? <SwitchToSepoliaButton /> : null}
      {wallet === "disconnected" ? <ConnectWalletButton /> : null}
      {wallet === "ready" ? (
        <a
          className="task-link"
          data-testid="journey-fund"
          href={flowHref("fund", 1)}
          onClick={(event) => {
            event.preventDefault()
            navigate(flowHref("fund", 1))
          }}
        >
          Fund an escrow
        </a>
      ) : null}
    </section>
  )
}
