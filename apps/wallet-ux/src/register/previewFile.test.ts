import { describe, expect, it } from "vitest"
import { previewRegistration } from "./previewFile"

const GOOD_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1"

describe("previewRegistration", () => {
  it("rejects invalid JSON and a bare registration-v1 type", () => {
    expect(previewRegistration("{", null).errorKind).toBe("InvalidJson")
    const bare = previewRegistration(JSON.stringify({ type: "registration-v1", name: "A" }), null)
    expect(bare.errorKind).toBe("WrongType")
    expect(bare.errorDetail).toBe("registration-v1")
  })

  it("accepts a type that ends in #registration-v1 and does not invent a size cap", () => {
    const raw = JSON.stringify({ type: GOOD_TYPE, name: "Sample agent" })
    const preview = previewRegistration(raw, null)
    expect(preview.errorKind).toBeNull()
    expect(preview.parsed?.name).toBe("Sample agent")
    expect(preview.parsed?.sizeCap).toBeNull()
    expect(preview.parsed?.sizeBytes).toBeGreaterThan(0)
  })

  it("flags a file as too large only when the caller passes a cap", () => {
    const raw = JSON.stringify({ type: GOOD_TYPE, name: "Sample agent" })
    expect(previewRegistration(raw, null).errorKind).toBeNull()
    expect(previewRegistration(raw, 4).errorKind).toBe("TooLarge")
  })

  it("rejects a data URI that is not application/json base64", () => {
    expect(previewRegistration("data:text/plain,hello", null).errorKind).toBe("BadUri")
  })
})
