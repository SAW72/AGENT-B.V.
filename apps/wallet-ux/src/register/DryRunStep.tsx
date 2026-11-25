import {
  CHECK_AGAIN,
  CONFIRM_SWITCH,
  CANT_SWITCH,
  DRY_RUN_RUNNING,
  LABEL_FROM,
  LABEL_GAS,
  NOT_THIS_WALLET,
  REVIEW_AND_CONFIRM,
  SWITCH_TO_SEPOLIA,
  WRONG_CHAIN,
  alreadyOwns,
  gasText,
  stayedOn,
  walletOnChain,
} from "../registerCopy"
import { CopyTextButton, KvRow, ProvisionalRow, RegisterAlerts, StepActions } from "./rows"
import { shortHex } from "./shortHex"
import type {
  ParsedRegistration,
  RegisterErrorCode,
  RegisterUiNotice,
  SwitchNotice,
  WizardGas,
} from "./types"

export function DryRunStep({
  from,
  provisionalId,
  gas,
  existingCount,
  parsed,
  errorKind,
  errorDetail,
  notice,
  noticeDetail,
  dryRunPending,
  chainName,
  switchNotice,
  onReview,
  onBack,
  onSwitchChain,
  onRecheck,
}: {
  from: string | null
  provisionalId: string | null
  gas: WizardGas | null
  existingCount: bigint | null
  parsed: ParsedRegistration | null
  errorKind: RegisterErrorCode | null
  errorDetail: string | null
  notice: RegisterUiNotice | null
  noticeDetail: string | null
  dryRunPending: boolean
  chainName: string | null
  switchNotice: SwitchNotice
  onReview: () => void
  onBack: () => void
  onSwitchChain: () => void
  onRecheck: () => void
}) {
  const chainBlocked = chainName != null || errorKind === "WrongChain" || notice === "chain-left"
  const blocked =
    dryRunPending ||
    chainBlocked ||
    switchNotice != null ||
    errorKind === "DryRunReverted" ||
    errorKind === "InsufficientFunds" ||
    notice === "account-changed" ||
    provisionalId == null ||
    provisionalId === ""
  const hideChainError = notice === "chain-left"
  return (
    <div data-testid="step-dry-run">
      {dryRunPending ? <p className="banner info">{DRY_RUN_RUNNING}</p> : null}
      {from ? (
        <>
          <KvRow label={LABEL_FROM} testId="dry-run-from">
            <span className="mono register-hex" title={from}>
              {shortHex(from)}
            </span>
            <CopyTextButton value={from} testId="copy-from" />
          </KvRow>
          <p className="muted">{NOT_THIS_WALLET}</p>
        </>
      ) : null}
      {provisionalId ? <ProvisionalRow id={provisionalId} /> : null}
      {gas ? (
        <KvRow label={LABEL_GAS} testId="gas-row">
          {gasText(gas.units, gas.estCostTestEth)}
        </KvRow>
      ) : null}
      {existingCount != null && existingCount > 0n ? (
        <div className="callout" role="status" data-testid="duplicate-warning">
          <p>{alreadyOwns(existingCount)}</p>
        </div>
      ) : null}
      {chainName ? (
        <>
          <p className="banner info">{walletOnChain(chainName)}</p>
          {switchNotice === "switching" ? <p className="banner info">{CONFIRM_SWITCH}</p> : null}
          {switchNotice === "rejected" ? <p className="banner info">{stayedOn(chainName)}</p> : null}
          {switchNotice === "unavailable" ? <p className="banner info">{CANT_SWITCH}</p> : null}
          <button type="button" onClick={onSwitchChain}>
            {SWITCH_TO_SEPOLIA}
          </button>
        </>
      ) : null}
      {!chainName && errorKind === "WrongChain" && !hideChainError ? <p className="banner info">{WRONG_CHAIN}</p> : null}
      <RegisterAlerts
        errorKind={errorKind === "WrongChain" ? null : errorKind}
        errorDetail={errorDetail}
        notice={notice}
        noticeDetail={noticeDetail}
        parsed={parsed}
      />
      <StepActions showBack onBack={onBack}>
        <button type="button" disabled={blocked} onClick={onReview}>
          {REVIEW_AND_CONFIRM}
        </button>
      </StepActions>
      {errorKind === "InsufficientFunds" ? (
        <button type="button" className="secondary" onClick={onRecheck}>
          {CHECK_AGAIN}
        </button>
      ) : null}
    </div>
  )
}
