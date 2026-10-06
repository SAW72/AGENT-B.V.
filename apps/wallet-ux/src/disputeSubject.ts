import { decodeFunctionResult, encodeFunctionData, type Abi, type Address, type Hex } from "viem"
import { escrowAbi } from "./abi"
import { ADDRESSES } from "./addresses"
import { FORM_ERRORS } from "./submit"

/**
 * Subject for openDispute.
 * A current escrow returns panelSubject(escrowId, createdAt) and that bytes32 is used as-is.
 * The booked escrow in the address book is source 7fe4a863e9bce0b70b629dab76ddd2728c97b536.
 * That contract exposes panelSubject. The claim-identifier fallback is only for
 * ADDRESSES.botAttestationEscrow, and only when that view reverts with empty data.
 * viem wraps every eth_call failure in CallExecutionError. Classification uses err.walk()
 * and never treats that wrapper as a revert. A real empty revert is ExecutionRevertedError,
 * RawContractError, or ContractFunctionRevertedError with data "0x" or no data. That
 * includes JSON-RPC code 3 and code -32000 whose message is execution reverted. HTTP
 * failures, timeouts, websocket failures, code -32603, code -32005, and -32000 header
 * not found block with the network message. No code blocks with the no-code message.
 * An empty revert on any other address is rejected and blocks. A claim that is not open,
 * or whose window is already past the exact expiry timestamp, blocks before the subject
 * read. The contract still allows a dispute at that exact timestamp.
 * A wrong subject would burn the random case identifier.
 * At the next redeploy, the wallet book, the relayer book, the deploy-guard pin, and the
 * superseded entry for the booked escrow change together.
 */
export type DisputeSubjectClient = {
  getCode: (args: { address: Address }) => Promise<Hex | undefined | null>
  call: (args: { to: Address; data: Hex }) => Promise<{ data?: Hex | null | undefined }>
  readContract: (args: {
    address: Address
    abi: Abi
    functionName: string
    args?: readonly unknown[]
  }) => Promise<unknown>
}

export type DisputeSubjectReady = {
  ok: true
  escrowId: Hex
  subject: Hex
  createdAt: bigint
  expiresAt: bigint
  state: number
  source: "view" | "escrow-id"
}

/** Solidity EscrowState.Open. Released, Refunded, and Disputed are every other value. */
export const OPEN_ESCROW_STATE = 0

export type DisputeSubjectBlocked = {
  ok: false
  message: string
}

export type DisputeSubjectResult = DisputeSubjectReady | DisputeSubjectBlocked

type CallFailure = "empty-revert" | "reverted" | "transport"

function bytecodePresent(code: unknown): boolean {
  return typeof code === "string" && /^0x[0-9a-fA-F]+$/i.test(code) && code.length > 2
}

function hexField(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === "") return null
  if (typeof value === "string") {
    const text = value.trim()
    if (/^0x$/i.test(text)) return null
    if (/^0x[0-9a-fA-F]+$/i.test(text)) return text.toLowerCase()
    return undefined
  }
  if (typeof value === "object" && value !== null && "data" in value) {
    return hexField((value as { data: unknown }).data)
  }
  return undefined
}

const TRANSPORT_NAMES = new Set(["HttpRequestError", "TimeoutError", "WebSocketRequestError"])
const EMPTY_REVERT_NAMES = new Set([
  "ExecutionRevertedError",
  "RawContractError",
  "ContractFunctionRevertedError",
])

/** True when a revert class carries revert bytes other than empty or absent data. */
function revertBytesPresent(record: Record<string, unknown>): boolean {
  for (const key of ["data", "raw"] as const) {
    if (!(key in record)) continue
    const found = hexField(record[key])
    if (typeof found === "string") return true
  }
  return false
}

function errorName(error: unknown): string {
  if (!error || typeof error !== "object" || !("name" in error)) return ""
  return typeof error.name === "string" ? error.name : ""
}

/**
 * viem's BaseError.walk. CallExecutionError is never a match: getCallError wraps
 * HTTP failures, timeouts, and reverts in that same class.
 */
function walkFor(error: unknown, names: ReadonlySet<string>): unknown | null {
  if (!error || typeof error !== "object" || !("walk" in error)) return null
  const walk = error.walk
  if (typeof walk !== "function") return null
  const found = walk.call(error, (node: unknown) => {
    const name = errorName(node)
    return name.length > 0 && name !== "CallExecutionError" && names.has(name)
  })
  return found && typeof found === "object" ? found : null
}

function chainHasRevertBytes(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current)
    const record = current as Record<string, unknown>
    if (errorName(current) !== "CallExecutionError" && revertBytesPresent(record)) return true
    const cause = record.cause
    current = cause && typeof cause === "object" ? cause : undefined
  }
  return false
}

function rpcCarrier(error: unknown): { code?: number; message: string } | null {
  const node = walkFor(error, new Set(["RpcRequestError"]))
  if (!node) return null
  const record = node as { code?: unknown; details?: unknown; shortMessage?: unknown }
  const message = [record.details, record.shortMessage].filter((part): part is string => typeof part === "string").join(" ")
  return { code: typeof record.code === "number" ? record.code : undefined, message }
}

/** Code 3, or -32000 whose text says execution reverted. Other RPC codes are transport. */
function isExecutionRevertRpc(rpc: { code?: number; message: string }): boolean {
  const message = rpc.message.toLowerCase()
  if (rpc.code === 3) return true
  return rpc.code === -32000 && message.includes("execution reverted")
}

