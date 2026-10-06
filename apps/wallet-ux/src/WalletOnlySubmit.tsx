import { useState } from "react"
import type { Address, Hex } from "viem"
import { useAccount, usePublicClient, useSendTransaction } from "wagmi"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { ErrorNotice } from "./ErrorNotice"
import { presentError, type ErrorPresentation } from "./format"
import { resolveWalletChainId } from "./guard"
import type { CallPreview } from "./preview"
import { submitAfterPreflight } from "./preflight"
import { assertSubmitTarget, evaluateEscrowSubmit, submitControl, submitSenderNote } from "./submit"
import { useConnectorChainId } from "./useWalletChain"
import {
  TX_CONFIRMED_TEXT,
  TX_LINK_LABEL,
  TX_PENDING_TEXT,
  TX_RECEIPT_UNREADABLE_TEXT,
  TX_REVERTED_TEXT,
  txExplorerUrl,
} from "./walletCopy"

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
  const connectorChainId = useConnectorChainId(account.connector, account.isConnected)
  const walletChainId = account.isConnected ? resolveWalletChainId(account.chainId, connectorChainId) : null
  const decision = evaluateEscrowSubmit({ walletConnected: account.isConnected, walletChainId })
  const publicClient = usePublicClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const { sendTransactionAsync, isPending } = useSendTransaction()
  const [phase, setPhase] = useState<Phase>("idle")
  const [txHash, setTxHash] = useState<Hex | null>(null)
  const [submitError, setSubmitError] = useState<ErrorPresentation | null>(null)
  const busy = isPending || phase === "pending"
  const control = submitControl(decision, busy)
  const disabled = control.disabled || hold || phase !== "idle"

  async function onClick() {
    if (disabled) return
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
    let submitted: Hex | null = null
    try {
      assertSubmitTarget(preview.to, allowed)
      if (!publicClient) {
        setTxHash(null)
        setPhase("idle")
        setSubmitError(notice("Base Sepolia client is unavailable. The wallet was not opened."))
        return
      }
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

  return (
    <div>
      <p>{submitSenderNote(preview.functionName)}</p>
      <button type="button" data-testid={control.testId} disabled={disabled} onClick={() => void onClick()}>
        {control.label}
      </button>
      {phase === "pending" ? (
        <p role="status" data-testid="tx-pending">
          {TX_PENDING_TEXT}
        </p>
      ) : null}
      {phase === "confirmed" ? (
        <p role="status" data-testid="tx-confirmed">
          {TX_CONFIRMED_TEXT}
        </p>
      ) : null}
      {txHash ? (
        <>
          <p className="mono" data-testid="tx-hash">
            {txHash}
          </p>
          <p>
            <a href={txExplorerUrl(txHash)} data-testid="tx-explorer" target="_blank" rel="noreferrer">
              {TX_LINK_LABEL}
            </a>
          </p>
        </>
      ) : null}
      {submitError ? (
        <ErrorNotice main={submitError.main} detail={submitError.detail} link={submitError.link} />
      ) : null}
    </div>
  )
}
