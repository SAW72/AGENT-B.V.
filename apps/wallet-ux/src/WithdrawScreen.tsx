import { useEffect, useRef, useState, type FormEvent } from "react"
import type { Address } from "viem"
import { useAccount, usePublicClient } from "wagmi"
import { escrowAbi } from "./abi"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { WALLET_SIGNED_TEST_LINE } from "./brand"
import { formatEth } from "./format"
import { ActionButton, ActionStatus } from "./actionButton"
import { CONTRACT_LABELS, GAS_FEE_TEXT } from "./actionProgress"
import { preparedMatches } from "./pendingTx"
import { prepareFailure, usePreparedRouteGuard, usePrepareSession, yieldPrepareTick } from "./prepareFeedback"
import { previewWithdraw, type CallPreview } from "./preview"
import { GuidedStepFooter, asideFromFooter, flowMayAdvance, footerReasonText, useFlowReadiness } from "./guidedFooter"
import { flowHref, historyAllowsStep, navigate, replaceRoute, shownStep, walletHome, type WalletRoute } from "./routes"
import { FLOW_STEP_LABELS } from "./walkthrough"
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

export type WithdrawReads = "pending" | "allowed" | "refused"

/** Pending is still checking. Refused is a finished check that did not allow reads. */
export function withdrawReadMode(chainPending: boolean, readsAllowed: boolean): WithdrawReads {
  if (chainPending) return "pending"
  return readsAllowed ? "allowed" : "refused"
}

function withdrawStatusText(
  state: "idle" | "loading" | "pending" | "ready" | "unreadable" | "hidden" | "disconnected",
  credit: bigint | null,
): string {
  if (state === "disconnected") return WITHDRAW_CONNECT_TEXT
  if (state === "hidden") return WITHDRAW_HIDDEN_TEXT
  if (state === "unreadable") return WITHDRAW_UNREADABLE_TEXT
  if (state === "ready" && credit != null) return availableToWithdrawText(formatEth(credit))
  return WITHDRAW_READING_TEXT
}

function withdrawBlockReason(
  state: "idle" | "loading" | "pending" | "ready" | "unreadable" | "hidden" | "disconnected",
  credit: bigint | null,
): string {
  if (state === "ready" && credit === 0n) return NOTHING_TO_WITHDRAW_TEXT
  return withdrawStatusText(state, credit)
}

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
  reads,
  route = null,
}: {
  escrow: Address | null
  reads: WithdrawReads
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
      <TestnetHeading />
      {route?.stepNotice ? (
        <p className="banner" role="status" data-testid="url-step-notice">
          {route.stepNotice}
        </p>
      ) : null}
      <p className="muted" data-testid="withdraw-gas">
        {WITHDRAW_GAS_TEXT}
      </p>
      <WithdrawForm escrow={escrow} reads={reads} guided={guided} step={route?.step ?? 1} />
    </section>
  )
}

function WithdrawForm({
  escrow,
  reads,
  guided,
  step,
}: {
  escrow: Address
  reads: WithdrawReads
  guided: boolean
  step: number
}) {
  const account = useAccount()
  const readiness = useFlowReadiness()
  const client = usePublicClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const [credit, setCredit] = useState<bigint | null>(null)
  const [creditState, setCreditState] = useState<
    "idle" | "loading" | "pending" | "ready" | "unreadable" | "hidden" | "disconnected"
  >("idle")
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
    if (reads === "pending") {
      setCredit(null)
      setCreditState("pending")
      return
    }
    if (reads !== "allowed") {
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
  }, [account.address, account.isConnected, Boolean(client), escrow, generation, reads])

  const canPrepare = creditState === "ready" && credit != null && credit > 0n
  const withdrawReady = session.preview != null && preparedMatches(session.preview.calldata, { action: "withdraw" })
  const guard = usePreparedRouteGuard(session.clear, `withdraw|${step}`)
  const displayStep = guided ? shownStep(step, 2, guard.allowed || historyAllowsStep(), withdrawReady) : 1
  const [withdrawStatus, setWithdrawStatus] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!guided || step <= 1 || displayStep !== 1) return
    replaceRoute(flowHref("withdraw", 1))
  }, [guided, step, displayStep])

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
    if (!flowMayAdvance(readiness)) return
    const ok = await onWithdraw()
    if (ok) {
      guard.arm("withdraw|2")
      navigate(flowHref("withdraw", 2), { allowStep: true })
    }
  }

  const availableText = withdrawStatusText(creditState, credit)
  const blockedLabel = withdrawBlockReason(creditState, credit)
  const stepReason = canPrepare ? null : blockedLabel
  const displayedReason = guided
    ? footerReasonText({
        readiness,
        busy: session.preparing,
        nextDisabled: session.preparing || !canPrepare,
        reason: stepReason,
      })
    : null
  const inlineText = guided ? asideFromFooter(availableText, displayedReason) : availableText

  if (guided && displayStep >= 2 && withdrawReady && session.preview) {
    const lead =
      credit != null && credit > 0n
        ? `You are withdrawing ${formatEth(credit)} test ETH to this connected wallet.`
        : "You are withdrawing the credited test ETH to this connected wallet."
    return (
      <div data-testid="review-step">
        <Stepper step={2} total={2} labels={FLOW_STEP_LABELS.withdraw} />
        <div className="preview" data-testid="withdraw-preview" tabIndex={-1} aria-label="Prepared withdrawal" ref={session.setNode}>
          <p data-testid="review-plain">{lead}</p>
          <p data-testid="review-contract">{CONTRACT_LABELS.escrow}</p>
          <LabeledChunks label="Contract" address={session.preview.to} testId="review-contract-address" />
          <p data-testid="review-gas">{GAS_FEE_TEXT}</p>
          <CalldataDetails calldata={session.preview.calldata} />
        </div>
        <div ref={setWithdrawStatus} />
        <StepFooter onBack={() => navigate(flowHref("withdraw", 1), { allowStep: true })}>
          <WalletOnlySubmit
            key={session.preview.calldata}
            preview={session.preview}
            allowed={[escrow]}
            hold={!canPrepare}
            guided
            statusRoot={withdrawStatus}
            onConfirmed={() => setGeneration((value) => value + 1)}
          />
        </StepFooter>
      </div>
    )
  }

  return (
    <>
      {guided ? <Stepper step={1} total={2} labels={FLOW_STEP_LABELS.withdraw} /> : null}
      <AddressRow label="Agent-BV escrow" value={escrow} testId="withdraw-escrow" />
      <p className="withdraw-available" data-testid={inlineText ? "withdraw-available" : undefined}>
        {inlineText}
      </p>
      {guided ? (
        <form
          id="withdraw-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (!flowMayAdvance(readiness)) return
            void onNext()
          }}
        >
          <GuidedStepFooter
            onBack={() => navigate(walletHome())}
            onNext={() => void onNext()}
            busy={session.preparing}
            nextDisabled={session.preparing || !canPrepare}
            reason={stepReason}
          />
          {session.error ? <ActionStatus state={{ status: "error", message: session.error }} nodeRef={session.setNode} /> : null}
        </form>
      ) : (
      <form id="withdraw-form" onSubmit={(event) => void onWithdraw(event)}>
        <ActionButton
          type="submit"
          disabled={session.preparing || !canPrepare}
          reason={stepReason}
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
