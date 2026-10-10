// @vitest-environment happy-dom

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { BASE_SEPOLIA_CHAIN_ID } from "../addresses"
import { DISPLAY_NAME } from "../brand"
import { parseBalance, parseConfig, parseHistory, reputationHistoryUrl, reputationRoot } from "./api"
import {
  BALANCE_LINE,
  LATER_LABEL,
  NETWORK_ERROR,
  RATE_LIMITED,
  REFUSED,
  UNAVAILABLE,
  WITHHELD,
  firstUseLabel,
} from "./copy"
import { exampleFiles, exampleSnapshot } from "./exampleData"
import { forgetReputationSession, ReputationView, resetReputationIntroduction, type ReputationViewProps } from "./ReputationView"
import type { ReputationHistory, ReputationSnapshot } from "./types"

const ADDRESS = exampleSnapshot.balance.address
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "../..")

const BANNED = /\b(reward|earnings|apy|yield|allocation)\b/i

afterEach(() => {
  cleanup()
  resetReputationIntroduction()
})

function renderView(props: Partial<ReputationViewProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReputationView
        connected
        chainId={BASE_SEPOLIA_CHAIN_ID}
        address={ADDRESS}
        relayerUrl="https://relayer.example"
        introduced={false}
        fetchImpl={props.fetchImpl}
        {...props}
      />
    </QueryClientProvider>,
  )
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function emptyHistory(ledger: "usage" | "arbitrator"): ReputationHistory {
  return {
    address: ADDRESS,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    ledger,
    items: [],
    next_cursor: null,
  }
}

function fixtureFetch(urls: string[]): typeof fetch {
  return async (input) => {
    const url = String(input)
    urls.push(url)
    const parsed = new URL(url)
    expect(parsed.searchParams.get("chainId")).toBe(String(BASE_SEPOLIA_CHAIN_ID))
    if (parsed.pathname.endsWith("/config")) return jsonResponse(exampleFiles.config.response)
    if (parsed.pathname.endsWith("/history")) {
      const ledger = parsed.searchParams.get("ledger")
      if (ledger === "arbitrator") return jsonResponse(emptyHistory("arbitrator"))
      return jsonResponse(exampleFiles.history.response)
    }
    return jsonResponse(exampleFiles.balance.response)
  }
}

