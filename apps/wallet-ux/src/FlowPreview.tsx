import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import { formatEther, getAddress, isAddress, parseEther, type Address, type Hex } from "viem"
import { useAccount, usePublicClient, useSendTransaction, useWalletClient } from "wagmi"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { parseBytes32, randomBytes32 } from "./bytes32"
import { disputeWindowMessage, readDisputeSubject, type DisputeSubjectResult } from "./disputeSubject"
import { currentNowSeconds } from "./nowClock"
import { ErrorNotice } from "./ErrorNotice"
import { presentError, type ErrorPresentation } from "./format"
import { resolveWalletChainId } from "./guard"
import {
  CASE_ID_HINT,
  ERROR_GLOSSARY,
  FILE_DISPUTE_BUTTON,
  FILE_DISPUTE_TEXT,
  MAX_DURATION_SECONDS,
  NEW_CASE_ID_BUTTON,
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
import { useConnectorChainId } from "./useWalletChain"

function notice(main: string): ErrorPresentation {
  return { main, detail: null }
}

/** Accept lowercase, mixed-case, and surrounding whitespace. Checksum is normalized. */
function parsePayeeAddress(raw: string): Address | null {
  const trimmed = raw.trim()
  if (!isAddress(trimmed, { strict: false })) return null
  try {
    return getAddress(trimmed.toLowerCase())
  } catch {
    return null
  }
}

function prepareFailure(cause: unknown): string {
  return `Couldn't prepare this claim: ${presentError(cause).main}`
}

function SepoliaSubmit({ preview, escrow, panel }: { preview: CallPreview; escrow: Address; panel: Address }) {
  const account = useAccount()
  const connectorChainId = useConnectorChainId(account.connector, account.isConnected)
  const walletChainId = account.isConnected ? resolveWalletChainId(account.chainId, connectorChainId) : null
  const decision = evaluateEscrowSubmit({ walletConnected: account.isConnected, walletChainId })
  const publicClient = usePublicClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const { data: walletClient } = useWalletClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const { sendTransactionAsync, isPending } = useSendTransaction()
  const [txHash, setTxHash] = useState<Hex | null>(null)
  const [submitError, setSubmitError] = useState<ErrorPresentation | null>(null)
  const [relayerPhase, setRelayerPhase] = useState<RelayerPhase>("idle")
  const [relayerHealth, setRelayerHealth] = useState<RelayerHealth>("unknown")
  const [pendingHash, setPendingHash] = useState<Hex | null>(null)
  const [confirmedHash, setConfirmedHash] = useState<Hex | null>(null)
  const relayerFlight = useRef(false)
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

  async function onClick() {
    setSubmitError(null)
    setConfirmedHash(null)
    setPendingHash(null)
    const current = evaluateEscrowSubmit({
      walletConnected: account.isConnected,
      walletChainId: account.isConnected ? resolveWalletChainId(account.chainId, connectorChainId) : null,
    })
    if (!current.ok) {
      setTxHash(null)
      setSubmitError(notice(current.reason))
      return
    }
    try {
      assertSubmitTarget(preview.to, [escrow, panel])
      if (!publicClient) {
        setTxHash(null)
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
      setTxHash(hash)
    } catch (cause) {
      setTxHash(null)
      setSubmitError(presentError(cause))
    }
  }

  async function onRelayer() {
    if (relayerFlight.current) return
    setSubmitError(null)
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
    if (!relayer.url || relayerHealth !== "ok") return
    if (!publicClient) {
      setTxHash(null)
      setSubmitError(notice("The network client isn't ready, so nothing was sent."))
      return
    }
    if (!account.address || !walletClient) {
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
          if (hash) setPendingHash(hash)
        },
      })
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
      setSubmitError(presentError(cause))
    } finally {
      relayerFlight.current = false
      setRelayerPhase("idle")
    }
  }

  return (
    <div>
      <p>{submitSenderNote(preview.functionName)}</p>
      <button type="button" data-testid={control.testId} disabled={control.disabled} onClick={() => void onClick()}>
        {control.label}
      </button>
      {relayerButton.visible ? (
        <div data-testid="relayer-panel">
          <p>Submit through the claim relayer, or from your wallet.</p>
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
          <button
            type="button"
            data-testid="relayer-submit"
            disabled={relayerButton.disabled || isPending}
            aria-busy={relayerBusy}
            onClick={() => void onRelayer()}
          >
            {relayerButton.label}
          </button>
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
      {txHash ? (
        <p className="mono" data-testid="submit-tx">
          Submitted {txHash}
        </p>
      ) : null}
    </div>
  )
}

function PreviewBlock({
  preview,
  escrow,
  panel,
  relayerConfigured,
}: {
  preview: CallPreview | null
  escrow: Address
  panel: Address
  relayerConfigured: boolean
}) {
  if (!preview) return null
  return (
    <div className="preview" data-testid="calldata-preview">
      <p>{previewCardCopy(preview.functionName, relayerConfigured)}</p>
      <p className="mono">{preview.to}</p>
      <p>value {formatEther(preview.valueWei)} ETH</p>
      <pre className="calldata">{preview.calldata}</pre>
      <SepoliaSubmit key={preview.calldata} preview={preview} escrow={escrow} panel={panel} />
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
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  readOnly?: boolean
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        spellCheck={false}
        autoComplete="off"
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  )
}

export function FlowPreview({ escrow, panel }: { escrow: Address; panel: Address }) {
  const [error, setError] = useState<string | null>(null)
  const [previews, setPreviews] = useState<CallPreview[]>([])
  const [sharedEpoch, setSharedEpoch] = useState(0)
  const relayerConfigured = relayerConfigFromEnv({
    VITE_CLAIM_RELAYER_URL: import.meta.env.VITE_CLAIM_RELAYER_URL,
  }).url != null

  function show(next: CallPreview | CallPreview[]) {
    setError(null)
    setPreviews(Array.isArray(next) ? next : [next])
    setSharedEpoch((value) => value + 1)
  }

  function fail(message: string) {
    setPreviews([])
    setError(message)
    setSharedEpoch((value) => value + 1)
  }

  function clearShared() {
    setError(null)
    setPreviews([])
  }

  return (
    <div>
      <h3>Prepared transaction</h3>
      <p className="muted">
        These forms prepare a transaction, then the connected wallet can submit it on Base Sepolia, chain{" "}
        {BASE_SEPOLIA_CHAIN_ID}. Ethereum mainnet and Base mainnet are refused.
      </p>
      <CreateForm
        escrow={escrow}
        panel={panel}
        relayerConfigured={relayerConfigured}
        resetToken={sharedEpoch}
        onClearShared={clearShared}
      />
      <IdForm
        idPrefix="release"
        title="Release a claim"
        buttonLabel="Prepare this payout"
        missingId={FORM_ERRORS.releaseId}
        onSubmit={(escrowId) => show(previewRelease(escrow, escrowId))}
        onError={fail}
      />
      <IdForm
        idPrefix="refund"
        title="Refund a claim"
        buttonLabel="Prepare this refund"
        missingId={FORM_ERRORS.refundId}
        intro={<PostExpiryRefundOrder />}
        onSubmit={(escrowId) => show(previewRefund(escrow, escrowId))}
        onError={fail}
      />
      <OpenDisputeForm
        escrow={escrow}
        onPreview={show}
        onError={fail}
      />
      {error ? (
        <p className="bad" role="alert">
          {error}
        </p>
      ) : null}
      <PreviewBlock preview={previews[0] ?? null} escrow={escrow} panel={panel} relayerConfigured={relayerConfigured} />
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
  resetToken,
  onClearShared,
}: {
  escrow: Address
  panel: Address
  relayerConfigured: boolean
  resetToken: number
  onClearShared: () => void
}) {
  const [escrowId, setEscrowId] = useState("")
  const [payee, setPayee] = useState("")
  const [payerBotId, setPayerBotId] = useState("")
  const [payeeBotId, setPayeeBotId] = useState("")
  const [duration, setDuration] = useState("86400")
  const [value, setValue] = useState("0.01")
  const [formError, setFormError] = useState<string | null>(null)
  const [preview, setPreview] = useState<CallPreview | null>(null)

  useEffect(() => {
    setFormError(null)
    setPreview(null)
  }, [resetToken])

  function report(message: string) {
    setPreview(null)
    setFormError(message)
    onClearShared()
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    try {
      const id = parseBytes32(escrowId)
      const payerBot = parseBytes32(payerBotId)
      const payeeBot = parseBytes32(payeeBotId)
      if (!id || !payerBot || !payeeBot) {
        report(FORM_ERRORS.createIds)
        return
      }
      const payeeAddress = parsePayeeAddress(payee)
      if (!payeeAddress) {
        report(FORM_ERRORS.payee)
        return
      }
      const durationSeconds = Number(duration.trim())
      if (!Number.isInteger(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_DURATION_SECONDS) {
        report(durationValidationMessage(MAX_DURATION_SECONDS))
        return
      }
      let valueWei: bigint
      try {
        valueWei = parseEther(value.trim())
      } catch {
        report(FORM_ERRORS.valueFormat)
        return
      }
      if (valueWei <= 0n) {
        report(FORM_ERRORS.valueZero)
        return
      }
      const next = previewCreateEscrow({
        escrow,
        escrowId: id,
        payee: payeeAddress,
        payerBotId: payerBot,
        payeeBotId: payeeBot,
        durationSeconds: BigInt(durationSeconds),
        valueWei,
      })
      setFormError(null)
      setPreview(next)
      onClearShared()
    } catch (cause) {
      report(prepareFailure(cause))
    }
  }

  return (
    <form id="create-claim" onSubmit={onSubmit}>
      <h3>Create a claim</h3>
      <Field id="create-id" label="Claim identifier" value={escrowId} onChange={setEscrowId} />
      <Field id="create-payee" label="Payee wallet" value={payee} onChange={setPayee} />
      <Field id="create-payer-bot" label="Payer bot identifier" value={payerBotId} onChange={setPayerBotId} />
      <Field id="create-payee-bot" label="Payee bot identifier" value={payeeBotId} onChange={setPayeeBotId} />
      <Field
        id="create-duration"
        label="Time window in seconds"
        value={duration}
        onChange={setDuration}
        hint={`Greater than 0 and at most ${MAX_DURATION_SECONDS}, which is 30 days.`}
      />
      <Field
        id="create-value"
        label="Amount in ETH"
        value={value}
        onChange={setValue}
        hint="This amount is sent with the transaction on Base Sepolia. The connected wallet must be allowed to fund claims for the payer."
      />
      <button type="submit">Prepare this claim</button>
      {formError ? (
        <p className="bad" role="alert">
          {formError}
        </p>
      ) : null}
      <PreviewBlock preview={preview} escrow={escrow} panel={panel} relayerConfigured={relayerConfigured} />
    </form>
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
  idPrefix,
  title,
  buttonLabel,
  missingId,
  intro,
  onSubmit,
  onError,
}: {
  idPrefix: string
  title: string
  buttonLabel: string
  missingId: string
  intro?: ReactNode
  onSubmit: (escrowId: `0x${string}`) => void
  onError: (message: string) => void
}) {
  const [escrowId, setEscrowId] = useState("")
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        const id = parseBytes32(escrowId)
        if (!id) {
          onError(missingId)
          return
        }
        onSubmit(id)
      }}
    >
      <h3>{title}</h3>
      {intro}
      <Field id={`${idPrefix}-id`} label="Claim identifier" value={escrowId} onChange={setEscrowId} />
      <button type="submit">{buttonLabel}</button>
    </form>
  )
}

