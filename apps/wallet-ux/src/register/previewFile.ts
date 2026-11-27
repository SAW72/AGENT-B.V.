import type { ParsedRegistration, RegisterErrorCode } from "./types"

export interface PreviewResult {
  parsed: ParsedRegistration | null
  errorKind: RegisterErrorCode | null
  errorDetail: string | null
}

const DATA_PREFIX = "data:application/json;base64,"

/**
 * Local preview of a pasted file or URI. No wallet and no network.
 * The size cap is an argument. This file does not choose one.
 * Builder still owns the registry check.
 */
export function previewRegistration(input: string, sizeCap: number | null): PreviewResult {
  const text = input.trim()
  if (text === "") {
    return { parsed: null, errorKind: "InvalidJson", errorDetail: null }
  }

  let jsonText = text
  let agentURI = text
  if (text.startsWith("data:")) {
    if (!text.startsWith(DATA_PREFIX)) {
      return { parsed: null, errorKind: "BadUri", errorDetail: null }
    }
    try {
      jsonText = decodeBase64(text.slice(DATA_PREFIX.length))
    } catch {
      return { parsed: null, errorKind: "BadUri", errorDetail: null }
    }
    agentURI = text
  }

  let value: unknown
  try {
    value = JSON.parse(jsonText)
  } catch {
    return {
      parsed: null,
      errorKind: text.startsWith("data:") ? "BadUri" : "InvalidJson",
      errorDetail: null,
    }
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { parsed: null, errorKind: "InvalidJson", errorDetail: null }
  }

  const record = value as Record<string, unknown>
  const rawType = record.type
  const type = typeof rawType === "string" ? rawType : ""
  if (!type.endsWith("#registration-v1")) {
    return {
      parsed: null,
      errorKind: "WrongType",
      errorDetail: type === "" ? "(missing)" : type,
    }
  }

  const name = typeof record.name === "string" ? record.name : ""
  const sizeBytes = new TextEncoder().encode(text).length
  const parsed: ParsedRegistration = { type, name, sizeBytes, sizeCap, agentURI }
  if (sizeCap != null && sizeBytes > sizeCap) {
    return { parsed, errorKind: "TooLarge", errorDetail: null }
  }
  return { parsed, errorKind: null, errorDetail: null }
}

function decodeBase64(encoded: string): string {
  const cleaned = encoded.replace(/\s/g, "")
  const binary = atob(cleaned)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
