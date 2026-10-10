import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
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
  USE_OWN_LABEL,
  useWalletHint,
  type ActionButtonState,
} from "./actionButton"
import { actionProgress, CONTRACT_LABELS, GAS_FEE_TEXT, BALANCE_WARN_TEXT, ANOTHER_PENDING_REASON } from "./actionProgress"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { parseBytes32, randomBytes32 } from "./bytes32"
import { carryDisputeId, carryEscrowId, readUrlBytes32, useCarriedIds } from "./carriedIds"
import { DEFAULT_DURATION_SECONDS, DURATION_PRESETS, parseWholeSeconds } from "./duration"
import { ESCROW_UNREAD_TEXT, READING_ESCROW_TEXT, useEscrowActionGate } from "./escrowGate"
import { disputeWindowMessage, readDisputeSubject, type DisputeSubjectResult } from "./disputeSubject"
import { ErrorNotice } from "./ErrorNotice"
import { formatLocalTimestamp, isZeroAddress, presentError, sameAddress, type ErrorPresentation } from "./format"
import { isWalletCancel } from "./revert"
import { currentNowSeconds } from "./nowClock"
import { clearPending, readPending, writePending } from "./pendingTx"
import { parsePayeeAddress, payeeHasChecksumError } from "./payeeAddress"
import { prepareFailure, usePrepareSession, yieldPrepareTick } from "./prepareFeedback"
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
  readRelayerHealth,
  RELAYER_CONFIRMED_TEXT,
  RELAYER_CONNECT_NOTE,
  RELAYER_SERVICE_DOWN_TEXT,
  RELAYER_SUBMITTED_TEXT,
  RELAYER_SUBMITTING_TEXT,
  RELAYER_TX_LINK_LABEL,
  RELAYER_WAITING_TEXT,
  relayerButtonModel,
  relayerConfigFromEnv,
  relayerSubmitAllowed,
  relayerTxUrl,
  runRelayerSubmission,
  type RelayerHealth,
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
import { CalldataDetails, LabeledChunks } from "./ui"
import { isReceiptTimeout, TX_RECEIPT_UNREADABLE_TEXT, TX_REVERTED_TEXT } from "./walletCopy"

function notice(main: string): ErrorPresentation {
  return { main, detail: null }
}

function ActionTestnet({ title }: { title: string }) {
  return <h3>{title}</h3>
}