function OpenDisputeForm({
  escrow,
  onPreview,
  onError,
}: {
  escrow: Address
  onPreview: (preview: CallPreview) => void
  onError: (message: string) => void
}) {
  const client = usePublicClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const [disputeId, setDisputeId] = useState(() => randomBytes32())
  const [claimId, setClaimId] = useState("")
  const [reason, setReason] = useState("")
  const [resolution, setResolution] = useState<DisputeSubjectResult | null>(null)
  const [readingSubject, setReadingSubject] = useState(false)
  const parsedClaim = parseBytes32(claimId)

  useEffect(() => {
    if (!parsedClaim) {
      setResolution(null)
      setReadingSubject(false)
      return
    }
    if (!client) {
      setReadingSubject(false)
      setResolution({ ok: false, message: FORM_ERRORS.subjectNetwork })
      return
    }
    let cancelled = false
    setReadingSubject(true)
    setResolution(null)
    readDisputeSubject(client, escrow, parsedClaim, currentNowSeconds()).then(
      (next) => {
        if (cancelled) return
        setReadingSubject(false)
        setResolution(next)
      },
      () => {
        if (cancelled) return
        setReadingSubject(false)
        setResolution({ ok: false, message: FORM_ERRORS.subjectNetwork })
      },
    )
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
        : "This escrow has no subject view, so the claim identifier is the subject."
      : resolution
        ? resolution.message
        : "Filled from the escrow after the claim identifier is entered."

  return (
    <form
      id="open-dispute"
      onSubmit={(event) => {
        event.preventDefault()
        const id = parseBytes32(disputeId)
        const claim = parseBytes32(claimId)
        if (!id || !claim) {
          onError(FORM_ERRORS.openIds)
          return
        }
        const trimmedReason = reason.trim()
        if (trimmedReason.length === 0) {
          onError(FORM_ERRORS.openReason)
          return
        }
        if (new TextEncoder().encode(trimmedReason).length > 256) {
          onError(FORM_ERRORS.reasonTooLong)
          return
        }
        if (readingSubject || !resolution || (resolution.ok && resolution.escrowId !== claim)) {
          onError(FORM_ERRORS.subjectPending)
          return
        }
        if (!resolution.ok) {
          onError(resolution.message)
          return
        }
        const windowMessage = disputeWindowMessage(resolution.state, resolution.expiresAt, currentNowSeconds())
        if (windowMessage) {
          onError(windowMessage)
          return
        }
        onPreview(previewDispute(escrow, claim, id, trimmedReason))
      }}
    >
      <h3>Open a dispute</h3>
      <p className="muted">{FILE_DISPUTE_TEXT}</p>
      <Field
        id="open-dispute-id"
        label="Case identifier"
        value={disputeId}
        onChange={() => undefined}
        readOnly
        hint={CASE_ID_HINT}
      />
      <button type="button" onClick={() => setDisputeId(randomBytes32())}>
        {NEW_CASE_ID_BUTTON}
      </button>
      <Field id="open-claim-id" label="Claim identifier" value={claimId} onChange={setClaimId} />
      <Field
        id="open-created-at"
        label="Time the claim was created"
        value={createdAt}
        onChange={() => undefined}
        readOnly
        hint="Read from the claim. This time is not typed."
      />
      <Field
        id="open-subject"
        label="Subject"
        value={subject}
        onChange={() => undefined}
        readOnly
        hint={subjectHint}
      />
      <Field id="open-reason" label="Reason" value={reason} onChange={setReason} />
      <button type="submit">{FILE_DISPUTE_BUTTON}</button>
    </form>
  )
}
