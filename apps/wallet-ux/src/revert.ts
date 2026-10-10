import {
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  RawContractError,
  decodeErrorResult,
  type Hex,
} from "viem"
import { disputePanelAbi, escrowAbi } from "./abi"
import { ERROR_GLOSSARY } from "./preview"

/** Solidity `Error(string)` and `Panic(uint256)`, alongside the wallet ABIs. */
const STANDARD_REVERT_ERRORS = [
  {
    type: "error",
    name: "Error",
    inputs: [{ name: "message", type: "string" }],
  },
  {
    type: "error",
    name: "Panic",
    inputs: [{ name: "code", type: "uint256" }],
  },
] as const

const REVERT_ABI = [...escrowAbi, ...disputePanelAbi, ...STANDARD_REVERT_ERRORS]

export type DecodedRevert = {
  name: string
  args: readonly unknown[] | undefined
  meaning: string | null
  selector: Hex
}

export type ErrorPresentation = {
  main: string
  detail: string | null
  /** Optional next step, such as a block explorer link. */
  link?: { href: string; label: string }
}

export const WALLET_CANCEL_TEXT = "You cancelled. Nothing was sent."
export const REVERT_FALLBACK_TEXT = "The contract rejected this transaction. No funds moved."
export const LOW_BALANCE_TEXT =
  "Not enough test ETH in this wallet to cover the amount plus gas. Get Base Sepolia test ETH from a faucet, then try again."

const LOW_BALANCE =
  /insufficient funds|exceeds transaction sender account balance|exceeds the balance of the account|gas \* (?:gas )?(?:price|fee) \+ value|OutOfFunds/i

/** Hide a details line that has no status, code, or reason after the label. */
export function visibleDetail(detail: string | null | undefined): string | null {
  if (detail == null) return null
  const rest = detail.replace(/^Details:\s*/, "").trim()
  if (detail.trim() === "" || rest === "") return null
  return detail
}

const REVERT_TEXT = /execution reverted|reverted for an unknown reason|the contract function .+ reverted/i

function isHexString(value: string): value is Hex {
  return /^0x[0-9a-fA-F]*$/.test(value) && (value.length - 2) % 2 === 0
}

function isRevertData(value: string): value is Hex {
  if (!isHexString(value)) return false
  const bytes = (value.length - 2) / 2
  return bytes >= 4 && (bytes - 4) % 32 === 0
}

function hexFromDataField(data: unknown): Hex | null {
  if (typeof data === "string" && isHexString(data)) return data
  if (data && typeof data === "object" && "data" in data) {
    return hexFromDataField((data as { data?: unknown }).data)
  }
  return null
}

function selectorOf(data: Hex): Hex {
  return `0x${data.slice(2, 10).toLowerCase()}` as Hex
}

function textOf(item: unknown): string {
  if (!item || typeof item !== "object") return ""
  const record = item as { shortMessage?: unknown; message?: unknown }
  return [record.shortMessage, record.message].filter((part) => typeof part === "string").join("\n")
}

/** Follow cause, error, and info.error. Uses BaseError.walk on viem errors. */
export function nodesOf(error: unknown): unknown[] {
  const out: unknown[] = []
  const seen = new Set<unknown>()
  const stack: unknown[] = [error]
  while (stack.length > 0) {
    const item = stack.pop()
    if (item == null || typeof item !== "object" || seen.has(item)) continue
    seen.add(item)
    out.push(item)
    if (item instanceof BaseError) {
      const deepest = item.walk()
      if (deepest && deepest !== item) stack.push(deepest)
    }
    const record = item as { cause?: unknown; error?: unknown; info?: unknown }
    if ("cause" in record) stack.push(record.cause)
    if ("error" in record) stack.push(record.error)
    if (record.info && typeof record.info === "object") {
      stack.push(record.info)
      if ("error" in record.info) stack.push((record.info as { error?: unknown }).error)
    }
  }
  return out
}

function matchesWalletCancel(item: unknown): boolean {
  if (!item || typeof item !== "object") return false
  const record = item as { name?: unknown; code?: unknown }
  if (record.name === "UserRejectedRequestError") return true
  if (record.code === 4001 || record.code === "4001" || record.code === "ACTION_REJECTED") return true
  return false
}

export function isWalletCancel(error: unknown): boolean {
  if (error instanceof BaseError) {
    const found = error.walk((item) => matchesWalletCancel(item))
    if (found) return true
  }
  return nodesOf(error).some((item) => matchesWalletCancel(item))
}

function glossaryMeaning(name: string, args: readonly unknown[] | undefined): string | null {
  const direct = ERROR_GLOSSARY.find((entry) => entry.name === name)
  if (direct) return direct.meaning
  const message = args?.[0]
  if (name === "Error" && typeof message === "string") {
    const byMessage = ERROR_GLOSSARY.find((entry) => entry.name === message)
    if (byMessage) return byMessage.meaning
  }
  return null
}

function validRevertData(error: unknown): Hex | null {
  if (error instanceof BaseError) {
    const reverted = error.walk((item) => item instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError && reverted.raw && isRevertData(reverted.raw)) {
      return reverted.raw
    }
    const raw = error.walk((item) => item instanceof RawContractError)
    if (raw instanceof RawContractError) {
      const hex = hexFromDataField(raw.data)
      if (hex && isRevertData(hex)) return hex
    }
  }
  for (const item of nodesOf(error)) {
    if (item instanceof ContractFunctionRevertedError && item.raw && isRevertData(item.raw)) return item.raw
    if (item instanceof RawContractError) {
      const hex = hexFromDataField(item.data)
      if (hex && isRevertData(hex)) return hex
    }
    if (item && typeof item === "object" && "data" in item) {
      const hex = hexFromDataField((item as { data?: unknown }).data)
      if (hex && isRevertData(hex)) return hex
    }
    if (item && typeof item === "object" && "raw" in item) {
      const raw = (item as { raw?: unknown }).raw
      if (typeof raw === "string" && isRevertData(raw)) return raw
    }
  }
  return null
}

