import { WALLET_HINT_TEXT } from "../actionButton"
import {
  ACK_CHECKBOX,
  CONFIRM_IN_WALLET,
  CONFIRM_TITLE,
  CONFIRM_TX_LINE,
  HUNG_PROMPT,
  LABEL_FROM,
  LABEL_GAS,
  LABEL_NAME,
  LABEL_NETWORK,
  LABEL_REGISTRY,
  NAME_EMPTY,
  NETWORK_VALUE,
  REGISTRY_ADDRESS,
  REGISTRY_BASESCAN_URL,
  VALUES_CHANGED,
  VIEW_ON_BASESCAN,
  WAITING_WALLET,
  gasText,
} from "../registerCopy"
import { KvRow, ProvisionalRow, RegisterAlerts, StepActions } from "./rows"
import { shortHex } from "./shortHex"
import type { ParsedRegistration, RegisterErrorCode, RegisterUiNotice, WizardGas } from "./types"

export function ConfirmStep({
  parsed,
  from,
  provisionalId,
  gas,
  acknowledged,
  walletPending,
  promptSlow,
  valuesChanged,
  errorKind,
  errorDetail,
  notice,
  noticeDetail,
  onAcknowledge,
  onConfirm,
  onBack,
}: {
  parsed: ParsedRegistration | null
  from: string | null
  provisionalId: string | null
  gas: WizardGas | null
  acknowledged: boolean
  walletPending: boolean
  promptSlow: boolean
  valuesChanged: boolean
  errorKind: RegisterErrorCode | null
  errorDetail: string | null
  notice: RegisterUiNotice | null
  noticeDetail: string | null
  onAcknowledge: (checked: boolean) => void
  onConfirm: () => void
  onBack: () => void
}) {
  const blocked =
    !acknowledged ||
    walletPending ||
    errorKind === "InsufficientFunds" ||
    errorKind === "WrongChain" ||
    notice === "chain-left"
  return (
    <div data-testid="step-confirm">
      <h3>{CONFIRM_TITLE}</h3>
      <KvRow label={LABEL_NETWORK}>{NETWORK_VALUE}</KvRow>
      <KvRow label={LABEL_REGISTRY}>
        <span className="mono register-hex" title={REGISTRY_ADDRESS}>
          {shortHex(REGISTRY_ADDRESS)}
        </span>
        <a href={REGISTRY_BASESCAN_URL} target="_blank" rel="noreferrer">
          {VIEW_ON_BASESCAN}
        </a>
      </KvRow>
      {from ? (
        <KvRow label={LABEL_FROM}>
          <span className="mono register-hex" title={from}>
            {shortHex(from)}
          </span>
        </KvRow>
      ) : null}
      {parsed ? <KvRow label={LABEL_NAME}>{parsed.name === "" ? NAME_EMPTY : parsed.name}</KvRow> : null}
      {provisionalId ? <ProvisionalRow id={provisionalId} /> : null}
      {gas ? <KvRow label={LABEL_GAS}>{gasText(gas.units, gas.estCostTestEth)}</KvRow> : null}
      {valuesChanged ? <p className="banner info">{VALUES_CHANGED}</p> : null}
      <RegisterAlerts
        errorKind={errorKind}
        errorDetail={errorDetail}
        notice={notice}
        noticeDetail={noticeDetail}
        parsed={parsed}
      />
      <label className="register-ack">
        <input
          type="checkbox"
          checked={acknowledged}
          data-testid="register-ack"
          onChange={(event) => onAcknowledge(event.target.checked)}
        />
        <span>{ACK_CHECKBOX}</span>
      </label>
      {walletPending ? <p className="muted">{CONFIRM_TX_LINE}</p> : null}
      {walletPending ? <p className="muted">{WALLET_HINT_TEXT}</p> : null}
      {walletPending && promptSlow ? <p className="banner info">{HUNG_PROMPT}</p> : null}
      <StepActions showBack={!walletPending} onBack={onBack}>
        <button type="button" disabled={blocked} onClick={onConfirm}>
          {walletPending ? WAITING_WALLET : CONFIRM_IN_WALLET}
        </button>
      </StepActions>
    </div>
  )
}
