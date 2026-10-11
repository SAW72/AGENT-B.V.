import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { formatEther, parseEther, type Address, type Hex } from "viem"
import { useAccount, useBalance, usePublicClient, useSendTransaction, useSwitchChain, useWalletClient } from "wagmi"
import {
  ActionButton,
  ActionStatus,
  AMOUNT_HINT,
  AMOUNT_PLACEHOLDER,
  CHECKING_LABEL,
  DISPUTE_ID_HINT,
  DISPUTE_ID_LABEL,
  ESCROW_ID_HINT,
  ESCROW_ID_LABEL,
  GENERATE_LABEL,
  NO_WALLET_REASON,
  PAYEE_SELF_WARNING,
  PendingClearedNote,
  USE_OWN_LABEL,
  useWalletHint,
  type ActionButtonState,
} from "./actionButton"
import { actionProgress, CONTRACT_LABELS, GAS_FEE_TEXT, BALANCE_WARN_TEXT, ANOTHER_PENDING_REASON, REFUND_ALREADY_PENDING_REASON } from "./actionProgress"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { parseBytes32, randomBytes32 } from "./bytes32"
import { readUrlBytes32, useCarriedIds, useSyncedPrefill } from "./carriedIds"
import { DEFAULT_DURATION_SECONDS, DURATION_PRESETS, parseWholeSeconds } from "./duration"
import { ESCROW_UNREAD_TEXT, READING_ESCROW_TEXT, useEscrowActionGate } from "./escrowGate"
import { disputeWindowMessage, readDisputeSubject, type DisputeSubjectResult } from "./disputeSubject"
import { ErrorNotice } from "./ErrorNotice"
import { chunkHex, formatLocalTimestamp, isZeroAddress, presentError, sameAddress, type ErrorPresentation } from "./format"
import { isWalletCancel } from "./revert"
import { currentNowSeconds } from "./nowClock"
import {
  clearPending,
  pendingSlot,
  pendingSubjectLabel,
  preparedMatches,
  subjectFromCalldata,
  writePending,
  writeRelayerPending,
} from "./pendingTx"
import { parsePayeeAddress, payeeHasChecksumError } from "./payeeAddress"
import { prepareFailure, usePreparedRouteGuard, usePrepareSession, yieldPrepareTick } from "./prepareFeedback"
import { resolveWalletChainId } from "./guard"
import {
  ERROR_GLOSSARY,
  FILE_DISPUTE_BUTTON,
  FILE_DISPUTE_TEXT,
  MAX_DURATION_SECONDS,
  POST_EXPIRY_REFUND_INTRO,
  POST_EXPIRY_REFUND_ORDER,
  previewCreateEscrow,
  previewDispute,
  previewRefund,
  previewRelease,
  type CallPreview,
} from "./preview"
import {
  CANONICAL_WALLET_HREF,
  CANONICAL_WALLET_ORIGIN,
  formatHealthReply,
  isHealthCancelled,
  pageOrigin,
  previewSupportsRelayer,
  readRelayerHealth,
  RELAYER_CONFIRMED_TEXT,
  RELAYER_CONNECT_NOTE,
  RELAYER_HEALTH_RETRY_LABEL,
  RELAYER_OPEN_CANONICAL_LABEL,
  RELAYER_PANEL_TEXT,
  RELAYER_WRONG_ORIGIN_TEXT,
  RELAYER_SERVICE_DOWN_TEXT,
  RELAYER_SUBMITTED_TEXT,
  RELAYER_SUBMITTING_TEXT,
  RELAYER_TX_LINK_LABEL,
  RELAYER_WAITING_TEXT,
  relayerButtonModel,
  relayerConfigFromEnv,
  relayerHealthWakes,
  relayerSubmitAllowed,
  relayerTxUrl,
  runRelayerSubmission,
  walletOriginAllowsRelayer,
  warnTerminalHealth,
  watchRelayerHealth,
  type RelayerHealth,
  type RelayerHealthUpdate,
  type RelayerPhase,
} from "./relayer"
import { submitAfterPreflight } from "./preflight"
import {
  assertSubmitTarget,
  durationValidationMessage,
  evaluateEscrowSubmit,
  FORM_ERRORS,
  previewCardCopy,
  submitControl,
  submitSenderNote,
} from "./submit"
import { releaseSubmit, tryHoldSubmit, useSubmitBlocked } from "./submitLock"
import { useConnectorChainId } from "./useWalletChain"
import { confirmedNext, flowHref, historyAllowsStep, navigate, replaceRoute, shownStep, type WalletRoute } from "./routes"
import { FilledFromLink, IdRow, ReadonlyValue, StepFooter, Stepper } from "./steps"
import { CalldataDetails, ChunkedHex, CopyButton, LabeledChunks } from "./ui"
import { dismissPending, usePendingReceipt, usePendingViews, type PendingView } from "./usePendingReceipt"
import { TX_REVERTED_TEXT, unconfirmedNote } from "./walletCopy"

function notice(main: string): ErrorPresentation {
  return { main, detail: null }
}

function ActionTestnet({ title }: { title: string }) {
  return <h3>{title}</h3>
}

export function PendingStrip() {
  const client = usePublicClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const views = usePendingViews(client).filter(
    (view) => view.phase !== "confirmed" && (view.phase !== "idle" || view.banner),
  )
  if (views.length === 0) return null
  return (
    <section className="card pending-strip" data-testid="pending-transactions" aria-label="Pending transactions">
      <h2>Pending transactions</h2>
      {views.map((view) => (
        <PendingRow key={view.record.slot} view={view} />
      ))}
    </section>
  )
}

function PendingRow({ view }: { view: PendingView }) {
  const progress = actionProgress(view.record.action)
  const label = pendingSubjectLabel(view.record.action)
  const state: ActionButtonState =
    view.phase === "confirmed"
      ? {
          status: "confirmed",
          hash: view.record.hash,
          label: progress.done,
          resultId: view.record.subjectId ?? undefined,
          resultLabel: label ?? undefined,
          nextHref: progress.next?.href,
          nextLabel: progress.next?.label,
        }
        : view.phase === "unconfirmed"
          ? {
              status: "unconfirmed",
              hash: view.record.hash,
              message: unconfirmedNote(view.notice),
              unsaved: view.record.saved === false,
            }
        : view.phase === "pending"
          ? {
              status: "pending",
              hash: view.record.hash,
              label: progress.pending,
              startedAt: view.record.startedAt,
              unsaved: view.record.saved === false,
            }
          : { status: "idle", label: "" }
  return (
    <article data-testid="pending-row" data-id={view.record.subjectId ?? ""} data-hash={view.record.hash}>
      {view.record.subjectId && label ? (
        <div className="kv-row" data-testid="pending-subject" data-id={view.record.subjectId}>
          <div className="kv-label">{label}</div>
          <div className="kv-value">
            <ChunkedHex parts={chunkHex(view.record.subjectId)} />
            <CopyButton value={view.record.subjectId} />
          </div>
        </div>
      ) : null}
      {view.phase === "idle" ? null : (
        <ActionStatus
          state={state}
          onTryAgain={
            view.phase === "pending" || view.phase === "unconfirmed" ? () => dismissPending(view.record.slot) : undefined
          }
        />
      )}
      <PendingClearedNote
        banner={view.banner}
        onDismiss={view.banner?.kind === "clock" ? () => dismissPending(view.record.slot) : undefined}
      />
    </article>
  )
}

