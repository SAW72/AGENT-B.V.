import { useState } from "react"
import { CheckStep } from "./register/CheckStep"
import { ConfirmStep } from "./register/ConfirmStep"
import { DoneStep } from "./register/DoneStep"
import { DryRunStep } from "./register/DryRunStep"
import { FileStep } from "./register/FileStep"
import { NetworkPill } from "./register/NetworkPill"
import { previewRegistration } from "./register/previewFile"
import { createStubController, STUB_CONTROLLER } from "./register/stub"
import type { FileTab, ParsedRegistration, RegisterErrorCode, WizardController, WizardStep } from "./register/types"
import { WizardStepper } from "./register/WizardStepper"
import { CARD_LINE, CARD_TITLE, OPEN_WIZARD } from "./registerCopy"

export type { WizardController } from "./register/types"
export { createStubController, STUB_CONTROLLER }

interface LocalState {
  expanded: boolean
  step: WizardStep
  fileTab: FileTab
  pasteText: string
  fileName: string | null
  fileText: string
  acknowledged: boolean
  parsed: ParsedRegistration | null
  errorKind: RegisterErrorCode | null
  errorDetail: string | null
}

const initialLocal: LocalState = {
  expanded: false,
  step: 1,
  fileTab: "upload",
  pasteText: "",
  fileName: null,
  fileText: "",
  acknowledged: false,
  parsed: null,
  errorKind: null,
  errorDetail: null,
}

function localController(state: LocalState, setLocal: (update: (current: LocalState) => LocalState) => void): WizardController {
  const inert = createStubController({
    expanded: state.expanded,
    step: state.step,
    parsed: state.parsed,
    errorKind: state.errorKind,
    errorDetail: state.errorDetail,
    fileTab: state.fileTab,
    pasteText: state.pasteText,
    fileName: state.fileName,
    acknowledged: state.acknowledged,
  })
  return {
    ...inert,
    onExpand: () => setLocal((current) => ({ ...current, expanded: true })),
    onSelectTab: (tab) => setLocal((current) => ({ ...current, fileTab: tab })),
    onPaste: (text) => setLocal((current) => ({ ...current, pasteText: text })),
    onAcknowledge: (checked) => setLocal((current) => ({ ...current, acknowledged: checked })),
    onFile: (file) => {
      setLocal((current) => ({ ...current, fileName: file.name }))
      void file.text().then((text) => {
        setLocal((current) => (current.fileName === file.name ? { ...current, fileText: text } : current))
      })
    },
    onCheck: () => {
      setLocal((current) => {
        const source = current.fileTab === "paste" ? current.pasteText : current.fileText
        const preview = previewRegistration(source, null)
        return {
          ...current,
          step: 2,
          parsed: preview.parsed,
          errorKind: preview.errorKind,
          errorDetail: preview.errorDetail,
        }
      })
    },
    onBack: () => {
      setLocal((current) => ({
        ...current,
        step: current.step > 1 ? ((current.step - 1) as WizardStep) : current.step,
      }))
    },
    onStartOver: () => setLocal(() => ({ ...initialLocal, expanded: true })),
  }
}

export function RegisterWizard({
  onRegistered,
  controller,
}: {
  onRegistered: (agentId: string) => void
  controller?: WizardController
}) {
  const [local, setLocal] = useState<LocalState>(initialLocal)
  const [closed, setClosed] = useState(false)
  const view = controller ?? localController(local, setLocal)
  const expanded = !closed && view.expanded

  function open() {
    setClosed(false)
    view.onExpand()
  }

  function continueIdentity() {
    const id = view.finalId
    if (id == null || id === "") return
    view.onContinueToIdentity()
    onRegistered(id)
    setClosed(true)
    if (controller == null) setLocal(initialLocal)
  }

  return (
    <section className="card register-wizard" aria-labelledby="register-heading" data-testid="register-wizard">
      <h2 id="register-heading">{CARD_TITLE}</h2>
      {expanded ? (
        <>
          <NetworkPill />
          <WizardStepper step={view.step} />
          {view.step === 1 ? (
            <FileStep
              tab={view.fileTab}
              pasteText={view.pasteText}
              fileName={view.fileName}
              onSelectTab={view.onSelectTab}
              onPaste={view.onPaste}
              onFile={view.onFile}
              onCheck={view.onCheck}
            />
          ) : null}
          {view.step === 2 ? (
            <CheckStep
              parsed={view.parsed}
              errorKind={view.errorKind}
              errorDetail={view.errorDetail}
              notice={view.notice}
              noticeDetail={view.noticeDetail}
              walletConnected={view.walletConnected}
              connectPending={view.connectPending}
              connectNotice={view.connectNotice}
              onContinue={view.onDryRun}
              onConnect={view.onConnect}
              onBack={view.onBack}
            />
          ) : null}
          {view.step === 3 ? (
            <DryRunStep
              from={view.from}
              provisionalId={view.provisionalId}
              gas={view.gas}
              existingCount={view.existingCount}
              parsed={view.parsed}
              errorKind={view.errorKind}
              errorDetail={view.errorDetail}
              notice={view.notice}
              noticeDetail={view.noticeDetail}
              dryRunPending={view.dryRunPending}
              chainName={view.chainName}
              switchNotice={view.switchNotice}
              onReview={view.onDryRun}
              onBack={view.onBack}
              onSwitchChain={view.onSwitchChain}
              onRecheck={view.onDryRun}
            />
          ) : null}
          {view.step === 4 ? (
            <ConfirmStep
              parsed={view.parsed}
              from={view.from}
              provisionalId={view.provisionalId}
              gas={view.gas}
              acknowledged={view.acknowledged}
              walletPending={view.walletPending}
              promptSlow={view.promptSlow}
              valuesChanged={view.valuesChanged}
              errorKind={view.errorKind}
              errorDetail={view.errorDetail}
              notice={view.notice}
              noticeDetail={view.noticeDetail}
              onAcknowledge={view.onAcknowledge}
              onConfirm={view.onConfirm}
              onBack={view.onBack}
            />
          ) : null}
          {view.step === 5 ? (
            <DoneStep
              txStatus={view.txStatus}
              txHash={view.txHash}
              finalId={view.finalId}
              globalId={view.globalId}
              owner={view.owner}
              errorKind={view.errorKind}
              errorDetail={view.errorDetail}
              notice={view.notice}
              noticeDetail={view.noticeDetail}
              pendingSlow={view.pendingSlow}
              walletDisconnected={view.walletDisconnected}
              showOwnerSwitch={view.showOwnerSwitch}
              spedUp={view.spedUp}
              resuming={view.resuming}
              onStartOver={view.onStartOver}
              onContinue={continueIdentity}
            />
          ) : null}
        </>
      ) : (
        <>
          <p className="muted" data-testid="register-card-line">
            {CARD_LINE}
          </p>
          <button type="button" onClick={open}>
            {OPEN_WIZARD}
          </button>
        </>
      )}
    </section>
  )
}
