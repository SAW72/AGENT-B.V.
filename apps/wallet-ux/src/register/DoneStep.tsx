import { ErrorNotice } from "../ErrorNotice"
import {
  CONTINUE_HELPER,
  CONTINUE_IDENTITY,
  DISCONNECTED,
  LABEL_AGENT_ID,
  LABEL_GLOBAL_ID,
  LABEL_OWNER,
  LABEL_TRANSACTION,
  PENDING_TX,
  PICKING_UP,
  SPED_UP,
  START_OVER,
  STILL_WAITING,
  VIEW_ON_BASESCAN,
  basescanTxUrl,
  registerErrorView,
  registerNoticeView,
  registeredId,
  switchToOwner,
} from "../registerCopy"
import { CopyTextButton, KvRow } from "./rows"
import { shortHex } from "./shortHex"
import type { RegisterErrorCode, RegisterUiNotice, TxStatus } from "./types"

export function DoneStep({
  txStatus,
  txHash,
  finalId,
  globalId,
  owner,
  errorKind,
  errorDetail,
  notice,
  noticeDetail,
  pendingSlow,
  walletDisconnected,
  showOwnerSwitch,
  spedUp,
  resuming,
  onStartOver,
  onContinue,
}: {
  txStatus: TxStatus | null
  txHash: string | null
  finalId: string | null
  globalId: string | null
  owner: string | null
  errorKind: RegisterErrorCode | null
  errorDetail: string | null
  notice: RegisterUiNotice | null
  noticeDetail: string | null
  pendingSlow: boolean
  walletDisconnected: boolean
  showOwnerSwitch: boolean
  spedUp: boolean
  resuming: boolean
  onStartOver: () => void
  onContinue: () => void
}) {
  const mode = doneMode(txStatus, errorKind, notice, finalId)
  const failureDetail = errorDetail ?? noticeDetail
  return (
    <div data-testid="step-done">
      {mode === "pending" ? (
        <>
          {resuming ? <p className="banner info">{PICKING_UP}</p> : null}
          <p className="banner info">{PENDING_TX}</p>
          {txHash ? (
            <p>
              <a href={basescanTxUrl(txHash)} target="_blank" rel="noreferrer">
                {VIEW_ON_BASESCAN}
              </a>
            </p>
          ) : null}
          {pendingSlow ? <p className="banner info">{STILL_WAITING}</p> : null}
          {walletDisconnected ? <p className="banner info">{DISCONNECTED}</p> : null}
          {spedUp ? <p className="muted">{SPED_UP}</p> : null}
        </>
      ) : null}
      {mode === "confirmed" && finalId ? (
        <>
          <p className="pill ok">{registeredId(finalId)}</p>
          <KvRow label={LABEL_AGENT_ID} testId="final-agent-id">
            {finalId}
          </KvRow>
          <KvRow label={LABEL_GLOBAL_ID}>
            <span className="mono register-hex" data-testid="global-id">
              {globalId ?? ""}
            </span>
            {globalId ? <CopyTextButton value={globalId} testId="copy-global-id" /> : null}
          </KvRow>
          {owner ? (
            <KvRow label={LABEL_OWNER}>
              <span className="mono register-hex" title={owner}>
                {shortHex(owner)}
              </span>
            </KvRow>
          ) : null}
          {txHash ? (
            <KvRow label={LABEL_TRANSACTION}>
              <a href={basescanTxUrl(txHash)} target="_blank" rel="noreferrer">
                {VIEW_ON_BASESCAN}
              </a>
            </KvRow>
          ) : null}
          {showOwnerSwitch && owner ? <p className="banner info">{switchToOwner(shortHex(owner))}</p> : null}
          <div className="step-actions">
            <div className="step-primary">
              <button type="button" onClick={onContinue}>
                {CONTINUE_IDENTITY}
              </button>
            </div>
          </div>
          <p className="hint">{CONTINUE_HELPER}</p>
        </>
      ) : null}
      {mode === "noEvent" ? <ErrorNotice main={registerErrorView("NoRegisteredEvent", null, null)?.main ?? ""} /> : null}
      {mode === "reverted" ? (
        <Failure
          main={registerNoticeView("reverted", failureDetail)?.main ?? ""}
          detail={registerNoticeView("reverted", failureDetail)?.detail}
          onStartOver={onStartOver}
        />
      ) : null}
      {mode === "replaced" ? (
        <Failure
          main={registerErrorView("Replaced", null, null)?.main ?? ""}
          detail={failureDetail}
          onStartOver={onStartOver}
        />
      ) : null}
      {mode === "cancelled" ? (
        <Failure
          main={registerErrorView("Cancelled", null, null)?.main ?? ""}
          detail={failureDetail ?? undefined}
          onStartOver={onStartOver}
        />
      ) : null}
    </div>
  )
}

function Failure({
  main,
  detail,
  onStartOver,
}: {
  main: string
  detail?: string | null
  onStartOver: () => void
}) {
  return (
    <>
      <ErrorNotice main={main} detail={detail} />
      <div className="step-actions">
        <div className="step-primary">
          <button type="button" onClick={onStartOver}>
            {START_OVER}
          </button>
        </div>
      </div>
    </>
  )
}

function doneMode(
  txStatus: TxStatus | null,
  errorKind: RegisterErrorCode | null,
  notice: RegisterUiNotice | null,
  finalId: string | null,
): "pending" | "confirmed" | "reverted" | "replaced" | "noEvent" | "cancelled" {
  let mode: "pending" | "confirmed" | "reverted" | "replaced" | "noEvent" | "cancelled"
  if (txStatus != null) mode = txStatus
  else if (errorKind === "Cancelled") mode = "cancelled"
  else if (notice === "reverted") mode = "reverted"
  else if (errorKind === "Replaced") mode = "replaced"
  else if (errorKind === "NoRegisteredEvent") mode = "noEvent"
  else mode = "pending"
  if (mode === "confirmed" && (finalId == null || finalId === "")) return "noEvent"
  return mode
}
