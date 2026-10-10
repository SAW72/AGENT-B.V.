import { describe, expect, it } from "vitest"
import { DEFAULT_DURATION_SECONDS, DURATION_PRESETS, parseWholeSeconds } from "./duration"
import { MAX_DURATION_SECONDS } from "./preview"

describe("duration presets", () => {
  it("offers 1 hour, 1 day, and 7 days, with 1 day equal to 86400", () => {
    expect(DURATION_PRESETS.map((preset) => [preset.label, preset.seconds])).toEqual([
      ["1 hour", 3600],
      ["1 day", 86400],
      ["7 days", 604800],
    ])
    expect(DEFAULT_DURATION_SECONDS).toBe(86400)
    expect(MAX_DURATION_SECONDS).toBe(30 * 24 * 60 * 60)
  })

  it("accepts only whole seconds and rejects hex, exponents, decimals, and negatives", () => {
    expect(parseWholeSeconds("86400", MAX_DURATION_SECONDS)).toBe(86400)
    expect(parseWholeSeconds("  3600  ", MAX_DURATION_SECONDS)).toBe(3600)
    expect(parseWholeSeconds("1", MAX_DURATION_SECONDS)).toBe(1)
    expect(parseWholeSeconds(String(MAX_DURATION_SECONDS), MAX_DURATION_SECONDS)).toBe(MAX_DURATION_SECONDS)
    for (const raw of ["0x15180", "8.64e4", "1.5", "86400.0", "-1", "0", "", "86400n", "1e3", "+10"]) {
      expect(parseWholeSeconds(raw, MAX_DURATION_SECONDS)).toBeNull()
    }
    expect(parseWholeSeconds(String(MAX_DURATION_SECONDS + 1), MAX_DURATION_SECONDS)).toBeNull()
  })
})
