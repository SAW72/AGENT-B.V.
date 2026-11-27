import type { WizardController } from "./types"

function noop(): void {
  /* The stub makes no wallet call and no network call. */
}

function noopFile(file: File): void {
  void file
}

function noopChecked(checked: boolean): void {
  void checked
}

function noopTab(tab: WizardController["fileTab"]): void {
  void tab
}

function noopText(text: string): void {
  void text
}

/** Inert controller. Every callback is a no-op. No wallet and no network. */
export function createStubController(overrides: Partial<WizardController> = {}): WizardController {
  const base: WizardController = {
    expanded: false,
    step: 1,
    parsed: null,
    from: null,
    provisionalId: null,
    gas: null,
    existingCount: null,
    errorKind: null,
    errorDetail: null,
    notice: null,
    noticeDetail: null,
    walletPending: false,
    valuesChanged: false,
    txHash: null,
    txStatus: null,
    finalId: null,
    globalId: null,
    owner: null,
    fileTab: "upload",
    pasteText: "",
    fileName: null,
    acknowledged: false,
    dryRunPending: false,
    walletConnected: false,
    connectPending: false,
    connectNotice: null,
    chainName: null,
    switchNotice: null,
    pendingSlow: false,
    promptSlow: false,
    walletDisconnected: false,
    showOwnerSwitch: false,
    spedUp: false,
    resuming: false,
    onFile: noopFile,
    onCheck: noop,
    onDryRun: noop,
    onConfirm: noop,
    onBack: noop,
    onStartOver: noop,
    onContinueToIdentity: noop,
    onExpand: noop,
    onAcknowledge: noopChecked,
    onSelectTab: noopTab,
    onPaste: noopText,
    onConnect: noop,
    onSwitchChain: noop,
  }
  return { ...base, ...overrides }
}

export const STUB_CONTROLLER: WizardController = Object.freeze(createStubController())