function looseHexData(error: unknown): Hex | null {
  for (const item of nodesOf(error)) {
    if (item instanceof ContractFunctionRevertedError && typeof item.raw === "string" && isHexString(item.raw)) {
      return item.raw
    }
    if (item instanceof RawContractError) {
      const hex = hexFromDataField(item.data)
      if (hex) return hex
    }
    if (item && typeof item === "object" && "data" in item) {
      const hex = hexFromDataField((item as { data?: unknown }).data)
      if (hex) return hex
    }
  }
  return null
}

function looksLikeRevert(error: unknown): boolean {
  return nodesOf(error).some((item) => {
    if (item instanceof ContractFunctionRevertedError) return true
    if (item instanceof ExecutionRevertedError) return true
    if (item instanceof RawContractError) return true
    const name = (item as { name?: unknown }).name
    if (name === "ExecutionRevertedError" || name === "ContractFunctionRevertedError" || name === "RawContractError") {
      return true
    }
    return REVERT_TEXT.test(textOf(item))
  })
}

function panicLabel(args: readonly unknown[] | undefined): string {
  const code = args?.[0]
  if (typeof code === "bigint" || typeof code === "number") return `Panic 0x${code.toString(16)}`
  return "Panic"
}

function presentDecoded(data: Hex): ErrorPresentation {
  const selector = selectorOf(data)
  try {
    const decoded = decodeErrorResult({ abi: REVERT_ABI, data })
    const args = decoded.args === undefined ? undefined : [...decoded.args]
    const meaning = glossaryMeaning(decoded.errorName, args)
    if (meaning) return { main: meaning, detail: `Details: ${decoded.errorName} (${selector})` }
    if (decoded.errorName === "Panic") return { main: REVERT_FALLBACK_TEXT, detail: `Details: ${panicLabel(args)}` }
    if (decoded.errorName === "Error" && typeof args?.[0] === "string") {
      const message = args[0].trim()
      if (!message) return { main: REVERT_FALLBACK_TEXT, detail: null }
      return { main: REVERT_FALLBACK_TEXT, detail: `Details: ${message}` }
    }
    return { main: REVERT_FALLBACK_TEXT, detail: `Details: ${decoded.errorName} (${selector})` }
  } catch {
    return { main: REVERT_FALLBACK_TEXT, detail: `Details: ${selector}` }
  }
}

export function revertDataOf(error: unknown): Hex | null {
  return validRevertData(error)
}

export function decodeRevert(error: unknown): DecodedRevert | null {
  const data = validRevertData(error)
  if (!data) return null
  try {
    const decoded = decodeErrorResult({ abi: REVERT_ABI, data })
    const args = decoded.args === undefined ? undefined : [...decoded.args]
    return {
      name: decoded.errorName,
      args,
      meaning: glossaryMeaning(decoded.errorName, args),
      selector: selectorOf(data),
    }
  } catch {
    return null
  }
}

/** Decode a revert payload from a relayer body field. Null when it is absent or not a revert payload. */
export function presentRevertHex(data: unknown): ErrorPresentation | null {
  const hex = hexFromDataField(data)
  if (!hex || !isRevertData(hex)) return null
  return presentDecoded(hex)
}

function firstLine(text: string): string {
  const line = text.split("\n")[0]?.trim() ?? ""
  if (line.length === 0) return ""
  if (line.includes(" at ") || text.includes("\n    at ") || text.includes("\n at ")) return ""
  if (REVERT_TEXT.test(line)) return ""
  return line
}

function safeShort(error: unknown): string {
  if (typeof error === "object" && error !== null && "shortMessage" in error) {
    const short = (error as { shortMessage?: unknown }).shortMessage
    if (typeof short === "string") {
      const line = firstLine(short)
      if (line.length > 0) return line
    }
  }
  if (error instanceof Error) {
    const line = firstLine(error.message)
    if (line.length > 0) return line
  }
  return "Something went wrong. Nothing was sent."
}

export function isLowBalance(error: unknown): boolean {
  return nodesOf(error).some((item) => {
    if (!item || typeof item !== "object") return false
    const record = item as { shortMessage?: unknown; message?: unknown; details?: unknown }
    return [record.shortMessage, record.message, record.details].some(
      (part) => typeof part === "string" && LOW_BALANCE.test(part),
    )
  })
}

export function presentError(error: unknown): ErrorPresentation {
  if (isWalletCancel(error)) return { main: WALLET_CANCEL_TEXT, detail: null }

  const valid = validRevertData(error)
  if (valid) return presentDecoded(valid)

  if (isLowBalance(error)) return { main: LOW_BALANCE_TEXT, detail: null }

  if (looksLikeRevert(error)) {
    const loose = looseHexData(error)
    if (loose && !isRevertData(loose)) {
      return { main: REVERT_FALLBACK_TEXT, detail: loose === "0x" ? "Details: 0x" : `Details: ${loose}` }
    }
    return { main: REVERT_FALLBACK_TEXT, detail: null }
  }

  return { main: safeShort(error), detail: null }
}
