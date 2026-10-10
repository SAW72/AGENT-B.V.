import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react"
import { txExplorerUrl, TX_CONFIRMED_TEXT, TX_LINK_LABEL, TX_PENDING_TEXT } from "./walletCopy"

export const NEEDS_WALLET_LABEL = "Connect a wallet on Base Sepolia"
export const WRONG_NETWORK_LABEL = "Switch to Base Sepolia"
export const CONFIRM_WALLET_LABEL = "Confirm in MetaMask…"
export const WALLET_HINT_TEXT = "No MetaMask window? Click the MetaMask icon in your browser toolbar."
export const PENDING_NETWORK_LABEL = TX_PENDING_TEXT
export const DONE_LABEL = TX_CONFIRMED_TEXT
export const CHECKING_LABEL = "Checking…"
export const WALLET_HINT_MS = 5_000

export const ESCROW_ID_LABEL = "Escrow ID"
export const DISPUTE_ID_LABEL = "Dispute ID"
export const ESCROW_ID_HINT = "The Escrow ID is the payment."
export const DISPUTE_ID_HINT = "The Dispute ID is the arbitration case."
export const AMOUNT_HINT = "Test ETH on Base Sepolia, no real value."
export const AMOUNT_PLACEHOLDER = "e.g. 0.001"
export const PAYEE_SELF_WARNING = "This payee is the connected wallet. You can continue."
export const GENERATE_LABEL = "Generate"
export const USE_OWN_LABEL = "Use my own"

export type ActionButtonState =
  | { status: "idle"; label: string }
  | { status: "needs-wallet" }
  | { status: "wrong-network" }
  | { status: "busy"; label: string }
  | { status: "waiting-wallet" }
  | { status: "pending"; hash: string }
  | { status: "confirmed"; hash: string }
  | { status: "error"; message: string }

export function actionButtonLabel(state: ActionButtonState): string {
  switch (state.status) {
    case "idle":
    case "busy":
      return state.label
    case "needs-wallet":
      return NEEDS_WALLET_LABEL
    case "wrong-network":
      return WRONG_NETWORK_LABEL
    case "waiting-wallet":
      return CONFIRM_WALLET_LABEL
    case "pending":
      return PENDING_NETWORK_LABEL
    case "confirmed":
      return DONE_LABEL
    case "error":
      return state.message
  }
}

export function ActionButton({
  state,
  onClick,
  type = "button",
  testId,
  disabled = false,
  ...rest
}: {
  state: ActionButtonState
  onClick?: () => void
  type?: "button" | "submit"
  testId?: string
  disabled?: boolean
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "onClick" | "disabled">) {
  const busy = state.status === "busy" || state.status === "waiting-wallet" || state.status === "pending"
  const locked =
    disabled ||
    state.status === "needs-wallet" ||
    state.status === "busy" ||
    state.status === "waiting-wallet" ||
    state.status === "pending" ||
    state.status === "confirmed"
  return (
    <button
      type={type}
      data-testid={testId}
      {...rest}
      data-action-button={state.status}
      disabled={locked}
      aria-busy={busy || undefined}
      onClick={onClick}
    >
      {actionButtonLabel(state)}
    </button>
  )
}

/** Result under the button that produced it: wallet hint, pending, confirmed, or a plain error. */
export function ActionStatus({
  state,
  walletHint = false,
  errorDetail,
  nodeRef,
  pendingTestId = "tx-pending",
  confirmedTestId = "tx-confirmed",
}: {
  state: ActionButtonState
  walletHint?: boolean
  errorDetail?: ReactNode
  nodeRef?: (node: HTMLElement | null) => void
  pendingTestId?: string
  confirmedTestId?: string
}) {
  if (state.status === "error") {
    return (
      <p className="bad" role="alert" tabIndex={-1} ref={nodeRef} data-testid="action-error">
        {state.message}
      </p>
    )
  }
  if (state.status === "waiting-wallet") {
    return walletHint ? (
      <p className="hint" role="status" data-testid="wallet-hint">
        {WALLET_HINT_TEXT}
      </p>
    ) : null
  }
  if (state.status === "pending") {
    return (
      <div role="status" tabIndex={-1} ref={nodeRef} data-testid="action-pending">
        <p data-testid={pendingTestId}>{PENDING_NETWORK_LABEL}</p>
        <p className="mono" data-testid="tx-hash">
          {state.hash}
        </p>
        <p>
          <a href={txExplorerUrl(state.hash)} data-testid="tx-explorer" target="_blank" rel="noreferrer">
            {TX_LINK_LABEL}
          </a>
        </p>
      </div>
    )
  }
  if (state.status === "confirmed") {
    return (
      <div className="action-done" role="status" tabIndex={-1} ref={nodeRef} data-testid="action-confirmed">
        <p>
          <span aria-hidden="true">✓</span> <span data-testid={confirmedTestId}>{DONE_LABEL}</span>
        </p>
        <p className="mono" data-testid="tx-hash">
          {state.hash}
        </p>
        <p>
          <a href={txExplorerUrl(state.hash)} data-testid="tx-explorer" target="_blank" rel="noreferrer">
            {TX_LINK_LABEL}
          </a>
        </p>
      </div>
    )
  }
  if (errorDetail) return <>{errorDetail}</>
  return null
}

export function useWalletHint(waiting: boolean): boolean {
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (!waiting) {
      setShow(false)
      return
    }
    const timer = window.setTimeout(() => setShow(true), WALLET_HINT_MS)
    return () => window.clearTimeout(timer)
  }, [waiting])
  return show
}