describe("reputation fixtures", () => {
  it("parses the copied EXAMPLE DATA responses", () => {
    expect(exampleFiles.balance.label).toMatch(/EXAMPLE DATA/)
    expect(exampleFiles.history.label).toMatch(/EXAMPLE DATA/)
    expect(exampleFiles.config.label).toMatch(/EXAMPLE DATA/)
    expect(exampleFiles.balance.response_is_live_chain_data).toBe(false)
    const balance = parseBalance(exampleFiles.balance.response)
    const history = parseHistory(exampleFiles.history.response)
    const config = parseConfig(exampleFiles.config.response)
    expect(balance.eligibility).toEqual({ status: "unverified", points_withheld: true })
    expect(balance.ledgers.usage.ledger).toBe("agent-bv-sepolia-reputation")
    expect(balance.ledgers.arbitrator.ledger).toBe("agent-bv-sepolia-arbitrator-rep")
    expect(history.items.map((item) => item.outcome_code)).toEqual(["O4", "O1"])
    expect(history.next_cursor).toBeNull()
    expect(config.product_title.length).toBeGreaterThan(config.product.length)
    expect(config.thresholds.season_length_days.value).toBe(90)
    expect(config.thresholds.season_start_block.value).toBeNull()
    expect(config.thresholds.season_start_timestamp.value).toBeNull()
    expect(config.thresholds.day_boundary.value).toBe("utc_day_by_block_timestamp")
    expect(config.status).toBe("draft")
  })

  it("renders both panels, withheld balances, and history from the fixtures", async () => {
    const urls: string[] = []
    renderView({ fetchImpl: fixtureFetch(urls), introduced: false })

    expect(await screen.findByTestId("usage-panel")).toBeTruthy()
    expect(screen.getByTestId("arbitrator-panel")).toBeTruthy()
    expect(screen.getByTestId("chain-badge").textContent).toBe(String(BASE_SEPOLIA_CHAIN_ID))
    expect(screen.getByTestId("reputation-label").textContent).toBe(firstUseLabel(exampleSnapshot.config.product_title))
    expect(screen.getAllByText(WITHHELD)).toHaveLength(2)
    expect(screen.queryByTestId("usage-points")).toBeNull()
    expect(screen.queryByTestId("arbitrator-points")).toBeNull()
    expect(screen.getAllByTestId("balance-line").every((node) => node.textContent === BALANCE_LINE)).toBe(true)
    expect(screen.getByText("Dispute path completed")).toBeTruthy()
    expect(screen.getByText("Bot onboarded")).toBeTruthy()
    expect(screen.getAllByTestId("history-status").map((node) => node.textContent)).toEqual(["final", "final"])
    const link = screen.getAllByTestId("history-tx")[0]
    expect(link?.getAttribute("href")).toBe(
      "https://sepolia.basescan.org/tx/0x0000000000000000000000000000000000000000000000000000000000007108",
    )
    expect(screen.getByTestId("usage-history").textContent).toContain("0 points")
    expect(screen.getByText("No history rows.")).toBeTruthy()
    expect(screen.getByTestId("placeholder-7").textContent).toMatch(/#7/)
    expect(screen.getByTestId("placeholder-9").textContent).toMatch(/#9/)
    expect(screen.getByTestId("placeholder-11").textContent).toMatch(/#11/)
    expect(screen.getByTestId("placeholder-12").textContent).toMatch(/#12/)
    expect(screen.getByTestId("draft-caps").textContent?.toLowerCase()).toContain("draft")
    expect(screen.getByTestId("cap-usage_points_per_wallet_per_day").textContent).toContain("20")
    const caps = screen.getByTestId("draft-caps").textContent ?? ""
    expect(caps).toContain("Season length: 90 days")
    expect(caps).toContain("Season start block: Not set")
    expect(caps).toContain("Season start time: Not set")
    expect(caps).toContain("Day boundary: utc_day_by_block_timestamp")
    const view = screen.getByTestId("reputation-view").textContent ?? ""
    expect(view.toLowerCase()).not.toMatch(/\b(total|combined)\b/)
    expect(view).not.toMatch(/stranded|gasrescue|tge|usd|\$|apy/i)
    expect(view).not.toMatch(/\bETH\b/)
    expect(screen.queryByRole("button", { name: /send|transfer|claim|redeem/i })).toBeNull()
    expect(urls.every((url) => url.includes("chainId=84532"))).toBe(true)
  })

  it("uses the loaded product title for the first-use label and the short label after that", async () => {
    const title = "Northwind QA"
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes("/config")) {
        return jsonResponse({ ...exampleFiles.config.response, product: "Northwind", product_title: title })
      }
      if (url.includes("/history")) {
        const ledger = new URL(url).searchParams.get("ledger") === "arbitrator" ? "arbitrator" : "usage"
        return jsonResponse(emptyHistory(ledger))
      }
      return jsonResponse(exampleFiles.balance.response)
    }
    renderView({ fetchImpl, introduced: false })
    expect(await screen.findByRole("heading", { name: firstUseLabel(title) })).toBeTruthy()
    expect(screen.getByTestId("reputation-label").textContent).not.toBe(firstUseLabel(DISPLAY_NAME))

    cleanup()
    renderView({ fetchImpl, introduced: true })
    await screen.findByTestId("usage-panel")
    expect(screen.getByTestId("reputation-label").textContent).toBe(LATER_LABEL)
    expect(screen.getByTestId("reputation-label").textContent).not.toContain(title)
  })

  it("shows the long label on the first page load and the short label on the next one", () => {
    renderView({ example: exampleSnapshot, relayerUrl: null, introduced: undefined })
    expect(screen.getByTestId("reputation-label").textContent).toBe(
      firstUseLabel(exampleSnapshot.config.product_title),
    )
    expect(window.localStorage.getItem("agent-bv-reputation-introduced")).toBe("1")
    cleanup()
    forgetReputationSession()
    renderView({ example: exampleSnapshot, relayerUrl: null, introduced: undefined })
    expect(screen.getByTestId("reputation-label").textContent).toBe(LATER_LABEL)
  })
})

describe("reputation chain guard", () => {
  it("hides the view unless the wallet is connected on Base Sepolia", () => {
    for (const chainId of [1, 8453, 11155111, null, "conflict"] as const) {
      renderView({ chainId, example: exampleSnapshot })
      expect(screen.queryByTestId("reputation-view")).toBeNull()
      cleanup()
    }
    renderView({ connected: false, chainId: BASE_SEPOLIA_CHAIN_ID, example: exampleSnapshot })
    expect(screen.queryByTestId("reputation-view")).toBeNull()
  })
})

describe("reputation panels", () => {
  it("shows separate final and provisional points and does not add them", async () => {
    const snapshot = structuredClone(exampleSnapshot) as ReputationSnapshot
    snapshot.balance.eligibility = { status: "eligible", points_withheld: false }
    snapshot.balance.ledgers.usage.final = 4
    snapshot.balance.ledgers.usage.provisional = 1
    snapshot.balance.ledgers.arbitrator.final = 7
    snapshot.balance.ledgers.arbitrator.provisional = 2
    renderView({ example: snapshot, relayerUrl: null })
    expect(screen.getByTestId("usage-points").textContent).toContain("Final")
    expect(screen.getByTestId("usage-points").textContent).toContain("4")
    expect(screen.getByTestId("usage-points").textContent).toContain("Provisional")
    expect(screen.getByTestId("usage-points").textContent).toContain("1")
    expect(screen.getByTestId("arbitrator-points").textContent).toContain("7")
    expect(screen.getByTestId("arbitrator-points").textContent).toContain("2")
    expect(screen.queryByTestId("usage-withheld")).toBeNull()
    expect(screen.getByTestId("usage-points").textContent).not.toContain("5")
    expect(screen.getByTestId("arbitrator-points").textContent).not.toContain("9")
    expect(screen.queryByText("11")).toBeNull()
    expect(screen.queryByText("14")).toBeNull()
    const text = screen.getByTestId("reputation-view").textContent ?? ""
    expect(text.toLowerCase()).not.toMatch(/\b(total|combined|sum)\b/)
  })

  it("renders disclaimer links when they are set, and placeholders when they are null", () => {
    const withLinks = structuredClone(exampleSnapshot) as ReputationSnapshot
    withLinks.balance.disclaimer.links = {
      master_disclaimer: "https://example.com/disclaimer",
      bvt_securities_disclaimer: "https://example.com/securities",
      as_is: "https://example.com/as-is",
      not_investment: "https://example.com/not-investment",
      eligibility_notice: "https://example.com/eligibility",
      abuse_policy: "https://example.com/abuse",
    }
    renderView({ example: withLinks, relayerUrl: null })
    expect(screen.getByRole("link", { name: "AS IS" }).getAttribute("href")).toBe("https://example.com/as-is")
    expect(screen.getByRole("link", { name: "Eligibility notice" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "Abuse policy" })).toBeTruthy()
    expect(screen.queryByTestId("placeholder-7")).toBeNull()
    expect(screen.queryByTestId("placeholder-9")).toBeNull()
    expect(screen.queryByTestId("placeholder-11")).toBeNull()
    expect(screen.getByTestId("example-data-banner").textContent).toMatch(/EXAMPLE DATA/)
  })
})

describe("reputation pagination and errors", () => {
  it("loads the next history page with the opaque cursor", async () => {
    const [first, second] = exampleSnapshot.history.usage.items
    if (!first || !second) throw new Error("fixture history needs two rows")
    const seen: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      seen.push(url)
      const parsed = new URL(url)
      if (parsed.pathname.endsWith("/config")) return jsonResponse(exampleFiles.config.response)
      if (parsed.pathname.endsWith("/history")) {
        const ledger = parsed.searchParams.get("ledger")
        if (ledger === "arbitrator") return jsonResponse(emptyHistory("arbitrator"))
        const cursor = parsed.searchParams.get("cursor")
        if (cursor === "cursor-2") {
          return jsonResponse({ ...exampleFiles.history.response, items: [second], next_cursor: null })
        }
        return jsonResponse({ ...exampleFiles.history.response, items: [first], next_cursor: "cursor-2" })
      }
      return jsonResponse(exampleFiles.balance.response)
    }
    renderView({ fetchImpl })
    expect(await screen.findByText("Dispute path completed")).toBeTruthy()
    expect(screen.queryByText("Bot onboarded")).toBeNull()
    fireEvent.click(screen.getByTestId("load-more-usage"))
    expect(await screen.findByText("Bot onboarded")).toBeTruthy()
    expect(screen.queryByTestId("load-more-usage")).toBeNull()
    expect(seen.some((url) => url.includes("cursor=cursor-2"))).toBe(true)
    expect(seen.some((url) => url.includes("ledger=usage"))).toBe(true)
    expect(seen.some((url) => url.includes("limit=25"))).toBe(true)
  })

  it("shows a quiet unavailable state when the relayer URL is unset", () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("should not fetch")
    }
    renderView({ relayerUrl: null, fetchImpl, example: null })
    expect(screen.getByTestId("reputation-unavailable").textContent).toBe(UNAVAILABLE)
    expect(screen.getByTestId("chain-badge")).toBeTruthy()
    expect(screen.queryByTestId("usage-panel")).toBeNull()
    expect(screen.queryByTestId("reputation-error")).toBeNull()
  })

  it("handles 400, 429, and network errors without showing a balance", async () => {
    const cases = [
      { status: 400, message: REFUSED },
      { status: 429, message: RATE_LIMITED },
    ] as const
    for (const item of cases) {
      renderView({
        fetchImpl: async () => jsonResponse({ error: "nope", ledgers: { usage: { final: 9 } } }, item.status),
      })
      expect((await screen.findByTestId("reputation-error")).textContent).toBe(item.message)
      expect(screen.queryByTestId("usage-panel")).toBeNull()
      expect(screen.queryByText("9")).toBeNull()
      cleanup()
      resetReputationIntroduction()
    }
    renderView({
      fetchImpl: async () => {
        throw new Error("offline")
      },
    })
    expect((await screen.findByTestId("reputation-error")).textContent).toBe(NETWORK_ERROR)
    expect(screen.queryByTestId("usage-panel")).toBeNull()
  })
})

