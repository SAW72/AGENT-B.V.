import { useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { Address, Hex } from "viem"
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain } from "wagmi"
import {
  ActionButton,
  ActionStatus,
  NextStepLink,
  NO_WALLET_REASON,
  PendingClearedNote,
  useWalletHint,
  type ActionButtonState,
} from "./actionButton"
import { actionProgress, ANOTHER_PENDING_REASON } from "./actionProgress"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { presentError, type ErrorPresentation } from "./format"
import { isWalletCancel } from "./revert"
import { pendingSlot, pendingSubjectLabel, subjectFromCalldata, writePending } from "./pendingTx"
import { resolveWalletChainId } from "./guard"
import type { CallPreview } from "./preview"
import { assertLiveChain84532, submitAfterPreflight, type PreflightClient } from "./preflight"
import { releaseSubmit, tryHoldSubmit, useSubmitBlocked } from "./submitLock"
import { assertSubmitTarget, evaluateEscrowSubmit, submitControl, submitSenderNote } from "./submit"
import { usePendingReceipt } from "./usePendingReceipt"
import { useConnectorChainId } from "./useWalletChain"
import { TX_REVERTED_TEXT, unconfirmedNote } from "./walletCopy"

function notice(main: string): ErrorPresentation {
  return { main, detail: null }
}


type WalletRequest = (args: { method: "eth_chainId" }) => Promise<unknown>

async function liveChainRequest(
  connector: { getProvider?: () => Promise<unknown> } | undefined,
): Promise<WalletRequest | null> {
  try {
    const provider = (await connector?.getProvider?.()) as { request?: (args: { method: string }) => Promise<unknown> } | undefined
    if (typeof provider?.request === "function") {
      const request = provider.request.bind(provider)
      return (args) => request(args)
    }
  } catch {
    // Fall through to the injected provider when the connector is not ready.
  }
  const eth = typeof window !== "undefined"
    ? (window as Window & { ethereum?: { request?: (args: { method: string }) => Promise<unknown> } }).ethereum
    : undefined
  if (typeof eth?.request === "function") {
    const request = eth.request.bind(eth)
    return (args) => request(args)
  }
  return null
}

export type WalletSubmitHandle = {
  /** The ticket comes back on onSubmitted and onSubmitError so a caller can drop a settle from an old prompt. */
  submit: (ticket?: number) => void
}

/**
 * Submit one prepared call from the connected wallet on Base Sepolia.
 * This control does not import the refund relayer and does not collect key material.
 */
