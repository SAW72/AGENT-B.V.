import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react"
import { CANCELLED_IDLE_TEXT, PENDING_SLOW_MS, PENDING_SLOW_TEXT } from "./actionProgress"
import { chunkHex, shortAddress } from "./format"
import { ChunkedHex, CopyButton } from "./ui"
import { txExplorerUrl, TX_CONFIRMED_TEXT, TX_LINK_LABEL, TX_PENDING_TEXT, TX_STILL_PENDING_TEXT } from "./walletCopy"

export const NEEDS_WALLET_LABEL = "Connect a wallet on Base Sepolia"
export const NO_WALLET_REASON = "No wallet connected"
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
  | { status: "pending"; hash: string; label?: string; startedAt?: number; stalled?: boolean }
  | {
      status: "confirmed"
      hash: string
      label?: string
      resultId?: string
      resultLabel?: string
      nextHref?: string
      nextLabel?: string
    }
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
      return state.label ?? PENDING_NETWORK_LABEL
    case "confirmed":
      return state.label ?? DONE_LABEL
    case "error":
      return state.message
  }
}

function Mark({ kind, glyph }: { kind: "ok" | "wait" | "bad" | "warn" | "muted"; glyph: string }) {
  return (
    <span className={`mark mark-${kind}`} aria-hidden="true">
      {glyph}
    </span>
  )
}

export function ActionButton({
  state,
  onClick,
  type = "button",
  testId,
  disabled = false,
  reason,
  ...rest
}: {
  state: ActionButtonState
  onClick?: () => void
  type?: "button" | "submit"
  testId?: string
  disabled?: boolean
  reason?: string | null
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "onClick" | "disabled">) {
  const busy = state.status === "busy" || state.status === "waiting-wallet" || state.status === "pending"
  const locked =
    disabled ||
    state.status === "needs-wallet" ||
    state.status === "busy" ||
    state.status === "waiting-wallet" ||
    state.status === "pending" ||
    state.status === "confirmed"
  const shownReason = locked ? reason : null
  return (
    <>
      {shownReason ? (
        <p className="action-reason" data-testid="action-reason">
          <Mark kind="muted" glyph="–" /> {shownReason}
        </p>
      ) : null}
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
    </>
  )
}

function usePendingSlow(startedAt: number | undefined, active: boolean): boolean {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || startedAt == null) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, startedAt])
  if (!active || startedAt == null) return false
  return now - startedAt >= PENDING_SLOW_MS
}

/** Result under the button that produced it: wallet hint, pending, confirmed, or a plain error. */
export function ActionStatus({
  state,
  walletHint = false,
  errorDetail,
  nodeRef,
  pendingTestId = "tx-pending",
  confirmedTestId = "tx-confirmed",
  cancelled = false,
}: {
  state: ActionButtonState
  walletHint?: boolean
  errorDetail?: ReactNode
  nodeRef?: (node: HTMLElement | null) => void
  pendingTestId?: string
  confirmedTestId?: string
  cancelled?: boolean
}) {
  const slow = usePendingSlow(state.status === "pending" ? state.startedAt : undefined, state.status === "pending")
  if (state.status === "error") {
    return (
      <p className="bad icon-bad" role="alert" aria-live="assertive" tabIndex={-1} ref={nodeRef} data-testid="action-error">
        {state.message}
      </p>
    )
  }
  if (cancelled && state.status === "idle") {
    return (
      <p className="cancel-note" role="status" aria-live="polite" data-testid="wallet-cancel">
        <Mark kind="muted" glyph="–" /> {CANCELLED_IDLE_TEXT}
      </p>
    )
  }
  if (state.status === "waiting-wallet") {
    return walletHint ? (
      <p className="hint" role="status" aria-live="polite">
        <Mark kind="wait" glyph="…" /> <span data-testid="wallet-hint">{WALLET_HINT_TEXT}</span>
      </p>
    ) : null
  }
  if (state.status === "pending") {
    return (
      <div role="status" aria-live="polite" tabIndex={-1} ref={nodeRef} data-testid="action-pending">
        <p>
          <Mark kind="wait" glyph="…" /> <span data-testid={pendingTestId}>{PENDING_NETWORK_LABEL}</span>
        </p>
        <p className="mono" data-testid="tx-hash">
          {state.hash}
        </p>
        <p>
          <a href={txExplorerUrl(state.hash)} data-testid="tx-explorer" target="_blank" rel="noreferrer">
            {TX_LINK_LABEL}
          </a>
        </p>
        {slow ? (
          <p className="warn-note" data-testid="pending-slow">
            {PENDING_SLOW_TEXT}
          </p>
        ) : null}
        {state.stalled ? (
          <p data-testid="tx-still-pending">{TX_STILL_PENDING_TEXT}</p>
        ) : null}
      </div>
    )
  }
  if (state.status === "confirmed") {
    const done = state.label ?? DONE_LABEL
    return (
      <div role="status" aria-live="polite" tabIndex={-1} ref={nodeRef} data-testid="action-confirmed">
        <p className="action-done">
          <Mark kind="ok" glyph="✓" /> <span data-testid={confirmedTestId}>{done}</span>
        </p>
        {state.resultId ? (
          <div className="kv-row" data-testid="result-id">
            <div className="kv-label">{state.resultLabel ?? "Escrow ID"}</div>
            <div className="kv-value">
              <ChunkedHex parts={chunkHex(state.resultId)} />
              <CopyButton value={state.resultId} />
            </div>
          </div>
        ) : null}
        <div className="kv-row">
          <div className="kv-label">Transaction</div>
          <div className="kv-value">
            <span className="mono" data-testid="tx-hash">
              {shortAddress(state.hash)}
            </span>
            <CopyButton value={state.hash} />
            <a href={txExplorerUrl(state.hash)} data-testid="tx-explorer" target="_blank" rel="noreferrer">
              {TX_LINK_LABEL}
            </a>
          </div>
        </div>
        {state.nextHref ? (
          <p>
            <a className="next-step" href={state.nextHref} data-testid="next-step" title={state.nextLabel}>
              Next step
            </a>
          </p>
        ) : null}
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
