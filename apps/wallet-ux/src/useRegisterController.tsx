import { useEffect, useRef, useState, type ReactNode } from "react"
import { formatEther, getAddress, isAddress, isAddressEqual, keccak256, toBytes, type Address, type Hex } from "viem"
import { useConnect } from "wagmi"
import { WALLET_HINT_MS } from "./actionButton"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import type { CallPreview } from "./preview"
import {
  Cancelled,
  NoRegisteredEvent,
  RegisterError,
  Replaced,
  Unknown,
  UserRejected,
  WrongType,
  baseSepoliaAddChainParams,
  buildRegisterWrite,
  checkBalanceForGas,
  dryRunRegister,
  findExistingAgent,
  formatAgentId,
  normalizeWalletError,
  registryAddress,
  REGISTRATION_MAX_BYTES,
  validateRegistration,
  waitForRegisterReceipt,
  type BalanceClient,
  type DryRunClient,
  type FeeReader,
  type ReceiptClient,
} from "./registry/register"
import { shortHex } from "./register/shortHex"
import type {
  ConnectNotice,
  FileTab,
  ParsedRegistration,
  RegisterErrorCode,
  RegisterUiNotice,
  SwitchNotice,
  TxStatus,
  WizardController,
  WizardGas,
  WizardStep,
} from "./register/types"
import { insufficientGas, isRegisterErrorCode, ownsAfterReplacement } from "./registerCopy"
import { createSepoliaClient, rpcUrlFromEnv } from "./read"
import { WalletOnlySubmit, type WalletSubmitHandle } from "./WalletOnlySubmit"

/**
 * Live register wizard.
 * Presentational files under register/ stay free of wallet clients.
 * The only send is WalletOnlySubmit. This hook prepares the call and tracks the receipt
 * on a read-only Base Sepolia client.
 *
 * viem onReplaced reports a replacement only after the original transaction has been seen
 * once. A replacement before that first sighting stays on the still-waiting path.
 */

export const REGISTER_PENDING_KEY = "abv.register.pending"
export const REGISTER_PENDING_SLOW_MS = 120_000

const RETRY_MS = 250

export type RegisterReader = DryRunClient &
  BalanceClient &
  FeeReader &
  ReceiptClient & {
    getTransactionReceipt?: (args: { hash: Hex }) => Promise<{ status?: string | number }>
    call?: (args: { account?: Address; to: Address; data: Hex; value?: bigint }) => Promise<unknown>
  }

type Phase = "form" | "prompt" | "sent"

type StoredPending = {
  chainId: number
  from: Address
  hash: Hex
  uriHash: Hex
  startedAt: number
  existingCount: string | null
}

type Fields = {
  expanded: boolean
  step: WizardStep
  parsed: ParsedRegistration | null
  from: string | null
  provisionalId: string | null
  gas: WizardGas | null
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
  globalId: string | null
  owner: string | null
  fileTab: FileTab
  pasteText: string
  fileName: string | null
  fileText: string
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
}

type EipProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  on?: (event: string, listener: (payload: unknown) => void) => void
  removeListener?: (event: string, listener: (payload: unknown) => void) => void
}

const PLACEHOLDER: CallPreview = {
  to: registryAddress(),
  functionName: "register",
  calldata: "0x",
  valueWei: 0n,
}

const ALLOWED = [registryAddress()] as const

function blankFields(): Fields {
  return {
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
    fileText: "",
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
  }
}

function fieldsFrom(stored: StoredPending | null): Fields {
  const fields = blankFields()
  if (!stored) return fields
  return {
    ...fields,
    expanded: true,
    step: 5,
    from: stored.from,
    txHash: stored.hash,
    txStatus: "pending",
    resuming: true,
    pendingSlow: Date.now() - stored.startedAt >= REGISTER_PENDING_SLOW_MS,
  }
}

function provider(): EipProvider | null {
  if (typeof window === "undefined") return null
  const eth = (window as Window & { ethereum?: EipProvider }).ethereum
  if (!eth || typeof eth.request !== "function") return null
  return eth
}

function numericCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value)
  return null
}

function codesOf(error: unknown): number[] {
  const codes: number[] = []
  const seen = new Set<unknown>()
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object" || seen.has(node)) return
    seen.add(node)
    const record = node as { code?: unknown; cause?: unknown; error?: unknown }
    const code = numericCode(record.code)
    if (code != null) codes.push(code)
    walk(record.cause)
    walk(record.error)
  }
  walk(error)
  return codes
}

