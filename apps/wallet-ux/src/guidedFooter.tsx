import { useAccount } from "wagmi"
import { ActionButton } from "./actionButton"
import { ConnectWalletButton, SwitchToSepoliaButton } from "./firstRun"
import { resolveWalletChainId } from "./guard"
import { StepFooter } from "./steps"
import { useConnectorChainId } from "./useWalletChain"
import { walletReadiness, type WalkthroughWallet } from "./walkthrough"

/** The only wallet check for a guided step. Wrong, unknown, and conflicting chains are the same state. */
export function useFlowReadiness(): WalkthroughWallet {
  const account = useAccount()
  const connectorChainId = useConnectorChainId(account.connector, account.isConnected)
  return walletReadiness(
    account.isConnected,
    account.isConnected ? resolveWalletChainId(account.chainId, connectorChainId) : null,
  )
}

/** Next and Enter stay on this step until the wallet is on Base Sepolia. */
export function flowMayAdvance(readiness: WalkthroughWallet): boolean {
  return readiness === "ready"
}

/**
 * The one step footer. Disconnected shows Connect. Any other chain shows Switch.
 * Next is only rendered when the wallet is ready.
 */
export function GuidedStepFooter({
  onBack,
  onNext,
  nextDisabled = false,
  busy = false,
  reason = null,
}: {
  onBack: () => void
  onNext: () => void
  nextDisabled?: boolean
  busy?: boolean
  reason?: string | null
}) {
  const readiness = useFlowReadiness()
  return (
    <StepFooter onBack={onBack}>
      {readiness === "wrong-network" ? (
        <SwitchToSepoliaButton />
      ) : readiness === "disconnected" ? (
        <ConnectWalletButton />
      ) : (
        <ActionButton
          type="button"
          disabled={nextDisabled}
          reason={nextDisabled ? reason : null}
          onClick={() => void onNext()}
          state={busy ? { status: "busy", label: "Preparing…" } : { status: "idle", label: "Next" }}
        />
      )}
    </StepFooter>
  )
}
