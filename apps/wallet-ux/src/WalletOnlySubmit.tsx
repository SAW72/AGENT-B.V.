import { useEffect, useRef, useState } from "react"
import type { Address, Hex } from "viem"
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain } from "wagmi"
import { ActionButton, ActionStatus, NO_WALLET_REASON, useWalletHint, type ActionButtonState } from "./actionButton"
import { actionProgress, ANOTHER_PENDING_REASON } from "./actionProgress"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { presentError, type ErrorPresentation } from "./format"
import { isWalletCancel } from "./revert"
import { clearPending, readPending, writePending } from "./pendingTx"
import { resolveWalletChainId } from "./guard"
import type { CallPreview } from "./preview"
import { submitAfterPreflight } from "./preflight"
import { releaseSubmit, tryHoldSubmit, useSubmitBlocked } from "./submitLock"
import { assertSubmitTarget, evaluateEscrowSubmit, submitControl, submitSenderNote } from "./submit"
import { useConnectorChainId } from "./useWalletChain"
import { isReceiptTimeout, TX_RECEIPT_UNREADABLE_TEXT, TX_REVERTED_TEXT } from "./walletCopy"

function notice(main: string): ErrorPresentation {
  return { main, detail: null }
}

type Phase = "idle" | "pending" | "confirmed"

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
  const [phase, setPhase] = useState<Phase>("idle")
  const [signing, setSigning] = useState(false)
  const [txHash, setTxHash] = useState<Hex | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const [stalled, setStalled] = useState(false)
  const [submitError, setSubmitError] = useState<ErrorPresentation | null>(null)
  const progress = actionProgress(preview.functionName)
  const slot = preview.functionName
  const ownedHash = useRef<Hex | null>(null)
  const onConfirmedRef = useRef(onConfirmed)
  onConfirmedRef.current = onConfirmed
  const waiting = signing || (isPending && phase === "idle")
  const { id: submitSlot, blocked } = useSubmitBlocked(waiting || phase === "pending")
  const walletHint = useWalletHint(waiting)
  const busy = isPending || phase === "pending" || signing
  const control = submitControl(decision, busy)
  const disabled = (decision.ok && (control.disabled || hold || phase !== "idle" || signing)) || blocked

  useEffect(() => {
    const saved = readPending(slot)
    if (!saved || !publicClient || ownedHash.current === saved.hash) return
    let stop = false
    setTxHash(saved.hash)
    setStartedAt(saved.startedAt)
    setPhase("pending")
    void publicClient.waitForTransactionReceipt({ hash: saved.hash }).then(
      (receipt) => {
        if (stop) return
        clearPending(slot)
        if (receipt.status !== "success") {
          setPhase("idle")
          setSubmitError(notice(TX_REVERTED_TEXT))
          return
        }
        setPhase("confirmed")
        onConfirmedRef.current?.()
      },
      (cause) => {
        if (stop) return
        if (isReceiptTimeout(cause)) {
          setStalled(true)
          return
        }
        clearPending(slot)
        setPhase("idle")
        setSubmitError(notice(TX_RECEIPT_UNREADABLE_TEXT))
      },
    )
    return () => {
      stop = true
    }
  }, [publicClient, slot])

  async function onClick() {
    if (hold || phase !== "idle" || blocked) return
    setSubmitError(null)
    setCancelled(false)
    setStalled(false)
    const current = evaluateEscrowSubmit({
      walletConnected: account.isConnected,
      walletChainId: account.isConnected ? resolveWalletChainId(account.chainId, connectorChainId) : null,
    })
    if (!current.ok) {
      setTxHash(null)
      setPhase("idle")
      setSubmitError(notice(current.reason))
      return
    }
    if (!tryHoldSubmit(submitSlot)) return
    let submitted: Hex | null = null
    let keepLock = false
    try {
      assertSubmitTarget(preview.to, allowed)
      if (!publicClient) {
        setTxHash(null)
        setPhase("idle")
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
      submitted = hash
      ownedHash.current = hash
      const stored = writePending(slot, hash)
      setStartedAt(stored.startedAt)
      setSigning(false)
      setTxHash(hash)
      setPhase("pending")
      keepLock = true
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      keepLock = false
      clearPending(slot)
      if (receipt.status !== "success") {
        setPhase("idle")
        setSubmitError(notice(TX_REVERTED_TEXT))
        return
      }
      setPhase("confirmed")
      onConfirmed?.()
    } catch (cause) {
      setSigning(false)
      if (submitted && isReceiptTimeout(cause)) {
        setPhase("pending")
        setStalled(true)
        keepLock = true
        return
      }
      keepLock = false
      if (submitted) {
        clearPending(slot)
        setPhase("idle")
        setSubmitError(notice(TX_RECEIPT_UNREADABLE_TEXT))
        return
      }
      setTxHash(null)
      setPhase("idle")
      if (isWalletCancel(cause)) {
        setCancelled(true)
        return
      }
      setSubmitError(presentError(cause))
    } finally {
      if (!keepLock) releaseSubmit(submitSlot)
    }
  }

  const state: ActionButtonState = !decision.ok
    ? decision.code === "disconnected"
      ? { status: "needs-wallet" }
      : { status: "wrong-network" }
    : phase === "confirmed" && txHash
      ? {
          status: "confirmed",
          hash: txHash,
          label: progress.done,
          nextHref: progress.next?.href,
          nextLabel: progress.next?.label,
        }
      : phase === "pending" && txHash
        ? { status: "pending", hash: txHash, label: progress.pending, startedAt: startedAt ?? undefined, stalled }
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
      <ActionStatus state={state} walletHint={walletHint} cancelled={cancelled} />
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