function hasCode(error: unknown, code: number): boolean {
  return codesOf(error).includes(code)
}

function parseChainId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || value.trim() === "") return null
  const parsed = value.trim().startsWith("0x") || value.trim().startsWith("0X") ? Number.parseInt(value, 16) : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function chainLabel(id: number | null): string | null {
  if (id == null || id === BASE_SEPOLIA_CHAIN_ID) return null
  return `chain ${id}`
}

function ethText(wei: bigint): string {
  return `${formatEther(wei)} test ETH`
}

function parseCount(value: string | null | undefined): bigint | null {
  if (value == null || !/^\d+$/.test(value)) return null
  return BigInt(value)
}

function typeDetail(source: string): string | null {
  try {
    const value: unknown = JSON.parse(source)
    if (!value || typeof value !== "object" || Array.isArray(value) || !("type" in value)) return null
    const type = (value as { type?: unknown }).type
    return typeof type === "string" ? type : null
  } catch {
    return null
  }
}

function readStored(): StoredPending | null {
  if (typeof sessionStorage === "undefined") return null
  try {
    const raw = sessionStorage.getItem(REGISTER_PENDING_KEY)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object") return null
    const record = value as Partial<StoredPending>
    if (record.chainId !== BASE_SEPOLIA_CHAIN_ID) return null
    if (typeof record.hash !== "string" || !record.hash.startsWith("0x")) return null
    if (typeof record.from !== "string" || !isAddress(record.from)) return null
    if (typeof record.uriHash !== "string" || !record.uriHash.startsWith("0x")) return null
    return {
      chainId: BASE_SEPOLIA_CHAIN_ID,
      from: getAddress(record.from),
      hash: record.hash as Hex,
      uriHash: record.uriHash as Hex,
      startedAt: typeof record.startedAt === "number" ? record.startedAt : Date.now(),
      existingCount: typeof record.existingCount === "string" ? record.existingCount : null,
    }
  } catch {
    return null
  }
}

function writeStored(record: StoredPending) {
  if (typeof sessionStorage === "undefined") return
  sessionStorage.setItem(REGISTER_PENDING_KEY, JSON.stringify(record))
}

function clearStored() {
  if (typeof sessionStorage === "undefined") return
  sessionStorage.removeItem(REGISTER_PENDING_KEY)
}

function errorCode(error: unknown): RegisterErrorCode {
  if (error instanceof RegisterError && isRegisterErrorCode(error.code)) return error.code
  const normalized = normalizeWalletError(error)
  return isRegisterErrorCode(normalized.code) ? normalized.code : "Unknown"
}

function rejected(error: unknown): boolean {
  return hasCode(error, 4001) || normalizeWalletError(error) instanceof UserRejected
}

function quoteCleared(): Pick<Fields, "provisionalId" | "gas" | "existingCount" | "valuesChanged"> {
  return { provisionalId: null, gas: null, existingCount: null, valuesChanged: false }
}

function ownerMismatch(connected: Address | null, owner: string | null): boolean {
  if (owner == null || !isAddress(owner)) return false
  if (connected == null) return true
  return !isAddressEqual(connected, getAddress(owner))
}

