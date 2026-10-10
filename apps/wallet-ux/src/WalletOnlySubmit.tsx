import { useState } from "react"
import type { Address, Hex } from "viem"
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain } from "wagmi"
import { ActionButton, ActionStatus, useWalletHint, type ActionButtonState } from "./actionButton"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { presentError, type ErrorPresentation } from "./format"
import { resolveWalletChainId } from "./guard"
import type { CallPreview } from "./preview"
import { submitAfterPreflight } from "./preflight"
import { releaseSubmit, tryHoldSubmit, useSubmitBlocked } from "./submitLock"
import { assertSubmitTarget, evaluateEscrowSubmit, submitControl, submitSenderNote } from "./submit"
import { useConnectorChainId } from "./useWalletChain"
import { TX_RECEIPT_UNREADABLE_TEXT, TX_REVERTED_TEXT } from "./walletCopy"

function notice(main: string): ErrorPresentation {
  return { main, detail: null }
}

type Phase = "idle" | "pending" | "confirmed"

/**
 * Submit one prepared call from the connected wallet on Base Sepolia.
 * This control does not import the claim relayer and does not collect key material.
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
  const [submitError, setSubmitError] = useState<ErrorPresentation | null>(null)
  const waiting = signing || (isPending && phase === "idle")
  const { id: submitSlot, blocked } = useSubmitBlocked(waiting || phase === "pending")
  const walletHint = useWalletHint(waiting)
  const busy = isPending || phase === "pending" || signing
  const control = submitControl(decision, busy)
  const disabled = (decision.ok && (control.disabled || hold || phase !== "idle" || signing)) || blocked

  async function onClick() {
    if (hold || phase !== "idle" || blocked) return
    setSubmitError(null)
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
    try {
      assertSubmitTarget(preview.to, allowed)
      if (!publicClient) {
        releaseSubmit(submitSlot)
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
      setSigning(false)
      setTxHash(hash)
      setPhase("pending")
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== "success") {
        setPhase("idle")
        setSubmitError(notice(TX_REVERTED_TEXT))
        return
      }
      setPhase("confirmed")
      onConfirmed?.()
    } catch (cause) {
      setSigning(false)
      if (submitted) {
        setPhase("idle")
        setSubmitError(notice(TX_RECEIPT_UNREADABLE_TEXT))
        return
      }
      setTxHash(null)
      setPhase("idle")
      setSubmitError(presentError(cause))
    }
  }

  const state: ActionButtonState = !decision.ok
    ? decision.code === "disconnected"
      ? { status: "needs-wallet" }
      : { status: "wrong-network" }
    : phase === "confirmed" && txHash
      ? { status: "confirmed", hash: txHash }
      : phase === "pending" && txHash
        ? { status: "pending", hash: txHash }
        : waiting
          ? { status: "waiting-wallet" }
          : { status: "idle", label: "Submit on Base Sepolia" }

  return (
    <div>
      <p>{submitSenderNote(preview.functionName)}</p>
      <ActionButton
        testId={control.testId}
        state={state}
        disabled={disabled && state.status !== "wrong-network"}
        onClick={() => {
          if (state.status === "wrong-network") {
            switchChain({ chainId: BASE_SEPOLIA_CHAIN_ID })
            return
          }
          void onClick()
        }}
      />
      <ActionStatus state={state} walletHint={walletHint} />
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
