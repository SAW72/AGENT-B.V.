import { useRef, useState } from "react"
import type { Address } from "viem"
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain } from "wagmi"
import {
  ActionButton,
  ActionStatus,
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
import { submitAfterPreflight } from "./preflight"
import { releaseSubmit, tryHoldSubmit, useSubmitBlocked } from "./submitLock"
import { assertSubmitTarget, evaluateEscrowSubmit, submitControl, submitSenderNote } from "./submit"
import { usePendingReceipt } from "./usePendingReceipt"
import { useConnectorChainId } from "./useWalletChain"
import { TX_REVERTED_TEXT } from "./walletCopy"

function notice(main: string): ErrorPresentation {
  return { main, detail: null }
}

/**
 * Submit one prepared call from the connected wallet on Base Sepolia.
 * This control does not import the refund relayer and does not collect key material.
 */
export function WalletOnlySubmit({
  preview,
  allowed,
  hold = false,
  onConfirmed,
}: {
  preview: CallPreview
  allowed: readonly Address[]
  hold?: boolean
  onConfirmed?: () => void
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
  const progress = actionProgress(preview.functionName)
  const sent = subjectFromCalldata(preview.calldata)
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

  async function onClick() {
    if (hold || receipt.phase !== "idle" || blocked) return
    setSubmitError(null)
    receipt.dismissBanner()
    setCancelled(false)
    const current = evaluateEscrowSubmit({
      walletConnected: account.isConnected,
      walletChainId: account.isConnected ? resolveWalletChainId(account.chainId, connectorChainId) : null,
    })
    if (!current.ok) {
      setSubmitError(notice(current.reason))
      return
    }
    if (!tryHoldSubmit(submitSlot)) return
    let keepLock = false
    try {
      assertSubmitTarget(preview.to, allowed)
      if (!publicClient) {
        setSubmitError(notice("Base Sepolia client is unavailable. The wallet was not opened."))
        return
      }
      setSigning(true)
      const hash = await submitAfterPreflight({
        chainId: BASE_SEPOLIA_CHAIN_ID,
        client: publicClient,
        account: account.address,
        to: preview.to,
        data: preview.calldata,
        value: preview.valueWei,
        send: () =>
          sendTransactionAsync({
            to: preview.to,
            data: preview.calldata,
            value: preview.valueWei,
            chainId: BASE_SEPOLIA_CHAIN_ID,
          }),
      })
      writePending({
        action: sent?.action ?? preview.functionName,
        subjectId: sent?.subjectId ?? null,
        hash,
      })
      releaseSubmit(submitSlot)
      keepLock = true
    } catch (cause) {
      keepLock = false
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
          nextHref: progress.next?.href,
          nextLabel: progress.next?.label,
        }
      : receipt.phase === "pending" && receipt.txHash
        ? { status: "pending", hash: receipt.txHash, label: progress.pending, startedAt: receipt.startedAt ?? undefined }
        : receipt.phase === "unconfirmed" && receipt.txHash
          ? { status: "unconfirmed", hash: receipt.txHash }
          : waiting
            ? { status: "waiting-wallet" }
            : { status: "idle", label: "Submit on Base Sepolia" }

  return (
    <div>
      <p>{submitSenderNote(preview.functionName)}</p>
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
      <ActionStatus
        state={state}
        walletHint={walletHint}
        cancelled={cancelled}
        onTryAgain={state.status === "unconfirmed" ? () => receipt.tryAgain() : undefined}
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
    </div>
  )
}
