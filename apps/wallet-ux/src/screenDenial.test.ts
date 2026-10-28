import { describe, expect, it } from "vitest"
import { RelayerRequestError, presentRelayerError } from "./relayer"

const MESSAGE =
  "Agent-B.V. isn't available for this wallet or location. If you think this is a mistake, contact hello@stewardoftheking.com."

describe("server denial sentence", () => {
  it("shows the server sentence only after the server sends it", () => {
    const shown = presentRelayerError(new RelayerRequestError("raw", 403, "forbidden", { message: MESSAGE }))
    expect(shown.main).toBe(MESSAGE)
    expect(shown.main.toLowerCase().includes("sanction")).toBe(false)
    const other = presentRelayerError(new RelayerRequestError("raw", 403, "unauthorized", { error: "unauthorized" }))
    expect(other.main).not.toBe(MESSAGE)
  })
})