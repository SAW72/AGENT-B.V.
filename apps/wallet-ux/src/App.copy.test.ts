import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { INSTALL_WALLET_HINT } from "./App"

const appSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "App.tsx"), "utf8")

describe("wallet-neutral connect-error hint", () => {
  it("keeps the exact wording and names no specific wallet brand", () => {
    expect(INSTALL_WALLET_HINT).toBe("Install a browser wallet if no injected wallet is available.")
    expect(INSTALL_WALLET_HINT).not.toMatch(/metamask|rabby|coinbase|phantom|brave/i)
    expect(appSource).toContain("{errorText(connectError)} {INSTALL_WALLET_HINT}")
    expect(appSource).not.toMatch(/Install MetaMask/i)
  })
})
