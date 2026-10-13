import { useId } from "react"
import { useAccount } from "wagmi"
import { ActionButton } from "./actionButton"
import { ConnectWalletButton, SwitchToSepoliaButton } from "./firstRun"
import { resolveWalletChainId } from "./guard"
import { StepFooter } from "./steps"
import { useConnectorChainId } from "./useWalletChain"
import { walletReadiness, type WalkthroughWallet } from "./walkthrough"

export const CONNECT_TO_CONTINUE = "Connect a wallet to continue."
export const SWITCH_TO_CONTINUE = "Switch your wallet to Base Sepolia to continue."
export const ENTER_AMOUNT_TO_CONTINUE = "Enter an amount to continue."

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

/** The one wallet sentence. A conflicting chain uses the same switch sentence as any other wrong network. */
export function footerBlockReason(readiness: WalkthroughWallet): string | null {
  if (readiness === "disconnected") return CONNECT_TO_CONTINUE
  if (readiness === "wrong-network") return SWITCH_TO_CONTINUE
  return null
}

function shownText(value: string | null | undefined): string | null {
  if (value == null) return null
  const text = value.trim()
  return text === "" ? null : value
}

/**
 * The one step footer. Disconnected shows Connect. Any other chain shows Switch.
 * Next is only rendered when the wallet is ready.
 * A hidden or disabled Next always has one plain reason. The wallet sentence wins.
 */
export function GuidedStepFooter({
  onBack,
  onNext,
  nextDisabled = false,
  busy = false,
  reason = null,
  missing = null,
}: {
  onBack: () => void
  onNext: () => void
  nextDisabled?: boolean
  busy?: boolean
  /** Existing step block, shown when the wallet is ready and Next stays disabled. */
  reason?: string | null
  /** Step-level gap, such as an empty amount. The wallet sentence replaces it. */
  missing?: string | null
}) {
  const readiness = useFlowReadiness()
  const reasonId = useId()
  const walletLine = footerBlockReason(readiness)
  const stepLine = busy ? null : shownText(missing) ?? (nextDisabled ? shownText(reason) : null)
  const line = walletLine ?? stepLine
  const describedBy = line ? reasonId : undefined
  return (
    <div className="guided-footer" data-testid="guided-footer">
      {line ? (
        <p id={reasonId} className="footer-reason" role="status" aria-live="polite" data-testid="footer-reason">
          {line}
        </p>
      ) : null}
      <StepFooter onBack={onBack}>
        {readiness === "wrong-network" ? (
          <SwitchToSepoliaButton describedBy={describedBy} />
        ) : readiness === "disconnected" ? (
          <ConnectWalletButton describedBy={describedBy} />
        ) : (
          <ActionButton
            type="button"
            disabled={nextDisabled || shownText(missing) != null}
            aria-describedby={describedBy}
            onClick={() => void onNext()}
            state={busy ? { status: "busy", label: "Preparing…" } : { status: "idle", label: "Next" }}
          />
        )}
      </StepFooter>
    </div>
  )
}
