import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ERROR_COPY, REGISTER_ERROR_CODES, wrongType } from "./registerCopy"
import * as copy from "./registerCopy"
import { BASE_SEPOLIA_FAUCET_DOCS_URL } from "./walkthrough"

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
      // Look's Confirm line uses "approve" as a wallet action. Pin it, then skip the generic ban.
      if (key === "CONFIRM_TX_LINE") {
        expect(value).toBe("Your wallet will open. Check the details and approve. You can still say no there.")
        expect(value).not.toContain(emDash)
        continue
      }
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

  it("pins Blockchain Look register-wizard copy", () => {
    expect(copy.CARD_TITLE).toBe("Register your bot")
    expect(copy.CARD_LINE).toBe(
      "Your bot gets a public on-chain ID that anyone can look up. Registration writes a record to the blockchain. The record's ID and history can't be erased, but you (the owner) can update your bot's profile or transfer it. This is a testnet record and may be reset. Nothing here costs real money.",
    )
    expect(copy.TRUST_LINE).toBe(
      "Anyone can check who registered this bot and when. Registration does not mean we, or anyone, have reviewed, verified, or endorsed the bot.",
    )
    expect(copy.OPEN_WIZARD).toBe("Start registering")
    expect(copy.WHAT_YOU_NEED_TITLE).toBe("What you need")
    expect(copy.NEED_WALLET).toBe(
      "A browser wallet, such as a wallet extension in Chrome or Brave. Your wallet signs and sends the registration. This site never holds your keys.",
    )
    expect(copy.NEED_TEST_ETH).toBe(
      "A little free Base Sepolia test ETH to pay the network fee. Get it from a Base Sepolia faucet. Test ETH has no cash value.",
    )
    expect(copy.NEED_PROFILE).toBe(
      "Your bot's profile: a small file that says who your bot is. You can upload it or paste it as an agent URI.",
    )
    expect(copy.FAUCET_LINK_LABEL).toBe("Get free test ETH")
    expect(copy.FAUCET_URL).toBe("https://docs.base.org/get-started/get-funds")
    expect(copy.FAUCET_URL).toBe(BASE_SEPOLIA_FAUCET_DOCS_URL)
    expect(copy.CONNECT_NOTE).toBe("Connect a browser wallet to register your bot on Base Sepolia testnet.")
    expect(copy.STEP_FILE).toBe("Profile")
    expect(copy.STEP_CHECK).toBe("Check")
    expect(copy.STEP_DRY_RUN).toBe("Test run")
    expect(copy.STEP_CONFIRM).toBe("Confirm")
    expect(copy.STEP_DONE).toBe("Done")
    expect(copy.WIZARD_STEP_LABELS).toEqual(["Profile", "Check", "Test run", "Confirm", "Done"])
    expect(copy.FILE_TITLE).toBe("Add your bot's profile")
    expect(copy.FILE_HELPER).toBe(
      "Upload your bot's profile file, or paste its agent URI. The agent URI is a link or text block that describes your bot. Nothing is sent yet. Don't put your name, email, or other personal info in your bot's profile. Parts of this record can never be deleted.",
    )
    expect(copy.CHECK_REGISTRATION).toBe("Check profile")
    expect(copy.PASS_LINE).toBe("Looks good. This profile is in the right format.")
    expect(copy.WRONG_TYPE).toBe("This file isn't a bot profile we can read.")
    expect(copy.BAD_URI_DETAIL).toBe(
      "Paste the agent URI that starts with data:application/json;base64, or upload the profile file.",
    )
    expect(copy.DRY_RUN_RUNNING).toBe(
      "Doing a practice run with the registry. Nothing is sent and no test ETH is spent.",
    )
    expect(copy.PROVISIONAL_LABEL).toBe("Expected id. Your final id is set when the transaction goes through.")
    expect(copy.LABEL_GAS).toBe("Network fee (test ETH)")
    expect(copy.REVIEW_AND_CONFIRM).toBe("Review and confirm")
    expect(copy.INSUFFICIENT_FUNDS).toBe(
      "Your wallet needs a little more free test ETH for the network fee. Get some from a Base Sepolia faucet, then check again.",
    )
    expect(copy.CONFIRM_TITLE).toBe("Confirm and register")
    expect(copy.ACK_CHECKBOX).toBe(
      "I understand this sends a transaction from my wallet on Base Sepolia testnet, uses test ETH only, and writes a public record, parts of which can never be deleted.",
    )
    expect(copy.CONFIRM_IN_WALLET).toBe("Confirm in wallet")
    expect(copy.CONTINUE_IDENTITY).toBe("Sign a wallet check")
    expect(copy.CONTINUE_HELPER).toBe(
      "Next, sign a quick check from your bot's wallet so people can confirm signatures come from that wallet. This is free and sends no transaction.",
    )
    expect(copy.registeredId("9001")).toBe(
      "Done. Your bot is registered on Base Sepolia testnet. Its agent id is 9001.",
    )
    expect(copy.CONNECT_NOTE).not.toMatch(/mainnet|real money/i)
    expect(copy.CARD_LINE).toContain("testnet")
    expect(copy.CARD_LINE).toContain("Nothing here costs real money.")
  })

})
