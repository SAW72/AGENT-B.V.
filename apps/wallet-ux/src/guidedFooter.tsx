import { useEffect, useId, useRef } from "react"
import { useAccount } from "wagmi"
import { ActionButton } from "./actionButton"
import { ConnectWalletButton, SwitchToSepoliaButton } from "./firstRun"
import { resolveWalletChainId } from "./guard"
import { StepFooter } from "./steps"
import { useConnectorChainId } from "./useWalletChain"
import { walletReadiness, type WalkthroughWallet } from "./walkthrough"

export const CONNECT_TO_CONTINUE = "Connect a wallet to continue."
export const SWITCH_TO_CONTINUE = "Switch your wallet to Base Sepolia to continue."

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
 * The one sentence in the footer. The wallet sentence wins. A busy prepare shows none.
 * Callers pass an existing step sentence; this function does not invent copy.
 */
export function footerReasonText({
  readiness,
  busy,
  nextDisabled,
  missing = null,
  reason = null,
}: {
  readiness: WalkthroughWallet
  busy: boolean
  nextDisabled: boolean
  missing?: string | null
  reason?: string | null
}): string | null {
  const walletLine = footerBlockReason(readiness)
  const stepLine = busy ? null : shownText(missing) ?? (nextDisabled ? shownText(reason) : null)
  return walletLine ?? stepLine
}

/** Drop an inline sentence that repeats the line the footer is already showing. */
export function asideFromFooter(aside: string | null, displayed: string | null): string | null {
  if (aside == null || aside === "") return null
  if (displayed != null && aside === displayed) return null
  return aside
}

/** Drop a step error when the wallet check changes, so the footer sentence is the only reason. */
export function useClearOnReadinessChange(clear: () => void): void {
  const readiness = useFlowReadiness()
  const clearRef = useRef(clear)
  clearRef.current = clear
  const seen = useRef(readiness)
  useEffect(() => {
    if (seen.current === readiness) return
    seen.current = readiness
    clearRef.current()
  }, [readiness])
}

/**
 * The one step footer. Disconnected shows Connect. Any other chain shows Switch.
 * Next is only rendered when the wallet is ready.
 * A hidden or unavailable Next always has one plain reason. The wallet sentence wins.
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
  /** Existing step block, shown when the wallet is ready and Next stays unavailable. */
  reason?: string | null
  /** Step-level gap, such as an amount the form will not accept. The wallet sentence replaces it. */
  missing?: string | null
}) {
  const readiness = useFlowReadiness()
  const reasonId = useId()
  const line = footerReasonText({ readiness, busy, nextDisabled, missing, reason })
  const describedBy = line ? reasonId : undefined
  return (
    <div className="guided-footer" data-testid="guided-footer">
      <p id={reasonId} className="footer-reason" role="status" aria-live="polite" data-testid="footer-reason">
        {line ?? ""}
      </p>
      <StepFooter onBack={onBack}>
        {readiness === "wrong-network" ? (
          <SwitchToSepoliaButton describedBy={describedBy} />
        ) : readiness === "disconnected" ? (
          <ConnectWalletButton describedBy={describedBy} />
        ) : (
          <ActionButton
            type="button"
            keepFocusable
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