function SepoliaSubmit({
  preview,
  escrow,
  panel,
  onConfirmed,
  resultId,
  resultLabel,
  submitReason,
  prepareEpoch = 0,
  guided = false,
  statusRoot = null,
}: {
  preview: CallPreview
  escrow: Address
  panel: Address
  onConfirmed?: () => void
  resultId?: string
  resultLabel?: string
  submitReason?: string | null
  prepareEpoch?: number
  guided?: boolean
  statusRoot?: HTMLElement | null
}) {
  const progress = actionProgress(preview.functionName)
  const sent = subjectFromCalldata(preview.calldata)
  const slot = pendingSlot(sent?.action ?? preview.functionName, sent?.subjectId ?? null)
  const account = useAccount()
  const { switchChain } = useSwitchChain()
  const connectorChainId = useConnectorChainId(account.connector, account.isConnected)
  const walletChainId = account.isConnected ? resolveWalletChainId(account.chainId, connectorChainId) : null
  const decision = evaluateEscrowSubmit({ walletConnected: account.isConnected, walletChainId })
  const publicClient = usePublicClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const { data: walletClient } = useWalletClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const { sendTransactionAsync, isPending } = useSendTransaction()
  const [signing, setSigning] = useState(false)
  const [relayerStartedAt, setRelayerStartedAt] = useState<number | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const [submitError, setSubmitError] = useState<ErrorPresentation | null>(null)
  const [relayerPhase, setRelayerPhase] = useState<RelayerPhase>("idle")
  const [relayerHealth, setRelayerHealth] = useState<RelayerHealth>("unknown")
  const [healthReply, setHealthReply] = useState<string | null>(null)
  const [pendingHash, setPendingHash] = useState<Hex | null>(null)
  const [confirmedHash, setConfirmedHash] = useState<Hex | null>(null)
  const [relayerNotice, setRelayerNotice] = useState<string | null>(null)
  const relayerFlight = useRef(false)
  const healthGen = useRef(0)
  const healthAbort = useRef<AbortController | null>(null)
  const lockRef = useRef("")
  const receipt = usePendingReceipt(slot, publicClient, lockRef, () => onConfirmed?.())
  const waiting = signing || (isPending && !receipt.holdLock && receipt.phase !== "confirmed")
  const { id: submitSlot, blocked } = useSubmitBlocked(waiting || relayerPhase !== "idle")
  lockRef.current = submitSlot
  const walletHint = useWalletHint(waiting || relayerPhase === "submitting")
  const relayer = relayerConfigFromEnv({
    VITE_CLAIM_RELAYER_URL: import.meta.env.VITE_CLAIM_RELAYER_URL,
  })
  const relayerGate = relayerSubmitAllowed({ walletConnected: account.isConnected, walletChainId })
  const relayerBusy = relayerPhase !== "idle"
  const control = submitControl(decision, isPending || relayerBusy)
  const originAllowed = walletOriginAllowsRelayer(pageOrigin())
  const relayerModel = relayerButtonModel({
    url: relayer.url,
    health: relayerHealth,
    phase: relayerPhase,
    gate: relayerGate,
    action: preview.functionName,
  })
  const relayerButton = originAllowed || !relayerModel.visible
    ? relayerModel
    : { visible: true as const, disabled: true, label: "Submit refund request", note: null }

  const applyHealthUpdate = useCallback((gen: number, update: RelayerHealthUpdate) => {
    if (healthGen.current !== gen) return
    if (update.phase === "ok") {
      setRelayerHealth("ok")
      setRelayerNotice(null)
      setHealthReply(null)
      return
    }
    if (update.phase === "paused") {
      setRelayerHealth("paused")
      setHealthReply(null)
      return
    }
    if (update.phase === "waking") {
      setRelayerHealth("waking")
      setRelayerNotice(null)
      setHealthReply(null)
      return
    }
    if (update.phase === "gave_up") {
      setRelayerHealth("gave_up")
      setRelayerNotice(null)
      setHealthReply(null)
      return
    }
    if (update.phase === "unreachable") {
      setRelayerHealth("unreachable")
      setRelayerNotice(null)
      setHealthReply(null)
      return
    }
    if (update.phase === "down") {
      setRelayerHealth("down")
      setHealthReply(update.report ? formatHealthReply(update.report) : null)
      return
    }
    setRelayerHealth("unknown")
    setHealthReply(null)
  }, [])

  const stopHealthWatch = useCallback(() => {
    healthAbort.current?.abort()
    healthGen.current += 1
  }, [])

  const beginHealthWatch = useCallback(() => {
    healthAbort.current?.abort()
    const controller = new AbortController()
    healthAbort.current = controller
    const gen = ++healthGen.current
    setRelayerHealth("unknown")
    setRelayerNotice(null)
    setHealthReply(null)
    if (!walletOriginAllowsRelayer(pageOrigin())) return
    if (!relayer.url || !previewSupportsRelayer(preview.functionName)) return
    const url = relayer.url
    void watchRelayerHealth({
      url,
      signal: controller.signal,
      onUpdate: (update) => applyHealthUpdate(gen, update),
    })
  }, [applyHealthUpdate, preview.functionName, relayer.url])

  useEffect(() => {
    if (!account.isConnected || !walletOriginAllowsRelayer(pageOrigin())) {
      stopHealthWatch()
      return
    }
    beginHealthWatch()
    return () => {
      stopHealthWatch()
    }
  }, [account.isConnected, beginHealthWatch, prepareEpoch, escrow, stopHealthWatch])

  async function onClick() {
    if (receipt.phase === "pending" || receipt.phase === "unconfirmed") return
    setSubmitError(null)
    receipt.dismissBanner()
    setCancelled(false)
    setConfirmedHash(null)
    setPendingHash(null)
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
      assertSubmitTarget(preview.to, [escrow, panel])
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
      stopHealthWatch()
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

  async function onRelayer() {
    if (relayerFlight.current) return
    if (!walletOriginAllowsRelayer(pageOrigin())) return
    setSubmitError(null)
    setCancelled(false)
    setConfirmedHash(null)
    setPendingHash(null)
    const gate = relayerSubmitAllowed({
      walletConnected: account.isConnected,
      walletChainId: account.isConnected ? resolveWalletChainId(account.chainId, connectorChainId) : null,
    })
    if (!gate.ok) {
      setSubmitError(notice(gate.reason))
      return
    }
    if (!relayer.url || !previewSupportsRelayer(preview.functionName)) {
      setRelayerHealth("down")
      setRelayerNotice(RELAYER_SERVICE_DOWN_TEXT)
      return
    }
    if (!publicClient) {
      setSubmitError(notice("The network client isn't ready, so nothing was sent."))
      return
    }
    if (!account.address || !walletClient) {
      setSubmitError(notice(RELAYER_CONNECT_NOTE))
      return
    }
    const signer = walletClient
    const sender = account.address
    const url = relayer.url
    if (relayerHealth !== "ok") {
      // Health only. After the two-minute cap, this click starts a fresh one.
      // A click while the check is already running does not restart it or send anything.
      if (relayerHealth === "gave_up") beginHealthWatch()
      return
    }
    relayerFlight.current = true
    const gen = healthGen.current
    const signal = healthAbort.current?.signal
    let held = false
    try {
      const report = await readRelayerHealth({ url, signal })
      if (healthGen.current !== gen || signal?.aborted) return
      if (report.state !== "ok") {
        if (report.cause === "network_or_cors" || relayerHealthWakes(report)) {
          void watchRelayerHealth({
            url,
            signal,
            initial: { report, loopStart: Date.now() - report.elapsedMs },
            onUpdate: (update) => applyHealthUpdate(gen, update),
          })
        } else {
          const paused = report.state === "paused"
          if (paused) setHealthReply(null)
          else {
            warnTerminalHealth(report)
            setHealthReply(formatHealthReply(report))
          }
          setRelayerHealth(paused ? "paused" : "down")
          setRelayerNotice(RELAYER_SERVICE_DOWN_TEXT)
        }
        return
      }
      setRelayerHealth("ok")
      setRelayerNotice(null)
      if (healthGen.current !== gen || signal?.aborted) return
      if (!tryHoldSubmit(submitSlot)) return
      held = true
      setRelayerPhase("submitting")
      assertSubmitTarget(preview.to, [escrow, panel])
      const outcome = await runRelayerSubmission({
        url,
        preview,
        sender,
        verifyingContract: escrow,
        signTypedData: (args) => signer.signTypedData(args),
        client: publicClient,
        onPhase: (phase, hash) => {
          setRelayerPhase(phase)
          if (hash) {
            const stored = writeRelayerPending(`${preview.functionName}:relayer`, hash)
            setRelayerStartedAt(stored.startedAt)
            setPendingHash(hash)
          }
        },
      })
      clearPending(`${preview.functionName}:relayer`)
      if (outcome.ok) {
        setPendingHash(null)
        setConfirmedHash(outcome.txHash)
        return
      }
      setPendingHash(null)
      setSubmitError(outcome.presentation)
      if (outcome.code === "kill_switch") setRelayerHealth("paused")
    } catch (cause) {
      setPendingHash(null)
      clearPending(`${preview.functionName}:relayer`)
      if (isHealthCancelled(cause) || signal?.aborted) return
      if (isWalletCancel(cause)) {
        setCancelled(true)
        return
      }
      setSubmitError(presentError(cause))
    } finally {
      relayerFlight.current = false
      setRelayerPhase("idle")
      if (held) releaseSubmit(submitSlot)
    }
  }

  const walletState: ActionButtonState = !decision.ok
    ? decision.code === "disconnected"
      ? { status: "needs-wallet" }
      : { status: "wrong-network" }
    : receipt.phase === "confirmed" && receipt.txHash
      ? {
          status: "confirmed",
          hash: receipt.txHash,
          label: progress.done,
          resultId: receipt.subjectId ?? resultId,
          resultLabel: receipt.subjectId ? pendingSubjectLabel(preview.functionName) ?? resultLabel : resultLabel,
          nextHref: guided ? confirmedNext(preview.functionName, receipt.subjectId ?? resultId ?? null)?.href : progress.next?.href,
          nextLabel: guided
            ? confirmedNext(preview.functionName, receipt.subjectId ?? resultId ?? null)?.label
            : progress.next?.label,
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

  const relayerState: ActionButtonState = !account.isConnected
    ? { status: "needs-wallet" }
    : !relayerGate.ok
      ? { status: "wrong-network" }
      : relayerPhase === "submitting"
        ? { status: "waiting-wallet" }
        : relayerPhase === "confirming" && pendingHash
          ? { status: "pending", hash: pendingHash, label: progress.pending, startedAt: relayerStartedAt ?? undefined }
          : confirmedHash
            ? {
                status: "confirmed",
                hash: confirmedHash,
                label: progress.done,
                resultId,
                resultLabel,
                nextHref: guided ? confirmedNext(preview.functionName, resultId ?? null)?.href : progress.next?.href,
                nextLabel: guided ? confirmedNext(preview.functionName, resultId ?? null)?.label : progress.next?.label,
              }
            : !originAllowed
              ? { status: "idle", label: "Submit refund request" }
              : relayerHealth === "unknown"
                ? { status: "busy", label: CHECKING_LABEL }
                : { status: "idle", label: relayerButton.visible ? relayerButton.label : "Submit refund request" }

  const status = (
    <>
      {guided ? <p>{submitSenderNote(preview.functionName)}</p> : null}
      <ActionStatus
        state={walletState}
        walletHint={walletHint}
        cancelled={cancelled && relayerPhase === "idle" && !pendingHash}
        onTryAgain={
          walletState.status === "pending" || walletState.status === "unconfirmed" ? () => receipt.tryAgain() : undefined
        }
      />
      {receipt.banner?.kind === "reverted" ? <ActionStatus state={{ status: "error", message: TX_REVERTED_TEXT }} /> : null}
      <PendingClearedNote banner={receipt.banner} />
      {relayerButton.visible ? (
        <div data-testid="relayer-panel">
          <p>{RELAYER_PANEL_TEXT}</p>
          {relayerButton.note ? (
            <p className="relayer-pending" role="status" data-testid="relayer-note">
              {relayerButton.note}
            </p>
          ) : null}
          {pageOrigin() !== CANONICAL_WALLET_ORIGIN && relayerHealth === "unreachable" ? (
            <p className="hint" role="status" data-testid="relayer-unreachable-link">
              <a href={CANONICAL_WALLET_HREF} data-testid="relayer-canonical-link">
                {RELAYER_OPEN_CANONICAL_LABEL}
              </a>
            </p>
          ) : null}
          {relayerPhase === "submitting" ? (
            <p className="relayer-pending" role="status" data-testid="relayer-status">
              {RELAYER_SUBMITTING_TEXT}
            </p>
          ) : null}
          {relayerPhase === "confirming" && pendingHash ? (
            <div className="relayer-pending" role="status" data-testid="relayer-status">
              <p>{RELAYER_WAITING_TEXT}</p>
              <p>{RELAYER_SUBMITTED_TEXT}</p>
              <p>
                <a href={relayerTxUrl(pendingHash)} data-testid="relayer-tx-link">
                  {RELAYER_TX_LINK_LABEL}
                </a>
              </p>
            </div>
          ) : null}
          <ActionButton
            data-testid="relayer-submit"
            state={relayerState}
            reason={
              preview.functionName === "refund" && (receipt.phase === "pending" || receipt.phase === "unconfirmed")
                ? REFUND_ALREADY_PENDING_REASON
                : blocked && relayerState.status === "idle"
                  ? ANOTHER_PENDING_REASON
                  : relayerButton.disabled && relayerState.status === "idle"
                    ? relayerButton.note
                    : relayerState.status === "needs-wallet"
                      ? NO_WALLET_REASON
                      : null
            }
            disabled={blocked || isPending || (relayerButton.disabled && relayerState.status === "idle")}
            onClick={() => {
              if (relayerState.status === "wrong-network") {
                switchChain({ chainId: BASE_SEPOLIA_CHAIN_ID })
                return
              }
              void onRelayer()
            }}
          />
          {relayerNotice || relayerHealth === "down" || relayerHealth === "paused" ? (
            <p className="hint" role="status" data-testid="relayer-unavailable">
              {relayerNotice ?? RELAYER_SERVICE_DOWN_TEXT}
            </p>
          ) : null}
          {healthReply && relayerHealth === "down" ? (
            <p className="hint" role="status" data-testid="relayer-health-reply">
              {healthReply}
            </p>
          ) : null}
          {originAllowed && (relayerHealth === "gave_up" || relayerHealth === "down" || relayerHealth === "unreachable") ? (
            <button type="button" className="link-button" data-testid="relayer-health-retry" onClick={() => beginHealthWatch()}>
              {RELAYER_HEALTH_RETRY_LABEL}
            </button>
          ) : null}
          <ActionStatus state={relayerState} walletHint={walletHint && relayerPhase === "submitting"} pendingTestId="relayer-pending-label" confirmedTestId="relayer-confirmed-label" />
        </div>
      ) : null}
      {confirmedHash ? (
        <div className="relayer-ok" role="status" data-testid="relayer-result">
          <p>{RELAYER_SUBMITTED_TEXT}</p>
          <p>{RELAYER_CONFIRMED_TEXT}</p>
          <p>
            <a href={relayerTxUrl(confirmedHash)} data-testid="relayer-tx-link">
              {RELAYER_TX_LINK_LABEL}
            </a>
          </p>
        </div>
      ) : null}
      {submitError ? (
        <ErrorNotice main={submitError.main} detail={submitError.detail} link={submitError.link} />
      ) : null}
    </>
  )

  return (
    <>
      {guided ? null : <p>{submitSenderNote(preview.functionName)}</p>}
      <ActionButton
        testId={control.testId}
        state={walletState}
        reason={
          submitReason && walletState.status === "idle"
            ? submitReason
            : blocked && walletState.status === "idle"
              ? ANOTHER_PENDING_REASON
              : walletState.status === "needs-wallet"
                ? NO_WALLET_REASON
                : null
        }
        disabled={
          Boolean(submitReason) ||
          blocked ||
          walletState.status === "unconfirmed" ||
          (decision.ok && control.disabled && walletState.status === "idle")
        }
        onClick={() => {
          if (walletState.status === "wrong-network") {
            switchChain({ chainId: BASE_SEPOLIA_CHAIN_ID })
            return
          }
          void onClick()
        }}
      />
      {statusRoot ? createPortal(status, statusRoot) : status}
    </>
  )
}

function durationPhrase(seconds: number): string {
  const preset = DURATION_PRESETS.find((item) => item.seconds === seconds)
  return preset ? `${preset.label}, ${seconds} seconds` : `${seconds} seconds`
}

function PreviewBlock({
  preview,
  escrow,
  panel,
  relayerConfigured,
  label,
  nodeRef,
  onConfirmed,
  payee,
  durationSeconds,
  resultId,
  resultLabel,
  submitReason,
  prepareEpoch = 0,
  guided = false,
  lead,
  omitSubmit = false,
}: {
  preview: CallPreview | null
  escrow: Address
  panel: Address
  relayerConfigured: boolean
  label: string
  nodeRef: (node: HTMLElement | null) => void
  onConfirmed?: () => void
  payee?: Address | null
  durationSeconds?: number | null
  resultId?: string
  resultLabel?: string
  submitReason?: string | null
  prepareEpoch?: number
  guided?: boolean
  lead?: string
  omitSubmit?: boolean
}) {
  if (!preview) return null
  const contractName = preview.to.toLowerCase() === panel.toLowerCase() ? CONTRACT_LABELS.panel : CONTRACT_LABELS.escrow
  const expiry =
    durationSeconds != null ? formatLocalTimestamp(currentNowSeconds() + BigInt(durationSeconds)) : null
  const amountUnit = "test ETH"
  const fundLeadOnly = Boolean(lead) && preview.functionName === "createEscrow"
  return (
    <div className="preview" data-testid="calldata-preview" tabIndex={-1} aria-label={label} ref={nodeRef}>
      {lead ? <p data-testid="review-plain">{lead}</p> : null}
      {fundLeadOnly ? null : <p>{previewCardCopy(preview.functionName, relayerConfigured)}</p>}
      {resultId ? <IdRow label={resultLabel ?? "Escrow ID"} value={resultId} testId="review-id" /> : null}
      <p data-testid="review-contract">{contractName}</p>
      <LabeledChunks label="Contract" address={preview.to} testId="review-contract-address" />
      {payee ? <LabeledChunks label="Payee" address={payee} testId="review-payee" /> : null}
      {durationSeconds != null && expiry ? (
        <p data-testid="review-duration">
          Time window: {durationPhrase(durationSeconds)}. Ends {expiry}.
        </p>
      ) : null}
      <p data-testid="review-amount">
        Amount {formatEther(preview.valueWei)} {amountUnit}
      </p>
      <p data-testid="review-gas">{GAS_FEE_TEXT}</p>
      <CalldataDetails calldata={preview.calldata} />
      {omitSubmit ? null : (
        <SepoliaSubmit
          key={preview.calldata}
          preview={preview}
          escrow={escrow}
          panel={panel}
          onConfirmed={onConfirmed}
          resultId={resultId}
          resultLabel={resultLabel}
          submitReason={submitReason}
          prepareEpoch={prepareEpoch}
          guided={guided}
        />
      )}
    </div>
  )
}

function Field({
  id,
  label,
  value,
  onChange,
  hint,
  readOnly = false,
  placeholder,
  aside,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  readOnly?: boolean
  placeholder?: string
  aside?: ReactNode
}) {
  return (
    <div className="field">
      <div className="label-line">
        <label htmlFor={id}>{label}</label>
        {aside}
      </div>
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        readOnly={readOnly}
        className={readOnly ? "readonly" : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  )
}

function IdField({
  id,
  label,
  hint,
  value,
  onChange,
  generated = false,
}: {
  id: string
  label: string
  hint: string
  value: string
  onChange: (value: string) => void
  generated?: boolean
}) {
  const [own, setOwn] = useState(!generated)
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        spellCheck={false}
        autoComplete="off"
        readOnly={generated && !own}
        className={generated && !own ? "readonly" : undefined}
        onChange={(event) => {
          if (generated && !own) return
          onChange(event.target.value)
        }}
      />
      <p className="hint">{hint}</p>
      {generated ? (
        <>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setOwn(false)
              onChange(randomBytes32())
            }}
          >
            {GENERATE_LABEL}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setOwn(true)
              onChange("")
            }}
          >
            {USE_OWN_LABEL}
          </button>
        </>
      ) : null}
    </div>
  )
}