function pause(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

export function useRegisterController(options?: { reader?: RegisterReader }): {
  controller: WizardController
  send: ReactNode
} {
  const readerRef = useRef<RegisterReader | null>(options?.reader ?? null)
  if (options?.reader) readerRef.current = options.reader
  if (!readerRef.current) {
    readerRef.current = createSepoliaClient(rpcUrlFromEnv(import.meta.env.VITE_BASE_SEPOLIA_RPC_URL)) as unknown as RegisterReader
  }
  const reader = readerRef.current

  const { connectAsync, connectors } = useConnect()
  const [fields, setFields] = useState<Fields>(() => fieldsFrom(readStored()))
  const [followNonce, setFollowNonce] = useState(() => (readStored() ? 1 : 0))
  const stateRef = useRef(fields)
  const mountedRef = useRef(true)
  const phaseRef = useRef<Phase>("form")
  const booted = useRef(false)
  const fromRef = useRef<Address | null>(null)
  const senderRef = useRef<Address | null>(null)
  const connectedRef = useRef<Address | null>(null)
  const chainRef = useRef<number | null>(null)
  const preSendCountRef = useRef<bigint | null>(null)
  const sendLock = useRef(false)
  const connectLock = useRef(false)
  const connectBlock = useRef(false)
  const switchLock = useRef(false)
  const startLock = useRef(false)
  const warnedRef = useRef(false)
  const dryGen = useRef(0)
  const confirmGen = useRef(0)
  const generationRef = useRef(0)
  const readGen = useRef(0)
  const promptTimer = useRef(0)
  const livePreviewRef = useRef<CallPreview | null>(null)
  const submitRef = useRef<WalletSubmitHandle | null>(null)
  const fromAddressRef = useRef<Address | null>(null)
  const onAccountsRef = useRef<(payload: unknown) => void>(() => {})
  const onChainRef = useRef<(payload: unknown) => void>(() => {})

  if (!booted.current) {
    booted.current = true
    const stored = readStored()
    if (stored) {
      phaseRef.current = "sent"
      fromRef.current = stored.from
      senderRef.current = stored.from
      preSendCountRef.current = parseCount(stored.existingCount)
      stateRef.current = fieldsFrom(stored)
    }
  }

  function patch(partial: Partial<Fields>) {
    const next = { ...stateRef.current, ...partial }
    stateRef.current = next
    if (mountedRef.current) setFields(next)
  }

  async function fetchAccounts(): Promise<Address | null> {
    const eth = provider()
    if (!eth) return null
    try {
      const value = await eth.request({ method: "eth_accounts" })
      const first = Array.isArray(value) ? value.find((item) => typeof item === "string") : null
      if (typeof first === "string" && isAddress(first)) return getAddress(first)
      return null
    } catch {
      return null
    }
  }

  async function fetchChain(): Promise<number | null> {
    const eth = provider()
    if (!eth) return chainRef.current
    try {
      return parseChainId(await eth.request({ method: "eth_chainId" }))
    } catch {
      return chainRef.current
    }
  }

  async function displayCost(gas: bigint): Promise<string> {
    let fee: bigint | null = null
    if (reader.estimateFeesPerGas) {
      try {
        const quoted = await reader.estimateFeesPerGas()
        if (quoted && typeof quoted.maxFeePerGas === "bigint") fee = quoted.maxFeePerGas
      } catch {
        fee = null
      }
    }
    if (fee == null && reader.getGasPrice) {
      try {
        fee = await reader.getGasPrice()
      } catch {
        fee = null
      }
    }
    if (fee == null) return "0"
    return formatEther(gas * fee)
  }

  function clearPromptTimer() {
    window.clearTimeout(promptTimer.current)
  }

  function armPromptTimer() {
    clearPromptTimer()
    promptTimer.current = window.setTimeout(() => {
      if (phaseRef.current === "prompt") patch({ promptSlow: true })
    }, WALLET_HINT_MS)
  }

  async function runDryRun(advance: boolean) {
    if (phaseRef.current !== "form") return
    const snap = stateRef.current
    if (!snap.parsed || snap.dryRunPending) return
    const intentAdvance =
      advance && snap.step === 3 && snap.errorKind == null && snap.notice == null && snap.provisionalId != null && snap.provisionalId !== ""
    const gen = ++dryGen.current
    patch({ dryRunPending: true, errorKind: null, errorDetail: null })
    const account = await fetchAccounts()
    const chainId = await fetchChain()
    if (gen !== dryGen.current || !mountedRef.current) return
    chainRef.current = chainId
    if (!account) {
      connectedRef.current = null
      fromRef.current = null
      patch({
        step: 2,
        walletConnected: false,
        from: null,
        dryRunPending: false,
        connectPending: false,
      })
      return
    }
    connectedRef.current = account
    fromRef.current = account
    if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
      patch({
        step: 3,
        dryRunPending: false,
        from: account,
        walletConnected: true,
        chainName: chainLabel(chainId),
        switchNotice: null,
        notice: null,
        noticeDetail: null,
        errorKind: null,
        errorDetail: null,
        ...quoteCleared(),
      })
      return
    }
    try {
      const existing = await findExistingAgent(reader as BalanceClient, account)
      const dry = await dryRunRegister(reader as DryRunClient, account, snap.parsed.agentURI)
      const units = dry.gas.toString()
      const estCostTestEth = await displayCost(dry.gas)
      const balance = await checkBalanceForGas(reader as FeeReader, account, dry.gas)
      if (gen !== dryGen.current || !mountedRef.current) return
      if (!balance.ok) {
        patch({
          step: 3,
          dryRunPending: false,
          from: account,
          walletConnected: true,
          chainName: null,
          provisionalId: dry.provisionalId.toString(10),
          gas: { units, estCostTestEth },
          existingCount: existing.count,
          errorKind: "InsufficientFunds",
          errorDetail: insufficientGas(ethText(balance.needed), ethText(balance.balance)),
          notice: null,
          noticeDetail: null,
        })
        return
      }
      let nextStep: WizardStep = snap.step < 3 ? 3 : snap.step
      if (intentAdvance) {
        const again = await fetchChain()
        if (gen !== dryGen.current || !mountedRef.current) return
        if (again !== BASE_SEPOLIA_CHAIN_ID) {
          chainRef.current = again
          patch({
            step: 3,
            dryRunPending: false,
            from: account,
            walletConnected: true,
            chainName: chainLabel(again),
            notice: null,
            ...quoteCleared(),
          })
          return
        }
        nextStep = 4
      }
      const nextId = dry.provisionalId.toString(10)
      patch({
        step: nextStep,
        dryRunPending: false,
        from: account,
        walletConnected: true,
        chainName: null,
        switchNotice: null,
        provisionalId: nextId,
        gas: { units, estCostTestEth },
        existingCount: existing.count,
        errorKind: null,
        errorDetail: null,
        notice: null,
        noticeDetail: null,
        valuesChanged: intentAdvance && snap.provisionalId !== nextId ? true : snap.valuesChanged && !intentAdvance,
      })
    } catch (error) {
      if (gen !== dryGen.current || !mountedRef.current) return
      const code = errorCode(error)
      patch({
        step: 3,
        dryRunPending: false,
        from: account,
        walletConnected: true,
        chainName: null,
        errorKind: code === "WrongChain" ? "WrongChain" : code === "Unknown" ? "Unknown" : "DryRunReverted",
        errorDetail: error instanceof Error ? error.message : null,
        ...quoteCleared(),
      })
    }
  }

  function onAccountsChanged(payload: unknown) {
    const list = Array.isArray(payload) ? payload : []
    const first = list.find((item) => typeof item === "string" && isAddress(item))
    const next = typeof first === "string" ? getAddress(first) : null
    const prev = connectedRef.current
    if (next && prev && isAddressEqual(next, prev)) return
    connectedRef.current = next
    if (phaseRef.current === "sent") {
      patch({
        walletConnected: next != null,
        walletDisconnected: next == null,
        showOwnerSwitch: ownerMismatch(next, stateRef.current.owner),
      })
      return
    }
    if (phaseRef.current === "prompt") return
    dryGen.current += 1
    confirmGen.current += 1
    sendLock.current = false
    clearPromptTimer()
    if (!next) {
      fromRef.current = null
      patch({
        step: stateRef.current.step >= 2 ? 2 : stateRef.current.step,
        walletConnected: false,
        from: null,
        connectPending: false,
        connectNotice: null,
        walletPending: false,
        promptSlow: false,
        dryRunPending: false,
        ...quoteCleared(),
      })
      return
    }
    fromRef.current = next
    connectBlock.current = false
    if (prev && stateRef.current.step >= 3) {
      patch({
        step: 3,
        from: next,
        walletConnected: true,
        notice: "account-changed",
        noticeDetail: shortHex(next),
        errorKind: null,
        errorDetail: null,
        connectPending: false,
        connectNotice: null,
        walletPending: false,
        promptSlow: false,
        dryRunPending: false,
        switchNotice: null,
        ...quoteCleared(),
      })
      return
    }
    patch({
      from: stateRef.current.step >= 3 ? next : (stateRef.current.from ?? next),
      walletConnected: true,
      connectPending: false,
      connectNotice: null,
    })
  }

  function onChainChanged(payload: unknown) {
    const id = parseChainId(payload)
    chainRef.current = id
    if (phaseRef.current === "sent" || phaseRef.current === "prompt") return
    if (stateRef.current.step < 3) return
    dryGen.current += 1
    confirmGen.current += 1
    sendLock.current = false
    clearPromptTimer()
    patch({
      step: 3,
      notice: "chain-left",
      noticeDetail: null,
      chainName: chainLabel(id),
      errorKind: null,
      errorDetail: null,
      switchNotice: null,
      walletPending: false,
      promptSlow: false,
      dryRunPending: false,
      ...quoteCleared(),
    })
  }

  onAccountsRef.current = onAccountsChanged
  onChainRef.current = onChainChanged

  useEffect(() => {
    mountedRef.current = true
    const onAccounts = (payload: unknown) => onAccountsRef.current(payload)
    const onChain = (payload: unknown) => onChainRef.current(payload)
    const eth = provider()
    eth?.on?.("accountsChanged", onAccounts)
    eth?.on?.("chainChanged", onChain)
    const gen = ++readGen.current
    void (async () => {
      const account = await fetchAccounts()
      const chainId = await fetchChain()
      if (!mountedRef.current || gen !== readGen.current) return
      chainRef.current = chainId
      if (phaseRef.current === "sent") {
        if (account) connectedRef.current = account
        patch({
          walletConnected: account != null,
          walletDisconnected: account == null,
          showOwnerSwitch: ownerMismatch(account, stateRef.current.owner),
        })
        return
      }
      if (!account) return
      connectedRef.current = account
      fromRef.current = account
      connectBlock.current = false
      patch({
        walletConnected: true,
        from: stateRef.current.from ?? account,
        connectPending: false,
        connectNotice: null,
      })
    })()
    return () => {
      mountedRef.current = false
      eth?.removeListener?.("accountsChanged", onAccounts)
      eth?.removeListener?.("chainChanged", onChain)
      window.clearTimeout(promptTimer.current)
    }
    // Subscription is once per mount. Handlers read the latest refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (phaseRef.current !== "sent") return
    const hash = stateRef.current.txHash
    if (!hash || !hash.startsWith("0x")) return
    const generation = ++generationRef.current
    let stopped = false
    const startedAt = readStored()?.startedAt ?? Date.now()
    const slowTimer = window.setTimeout(() => {
      if (!stopped && generation === generationRef.current) patch({ pendingSlow: true })
    }, Math.max(0, REGISTER_PENDING_SLOW_MS - (Date.now() - startedAt)))

    void track(hash as Hex, generation)

    return () => {
      stopped = true
      window.clearTimeout(slowTimer)
      if (generationRef.current === generation) generationRef.current += 1
    }

    async function track(currentHash: Hex, generation: number) {
      let current = currentHash
      while (generation === generationRef.current && mountedRef.current) {
        try {
          const result = await waitForRegisterReceipt(reader as ReceiptClient, current, (status) => {
            if (generation !== generationRef.current) return
            if (status.phase === "repriced") {
              current = status.hash
              const stored = readStored()
              if (stored) writeStored({ ...stored, hash: status.hash })
              patch({ txHash: status.hash, spedUp: true })
              return
            }
            if (status.phase === "timeout") patch({ pendingSlow: true })
          })
          if (generation !== generationRef.current || !mountedRef.current) return
          const owner = result.owner
          clearStored()
          patch({
            txStatus: "confirmed",
            txHash: result.hash,
            finalId: result.agentId.toString(10),
            globalId: formatAgentId(BASE_SEPOLIA_CHAIN_ID, registryAddress(), result.agentId),
            owner,
            showOwnerSwitch: ownerMismatch(connectedRef.current, owner),
            pendingSlow: false,
            resuming: false,
            spedUp: stateRef.current.spedUp,
            errorKind: null,
            errorDetail: null,
            notice: null,
            walletDisconnected: connectedRef.current == null && stateRef.current.walletDisconnected,
          })
          return
        } catch (error) {
          if (generation !== generationRef.current || !mountedRef.current) return
          if (error instanceof Cancelled) {
            clearStored()
            patch({ txStatus: "cancelled", errorKind: "Cancelled", errorDetail: null, pendingSlow: false, resuming: false })
            return
          }
          if (error instanceof Replaced) {
            clearStored()
            patch({ txStatus: "replaced", errorKind: "Replaced", errorDetail: null, pendingSlow: false, resuming: false })
            return
          }
          if (error instanceof Unknown && error.message === "The register transaction changed in an unexpected way.") {
            clearStored()
            patch({ txStatus: "dropped", errorKind: null, errorDetail: null, pendingSlow: false, resuming: false })
            return
          }
          if (error instanceof NoRegisteredEvent) {
            let reverted = false
            if (reader.getTransactionReceipt) {
              try {
                const receipt = await reader.getTransactionReceipt({ hash: current })
                reverted = receipt.status === "reverted" || receipt.status === 0
              } catch {
                reverted = false
              }
            }
            clearStored()
            if (reverted) {
              patch({ txStatus: "reverted", notice: "reverted", errorKind: null, pendingSlow: false, resuming: false, finalId: null })
            } else {
              patch({
                txStatus: "noEvent",
                errorKind: "NoRegisteredEvent",
                errorDetail: null,
                finalId: null,
                pendingSlow: false,
                resuming: false,
              })
            }
            return
          }
          if (error instanceof Unknown && /timed out/i.test(error.message)) {
            patch({ pendingSlow: true, txStatus: "pending" })
            await pause(RETRY_MS)
            continue
          }
          await pause(RETRY_MS)
        }
      }
    }
    // followNonce restarts tracking. txHash updates for a speed-up stay on this run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followNonce])

  async function onConnect() {
    if (connectLock.current || connectBlock.current || phaseRef.current === "sent") return
    if (!provider()) {
      patch({ connectNotice: "no-wallet", connectPending: false })
      return
    }
    const connector = connectors[0]
    if (!connector) {
      patch({ connectNotice: "failed", connectPending: false })
      return
    }
    connectLock.current = true
    readGen.current += 1
    patch({ connectPending: true, connectNotice: null })
    try {
      await connectAsync({ connector })
      const account = await fetchAccounts()
      const chainId = await fetchChain()
      if (!mountedRef.current) return
      chainRef.current = chainId
      if (account) {
        connectedRef.current = account
        fromRef.current = account
        connectBlock.current = false
        patch({
          walletConnected: true,
          from: account,
          connectPending: false,
          connectNotice: null,
          chainName: chainLabel(chainId),
        })
      } else {
        patch({ connectPending: false, connectNotice: "failed", walletConnected: false })
      }
    } catch (error) {
      if (!mountedRef.current) return
      if (hasCode(error, -32002)) {
        connectBlock.current = true
        patch({ connectNotice: "already-pending", connectPending: true })
        return
      }
      if (rejected(error)) {
        patch({ connectNotice: "rejected", connectPending: false, walletConnected: false })
        return
      }
      patch({ connectNotice: "failed", connectPending: false })
    } finally {
      connectLock.current = false
    }
  }

  async function onSwitchChain() {
    if (switchLock.current || phaseRef.current !== "form") return
    const eth = provider()
    if (!eth) {
      patch({ switchNotice: "unavailable" })
      return
    }
    switchLock.current = true
    patch({ switchNotice: "switching" })
    const params = [{ chainId: baseSepoliaAddChainParams.chainId }]
    try {
      await switchOrAdd(eth, params)
    } catch (error) {
      if (!mountedRef.current) return
      if (hasCode(error, 4902)) {
        try {
          await eth.request({ method: "wallet_addEthereumChain", params: [baseSepoliaAddChainParams] })
          await switchOrAdd(eth, params)
        } catch (addError) {
          finishSwitchError(addError)
          switchLock.current = false
          return
        }
      } else {
        finishSwitchError(error)
        switchLock.current = false
        return
      }
    }
    switchLock.current = false
    if (!mountedRef.current) return
    const chainId = await fetchChain()
    chainRef.current = chainId
    if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
      patch({ switchNotice: "unavailable", chainName: chainLabel(chainId) })
      return
    }
    patch({ switchNotice: null, chainName: null, notice: null, noticeDetail: null })
    if (stateRef.current.parsed) void runDryRun(false)
  }

  function finishSwitchError(error: unknown) {
    if (rejected(error)) {
      patch({ switchNotice: "rejected" })
      return
    }
    normalizeWalletError(error)
    patch({ switchNotice: "unavailable" })
  }

  function onCheck() {
    const current = stateRef.current
    const source = current.fileTab === "paste" ? current.pasteText : current.fileText
    try {
      const validated = validateRegistration(source)
      patch({
        step: 2,
        parsed: {
          type: validated.type,
          name: validated.name ?? "",
          sizeBytes: validated.size,
          sizeCap: REGISTRATION_MAX_BYTES,
          agentURI: validated.uri,
        },
        errorKind: null,
        errorDetail: null,
        notice: null,
        noticeDetail: null,
      })
    } catch (error) {
      patch({
        step: 2,
        parsed: null,
        errorKind: errorCode(error),
        errorDetail: error instanceof WrongType ? typeDetail(source) : null,
        notice: null,
        noticeDetail: null,
      })
    }
  }

  async function onConfirm() {
    if (sendLock.current || phaseRef.current !== "form") return
    const snap = stateRef.current
    const parsed = snap.parsed
    if (!parsed || !snap.acknowledged) return
    const gen = ++confirmGen.current
    sendLock.current = true
    const previousId = snap.provisionalId
    const previousGas = snap.gas?.units ?? null
    try {
      const chainId = await fetchChain()
      if (gen !== confirmGen.current || !mountedRef.current) return
      chainRef.current = chainId
      if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
        sendLock.current = false
        patch({
          step: 3,
          chainName: chainLabel(chainId),
          walletPending: false,
          notice: null,
          errorKind: null,
          ...quoteCleared(),
        })
        return
      }
      const from = fromRef.current ?? (await fetchAccounts())
      if (gen !== confirmGen.current || !mountedRef.current) return
      if (!from) {
        sendLock.current = false
        connectedRef.current = null
        patch({ step: 2, walletConnected: false, from: null, walletPending: false })
        return
      }
      fromRef.current = from
      const dry = await dryRunRegister(reader as DryRunClient, from, parsed.agentURI)
      if (gen !== confirmGen.current || !mountedRef.current) return
      const units = dry.gas.toString()
      const nextId = dry.provisionalId.toString(10)
      if (previousId !== nextId || (previousGas != null && previousGas !== units)) {
        sendLock.current = false
        patch({
          step: 4,
          provisionalId: nextId,
          gas: { units, estCostTestEth: await displayCost(dry.gas) },
          valuesChanged: true,
          walletPending: false,
          errorKind: null,
          errorDetail: null,
        })
        return
      }
      const balance = await checkBalanceForGas(reader as FeeReader, from, dry.gas)
      if (gen !== confirmGen.current || !mountedRef.current) return
      if (!balance.ok) {
        sendLock.current = false
        patch({
          step: 4,
          walletPending: false,
          errorKind: "InsufficientFunds",
          errorDetail: insufficientGas(ethText(balance.needed), ethText(balance.balance)),
          notice: null,
        })
        return
      }
      try {
        const existing = await findExistingAgent(reader as BalanceClient, from)
        if (gen === confirmGen.current) preSendCountRef.current = existing.count
      } catch {
        preSendCountRef.current = stateRef.current.existingCount
      }
      if (gen !== confirmGen.current || !mountedRef.current) return
      const again = await fetchChain()
      if (gen !== confirmGen.current || !mountedRef.current) return
      if (again !== BASE_SEPOLIA_CHAIN_ID) {
        sendLock.current = false
        chainRef.current = again
        patch({
          step: 3,
          chainName: chainLabel(again),
          walletPending: false,
          ...quoteCleared(),
        })
        return
      }
      const write = buildRegisterWrite(parsed.agentURI)
      livePreviewRef.current = {
        to: write.to,
        functionName: "register",
        calldata: write.data,
        valueWei: 0n,
      }
      fromAddressRef.current = from
      senderRef.current = from
      const submit = submitRef.current?.submit
      if (!submit) {
        sendLock.current = false
        patch({
          walletPending: false,
          errorKind: "Unknown",
          errorDetail: "The register transaction is not ready.",
        })
        return
      }
      phaseRef.current = "prompt"
      patch({
        walletPending: true,
        promptSlow: false,
        errorKind: null,
        errorDetail: null,
        notice: null,
        noticeDetail: null,
      })
      armPromptTimer()
      submit()
    } catch (error) {
      if (gen !== confirmGen.current || !mountedRef.current) return
      sendLock.current = false
      phaseRef.current = "form"
      clearPromptTimer()
      patch({
        walletPending: false,
        promptSlow: false,
        errorKind: errorCode(error),
        errorDetail: error instanceof Error ? error.message : null,
      })
    }
  }

  function onSubmitted(hash: Hex) {
    if (phaseRef.current === "sent") return
    clearPromptTimer()
    phaseRef.current = "sent"
    sendLock.current = true
    const from = senderRef.current ?? fromRef.current
    const uri = stateRef.current.parsed?.agentURI ?? ""
    if (from) {
      writeStored({
        chainId: BASE_SEPOLIA_CHAIN_ID,
        from,
        hash,
        uriHash: keccak256(toBytes(uri)),
        startedAt: Date.now(),
        existingCount: preSendCountRef.current == null ? null : preSendCountRef.current.toString(),
      })
    }
    patch({
      step: 5,
      txHash: hash,
      txStatus: "pending",
      walletPending: false,
      promptSlow: false,
      pendingSlow: false,
      resuming: false,
      spedUp: false,
      finalId: null,
      globalId: null,
      owner: null,
      errorKind: null,
      errorDetail: null,
      notice: null,
      showOwnerSwitch: false,
      walletDisconnected: false,
    })
    setFollowNonce((value) => value + 1)
  }

  function onSubmitError(error: unknown) {
    if (phaseRef.current === "sent") return
    clearPromptTimer()
    phaseRef.current = "form"
    sendLock.current = false
    if (rejected(error)) {
      patch({
        step: 4,
        walletPending: false,
        promptSlow: false,
        errorKind: "UserRejected",
        errorDetail: null,
      })
      return
    }
    const normalized = normalizeWalletError(error)
    patch({
      step: 4,
      walletPending: false,
      promptSlow: false,
      errorKind: errorCode(normalized),
      errorDetail: normalized.message,
    })
  }

  const submittedImpl = useRef<(hash: Hex) => void>(() => {})
  const failedImpl = useRef<(error: unknown) => void>(() => {})
  submittedImpl.current = onSubmitted
  failedImpl.current = onSubmitError

  async function onStartOver() {
    if (startLock.current) return
    if (phaseRef.current === "prompt") return
    startLock.current = true
    try {
      const pre = preSendCountRef.current
      const from = senderRef.current
      if (pre != null && from && !warnedRef.current && phaseRef.current === "sent") {
        try {
          const found = await findExistingAgent(reader as BalanceClient, from)
          if (!mountedRef.current) return
          if (found.count > pre) {
            warnedRef.current = true
            patch({ noticeDetail: ownsAfterReplacement(found.count), errorDetail: null })
            return
          }
        } catch {
          // A failed recount still lets the user leave the receipt.
        }
      }
      resetAll()
    } finally {
      startLock.current = false
    }
  }

  function resetAll() {
    phaseRef.current = "form"
    generationRef.current += 1
    dryGen.current += 1
    confirmGen.current += 1
    sendLock.current = false
    warnedRef.current = false
    senderRef.current = null
    preSendCountRef.current = null
    livePreviewRef.current = null
    clearStored()
    clearPromptTimer()
    const next = { ...blankFields(), expanded: true }
    stateRef.current = next
    if (mountedRef.current) setFields(next)
    setFollowNonce((value) => value + 1)
  }

  function onBack() {
    const current = stateRef.current
    if (current.walletPending || current.step <= 1 || current.step === 5) return
    patch({ step: (current.step - 1) as WizardStep })
  }

  function onFile(file: File) {
    patch({ fileName: file.name })
    const name = file.name
    void file.text().then((text) => {
      if (stateRef.current.fileName === name) patch({ fileText: text })
    })
  }

  const controller: WizardController = {
    expanded: fields.expanded,
    step: fields.step,
    parsed: fields.parsed,
    from: fields.from,
    provisionalId: fields.provisionalId,
    gas: fields.gas,
    existingCount: fields.existingCount,
    errorKind: fields.errorKind,
    errorDetail: fields.errorDetail,
    notice: fields.notice,
    noticeDetail: fields.noticeDetail,
    walletPending: fields.walletPending,
    valuesChanged: fields.valuesChanged,
    txHash: fields.txHash,
    txStatus: fields.txStatus,
    finalId: fields.finalId,
    globalId: fields.globalId,
    owner: fields.owner,
    fileTab: fields.fileTab,
    pasteText: fields.pasteText,
    fileName: fields.fileName,
    acknowledged: fields.acknowledged,
    dryRunPending: fields.dryRunPending,
    walletConnected: fields.walletConnected,
    connectPending: fields.connectPending,
    connectNotice: fields.connectNotice,
    chainName: fields.chainName,
    switchNotice: fields.switchNotice,
    pendingSlow: fields.pendingSlow,
    promptSlow: fields.promptSlow,
    walletDisconnected: fields.walletDisconnected,
    showOwnerSwitch: fields.showOwnerSwitch,
    spedUp: fields.spedUp,
    resuming: fields.resuming,
    onFile,
    onCheck,
    onDryRun: () => {
      void runDryRun(true)
    },
    onConfirm: () => {
      void onConfirm()
    },
    onBack,
    onStartOver: () => {
      void onStartOver()
    },
    onContinueToIdentity: () => undefined,
    onExpand: () => patch({ expanded: true }),
    onAcknowledge: (checked) => patch({ acknowledged: checked }),
    onSelectTab: (tab) => patch({ fileTab: tab }),
    onPaste: (text) => patch({ pasteText: text }),
    onConnect: () => {
      void onConnect()
    },
    onSwitchChain: () => {
      void onSwitchChain()
    },
  }

  const send = (
    <WalletOnlySubmit
      preview={PLACEHOLDER}
      allowed={ALLOWED}
      quiet
      livePreviewRef={livePreviewRef}
      submitRef={submitRef}
      fromAddressRef={fromAddressRef}
      preflightClient={reader.call ? { call: reader.call } : null}
      onSubmitted={(hash) => submittedImpl.current(hash)}
      onSubmitError={(error) => failedImpl.current(error)}
    />
  )

  return { controller, send }
}

async function switchOrAdd(eth: EipProvider, params: { chainId: string }[]) {
  await eth.request({ method: "wallet_switchEthereumChain", params })
}
