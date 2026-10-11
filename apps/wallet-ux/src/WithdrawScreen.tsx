import { useEffect, useRef, useState, type FormEvent } from "react"
import type { Address } from "viem"
import { useAccount, usePublicClient } from "wagmi"
import { escrowAbi } from "./abi"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { WALLET_SIGNED_TEST_LINE } from "./brand"
import { formatEth } from "./format"
import { ActionButton, ActionStatus } from "./actionButton"
import { CONTRACT_LABELS, GAS_FEE_TEXT } from "./actionProgress"
import { prepareFailure, usePrepareSession, yieldPrepareTick } from "./prepareFeedback"
import { previewWithdraw, type CallPreview } from "./preview"
import { REVIEW_EMPTY, navigate, type WalletRoute } from "./routes"
import { previewCardCopy } from "./submit"
import { StepFooter, Stepper } from "./steps"
import { AddressRow, CalldataDetails, LabeledChunks } from "./ui"
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
      <h2 id="withdraw-heading">{WITHDRAW_HEADING}</h2>
      <p data-testid="withdraw-test-only">{WALLET_SIGNED_TEST_LINE}</p>
    </>
  )
}

export function WithdrawScreen({
  escrow,
  readsEnabled,
  route = null,
}: {
  escrow: Address | null
  readsEnabled: boolean
  route?: WalletRoute | null
}) {
  if (escrow == null) {
    return (
      <section id="withdraw-screen" className="card" aria-labelledby="withdraw-heading" data-testid="withdraw-screen">
        <TestnetHeading />
        <div className="empty" data-testid="withdraw-empty" role="status">
          <strong>Not deployed on Sepolia yet.</strong>
          <p>The Agent-BV escrow address is empty. There is nothing to withdraw.</p>
        </div>
      </section>
    )
  }

  const guided = route?.flow === "withdraw"
  return (
    <section
      id="withdraw-screen"
      className={guided ? "card guided-flow" : "card"}
      aria-labelledby="withdraw-heading"
      data-testid="withdraw-screen"
    >
      {guided ? <Stepper step={route?.step ?? 1} total={2} /> : null}
      <TestnetHeading />
      {route?.stepNotice ? (
        <p className="banner" role="status" data-testid="url-step-notice">
          {route.stepNotice}
        </p>
      ) : null}
      <p className="muted" data-testid="withdraw-gas">
        {WITHDRAW_GAS_TEXT}
      </p>
      <WithdrawForm escrow={escrow} readsEnabled={readsEnabled} guided={guided} step={route?.step ?? 1} />
    </section>
  )
}

function WithdrawForm({
  escrow,
  readsEnabled,
  guided,
  step,
}: {
  escrow: Address
  readsEnabled: boolean
  guided: boolean
  step: number
}) {
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

  async function onWithdraw(event?: FormEvent): Promise<boolean> {
    event?.preventDefault()
    if (creditStateRef.current !== "ready" || creditRef.current == null || creditRef.current <= 0n) return false
    if (!session.begin()) return false
    try {
      await yieldPrepareTick()
      if (creditStateRef.current !== "ready" || creditRef.current == null || creditRef.current <= 0n) return false
      session.publish(null, previewWithdraw(escrow))
      return true
    } catch (cause) {
      session.publish(prepareFailure("withdrawal", cause), null)
      return false
    } finally {
      session.finish()
    }
  }

  async function onNext() {
    const ok = await onWithdraw()
    if (ok) navigate("/withdraw?step=2")
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

  if (guided && step >= 2) {
    const lead =
      credit != null && credit > 0n
        ? `You are withdrawing ${formatEth(credit)} test ETH to this connected wallet.`
        : "You are withdrawing the credited test ETH to this connected wallet."
    return (
      <div data-testid="review-step">
        {session.error ? (
          <ActionStatus state={{ status: "error", message: session.error }} nodeRef={session.setNode} />
        ) : session.preview ? (
          <div className="preview" data-testid="withdraw-preview" tabIndex={-1} aria-label="Prepared withdrawal" ref={session.setNode}>
            <p data-testid="review-plain">{lead}</p>
            <p>{previewCardCopy(session.preview.functionName, false)}</p>
            <p data-testid="review-contract">{CONTRACT_LABELS.escrow}</p>
            <LabeledChunks label="Contract" address={session.preview.to} testId="review-contract-address" />
            <p data-testid="review-gas">{GAS_FEE_TEXT}</p>
            <CalldataDetails calldata={session.preview.calldata} />
          </div>
        ) : (
          <p className="hint" role="status" data-testid="review-empty">
            {REVIEW_EMPTY}
          </p>
        )}
        <StepFooter onBack={() => navigate("/withdraw")}>
          {session.preview ? (
            <WalletOnlySubmit
              key={session.preview.calldata}
              preview={session.preview}
              allowed={[escrow]}
              hold={!canPrepare}
              guided
              onConfirmed={() => setGeneration((value) => value + 1)}
            />
          ) : (
            <ActionButton disabled reason={REVIEW_EMPTY} state={{ status: "idle", label: "Submit on Base Sepolia" }} />
          )}
        </StepFooter>
      </div>
    )
  }

  return (
    <>
      <AddressRow label="Agent-BV escrow" value={escrow} testId="withdraw-escrow" />
      <p data-testid="withdraw-available">{availableText}</p>
      {guided ? (
        <form
          id="withdraw-form"
          onSubmit={(event) => {
            event.preventDefault()
            void onNext()
          }}
        >
          <StepFooter onBack={() => navigate("/")}>
            <ActionButton
              type="button"
              disabled={session.preparing || !canPrepare}
              reason={canPrepare ? null : blockedLabel}
              onClick={() => void onNext()}
              state={
                session.preparing
                  ? { status: "busy", label: "Preparing…" }
                  : { status: "idle", label: "Next" }
              }
            />
          </StepFooter>
          {session.error ? <ActionStatus state={{ status: "error", message: session.error }} nodeRef={session.setNode} /> : null}
        </form>
      ) : (
      <form id="withdraw-form" onSubmit={(event) => void onWithdraw(event)}>
        <ActionButton
          type="submit"
          disabled={session.preparing || !canPrepare}
          reason={canPrepare ? null : blockedLabel}
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
            <p data-testid="review-contract">{CONTRACT_LABELS.escrow}</p>
            <LabeledChunks label="Contract" address={session.preview.to} testId="review-contract-address" />
            <p data-testid="review-gas">{GAS_FEE_TEXT}</p>
            <CalldataDetails calldata={session.preview.calldata} />
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
      )}
    </>
  )
}
