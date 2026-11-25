import { useState } from "react"
import { WALLET_HINT_TEXT } from "../actionButton"
import { INSTALL_WALLET_HINT } from "../walletHint"
import {
  ALREADY_PENDING,
  COULD_NOT_CONNECT,
  COLLAPSE,
  CONNECT_REJECTED,
  CONNECT_WALLET,
  CONNECTING,
  CONTINUE,
  EXPAND,
  LABEL_AGENT_URI,
  LABEL_NAME,
  LABEL_SIZE,
  LABEL_TYPE,
  NAME_EMPTY,
  OPEN_WALLET_CONNECT,
  URI_EMPTY,
  PASS_LINE,
  WAITING_WALLET,
  sizeText,
} from "../registerCopy"
import { KvRow, RegisterAlerts, StepActions } from "./rows"
import type { ConnectNotice, ParsedRegistration, RegisterErrorCode, RegisterUiNotice } from "./types"

const URI_PREVIEW = 96

export function CheckStep({
  parsed,
  errorKind,
  errorDetail,
  notice,
  noticeDetail,
  walletConnected,
  connectPending,
  connectNotice,
  onContinue,
  onConnect,
  onBack,
}: {
  parsed: ParsedRegistration | null
  errorKind: RegisterErrorCode | null
  errorDetail: string | null
  notice: RegisterUiNotice | null
  noticeDetail: string | null
  walletConnected: boolean
  connectPending: boolean
  connectNotice: ConnectNotice
  onContinue: () => void
  onConnect: () => void
  onBack: () => void
}) {
  const passed = parsed != null && errorKind == null && notice == null
  return (
    <div data-testid="step-check">
      {parsed ? (
        <>
          <KvRow label={LABEL_TYPE}>{parsed.type}</KvRow>
          <KvRow label={LABEL_NAME}>{parsed.name === "" ? NAME_EMPTY : parsed.name}</KvRow>
          <KvRow label={LABEL_SIZE} testId="size-row">
            {sizeText(parsed.sizeBytes, parsed.sizeCap)}
          </KvRow>
          <AgentUriRow value={parsed.agentURI} />
        </>
      ) : null}
      {passed ? <p className="pill ok">{PASS_LINE}</p> : null}
      <RegisterAlerts
        errorKind={errorKind}
        errorDetail={errorDetail}
        notice={notice}
        noticeDetail={noticeDetail}
        parsed={parsed}
      />
      {connectNotice === "no-wallet" ? <p className="banner info">{INSTALL_WALLET_HINT}</p> : null}
      {connectNotice === "already-pending" ? <p className="banner info">{ALREADY_PENDING}</p> : null}
      {connectNotice === "rejected" ? <p className="banner info">{CONNECT_REJECTED}</p> : null}
      {connectNotice === "failed" ? <p className="banner info">{COULD_NOT_CONNECT}</p> : null}
      {connectPending ? <p className="muted">{OPEN_WALLET_CONNECT}</p> : null}
      {connectPending ? <p className="muted">{WALLET_HINT_TEXT}</p> : null}
      <StepActions showBack onBack={onBack}>
        {walletConnected ? (
          <button type="button" disabled={!passed || connectPending} onClick={onContinue}>
            {connectPending ? CONNECTING : CONTINUE}
          </button>
        ) : (
          <button type="button" disabled={connectPending} onClick={onConnect}>
            {connectPending ? WAITING_WALLET : CONNECT_WALLET}
          </button>
        )}
      </StepActions>
    </div>
  )
}

function AgentUriRow({ value }: { value: string }) {
  const [open, setOpen] = useState(false)
  const shown = value === "" ? URI_EMPTY : value
  const long = shown.length > URI_PREVIEW
  const text = !long || open ? shown : `${shown.slice(0, URI_PREVIEW)}...`
  return (
    <KvRow label={LABEL_AGENT_URI}>
      <span className="register-uri" title={shown} data-testid="agent-uri">
        {text}
      </span>
      {long ? (
        <button type="button" className="secondary" onClick={() => setOpen((current) => !current)}>
          {open ? COLLAPSE : EXPAND}
        </button>
      ) : null}
    </KvRow>
  )
}
