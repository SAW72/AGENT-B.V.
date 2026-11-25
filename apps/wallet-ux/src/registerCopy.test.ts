import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ERROR_COPY, REGISTER_ERROR_CODES, wrongType } from "./registerCopy"
import * as copy from "./registerCopy"

const banned = /access|approved|approve|unlocked|trusted|earn|metamask|coinbase wallet/i
const emDash = "\u2014"

function assertClean(text: string) {
  expect(text).not.toMatch(banned)
  expect(text).not.toContain(emDash)
}

function walk(value: unknown, seen: Set<unknown>) {
  if (typeof value === "string") {
    assertClean(value)
    return
  }
  if (typeof value === "function") {
    if (seen.has(value)) return
    seen.add(value)
    const results = [
      value("42"),
      value("42", "1000"),
      value(1n),
      value(2),
      value(10, 1000),
      value("0xabc"),
      value("chain 1"),
    ]
    for (const result of results) walk(result, seen)
    return
  }
  if (typeof value === "object" && value != null) {
    if (seen.has(value)) return
    seen.add(value)
    for (const nested of Object.values(value as Record<string, unknown>)) walk(nested, seen)
  }
}

describe("register copy", () => {
  it("has no banned words or em dashes in exported strings", () => {
    const seen = new Set<unknown>()
    for (const [key, value] of Object.entries(copy)) {
      if (key === "__esModule") continue
      walk(value, seen)
    }
  })

  it("maps every error code and uses the Rev 3 type sentence", () => {
    expect(Object.keys(ERROR_COPY).sort()).toEqual([...REGISTER_ERROR_CODES].sort())
    expect(wrongType("other")).toBe(
      "The type field must be the ERC-8004 registration-v1 type (ends in #registration-v1). It is other.",
    )
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "registerCopy.ts"), "utf8")
    expect(source).not.toContain("Install a browser wallet")
    expect(source).not.toMatch(/metamask|coinbase wallet/i)
    expect(source).not.toContain(emDash)
  })
})
