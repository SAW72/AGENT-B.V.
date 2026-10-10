import { useEffect, useRef, useState, type FormEvent } from "react"
import { formatEther, type Address } from "viem"
import { useAccount, usePublicClient } from "wagmi"
import { escrowAbi } from "./abi"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { TESTNET_LINE, WALLET_SIGNED_TEST_LINE } from "./brand"
import { formatEth } from "./format"
import { ActionButton, ActionStatus } from "./actionButton"
import { prepareFailure, usePrepareSession, yieldPrepareTick } from "./prepareFeedback"
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
  const [credit, setCredit] = useState<bigint | null>(null)
  const [creditState, setCreditState] = useState<"idle" | "loading" | "ready" | "unreadable" | "hidden" | "disconnected">(
    "idle",
  )
  const [generation, setGeneration] = useState(0)
  const session = usePrepareSession<CallPreview>("withdraw", null)
  const creditRef = useRef(credit)
  const creditStateRef = useRef(creditState)
  creditRef.current = credit
  creditStateRef.current = creditState

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

  async function onWithdraw(event: FormEvent) {
    event.preventDefault()
    if (creditStateRef.current !== "ready" || creditRef.current == null || creditRef.current <= 0n) return
    if (!session.begin()) return
    try {
      await yieldPrepareTick()
      if (creditStateRef.current !== "ready" || creditRef.current == null || creditRef.current <= 0n) return
      session.publish(null, previewWithdraw(escrow))
    } catch (cause) {
      session.publish(prepareFailure("withdrawal", cause), null)
    } finally {
      session.finish()
    }
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
      <form id="withdraw-form" onSubmit={(event) => void onWithdraw(event)}>
        <ActionButton
          type="submit"
          disabled={session.preparing || !canPrepare}
          state={
            session.preparing
              ? { status: "busy", label: "Preparing…" }
              : { status: "idle", label: canPrepare ? "Prepare withdraw" : blockedLabel }
          }
        />
        {session.error ? (
          <ActionStatus state={{ status: "error", message: session.error }} nodeRef={session.setNode} />
        ) : session.preview ? (
          <div
            className="preview"
            data-testid="withdraw-preview"
            tabIndex={-1}
            aria-label="Prepared withdrawal"
            ref={session.setNode}
          >
            <p>{previewCardCopy(session.preview.functionName, false)}</p>
            <p className="mono">{session.preview.to}</p>
            <p>value {formatEther(session.preview.valueWei)} ETH</p>
            <pre className="calldata">{session.preview.calldata}</pre>
            <WalletOnlySubmit
              key={session.preview.calldata}
              preview={session.preview}
              allowed={[escrow]}
              hold={!canPrepare}
              onConfirmed={() => setGeneration((value) => value + 1)}
            />
          </div>
        ) : null}
      </form>
    </>
  )
}
