import { useAccount, useConnect, useSwitchChain } from "wagmi"
import { WRONG_NETWORK_LABEL } from "./actionButton"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { visibleConnectors } from "./connectors"
import { resolveWalletChainId } from "./guard"
import { flowHref, navigate } from "./routes"
import { Stepper } from "./steps"
import { useConnectorChainId } from "./useWalletChain"
import {
  BASE_SEPOLIA_FAUCET_DOCS_URL,
  CONNECT_NOTE,
  TEST_ETH_LINK_LABEL,
  TEST_ETH_NOTE,
  WRONG_NETWORK_NOTE,
  walkthroughLabels,
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

/** The faucet sentence, with the official Base docs page as the only link. */
export function TestEthNote() {
  const at = TEST_ETH_NOTE.indexOf(TEST_ETH_LINK_LABEL)
  const before = TEST_ETH_NOTE.slice(0, at)
  const after = TEST_ETH_NOTE.slice(at + TEST_ETH_LINK_LABEL.length)
  return (
    <p className="hint" data-testid="test-eth-note">
      {before}
      <a href={BASE_SEPOLIA_FAUCET_DOCS_URL} rel="noopener noreferrer" target="_blank">
        {TEST_ETH_LINK_LABEL}
      </a>
      {after}
    </p>
  )
}

/** Three steps for a first visit. One primary action. */
export function FirstRun() {
  const account = useAccount()
  const connectorChainId = useConnectorChainId(account.connector, account.isConnected)
  const chainId = account.isConnected ? resolveWalletChainId(account.chainId, connectorChainId) : null
  const wallet = walletReadiness(account.isConnected, chainId)
  const states = walkthroughStates(wallet, "home")
  const labels = walkthroughLabels(wallet)
  return (
    <section className="card first-run" data-testid="first-run" aria-label="Start here">
      <h2>Start here</h2>
      <Stepper step={walkthroughStep(states)} total={labels.length} labels={labels} />
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
      {wallet === "ready" ? <TestEthNote /> : null}
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