describe("reputation copy", () => {
  it("fails when banned words appear in the reputation components", () => {
    const dir = join(rootDir, "src/reputation")
    const files = readdirSync(dir).filter((name) => name !== "reputation.test.tsx")
    const extras = [join(rootDir, "src/reputationExample.tsx"), join(rootDir, "reputation-example.html")]
    const texts = [...files.map((name) => readFileSync(join(dir, name), "utf8")), ...extras.map((path) => readFileSync(path, "utf8"))]
    for (const text of texts) {
      expect(text).not.toMatch(BANNED)
      expect(text).not.toMatch(/\bearn tokens\b/i)
      expect(text).not.toMatch(/stranded|gasrescue/i)
    }
    const view = readFileSync(join(dir, "ReputationView.tsx"), "utf8")
    expect(view).toContain('from "../brand"')
    expect(view).toContain("DISPLAY_NAME")
    expect(view).not.toContain("Agent-BV")
    expect(view).not.toContain("Agent Bot Verifier")
  })
})

describe("reputation URL", () => {
  it("builds read URLs from the refund relayer base and keeps the cursor opaque", () => {
    expect(reputationRoot("https://relayer.example/v1/claims")).toBe("https://relayer.example")
    expect(reputationRoot("https://relayer.example/")).toBe("https://relayer.example")
    const history = reputationHistoryUrl("https://relayer.example", ADDRESS, "usage", "abc/def", 25)
    const parsed = new URL(history)
    expect(parsed.searchParams.get("cursor")).toBe("abc/def")
    expect(parsed.searchParams.get("ledger")).toBe("usage")
    expect(parsed.searchParams.get("limit")).toBe("25")
    expect(parsed.searchParams.get("chainId")).toBe("84532")
  })
})