/**
 * HTTP, timeout, and websocket errors are network failures wherever they sit.
 * walk() finds them inside CallExecutionError. A genuine execution revert is
 * code 3, or -32000 "execution reverted", surfaced as ExecutionRevertedError,
 * RawContractError, or ContractFunctionRevertedError. Empty or absent data is
 * the legacy fallback. -32603, -32005, and -32000 "header not found" block.
 * ContractFunctionRevertedError is not enough on its own: viem uses that class
 * for an internal RPC error too.
 */
function callFailure(error: unknown): CallFailure {
  if (walkFor(error, TRANSPORT_NAMES)) return "transport"
  const rpc = rpcCarrier(error)
  if (rpc && !isExecutionRevertRpc(rpc)) return "transport"
  if (walkFor(error, EMPTY_REVERT_NAMES)) {
    return chainHasRevertBytes(error) ? "reverted" : "empty-revert"
  }
  if (walkFor(error, new Set(["ContractFunctionZeroDataError"]))) return "reverted"
  return "transport"
}

/**
 * Matches dispute(): state must be Open, and the window includes the exact expiry timestamp.
 * block.timestamp > expiresAt reverts DisputeAfterExpiry. An equal timestamp does not.
 */
export function disputeWindowMessage(state: number, expiresAt: bigint, nowSeconds: bigint): string | null {
  if (state !== OPEN_ESCROW_STATE) return FORM_ERRORS.subjectNotOpen
  if (nowSeconds > expiresAt) return FORM_ERRORS.subjectExpired
  return null
}

function isBookedEscrow(escrow: Address): boolean {
  const booked = ADDRESSES.botAttestationEscrow
  if (!booked) return false
  return escrow.toLowerCase() === booked.toLowerCase()
}

function tupleField(value: unknown, index: number, name: string): unknown {
  if (Array.isArray(value)) return value[index]
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    if (name in record) return record[name]
    if (String(index) in record) return record[String(index)]
  }
  return undefined
}

function asUint(value: unknown): bigint | null {
  if (typeof value === "bigint" && value >= 0n) return value
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value)
  return null
}

function asCreatedAt(row: unknown): bigint | null {
  return asUint(tupleField(row, 5, "createdAt"))
}

function asExpiresAt(row: unknown): bigint | null {
  return asUint(tupleField(row, 6, "expiresAt"))
}

function asState(row: unknown): number | null {
  const value = asUint(tupleField(row, 7, "state"))
  if (value === null || value > 255n) return null
  return Number(value)
}

function bytes32Result(data: unknown): Hex | null {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{64}$/i.test(data)) return null
  return data.toLowerCase() as Hex
}

function blocked(message: string): DisputeSubjectBlocked {
  return { ok: false, message }
}

export async function readDisputeSubject(
  client: DisputeSubjectClient,
  escrow: Address,
  escrowId: Hex,
  nowSeconds: bigint,
): Promise<DisputeSubjectResult> {
  let code: unknown
  try {
    code = await client.getCode({ address: escrow })
  } catch {
    return blocked(FORM_ERRORS.subjectNetwork)
  }
  if (!bytecodePresent(code)) return blocked(FORM_ERRORS.subjectNoCode)

  let createdAt: bigint | null
  try {
    const row = await client.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "escrows",
      args: [escrowId],
    })
    createdAt = asCreatedAt(row)
    const expiresAt = asExpiresAt(row)
    const state = asState(row)
    if (createdAt === null || expiresAt === null || state === null) return blocked(FORM_ERRORS.subjectRejected)
    if (createdAt === 0n) return blocked(FORM_ERRORS.subjectMissing)
    const windowMessage = disputeWindowMessage(state, expiresAt, nowSeconds)
    if (windowMessage) return blocked(windowMessage)
    return await readPanelSubject(client, escrow, escrowId, createdAt, expiresAt, state)
  } catch (error) {
    return blocked(callFailure(error) === "transport" ? FORM_ERRORS.subjectNetwork : FORM_ERRORS.subjectRejected)
  }
}

async function readPanelSubject(
  client: DisputeSubjectClient,
  escrow: Address,
  escrowId: Hex,
  createdAt: bigint,
  expiresAt: bigint,
  state: number,
): Promise<DisputeSubjectResult> {
  const data = encodeFunctionData({
    abi: escrowAbi,
    functionName: "panelSubject",
    args: [escrowId, createdAt],
  })
  try {
    const result = await client.call({ to: escrow, data })
    const returned = result?.data
    if (typeof returned !== "string" || !/^0x[0-9a-fA-F]{64}$/i.test(returned)) {
      return blocked(FORM_ERRORS.subjectRejected)
    }
    try {
      const value = decodeFunctionResult({ abi: escrowAbi, functionName: "panelSubject", data: returned as Hex })
      const fromAbi = bytes32Result(value)
      if (!fromAbi) return blocked(FORM_ERRORS.subjectRejected)
      return { ok: true, escrowId, subject: fromAbi, createdAt, expiresAt, state, source: "view" }
    } catch {
      return blocked(FORM_ERRORS.subjectRejected)
    }
  } catch (error) {
    const failure = callFailure(error)
    if (failure === "empty-revert") {
      if (isBookedEscrow(escrow)) {
        return { ok: true, escrowId, subject: escrowId, createdAt, expiresAt, state, source: "escrow-id" }
      }
      return blocked(FORM_ERRORS.subjectNotBooked)
    }
    if (failure === "transport") return blocked(FORM_ERRORS.subjectNetwork)
    return blocked(FORM_ERRORS.subjectRejected)
  }
}