type PrepareSlot = "create" | "release" | "refund" | "dispute"

type GuidedStep = {
  step: number
  notice: string | null
  linkEscrow: `0x${string}` | null
  go: (step: number, allowStep?: boolean) => void
  back: () => void
}

function guidedFor(flow: "fund" | "release" | "refund" | "dispute", route: WalletRoute | null): GuidedStep | null {
  if (!route || route.flow !== flow) return null
  const query = { escrow: route.escrow.value, dispute: route.dispute.value }
  return {
    step: route.step,
    notice: route.stepNotice,
    linkEscrow: route.escrow.value,
    go(step: number, allowStep = false) {
      navigate(flowHref(flow, step, query), { allowStep })
    },
    back() {
      if (route.step > 1) navigate(flowHref(flow, route.step - 1, query), { allowStep: true })
      else navigate("/")
    },
  }
}

function useFlowStep(
  clear: () => void,
  flow: string,
  routeStep: number,
  reviewStep: number,
  idPart: string,
  reviewReady: boolean,
  step1Href: string | null,
) {
  const identity = `${flow}|${idPart}|${routeStep}`
  const guard = usePreparedRouteGuard(clear, identity)
  const display = shownStep(routeStep, reviewStep, guard.allowed || historyAllowsStep(), reviewReady)
  useEffect(() => {
    if (!step1Href || routeStep <= 1 || display !== 1) return
    replaceRoute(step1Href)
  }, [step1Href, routeStep, display])
  return { arm: guard.arm, display, identity }
}