function SepoliaSubmit({
  preview,
  escrow,
  panel,
  onConfirmed,
  resultId,
  resultLabel,
  submitReason,
}: {
  preview: CallPreview
  escrow: Address
  panel: Address
  onConfirmed?: () => void
  resultId?: string
  resultLabel?: string
  submitReason?: string | null
}) {
  const progress = actionProgress(preview.functionName)
  const slot = preview.functionName
  const account = useAccount()
  const { switchChain } = useSwitchChain()
  const connectorChainId = useConnectorChainId(account.connector, account.isConnected)
  const walletChainId = account.isConnected ? resolveWalletChainId(account.chainId, connectorChainId) : null
  const decision = evaluateEscrowSubmit({ walletConnected: account.isConnected, walletChainId })
  const publicClient = usePublicClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const { data: walletClient } = useWalletClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const { sendTransactionAsync, isPending } = useSendTransaction()
  const [phase, setPhase] = useState<"idle" | "waiting" | "pending" | "confirmed">("idle")
  const [txHash, setTxHash] = useState<Hex | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const [submitError, setSubmitError] = useState<ErrorPresentation | null>(null)
  const [relayerPhase, setRelayerPhase] = useState<RelayerPhase>("idle")
  const [relayerHealth, setRelayerHealth] = useState<RelayerHealth>("unknown")
  const [pendingHash, setPendingHash] = useState<Hex | null>(null)
  const [confirmedHash, setConfirmedHash] = useState<Hex | null>(null)
  const [stalled, setStalled] = useState(false)
  const [relayerNotice, setRelayerNotice] = useState<string | null>(null)
  const relayerFlight = useRef(false)
  const ownedHash = useRef<Hex | null>(null)
  const onConfirmedRef = useRef(onConfirmed)
  onConfirmedRef.current = onConfirmed
  const waiting = phase === "waiting" || (isPending && phase !== "pending" && phase !== "confirmed")
  const { id: submitSlot, blocked } = useSubmitBlocked(waiting || phase === "pending" || relayerPhase !== "idle")
  const walletHint = useWalletHint(waiting || relayerPhase === "submitting")
  const relayer = relayerConfigFromEnv({
    VITE_CLAIM_RELAYER_URL: import.meta.env.VITE_CLAIM_RELAYER_URL,
  })
  const relayerGate = relayerSubmitAllowed({ walletConnected: account.isConnected, walletChainId })
  const relayerBusy = relayerPhase !== "idle"
  const control = submitControl(decision, isPending || relayerBusy)
  const relayerButton = relayerButtonModel({
    url: relayer.url,
    health: relayerHealth,
    phase: relayerPhase,
    gate: relayerGate,
    action: preview.functionName,
  })

  useEffect(() => {
    if (!relayer.url) return
    let cancelled = false
    void readRelayerHealth({ url: relayer.url }).then((health) => {
      if (!cancelled) setRelayerHealth(health)
    })
    return () => {
      cancelled = true
    }
  }, [relayer.url])

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
    setSubmitError(null)
    setCancelled(false)
    setConfirmedHash(null)
    setPendingHash(null)
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
      assertSubmitTarget(preview.to, [escrow, panel])
      if (!publicClient) {
        setTxHash(null)
        setPhase("idle")
        setSubmitError(notice("Base Sepolia client is unavailable. The wallet was not opened."))
        return
      }
      setPhase("waiting")
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
      if (submitted && isReceiptTimeout(cause)) {
        setPhase("pending")
        setStalled(true)
        keepLock = true
        return
      }
      keepLock = false
      setPhase("idle")
      if (submitted) {
        clearPending(slot)
        setSubmitError(notice(TX_RECEIPT_UNREADABLE_TEXT))
        return
      }
      setTxHash(null)
      if (isWalletCancel(cause)) {
        setCancelled(true)
        return
      }
      setSubmitError(presentError(cause))
    } finally {
      if (!keepLock) releaseSubmit(submitSlot)
    }
  }

  async function onRelayer() {
    if (relayerFlight.current) return
    setSubmitError(null)
    setRelayerNotice(null)
    setCancelled(false)
    setConfirmedHash(null)
    setPendingHash(null)
    const gate = relayerSubmitAllowed({
      walletConnected: account.isConnected,
      walletChainId: account.isConnected ? resolveWalletChainId(account.chainId, connectorChainId) : null,
    })
    if (!gate.ok) {
      setTxHash(null)
      setSubmitError(notice(gate.reason))
      return
    }
    if (!tryHoldSubmit(submitSlot)) return
    if (!relayer.url || relayerHealth !== "ok") {
      releaseSubmit(submitSlot)
      setRelayerNotice(RELAYER_SERVICE_DOWN_TEXT)
      return
    }
    if (!publicClient) {
      releaseSubmit(submitSlot)
      setTxHash(null)
      setSubmitError(notice("The network client isn't ready, so nothing was sent."))
      return
    }
    if (!account.address || !walletClient) {
      releaseSubmit(submitSlot)
      setTxHash(null)
      setSubmitError(notice(RELAYER_CONNECT_NOTE))
      return
    }
    const signer = walletClient
    const sender = account.address
    relayerFlight.current = true
    setRelayerPhase("submitting")
    setTxHash(null)
    try {
      assertSubmitTarget(preview.to, [escrow, panel])
      const url = relayer.url
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
            const stored = writePending(`${slot}:relayer`, hash)
            setStartedAt(stored.startedAt)
            setPendingHash(hash)
          }
        },
      })
      clearPending(`${slot}:relayer`)
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
      clearPending(`${slot}:relayer`)
      if (isWalletCancel(cause)) {
        setCancelled(true)
        return
      }
      setSubmitError(presentError(cause))
    } finally {
      relayerFlight.current = false
      setRelayerPhase("idle")
    }
  }

  const walletState: ActionButtonState = !decision.ok
    ? decision.code === "disconnected"
      ? { status: "needs-wallet" }
      : { status: "wrong-network" }
    : phase === "confirmed" && txHash
      ? {
          status: "confirmed",
          hash: txHash,
          label: progress.done,
          resultId,
          resultLabel,
          nextHref: progress.next?.href,
          nextLabel: progress.next?.label,
        }
      : phase === "pending" && txHash
        ? { status: "pending", hash: txHash, label: progress.pending, startedAt: startedAt ?? undefined, stalled }
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
          ? { status: "pending", hash: pendingHash, label: progress.pending, startedAt: startedAt ?? undefined }
          : confirmedHash
            ? { status: "confirmed", hash: confirmedHash, label: progress.done, resultId, resultLabel, nextHref: progress.next?.href, nextLabel: progress.next?.label }
            : relayerHealth === "unknown"
              ? { status: "busy", label: CHECKING_LABEL }
              : { status: "idle", label: relayerButton.visible ? relayerButton.label : "Submit refund request" }

  return (
    <div>
      <p>{submitSenderNote(preview.functionName)}</p>
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
          Boolean(submitReason) || blocked || (decision.ok && control.disabled && walletState.status === "idle")
        }
        onClick={() => {
          if (walletState.status === "wrong-network") {
            switchChain({ chainId: BASE_SEPOLIA_CHAIN_ID })
            return
          }
          void onClick()
        }}
      />
      <ActionStatus state={walletState} walletHint={walletHint} cancelled={cancelled && relayerPhase === "idle" && !pendingHash} />
      {relayerButton.visible ? (
        <div data-testid="relayer-panel">
          <p>Submit the refund request through the relayer, or send it from your wallet.</p>
          {relayerButton.note ? (
            <p className="relayer-pending" role="status" data-testid="relayer-note">
              {relayerButton.note}
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
              blocked && relayerState.status === "idle"
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
    </div>
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
}) {
  if (!preview) return null
  const contractName = CONTRACT_LABELS.escrow
  const expiry =
    durationSeconds != null ? formatLocalTimestamp(currentNowSeconds() + BigInt(durationSeconds)) : null
  return (
    <div className="preview" data-testid="calldata-preview" tabIndex={-1} aria-label={label} ref={nodeRef}>
      <p>{previewCardCopy(preview.functionName, relayerConfigured)}</p>
      <p data-testid="review-contract">{contractName}</p>
      <LabeledChunks label="Contract" address={preview.to} testId="review-contract-address" />
      {payee ? <LabeledChunks label="Payee" address={payee} testId="review-payee" /> : null}
      {durationSeconds != null && expiry ? (
        <p data-testid="review-duration">
          Time window: {durationPhrase(durationSeconds)}. Ends {expiry}.
        </p>
      ) : null}
      <p data-testid="review-amount">Amount {formatEther(preview.valueWei)} ETH</p>
      <p data-testid="review-gas">{GAS_FEE_TEXT}</p>
      <CalldataDetails calldata={preview.calldata} />
      <SepoliaSubmit
        key={preview.calldata}
        preview={preview}
        escrow={escrow}
        panel={panel}
        onConfirmed={onConfirmed}
        resultId={resultId}
        resultLabel={resultLabel}
        submitReason={submitReason}
      />
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

export function FlowPreview({ escrow, panel }: { escrow: Address; panel: Address }) {
  const [active, setActive] = useState<PrepareSlot | null>(null)
  const [escrowUrl] = useState(() => readUrlBytes32("escrow"))
  const relayerConfigured = relayerConfigFromEnv({
    VITE_CLAIM_RELAYER_URL: import.meta.env.VITE_CLAIM_RELAYER_URL,
  }).url != null

  return (
    <div>
      {escrowUrl.notice ? (
        <p className="banner" role="status" data-testid="url-escrow-notice">
          {escrowUrl.notice}
        </p>
      ) : null}
      <p className="muted">
        These forms prepare a transaction, then the connected wallet can submit it on Base Sepolia, chain{" "}
        {BASE_SEPOLIA_CHAIN_ID}. Ethereum mainnet and Base mainnet are refused.
      </p>
      <CreateForm
        escrow={escrow}
        panel={panel}
        relayerConfigured={relayerConfigured}
        active={active}
        onActivate={setActive}
      />
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
        build={(escrowId) => previewRelease(escrow, escrowId)}
      />
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
        build={(escrowId) => previewRefund(escrow, escrowId)}
      />
      <OpenDisputeForm escrow={escrow} panel={panel} relayerConfigured={relayerConfigured} active={active} onActivate={setActive} />
      <h3>Revert glossary</h3>
      <dl className="glossary">
        {ERROR_GLOSSARY.map((entry) => (
          <div key={entry.name}>
            <dt>{entry.name}</dt>
            <dd>{entry.meaning}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function CreateForm({
  escrow,
  panel,
  relayerConfigured,
  active,
  onActivate,
}: {
  escrow: Address
  panel: Address
  relayerConfigured: boolean
  active: PrepareSlot | null
  onActivate: (slot: PrepareSlot) => void
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
  const preparedId = useRef<Hex | null>(null)
  const session = usePrepareSession<CallPreview>("create", active)
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

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!session.begin()) return
    try {
      await yieldPrepareTick()
      const id = parseBytes32(escrowId)
      const payerBot = parseBytes32(payerBotId)
      const payeeBot = parseBytes32(payeeBotId)
      if (!id || !payerBot || !payeeBot) {
        session.publish(FORM_ERRORS.createIds, null)
        onActivate("create")
        return
      }
      if (payerBot.toLowerCase() === payeeBot.toLowerCase()) {
        session.publish(FORM_ERRORS.sameBots, null)
        onActivate("create")
        return
      }
      if (payeeHasChecksumError(payee)) {
        session.publish(FORM_ERRORS.payeeChecksum, null)
        onActivate("create")
        return
      }
      const payeeParsed = parsePayeeAddress(payee)
      if (!payeeParsed) {
        session.publish(FORM_ERRORS.payee, null)
        onActivate("create")
        return
      }
      if (isZeroAddress(payeeParsed)) {
        session.publish(FORM_ERRORS.payeeZero, null)
        onActivate("create")
        return
      }
      const durationSeconds =
        preset === "custom" ? parseWholeSeconds(customDuration, MAX_DURATION_SECONDS) : preset
      if (durationSeconds == null || durationSeconds <= 0 || durationSeconds > MAX_DURATION_SECONDS) {
        session.publish(durationValidationMessage(MAX_DURATION_SECONDS), null)
        onActivate("create")
        return
      }
      if (value.trim() === "") {
        session.publish(FORM_ERRORS.valueEmpty, null)
        onActivate("create")
        return
      }
      let valueWei: bigint
      try {
        valueWei = parseEther(value.trim())
      } catch {
        session.publish(FORM_ERRORS.valueFormat, null)
        onActivate("create")
        return
      }
      if (valueWei <= 0n) {
        session.publish(FORM_ERRORS.valueZero, null)
        onActivate("create")
        return
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
      preparedId.current = id
      session.publish(null, next)
      onActivate("create")
    } catch (cause) {
      session.publish(prepareFailure("escrow", cause), null)
      onActivate("create")
    } finally {
      session.finish()
    }
  }

  return (
    <section id="fund-form" aria-label="Fund an escrow">
      <form id="create-claim" onSubmit={(event) => void onSubmit(event)}>
        <ActionTestnet title="Fund an escrow" />
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
            onConfirmed={() => {
              if (preparedId.current) carryEscrowId(preparedId.current)
            }}
          />
        )}
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
  build: (escrowId: Hex) => CallPreview
}) {
  const carried = useCarriedIds()
  const client = usePublicClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const [urlEscrow] = useState(() => readUrlBytes32("escrow"))
  const [escrowId, setEscrowId] = useState(urlEscrow.value ?? "")
  const [touched, setTouched] = useState(false)
  const session = usePrepareSession<CallPreview>(slot, active)
  const gate = useEscrowActionGate(client, escrow, panel, escrowId)
  const decision = slot === "release" ? gate.release : gate.refund
  const gated = gate.status === "ready" && !decision.allowed

  useEffect(() => {
    if (touched || !carried.escrowId) return
    setEscrowId(carried.escrowId)
  }, [carried.escrowId, touched])

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!session.begin()) return
    try {
      await yieldPrepareTick()
      const id = parseBytes32(escrowId)
      if (!id) {
        session.publish(missingId, null)
        onActivate(slot)
        return
      }
      session.publish(null, build(id))
      onActivate(slot)
    } catch (cause) {
      session.publish(prepareFailure(action, cause), null)
      onActivate(slot)
    } finally {
      session.finish()
    }
  }

  return (
    <section id={`${slot}-form`} aria-label={title}>
      <form onSubmit={(event) => void onSubmit(event)}>
        <ActionTestnet title={title} />
        {intro}
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
        {gate.status === "reading" && parseBytes32(escrowId) ? <p className="hint">{READING_ESCROW_TEXT}</p> : null}
        {gate.status === "unread" ? (
          <p className="warn-note" role="status">
            {ESCROW_UNREAD_TEXT}
          </p>
        ) : null}
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
          />
        )}
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
}: {
  escrow: Address
  panel: Address
  relayerConfigured: boolean
  active: PrepareSlot | null
  onActivate: (slot: PrepareSlot) => void
}) {
  const client = usePublicClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const carried = useCarriedIds()
  const [urlEscrow] = useState(() => readUrlBytes32("escrow"))
  const [disputeId, setDisputeId] = useState<string>(() => randomBytes32())
  const [claimId, setClaimId] = useState(urlEscrow.value ?? "")
  const [claimTouched, setClaimTouched] = useState(false)
  const preparedDispute = useRef<Hex | null>(null)
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
    if (claimTouched || !carried.escrowId) return
    setClaimId(carried.escrowId)
  }, [carried.escrowId, claimTouched])

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

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!session.begin()) return
    try {
      await yieldPrepareTick()
      await settleSubject()
      const id = parseBytes32(disputeIdRef.current)
      const claim = parseBytes32(claimIdRef.current)
      if (!id || !claim) {
        session.publish(FORM_ERRORS.openIds, null)
        onActivate("dispute")
        return
      }
      const trimmedReason = reasonRef.current.trim()
      if (trimmedReason.length === 0) {
        session.publish(FORM_ERRORS.openReason, null)
        onActivate("dispute")
        return
      }
      if (new TextEncoder().encode(trimmedReason).length > 256) {
        session.publish(FORM_ERRORS.reasonTooLong, null)
        onActivate("dispute")
        return
      }
      const current = resolutionRef.current
      if (readingRef.current || !current || (current.ok && current.escrowId !== claim)) {
        session.publish(FORM_ERRORS.subjectPending, null)
        onActivate("dispute")
        return
      }
      if (!current.ok) {
        session.publish(current.message, null)
        onActivate("dispute")
        return
      }
      const windowMessage = disputeWindowMessage(current.state, current.expiresAt, currentNowSeconds())
      if (windowMessage) {
        session.publish(windowMessage, null)
        onActivate("dispute")
        return
      }
      preparedDispute.current = id
      carryDisputeId(id)
      session.publish(null, previewDispute(escrow, claim, id, trimmedReason))
      onActivate("dispute")
    } catch (cause) {
      session.publish(prepareFailure("dispute", cause), null)
      onActivate("dispute")
    } finally {
      session.finish()
    }
  }

  return (
    <section id="dispute-form" aria-label="Open a dispute">
    <form
      id="open-dispute"
      onSubmit={(event) => void onSubmit(event)}
    >
      <ActionTestnet title="Open a dispute" />
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
      <Field
        id="open-reason"
        label="Reason"
        value={reason}
        onChange={(next) => {
          setReason(next)
          session.clear()
        }}
      />
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
          onConfirmed={() => {
            if (preparedDispute.current) carryDisputeId(preparedDispute.current)
          }}
        />
      )}
    </form>
    </section>
  )
}
