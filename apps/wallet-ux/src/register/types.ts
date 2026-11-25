/**
 * Builder RegisterError.code values (Rev 3).
 * UI-only states (account changed, chain left before send, send failed, reverted)
 * are RegisterUiNotice, not members of this union.
 */
export const REGISTER_ERROR_CODES = [
  "InvalidJson",
  "WrongType",
  "TooLarge",
  "BadUri",
  "WrongChain",
  "DryRunReverted",
  "NoRegisteredEvent",
  "UserRejected",
  "InsufficientFunds",
  "Replaced",
  "Cancelled",
  "Unknown",
] as const

export type RegisterErrorCode = (typeof REGISTER_ERROR_CODES)[number]

/** Not a Builder error code. The controller sets one of these and returns to the right step. */
export type RegisterUiNotice = "chain-left" | "account-changed" | "send-failed" | "reverted"

export type WizardStep = 1 | 2 | 3 | 4 | 5

export type TxStatus = "pending" | "confirmed" | "reverted" | "replaced" | "noEvent" | "cancelled"

export type FileTab = "upload" | "paste"

export type ConnectNotice = null | "no-wallet" | "already-pending" | "rejected" | "failed"

export type SwitchNotice = null | "switching" | "rejected" | "unavailable"

export interface ParsedRegistration {
  type: string
  name: string
  sizeBytes: number
  /** Passed in by the controller. Null until Builder supplies the cap. */
  sizeCap: number | null
  agentURI: string
}

export interface WizardGas {
  units: string
  estCostTestEth: string
}

export interface WizardController {
  expanded: boolean
  step: WizardStep
  parsed: ParsedRegistration | null
  from: string | null
  provisionalId: string | null
  gas: WizardGas | null
  /** Count from findExistingAgent. Null when unknown. No agent id is included. */
  existingCount: bigint | null
  errorKind: RegisterErrorCode | null
  errorDetail: string | null
  notice: RegisterUiNotice | null
  noticeDetail: string | null
  walletPending: boolean
  valuesChanged: boolean
  txHash: string | null
  txStatus: TxStatus | null
  finalId: string | null
  /** eip155:84532:<registry>:<n>. Display only. Prefill stays the decimal finalId. */
  globalId: string | null
  owner: string | null
  fileTab: FileTab
  pasteText: string
  fileName: string | null
  acknowledged: boolean
  dryRunPending: boolean
  walletConnected: boolean
  connectPending: boolean
  connectNotice: ConnectNotice
  chainName: string | null
  switchNotice: SwitchNotice
  pendingSlow: boolean
  promptSlow: boolean
  walletDisconnected: boolean
  showOwnerSwitch: boolean
  spedUp: boolean
  resuming: boolean
  onFile: (file: File) => void
  onCheck: () => void
  onDryRun: () => void
  onConfirm: () => void
  onBack: () => void
  onStartOver: () => void
  onContinueToIdentity: () => void
  onExpand: () => void
  onAcknowledge: (checked: boolean) => void
  onSelectTab: (tab: FileTab) => void
  onPaste: (text: string) => void
  onConnect: () => void
  onSwitchChain: () => void
}