export function FlowPreview({
  escrow,
  panel,
  route = null,
  showStrip = true,
}: {
  escrow: Address
  panel: Address
  route?: WalletRoute | null
  showStrip?: boolean
}) {
  const [active, setActive] = useState<PrepareSlot | null>(null)
  const [escrowUrl] = useState(() => readUrlBytes32("escrow"))
  const relayerConfigured = relayerConfigFromEnv({
    VITE_CLAIM_RELAYER_URL: import.meta.env.VITE_CLAIM_RELAYER_URL,
  }).url != null
  const guided = route != null
  const show = (flow: "fund" | "release" | "refund" | "dispute") => !guided || route.flow === flow

  const originAllowed = walletOriginAllowsRelayer(pageOrigin())

  return (
    <div>
      {originAllowed ? null : (
        <p className="banner" role="status" data-testid="relayer-origin-notice">
          {RELAYER_WRONG_ORIGIN_TEXT}{" "}
          <a href={CANONICAL_WALLET_HREF} data-testid="relayer-canonical-link">
            {RELAYER_OPEN_CANONICAL_LABEL}
          </a>
        </p>
      )}
      {!guided && escrowUrl.notice ? (
        <p className="banner" role="status" data-testid="url-escrow-notice">
          {escrowUrl.notice}
        </p>
      ) : null}
      {route?.escrow.notice ? (
        <p className="banner" role="status" data-testid="url-escrow-notice">
          {route.escrow.notice}
        </p>
      ) : null}
      {route?.stepNotice ? (
        <p className="banner" role="status" data-testid="url-step-notice">
          {route.stepNotice}
        </p>
      ) : null}
      {guided ? null : (
        <p className="muted">
          These forms prepare a transaction, then the connected wallet can submit it on Base Sepolia, chain{" "}
          {BASE_SEPOLIA_CHAIN_ID}. Ethereum mainnet and Base mainnet are refused.
        </p>
      )}
      {showStrip ? <PendingStrip /> : null}
      {show("fund") ? (
      <CreateForm
        escrow={escrow}
        panel={panel}
        relayerConfigured={relayerConfigured}
        active={active}
        onActivate={setActive}
        guided={guidedFor("fund", route)}
      />
      ) : null}
      {show("release") ? (
      <IdForm
        slot="release"
        idPrefix="release"
        title="Release a payment"
        buttonLabel="Prepare this payout"
        missingId={FORM_ERRORS.releaseId}
        action="payout"
        resultLabel="Prepared payout"
        escrow={escrow}
        panel={panel}
        relayerConfigured={relayerConfigured}
        active={active}
        onActivate={setActive}
        guided={guidedFor("release", route)}
        otherFlow="refund"
        build={(escrowId) => previewRelease(escrow, escrowId)}
      />
      ) : null}
      {show("refund") ? (
      <IdForm
        slot="refund"
        idPrefix="refund"
        title="Refund a payment"
        buttonLabel="Prepare this refund"
        missingId={FORM_ERRORS.refundId}
        action="refund"
        resultLabel="Prepared refund"
        intro={<PostExpiryRefundOrder />}
        escrow={escrow}
        panel={panel}
        relayerConfigured={relayerConfigured}
        active={active}
        onActivate={setActive}
        guided={guidedFor("refund", route)}
        otherFlow="release"
        build={(escrowId) => previewRefund(escrow, escrowId)}
      />
      ) : null}
      {show("dispute") ? (
      <OpenDisputeForm
        escrow={escrow}
        panel={panel}
        relayerConfigured={relayerConfigured}
        active={active}
        onActivate={setActive}
        guided={guidedFor("dispute", route)}
      />
      ) : null}
      {guided ? null : (
        <>
          <h3>Revert glossary</h3>
          <dl className="glossary">
            {ERROR_GLOSSARY.map((entry) => (
              <div key={entry.name}>
                <dt>{entry.name}</dt>
                <dd>{entry.meaning}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </div>
  )
}

function CreateForm({
  escrow,
  panel,
  relayerConfigured,
  active,
  onActivate,
  guided = null,
}: {
  escrow: Address
  panel: Address
  relayerConfigured: boolean
  active: PrepareSlot | null
  onActivate: (slot: PrepareSlot) => void
  guided?: GuidedStep | null
}) {
  const account = useAccount()
  const balance = useBalance({
    address: account.address,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    query: { enabled: Boolean(account.address) },
  })
  const [escrowId, setEscrowId] = useState<string>(() => randomBytes32())
  const [payee, setPayee] = useState("")
  const [payerBotId, setPayerBotId] = useState("")
  const [payeeBotId, setPayeeBotId] = useState("")
  const [preset, setPreset] = useState<number | "custom">(DEFAULT_DURATION_SECONDS)
  const [customDuration, setCustomDuration] = useState("")
  const [value, setValue] = useState("")
  const session = usePrepareSession<CallPreview>("create", active)
  const [fundStatus, setFundStatus] = useState<HTMLElement | null>(null)
  const escrowHex = parseBytes32(escrowId)
  const fundReady =
    session.preview != null && preparedMatches(session.preview.calldata, { action: "createEscrow", escrowId: escrowHex })
  const flowStep = useFlowStep(
    session.clear,
    "fund",
    guided?.step ?? 1,
    4,
    escrowHex ?? "",
    fundReady,
    guided ? flowHref("fund", 1) : null,
  )
  const payeeAddress = parsePayeeAddress(payee)
  const payeeIsSelf =
    payeeAddress != null && account.address != null && sameAddress(payeeAddress, account.address)
  const shownDuration = preset === "custom" ? parseWholeSeconds(customDuration, MAX_DURATION_SECONDS) : preset
  let overBalance = false
  if (balance.data?.value != null && value.trim() !== "") {
    try {
      overBalance = parseEther(value.trim()) > balance.data.value
    } catch {
      overBalance = false
    }
  }

  function edit(apply: () => void) {
    apply()
    session.clear()
  }

  async function onSubmit(event?: FormEvent): Promise<boolean> {
    event?.preventDefault()
    if (!session.begin()) return false
    try {
      await yieldPrepareTick()
      const id = parseBytes32(escrowId)
      const payerBot = parseBytes32(payerBotId)
      const payeeBot = parseBytes32(payeeBotId)
      if (!id || !payerBot || !payeeBot) {
        session.publish(FORM_ERRORS.createIds, null)
        onActivate("create")
        return false
      }
      if (payerBot.toLowerCase() === payeeBot.toLowerCase()) {
        session.publish(FORM_ERRORS.sameBots, null)
        onActivate("create")
        return false
      }
      if (payeeHasChecksumError(payee)) {
        session.publish(FORM_ERRORS.payeeChecksum, null)
        onActivate("create")
        return false
      }
      const payeeParsed = parsePayeeAddress(payee)
      if (!payeeParsed) {
        session.publish(FORM_ERRORS.payee, null)
        onActivate("create")
        return false
      }
      if (isZeroAddress(payeeParsed)) {
        session.publish(FORM_ERRORS.payeeZero, null)
        onActivate("create")
        return false
      }
      const durationSeconds =
        preset === "custom" ? parseWholeSeconds(customDuration, MAX_DURATION_SECONDS) : preset
      if (durationSeconds == null || durationSeconds <= 0 || durationSeconds > MAX_DURATION_SECONDS) {
        session.publish(durationValidationMessage(MAX_DURATION_SECONDS), null)
        onActivate("create")
        return false
      }
      if (value.trim() === "") {
        session.publish(FORM_ERRORS.valueEmpty, null)
        onActivate("create")
        return false
      }
      let valueWei: bigint
      try {
        valueWei = parseEther(value.trim())
      } catch {
        session.publish(FORM_ERRORS.valueFormat, null)
        onActivate("create")
        return false
      }
      if (valueWei <= 0n) {
        session.publish(FORM_ERRORS.valueZero, null)
        onActivate("create")
        return false
      }
      const next = previewCreateEscrow({
        escrow,
        escrowId: id,
        payee: payeeParsed,
        payerBotId: payerBot,
        payeeBotId: payeeBot,
        durationSeconds: BigInt(durationSeconds),
        valueWei,
      })
      session.publish(null, next)
      onActivate("create")
      return true
    } catch (cause) {
      session.publish(prepareFailure("escrow", cause), null)
      onActivate("create")
      return false
    } finally {
      session.finish()
    }
  }

  async function onNext() {
    if (!guided) return
    if (guided.step === 1) {
      if (!parseBytes32(escrowId)) {
        session.publish(FORM_ERRORS.createIds, null)
        return
      }
      if (payeeHasChecksumError(payee)) {
        session.publish(FORM_ERRORS.payeeChecksum, null)
        return
      }
      const parsed = parsePayeeAddress(payee)
      if (!parsed) {
        session.publish(FORM_ERRORS.payee, null)
        return
      }
      if (isZeroAddress(parsed)) {
        session.publish(FORM_ERRORS.payeeZero, null)
        return
      }
      session.clear()
      flowStep.arm(`fund|${parseBytes32(escrowId) ?? ""}|2`)
      guided.go(2, true)
      return
    }
    if (guided.step === 2) {
      const payerBot = parseBytes32(payerBotId)
      const payeeBot = parseBytes32(payeeBotId)
      if (!payerBot || !payeeBot) {
        session.publish(FORM_ERRORS.createIds, null)
        return
      }
      if (payerBot.toLowerCase() === payeeBot.toLowerCase()) {
        session.publish(FORM_ERRORS.sameBots, null)
        return
      }
      session.clear()
      flowStep.arm(`fund|${parseBytes32(escrowId) ?? ""}|3`)
      guided.go(3, true)
      return
    }
    if (guided.step === 3) {
      const ok = await onSubmit()
      if (ok) {
        flowStep.arm(`fund|${parseBytes32(escrowId) ?? ""}|4`)
        guided.go(4, true)
      }
    }
  }

  const step = guided ? flowStep.display : 1
  const show = (n: number) => guided == null || step === n
  const plainLead = `You are sending ${value.trim() === "" ? "test ETH" : `${value.trim()} test ETH`} into escrow for the payee below.`

  return (
    <section id="fund-form" className={guided ? "guided-flow" : undefined} aria-label="Fund an escrow">
      <form
        id="create-claim"
        onSubmit={(event) => {
          if (!guided) {
            void onSubmit(event)
            return
          }
          event.preventDefault()
          if (step < 4) void onNext()
        }}
      >
        {guided ? <Stepper step={step} total={4} /> : null}
        <ActionTestnet title="Fund an escrow" />
        {show(1) ? (
          <>
        <IdField
          id="create-id"
          label={ESCROW_ID_LABEL}
          hint={ESCROW_ID_HINT}
          value={escrowId}
          generated
          onChange={(next) => edit(() => setEscrowId(next))}
        />
        <Field id="create-payee" label="Payee wallet" value={payee} onChange={(next) => edit(() => setPayee(next))} />
        {payeeIsSelf ? (
          <p className="warn-note" role="status" data-testid="payee-self-warning">
            {PAYEE_SELF_WARNING}
          </p>
        ) : null}
          </>
        ) : null}
        {show(2) ? (
          <>
        <Field
          id="create-payer-bot"
          label="Payer bot identifier"
          value={payerBotId}
          onChange={(next) => edit(() => setPayerBotId(next))}
        />
        <Field
          id="create-payee-bot"
          label="Payee bot identifier"
          value={payeeBotId}
          onChange={(next) => edit(() => setPayeeBotId(next))}
        />
          </>
        ) : null}
        {show(3) ? (
          <>
        <fieldset className="choice">
          <legend>Time window</legend>
          {DURATION_PRESETS.map((option) => (
            <label key={option.id}>
              <input
                type="radio"
                name="create-duration-preset"
                value={String(option.seconds)}
                checked={preset === option.seconds}
                onChange={() => edit(() => setPreset(option.seconds))}
              />
              {option.label}
            </label>
          ))}
          <label>
            <input
              type="radio"
              name="create-duration-preset"
              value="custom"
              checked={preset === "custom"}
              onChange={() => edit(() => setPreset("custom"))}
            />
            Custom
          </label>
        </fieldset>
        {preset === "custom" ? (
          <Field
            id="create-duration"
            label="Time window in seconds"
            value={customDuration}
            onChange={(next) => edit(() => setCustomDuration(next))}
            hint={`Whole seconds only, from 1 through ${MAX_DURATION_SECONDS}, which is 30 days.`}
          />
        ) : (
          <p className="hint">Whole seconds only. The contract allows at most 30 days.</p>
        )}
        <Field
          id="create-value"
          label="Amount in ETH"
          value={value}
          placeholder={AMOUNT_PLACEHOLDER}
          onChange={(next) => edit(() => setValue(next))}
          hint={AMOUNT_HINT}
          aside={
            account.address && balance.data?.value != null ? (
              <span className="hint" data-testid="wallet-balance">
                Balance: {formatEther(balance.data.value)} test ETH
              </span>
            ) : null
          }
        />
        {overBalance ? (
          <p className="warn-note" role="status" data-testid="balance-warning">
            {BALANCE_WARN_TEXT}
          </p>
        ) : null}
          </>
        ) : null}
        {guided && step < 4 ? (
          <StepFooter onBack={() => guided.back()}>
            <ActionButton
              type="button"
              onClick={() => void onNext()}
              state={session.preparing ? { status: "busy", label: "Preparing…" } : { status: "idle", label: "Next" }}
            />
          </StepFooter>
        ) : null}
        {guided && session.error && step < 4 ? (
          <ActionStatus state={{ status: "error", message: session.error }} nodeRef={session.setNode} />
        ) : null}
        {!guided ? (
          <>
        <ActionButton
          type="submit"
          state={session.preparing ? { status: "busy", label: "Preparing…" } : { status: "idle", label: "Prepare this escrow" }}
        />
        {session.error ? (
          <ActionStatus state={{ status: "error", message: session.error }} nodeRef={session.setNode} />
        ) : (
          <PreviewBlock
            preview={session.preview}
            escrow={escrow}
            panel={panel}
            relayerConfigured={relayerConfigured}
            label="Prepared escrow"
            nodeRef={session.setNode}
            payee={payeeAddress}
            durationSeconds={shownDuration}
            resultId={parseBytes32(escrowId) ?? undefined}
            resultLabel={ESCROW_ID_LABEL}
          />
        )}
          </>
        ) : null}
        {guided && step === 4 && fundReady && session.preview ? (
          <div data-testid="review-step">
            <PreviewBlock
              preview={session.preview}
              escrow={escrow}
              panel={panel}
              relayerConfigured={relayerConfigured}
              label="Prepared escrow"
              nodeRef={session.setNode}
              payee={payeeAddress}
              durationSeconds={shownDuration}
              resultId={escrowHex ?? undefined}
              resultLabel={ESCROW_ID_LABEL}
              guided
              lead={plainLead}
              omitSubmit
            />
            <div ref={setFundStatus} />
            <StepFooter onBack={() => guided.back()}>
              <SepoliaSubmit
                preview={session.preview}
                escrow={escrow}
                panel={panel}
                resultId={escrowHex ?? undefined}
                resultLabel={ESCROW_ID_LABEL}
                guided
                statusRoot={fundStatus}
              />
            </StepFooter>
          </div>
        ) : null}
      </form>
    </section>
  )
}

function PostExpiryRefundOrder() {
  return (
    <div data-testid="post-expiry-refund-order">
      <p className="muted">{POST_EXPIRY_REFUND_INTRO}</p>
      <ol className="plain">
        {POST_EXPIRY_REFUND_ORDER.map((step) => (
          <li key={step.state}>
            <strong>{step.state}.</strong> {step.error ? <span className="mono">{step.error}. </span> : null}
            {step.outcome}
          </li>
        ))}
      </ol>
    </div>
  )
}

function IdForm({
  slot,
  idPrefix,
  title,
  buttonLabel,
  missingId,
  action,
  resultLabel,
  intro,
  escrow,
  panel,
  relayerConfigured,
  active,
  onActivate,
  guided = null,
  otherFlow,
  build,
}: {
  slot: PrepareSlot
  idPrefix: string
  title: string
  buttonLabel: string
  missingId: string
  action: string
  resultLabel: string
  intro?: ReactNode
  escrow: Address
  panel: Address
  relayerConfigured: boolean
  active: PrepareSlot | null
  onActivate: (slot: PrepareSlot) => void
  guided?: GuidedStep | null
  otherFlow?: "release" | "refund"
  build: (escrowId: Hex) => CallPreview
}) {
  const carried = useCarriedIds()
  const client = usePublicClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const [urlEscrow] = useState(() => readUrlBytes32("escrow"))
  const prefill = useSyncedPrefill(guided?.linkEscrow, urlEscrow.value ?? "")
  const setEscrowId = prefill.setValue
  const touched = prefill.touched
  const setTouched = prefill.setTouched
  const linkId = guided?.linkEscrow ?? null
  const linked = linkId != null && !touched
  const escrowId = linked ? linkId : prefill.value
  const session = usePrepareSession<CallPreview>(slot, active)
  const [prepareEpoch, setPrepareEpoch] = useState(0)
  const [idStatus, setIdStatus] = useState<HTMLElement | null>(null)
  const idHex = parseBytes32(escrowId)
  const actionReady =
    session.preview != null && preparedMatches(session.preview.calldata, { action: slot, escrowId: idHex })
  const flowStep = useFlowStep(
    session.clear,
    slot,
    guided?.step ?? 1,
    2,
    idHex ?? "",
    actionReady,
    guided && (slot === "release" || slot === "refund") ? flowHref(slot, 1, { escrow: idHex }) : null,
  )
  const gate = useEscrowActionGate(client, escrow, panel, escrowId)
  const decision = slot === "release" ? gate.release : gate.refund
  const gated = gate.status === "ready" && !decision.allowed

  useEffect(() => {
    if (touched || guided?.linkEscrow || !carried.escrowId) return
    setEscrowId(carried.escrowId)
  }, [carried.escrowId, guided?.linkEscrow, setEscrowId, touched])

  const step = guided ? flowStep.display : 1
  const other = otherFlow ? (otherFlow === "release" ? gate.release : gate.refund) : null
  const plainLead =
    slot === "release"
      ? "You are releasing this payment. The payee is credited and can then withdraw the test ETH."
      : "You are refunding this payment. The payer is credited and can then withdraw the test ETH."

  async function onSubmit(event?: FormEvent): Promise<boolean> {
    event?.preventDefault()
    if (gated) return false
    if (!session.begin()) return false
    if (slot === "refund") setPrepareEpoch((value) => value + 1)
    try {
      await yieldPrepareTick()
      const id = parseBytes32(escrowId)
      if (!id) {
        session.publish(missingId, null)
        onActivate(slot)
        return false
      }
      session.publish(null, build(id))
      onActivate(slot)
      return true
    } catch (cause) {
      session.publish(prepareFailure(action, cause), null)
      onActivate(slot)
      return false
    } finally {
      session.finish()
    }
  }

  async function onNext() {
    if (!guided || gated) return
    const ok = await onSubmit()
    if (ok) {
      flowStep.arm(`${slot}|${parseBytes32(escrowId) ?? ""}|2`)
      guided.go(2, true)
    }
  }

  return (
    <section id={`${slot}-form`} className={guided ? "guided-flow" : undefined} aria-label={title}>
      <form
        onSubmit={(event) => {
          if (!guided) {
            void onSubmit(event)
            return
          }
          event.preventDefault()
          if (step === 1) void onNext()
        }}
      >
        {guided ? <Stepper step={step} total={2} /> : null}
        <ActionTestnet title={title} />
        {(!guided || step === 1) && intro}
        {!guided || step === 1 ? (
          <>
            {linked && guided?.linkEscrow ? (
              <>
                <FilledFromLink label={ESCROW_ID_LABEL} value={guided.linkEscrow} />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setTouched(true)
                    setEscrowId("")
                    session.clear()
                  }}
                >
                  Use a different id
                </button>
              </>
            ) : (
              <IdField
                id={`${idPrefix}-id`}
                label={ESCROW_ID_LABEL}
                hint={ESCROW_ID_HINT}
                value={escrowId}
                onChange={(next) => {
                  setTouched(true)
                  setEscrowId(next)
                  session.clear()
                }}
              />
            )}
            {gate.status === "reading" && parseBytes32(escrowId) ? <p className="hint">{READING_ESCROW_TEXT}</p> : null}
            {gate.status === "unread" ? (
              <p className="warn-note" role="status">
                {ESCROW_UNREAD_TEXT}
              </p>
            ) : null}
            {guided && gate.face ? (
              <div className="readonly-card" data-testid="escrow-face">
                <LabeledChunks label="Payee" address={gate.face.payee} testId="face-payee" />
                <ReadonlyValue
                  label="Amount"
                  value={`${formatEther(gate.face.amountWei)} test ETH`}
                  testId="face-amount"
                />
                <p className="hint">Read from the escrow.</p>
              </div>
            ) : null}
            {guided && other && gate.status === "ready" ? (
              other.allowed ? (
                <p>
                  <a
                    href={flowHref(otherFlow!, 1, { escrow: parseBytes32(escrowId) })}
                    data-testid="other-action"
                    onClick={(event) => {
                      event.preventDefault()
                      navigate(flowHref(otherFlow!, 1, { escrow: parseBytes32(escrowId) }))
                    }}
                  >
                    {otherFlow === "release" ? "Release a payment" : "Refund a payment"}
                  </a>
                </p>
              ) : (
                <p className="action-reason" data-testid="other-action">
                  {otherFlow === "release" ? "Release a payment" : "Refund a payment"} is unavailable. {other.reason}
                </p>
              )
            ) : null}
          </>
        ) : null}
        {!guided ? (
          <>
            <ActionButton
              type="submit"
              disabled={gated}
              reason={gated ? decision.reason : null}
              state={session.preparing ? { status: "busy", label: "Preparing…" } : { status: "idle", label: buttonLabel }}
            />
            {session.error ? (
              <ActionStatus state={{ status: "error", message: session.error }} nodeRef={session.setNode} />
            ) : (
              <PreviewBlock
                preview={session.preview}
                escrow={escrow}
                panel={panel}
                relayerConfigured={relayerConfigured}
                label={resultLabel}
                nodeRef={session.setNode}
                submitReason={gated ? decision.reason : null}
                prepareEpoch={prepareEpoch}
              />
            )}
          </>
        ) : null}
        {guided && step === 1 ? (
          <>
            <StepFooter onBack={() => guided.back()}>
              <ActionButton
                type="button"
                disabled={gated || (gate.status === "reading" && Boolean(parseBytes32(escrowId)))}
                reason={gated ? decision.reason : gate.status === "reading" ? READING_ESCROW_TEXT : null}
                onClick={() => void onNext()}
                state={session.preparing ? { status: "busy", label: "Preparing…" } : { status: "idle", label: "Next" }}
              />
            </StepFooter>
            {session.error ? <ActionStatus state={{ status: "error", message: session.error }} nodeRef={session.setNode} /> : null}
          </>
        ) : null}
        {guided && step === 2 && actionReady && session.preview ? (
          <div data-testid="review-step">
            <PreviewBlock
              preview={session.preview}
              escrow={escrow}
              panel={panel}
              relayerConfigured={relayerConfigured}
              label={resultLabel}
              nodeRef={session.setNode}
              submitReason={gated ? decision.reason : null}
              guided
              lead={plainLead}
              payee={gate.face?.payee}
              resultId={idHex ?? undefined}
              resultLabel={ESCROW_ID_LABEL}
              omitSubmit
            />
            <div ref={setIdStatus} />
            <StepFooter onBack={() => guided.back()}>
              <SepoliaSubmit
                preview={session.preview}
                escrow={escrow}
                panel={panel}
                resultId={idHex ?? undefined}
                resultLabel={ESCROW_ID_LABEL}
                submitReason={gated ? decision.reason : null}
                prepareEpoch={prepareEpoch}
                guided
                statusRoot={idStatus}
              />
            </StepFooter>
          </div>
        ) : null}
      </form>
    </section>
  )
}

function OpenDisputeForm({
  escrow,
  panel,
  relayerConfigured,
  active,
  onActivate,
  guided = null,
}: {
  escrow: Address
  panel: Address
  relayerConfigured: boolean
  active: PrepareSlot | null
  onActivate: (slot: PrepareSlot) => void
  guided?: GuidedStep | null
}) {
  const client = usePublicClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const carried = useCarriedIds()
  const [urlEscrow] = useState(() => readUrlBytes32("escrow"))
  const [disputeId, setDisputeId] = useState<string>(() => randomBytes32())
  const claimPrefill = useSyncedPrefill(guided?.linkEscrow, urlEscrow.value ?? "")
  const setClaimId = claimPrefill.setValue
  const claimTouched = claimPrefill.touched
  const setClaimTouched = claimPrefill.setTouched
  const claimLink = guided?.linkEscrow ?? null
  const claimId = claimLink != null && !claimTouched ? claimLink : claimPrefill.value
  const [reason, setReason] = useState("")
  const [resolution, setResolution] = useState<DisputeSubjectResult | null>(null)
  const [readingSubject, setReadingSubject] = useState(false)
  const session = usePrepareSession<CallPreview>("dispute", active)
  const parsedClaim = parseBytes32(claimId)
  const flightRef = useRef<Promise<DisputeSubjectResult | null> | null>(null)
  const resolutionRef = useRef<DisputeSubjectResult | null>(null)
  const readingRef = useRef(false)
  const disputeIdRef = useRef(disputeId)
  const claimIdRef = useRef(claimId)
  const reasonRef = useRef(reason)
  disputeIdRef.current = disputeId
  claimIdRef.current = claimId
  reasonRef.current = reason

  useEffect(() => {
    if (claimTouched || guided?.linkEscrow || !carried.escrowId) return
    setClaimId(carried.escrowId)
  }, [carried.escrowId, claimTouched, guided?.linkEscrow, setClaimId])

  useEffect(() => {
    if (!parsedClaim) {
      flightRef.current = null
      readingRef.current = false
      resolutionRef.current = null
      setResolution(null)
      setReadingSubject(false)
      return
    }
    if (!client) {
      flightRef.current = null
      readingRef.current = false
      const next = { ok: false as const, message: FORM_ERRORS.subjectNetwork }
      resolutionRef.current = next
      setReadingSubject(false)
      setResolution(next)
      return
    }
    let cancelled = false
    readingRef.current = true
    resolutionRef.current = null
    setReadingSubject(true)
    setResolution(null)
    const flight = readDisputeSubject(client, escrow, parsedClaim, currentNowSeconds()).then(
      (next) => {
        if (!cancelled) {
          readingRef.current = false
          resolutionRef.current = next
          setReadingSubject(false)
          setResolution(next)
        }
        return next
      },
      () => {
        const next = { ok: false as const, message: FORM_ERRORS.subjectNetwork }
        if (!cancelled) {
          readingRef.current = false
          resolutionRef.current = next
          setReadingSubject(false)
          setResolution(next)
        }
        return next
      },
    )
    flightRef.current = flight
    return () => {
      cancelled = true
    }
  }, [client, escrow, parsedClaim])

  const createdAt = resolution?.ok ? resolution.createdAt.toString() : ""
  const subject = resolution?.ok ? resolution.subject : ""
  const subjectHint = readingSubject
    ? "Reading the subject from the escrow."
    : resolution?.ok
      ? resolution.source === "view"
        ? "Read from the escrow. The panel stores this subject."
        : "This escrow has no subject view, so the Escrow ID is the subject."
      : resolution
        ? resolution.message
        : "Filled from the escrow after the Escrow ID is entered."

  async function settleSubject() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const flight = flightRef.current
      if (!readingRef.current || !flight) return
      await flight
      if (flightRef.current === flight) return
    }
  }

  const claimHex = parseBytes32(claimId)
  const disputeHex = parseBytes32(disputeId)
  const disputeReady =
    claimHex != null &&
    disputeHex != null &&
    session.preview != null &&
    preparedMatches(session.preview.calldata, { action: "dispute", escrowId: claimHex, disputeId: disputeHex })
  const [disputeStatus, setDisputeStatus] = useState<HTMLElement | null>(null)
  const flowStep = useFlowStep(
    session.clear,
    "dispute",
    guided?.step ?? 1,
    2,
    `${claimHex ?? ""}|${disputeHex ?? ""}`,
    disputeReady,
    guided ? flowHref("dispute", 1, { escrow: claimHex }) : null,
  )
  const step = guided ? flowStep.display : 1
  const linked =
    guided?.linkEscrow != null && !claimTouched && claimId.toLowerCase() === guided.linkEscrow.toLowerCase()
  const plainLead = "You are opening a dispute. The panel will decide who should get the test ETH."

  async function onSubmit(event?: FormEvent): Promise<boolean> {
    event?.preventDefault()
    if (!session.begin()) return false
    try {
      await yieldPrepareTick()
      await settleSubject()
      const id = parseBytes32(disputeIdRef.current)
      const claim = parseBytes32(claimIdRef.current)
      if (!id || !claim) {
        session.publish(FORM_ERRORS.openIds, null)
        onActivate("dispute")
        return false
      }
      const trimmedReason = reasonRef.current.trim()
      if (trimmedReason.length === 0) {
        session.publish(FORM_ERRORS.openReason, null)
        onActivate("dispute")
        return false
      }
      if (new TextEncoder().encode(trimmedReason).length > 256) {
        session.publish(FORM_ERRORS.reasonTooLong, null)
        onActivate("dispute")
        return false
      }
      const current = resolutionRef.current
      if (readingRef.current || !current || (current.ok && current.escrowId !== claim)) {
        session.publish(FORM_ERRORS.subjectPending, null)
        onActivate("dispute")
        return false
      }
      if (!current.ok) {
        session.publish(current.message, null)
        onActivate("dispute")
        return false
      }
      const windowMessage = disputeWindowMessage(current.state, current.expiresAt, currentNowSeconds())
      if (windowMessage) {
        session.publish(windowMessage, null)
        onActivate("dispute")
        return false
      }
      session.publish(null, previewDispute(escrow, claim, id, trimmedReason))
      onActivate("dispute")
      return true
    } catch (cause) {
      session.publish(prepareFailure("dispute", cause), null)
      onActivate("dispute")
      return false
    } finally {
      session.finish()
    }
  }

  async function onNext() {
    if (!guided) return
    const ok = await onSubmit()
    if (ok) {
      const claim = parseBytes32(claimIdRef.current)
      const id = parseBytes32(disputeIdRef.current)
      flowStep.arm(`dispute|${claim ?? ""}|${id ?? ""}|2`)
      guided.go(2, true)
    }
  }

  return (
    <section id="dispute-form" className={guided ? "guided-flow" : undefined} aria-label="Open a dispute">
    <form
      id="open-dispute"
      onSubmit={(event) => {
        if (!guided) {
          void onSubmit(event)
          return
        }
        event.preventDefault()
        if (step === 1) void onNext()
      }}
    >
      {guided ? <Stepper step={step} total={2} /> : null}
      <ActionTestnet title="Open a dispute" />
      {!guided || step === 1 ? (
        <>
      <p className="muted">{FILE_DISPUTE_TEXT}</p>
      <IdField
        id="open-dispute-id"
        label={DISPUTE_ID_LABEL}
        hint={DISPUTE_ID_HINT}
        value={disputeId}
        generated
        onChange={(next) => {
          setDisputeId(next)
          session.clear()
        }}
      />
      {linked && guided?.linkEscrow ? (
        <>
          <FilledFromLink label={ESCROW_ID_LABEL} value={guided.linkEscrow} />
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setClaimTouched(true)
              setClaimId("")
              session.clear()
            }}
          >
            Use a different id
          </button>
        </>
      ) : (
        <IdField
          id="open-claim-id"
          label={ESCROW_ID_LABEL}
          hint={ESCROW_ID_HINT}
          value={claimId}
          onChange={(next) => {
            setClaimTouched(true)
            setClaimId(next)
            session.clear()
          }}
        />
      )}
      {guided ? (
        <>
          <ReadonlyValue
            label="Time the escrow was created"
            value={createdAt || subjectHint}
            testId="dispute-created"
          />
          <ReadonlyValue label="Subject" value={subject || subjectHint} testId="dispute-subject" />
        </>
      ) : (
        <>
      <Field
        id="open-created-at"
        label="Time the escrow was created"
        value={createdAt}
        onChange={() => undefined}
        readOnly
        hint="Read from the escrow. This time is not typed."
      />
      <Field
        id="open-subject"
        label="Subject"
        value={subject}
        onChange={() => undefined}
        readOnly
        hint={subjectHint}
      />
        </>
      )}
      <Field
        id="open-reason"
        label="Reason"
        value={reason}
        onChange={(next) => {
          setReason(next)
          session.clear()
        }}
      />
        </>
      ) : null}
      {!guided ? (
        <>
      <ActionButton
        type="submit"
        state={session.preparing ? { status: "busy", label: "Preparing…" } : { status: "idle", label: FILE_DISPUTE_BUTTON }}
      />
      {session.error ? (
        <ActionStatus state={{ status: "error", message: session.error }} nodeRef={session.setNode} />
      ) : (
        <PreviewBlock
          preview={session.preview}
          escrow={escrow}
          panel={panel}
          relayerConfigured={relayerConfigured}
          label="Prepared dispute"
          nodeRef={session.setNode}
          resultId={parseBytes32(disputeId) ?? undefined}
          resultLabel={DISPUTE_ID_LABEL}
        />
      )}
        </>
      ) : null}
      {guided && step === 1 ? (
        <>
          <StepFooter onBack={() => guided.back()}>
            <ActionButton
              type="button"
              onClick={() => void onNext()}
              state={session.preparing ? { status: "busy", label: "Preparing…" } : { status: "idle", label: "Next" }}
            />
          </StepFooter>
          {session.error ? <ActionStatus state={{ status: "error", message: session.error }} nodeRef={session.setNode} /> : null}
        </>
      ) : null}
      {guided && step === 2 && disputeReady && session.preview ? (
        <div data-testid="review-step">
          <PreviewBlock
            preview={session.preview}
            escrow={escrow}
            panel={panel}
            relayerConfigured={relayerConfigured}
            label="Prepared dispute"
            nodeRef={session.setNode}
            resultId={disputeHex ?? undefined}
            resultLabel={DISPUTE_ID_LABEL}
            guided
            lead={plainLead}
            omitSubmit
          />
          <IdRow label={ESCROW_ID_LABEL} value={claimHex ?? ""} testId="review-escrow-id" />
          <div ref={setDisputeStatus} />
          <StepFooter onBack={() => guided.back()}>
            <SepoliaSubmit
              preview={session.preview}
              escrow={escrow}
              panel={panel}
              resultId={disputeHex ?? undefined}
              resultLabel={DISPUTE_ID_LABEL}
              guided
              statusRoot={disputeStatus}
            />
          </StepFooter>
        </div>
      ) : null}
    </form>
    </section>
  )
}