export function WalletOnlySubmit({
  preview,
  allowed,
  hold = false,
  guided = false,
  onConfirmed,
  statusRoot = null,
  quiet = false,
  livePreviewRef = null,
  submitRef = null,
  fromAddressRef = null,
  preflightClient = null,
  onSubmitted,
  onSubmitError,
}: {
  preview: CallPreview
  allowed: readonly Address[]
  hold?: boolean
  guided?: boolean
  onConfirmed?: () => void
  statusRoot?: HTMLElement | null
  /** Hide the escrow button. The register wizard calls submit() after its own checks. */
  quiet?: boolean
  livePreviewRef?: { current: CallPreview | null } | null
  submitRef?: { current: WalletSubmitHandle | null } | null
  fromAddressRef?: { current: Address | null } | null
  preflightClient?: PreflightClient | null
  onSubmitted?: (hash: Hex, ticket?: number) => void
  onSubmitError?: (error: unknown, ticket?: number) => void
}) {
  const account = useAccount()
  const { switchChain } = useSwitchChain()
  const connectorChainId = useConnectorChainId(account.connector, account.isConnected)
  const walletChainId = account.isConnected ? resolveWalletChainId(account.chainId, connectorChainId) : null
  const decision = evaluateEscrowSubmit({ walletConnected: account.isConnected, walletChainId })
  const publicClient = usePublicClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const { sendTransactionAsync, isPending } = useSendTransaction()
  const [signing, setSigning] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [submitError, setSubmitError] = useState<ErrorPresentation | null>(null)
  const sent = subjectFromCalldata(preview.calldata)
  const progress = actionProgress(preview.functionName, sent?.subjectId ?? null)
  const slot = pendingSlot(sent?.action ?? preview.functionName, sent?.subjectId ?? null)
  const lockRef = useRef("")
  const receipt = usePendingReceipt(slot, publicClient, lockRef, () => onConfirmed?.())
  const waiting = signing || (isPending && !receipt.holdLock && receipt.phase !== "confirmed")
  const { id: submitSlot, blocked } = useSubmitBlocked(waiting)
  lockRef.current = submitSlot
  const walletHint = useWalletHint(waiting)
  const busy = isPending || receipt.holdLock || signing
  const control = submitControl(decision, busy)
  const disabled =
    (decision.ok && (control.disabled || hold || receipt.phase !== "idle" || signing)) || blocked

  function failSubmit(error: unknown, ticket?: number) {
    onSubmitError?.(error, ticket)
  }

  async function onClick(ticket?: number) {
    const active = livePreviewRef?.current ?? (livePreviewRef ? null : preview)
    if (!active) {
      failSubmit(new Error("The register transaction is not ready."), ticket)
      return
    }
    if (hold || receipt.phase !== "idle" || blocked) {
      if (quiet) failSubmit(new Error("Another transaction is still pending."), ticket)
      return
    }
    setSubmitError(null)
    receipt.dismissBanner()
    setCancelled(false)
    const current = evaluateEscrowSubmit({
      walletConnected: account.isConnected,
      walletChainId: account.isConnected ? resolveWalletChainId(account.chainId, connectorChainId) : null,
    })
    if (!current.ok) {
      setSubmitError(notice(current.reason))
      failSubmit(new Error(current.reason), ticket)
      return
    }
    if (!tryHoldSubmit(submitSlot)) {
      failSubmit(new Error("Another transaction is still pending."), ticket)
      return
    }
    let keepLock = false
    try {
      assertSubmitTarget(active.to, allowed)
      const client = preflightClient ?? publicClient
      if (!client) {
        const unavailable = new Error("Base Sepolia client is unavailable. The wallet was not opened.")
        setSubmitError(notice(unavailable.message))
        failSubmit(unavailable, ticket)
        return
      }
      setSigning(true)
      const from = fromAddressRef?.current ?? account.address
      const hash = await submitAfterPreflight({
        chainId: BASE_SEPOLIA_CHAIN_ID,
        client,
        account: from,
        to: active.to,
        data: active.calldata,
        value: active.valueWei,
        send: async () => {
          await assertLiveChain84532(await liveChainRequest(account.connector))
          return sendTransactionAsync({
            to: active.to,
            data: active.calldata,
            value: active.valueWei,
            chainId: BASE_SEPOLIA_CHAIN_ID,
          })
        },
      })
      if (!quiet) {
        const activeSent = subjectFromCalldata(active.calldata)
        writePending({
          action: activeSent?.action ?? active.functionName,
          subjectId: activeSent?.subjectId ?? null,
          hash,
        })
      }
      onSubmitted?.(hash, ticket)
      releaseSubmit(submitSlot)
      keepLock = true
    } catch (cause) {
      keepLock = false
      failSubmit(cause, ticket)
      if (isWalletCancel(cause)) {
        setCancelled(true)
        return
      }
      setSubmitError(presentError(cause))
    } finally {
      setSigning(false)
      if (!keepLock) releaseSubmit(submitSlot)
    }
  }

  if (submitRef) {
    submitRef.current = { submit: (ticket) => { void onClick(ticket) } }
  }

  const state: ActionButtonState = !decision.ok
    ? decision.code === "disconnected"
      ? { status: "needs-wallet" }
      : { status: "wrong-network" }
    : receipt.phase === "confirmed" && receipt.txHash
      ? {
          status: "confirmed",
          hash: receipt.txHash,
          label: progress.done,
          resultId: receipt.subjectId ?? undefined,
          resultLabel: receipt.subjectId ? pendingSubjectLabel(preview.functionName) ?? undefined : undefined,
        }
      : receipt.phase === "pending" && receipt.txHash
        ? {
            status: "pending",
            hash: receipt.txHash,
            label: progress.pending,
            startedAt: receipt.startedAt ?? undefined,
            unsaved: receipt.unsaved,
          }
        : receipt.phase === "unconfirmed" && receipt.txHash
          ? { status: "unconfirmed", hash: receipt.txHash, message: unconfirmedNote(receipt.notice), unsaved: receipt.unsaved }
          : waiting
            ? { status: "waiting-wallet" }
            : { status: "idle", label: "Submit on Base Sepolia" }

  const status = (
    <>
      {guided ? <p>{submitSenderNote(preview.functionName)}</p> : null}
      <ActionStatus
        state={state}
        walletHint={walletHint}
        cancelled={cancelled}
        onTryAgain={state.status === "pending" || state.status === "unconfirmed" ? () => receipt.tryAgain() : undefined}
      />
      {receipt.banner?.kind === "reverted" ? <ActionStatus state={{ status: "error", message: TX_REVERTED_TEXT }} /> : null}
      <PendingClearedNote banner={receipt.banner} />
      {submitError ? <ActionStatus state={{ status: "error", message: submitError.main }} /> : null}
      {submitError?.detail ? <p className="hint">{submitError.detail}</p> : null}
      {submitError?.link ? (
        <p>
          <a href={submitError.link.href}>{submitError.link.label}</a>
        </p>
      ) : null}
    </>
  )

  if (quiet) return null

  return (
    <>
      {guided ? null : <p>{submitSenderNote(preview.functionName)}</p>}
      {state.status === "confirmed" ? (
        progress.next ? <NextStepLink href={progress.next.href} label={progress.next.label} /> : null
      ) : (
      <ActionButton
        testId={control.testId}
        state={state}
        reason={
          blocked && state.status === "idle"
            ? ANOTHER_PENDING_REASON
            : hold && state.status === "idle"
              ? "This step is not available for the connected wallet."
              : state.status === "needs-wallet"
                ? NO_WALLET_REASON
                : null
        }
        disabled={disabled && state.status !== "wrong-network"}
        onClick={() => {
          if (state.status === "wrong-network") {
            switchChain({ chainId: BASE_SEPOLIA_CHAIN_ID })
            return
          }
          void onClick()
        }}
      />
      )}
      {statusRoot ? createPortal(status, statusRoot) : status}
    </>
  )
}
