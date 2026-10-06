import { useEffect, useState, type FormEvent } from "react"
import { formatEther, type Address } from "viem"
import { useAccount, usePublicClient } from "wagmi"
import { escrowAbi } from "./abi"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { TESTNET_LINE, WALLET_SIGNED_TEST_LINE } from "./brand"
import { formatEth } from "./format"
import { previewWithdraw, type CallPreview } from "./preview"
import { previewCardCopy } from "./submit"
import { AddressRow } from "./ui"
import {
  NOTHING_TO_WITHDRAW_TEXT,
  WITHDRAW_CONNECT_TEXT,
  WITHDRAW_GAS_TEXT,
  WITHDRAW_HEADING,
  WITHDRAW_HIDDEN_TEXT,
  WITHDRAW_READING_TEXT,
  WITHDRAW_UNREADABLE_TEXT,
  availableToWithdrawText,
} from "./walletCopy"
import { WalletOnlySubmit } from "./WalletOnlySubmit"

function TestnetHeading() {
  return (
    <>
      <h2 id="withdraw-heading" className="heading-with-pill">
        <span>{WITHDRAW_HEADING}</span>
        <span className="pill info" data-testid="withdraw-testnet-pill">
          {TESTNET_LINE}
        </span>
      </h2>
      <p data-testid="withdraw-test-only">{WALLET_SIGNED_TEST_LINE}</p>
    </>
  )
}

export function WithdrawScreen({
  escrow,
  readsEnabled,
}: {
  escrow: Address | null
  readsEnabled: boolean
}) {
  if (escrow == null) {
    return (
      <section className="card" aria-labelledby="withdraw-heading" data-testid="withdraw-screen">
        <TestnetHeading />
        <div className="empty" data-testid="withdraw-empty" role="status">
          <strong>Not deployed on Sepolia yet.</strong>
          <p>The Agent-BV escrow address is empty. There is nothing to withdraw.</p>
        </div>
      </section>
    )
  }

  return (
    <section className="card" aria-labelledby="withdraw-heading" data-testid="withdraw-screen">
      <TestnetHeading />
      <p className="muted" data-testid="withdraw-gas">
        {WITHDRAW_GAS_TEXT}
      </p>
      <WithdrawForm escrow={escrow} readsEnabled={readsEnabled} />
    </section>
  )
}

function WithdrawForm({ escrow, readsEnabled }: { escrow: Address; readsEnabled: boolean }) {
  const account = useAccount()
  const client = usePublicClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const [preview, setPreview] = useState<CallPreview | null>(null)
  const [credit, setCredit] = useState<bigint | null>(null)
  const [creditState, setCreditState] = useState<"idle" | "loading" | "ready" | "unreadable" | "hidden" | "disconnected">(
    "idle",
  )
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    const accountAddress = account.address
    if (!account.isConnected || !accountAddress) {
      setCredit(null)
      setCreditState("disconnected")
      return
    }
    if (!readsEnabled) {
      setCredit(null)
      setCreditState("hidden")
      return
    }
    if (!client) {
      setCredit(null)
      setCreditState("unreadable")
      return
    }
    let cancelled = false
    setCreditState((state) => (state === "ready" ? state : "loading"))
    void client
      .readContract({
        address: escrow,
        abi: escrowAbi,
        functionName: "pendingWithdrawals",
        args: [accountAddress],
      })
      .then(
        (value) => {
          if (cancelled) return
          if (typeof value !== "bigint") {
            setCreditState("unreadable")
            return
          }
          setCredit(value)
          setCreditState("ready")
        },
        () => {
          if (!cancelled) setCreditState("unreadable")
        },
      )
    return () => {
      cancelled = true
    }
  }, [account.address, account.isConnected, client, escrow, generation, readsEnabled])

  const canPrepare = creditState === "ready" && credit != null && credit > 0n

  function onWithdraw(event: FormEvent) {
    event.preventDefault()
    if (!canPrepare) return
    setPreview(previewWithdraw(escrow))
  }

  const availableText =
    creditState === "disconnected"
      ? WITHDRAW_CONNECT_TEXT
      : creditState === "hidden"
        ? WITHDRAW_HIDDEN_TEXT
        : creditState === "unreadable"
          ? WITHDRAW_UNREADABLE_TEXT
          : creditState === "ready" && credit != null
            ? availableToWithdrawText(formatEth(credit))
            : WITHDRAW_READING_TEXT

  const blockedLabel =
    creditState === "ready" && credit === 0n
      ? NOTHING_TO_WITHDRAW_TEXT
      : creditState === "unreadable"
        ? WITHDRAW_UNREADABLE_TEXT
        : creditState === "disconnected"
          ? WITHDRAW_CONNECT_TEXT
          : creditState === "hidden"
            ? WITHDRAW_HIDDEN_TEXT
            : WITHDRAW_READING_TEXT

  return (
    <>
      <AddressRow label="Agent-BV escrow" value={escrow} testId="withdraw-escrow" />
      <p data-testid="withdraw-available">{availableText}</p>
      <form id="withdraw-form" onSubmit={onWithdraw}>
        <button type="submit" disabled={!canPrepare}>
          {canPrepare ? "Prepare withdraw" : blockedLabel}
        </button>
      </form>
      {preview ? (
        <div className="preview" data-testid="withdraw-preview">
          <p>{previewCardCopy(preview.functionName, false)}</p>
          <p className="mono">{preview.to}</p>
          <p>value {formatEther(preview.valueWei)} ETH</p>
          <pre className="calldata">{preview.calldata}</pre>
          <WalletOnlySubmit
            key={preview.calldata}
            preview={preview}
            allowed={[escrow]}
            hold={!canPrepare}
            onConfirmed={() => setGeneration((value) => value + 1)}
          />
        </div>
      ) : null}
    </>
  )
}
