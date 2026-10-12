// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, within } from "@testing-library/react"
import { type Address, type Hex } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FlowPreview } from "./FlowPreview"
import { resetCarriedIds } from "./carriedIds"
import { resetPendingRuntime } from "./usePendingReceipt"
import {
  RELAYER_CHECKING_NOTE,
  RELAYER_DOWN_NOTE,
  RELAYER_HEALTH_BACKGROUND_MS,
  RELAYER_HEALTH_RETRY_LABEL,
  RELAYER_HEALTH_RETRY_MS,
  RELAYER_HEALTH_TIMEOUT_MS,
  RELAYER_HEALTH_WAKE_CAP_MS,
  RELAYER_NO_RESPONSE_TEXT,
  RELAYER_PAUSED_NOTE,
  RELAYER_WAKING_TEXT,
} from "./relayer"
import { resetSubmitLock } from "./submitLock"

const { signCalls, harness } = vi.hoisted(() => ({
  signCalls: { n: 0 },
  harness: {
    connected: true,
    sendTransactionAsync: vi.fn(async () => `0x${"22".repeat(32)}`),
  },
}))

const ACCOUNT = "0x6dBe4B1c56494Ee00d6f97FFE9f853F42299D6Ac" as Address
const escrow = "0x3d660502D75f1e97b08c110255921b437A3C4C42" as Address
const panel = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb" as Address
const claim = `0x${"ab".repeat(32)}` as Hex
const otherClaim = `0x${"cd".repeat(32)}` as Hex
const ZERO = "0x0000000000000000000000000000000000000000" as Address
const TX = `0x${"22".repeat(32)}` as Hex
const SIG = `0x${"11".repeat(65)}` as Hex

const escrowFixture = { expiresAt: 1n, state: 0 }

const publicClient = {
  getCode: async () => "0x60016000",
  call: async () => "0x",
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === "escrows") {
      return [escrow, escrow, claim, claim, 1n, 1_700_000_000n, escrowFixture.expiresAt, escrowFixture.state, `0x${"00".repeat(32)}`, ZERO]
    }
    return 0n
  },
  waitForTransactionReceipt: async () => ({ status: "success" as const }),
  getTransactionReceipt: async () => {
    throw Object.assign(new Error("missing receipt"), { name: "TransactionReceiptNotFoundError" })
  },
  getTransaction: async () => {
    throw Object.assign(new Error("missing transaction"), { name: "TransactionNotFoundError" })
  },
}

vi.mock("wagmi", () => ({
  useAccount: () => ({
    isConnected: harness.connected,
    address: harness.connected ? ACCOUNT : undefined,
    chainId: harness.connected ? 84532 : undefined,
    connector: undefined,
  }),
  usePublicClient: () => publicClient,
  useSendTransaction: () => ({ sendTransactionAsync: harness.sendTransactionAsync, isPending: false }),
  useWalletClient: () => ({
    data: {
      signTypedData: async () => {
        signCalls.n += 1
        return SIG
      },
    },
  }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false, error: null }),
  useBalance: () => ({ data: { value: 10n ** 18n }, isSuccess: true }),
}))

type Step = "hang" | "hold" | "ok" | "502" | "400" | "typeerror" | "404html" | "200html" | "522" | "notok" | "disabled"
type Held = {
  url: string
  init: RequestInit
  resolve: (response: Response) => void
}

const counts = { health: 0, post: 0 }
let steps: Step[] = []
let held: Held[] = []

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function okHealth(): Response {
  return jsonResponse(200, { ok: true, killSwitch: false })
}

function installFetch() {
  counts.health = 0
  counts.post = 0
  held = []
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit = {}) => {
      const method = String(init.method ?? "GET")
      if (method === "POST") {
        counts.post += 1
        const headers = new Headers(init.headers)
        expect(headers.get("authorization")).toBeNull()
        expect(headers.get("x-claim-secret")).toBeNull()
        expect(init.credentials).toBeUndefined()
        return Promise.resolve(jsonResponse(200, { ok: true, mode: "live", txHash: TX, escrowAddress: escrow }))
      }
      counts.health += 1
      expect(String(url).endsWith("/health")).toBe(true)
      expect(method).toBe("GET")
      expect(init.headers).toBeUndefined()
      expect(init.credentials).toBeUndefined()
      expect(init.body).toBeUndefined()
      const step = steps.shift() ?? "ok"
      if (step === "typeerror") return Promise.reject(new TypeError("Failed to fetch"))
      if (step === "502") return Promise.resolve(jsonResponse(502, {}))
      if (step === "400") return Promise.resolve(jsonResponse(400, { ok: false }))
      if (step === "404html") {
        return Promise.resolve(new Response("<html><body>no-server</body></html>", { status: 404, headers: { "content-type": "text/html" } }))
      }
      if (step === "200html") {
        return Promise.resolve(
          new Response("<html><body>Application is starting</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
        )
      }
      if (step === "522") return Promise.resolve(new Response("error code: 522", { status: 522, headers: { "content-type": "text/plain" } }))
      if (step === "notok") return Promise.resolve(jsonResponse(200, { ok: false, killSwitch: false }))
      if (step === "disabled") {
        return Promise.resolve(jsonResponse(200, { ok: true, killSwitch: false, submitsDisabled: true }))
      }
      if (step === "ok") return Promise.resolve(okHealth())
      return new Promise<Response>((resolve, reject) => {
        const entry: Held = { url: String(url), init, resolve }
        held.push(entry)
        init.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        })
      })
    }),
  )
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function refundSection() {
  const button = document.querySelector("section[aria-label='Refund a payment']")
  if (!(button instanceof HTMLElement)) throw new Error("missing refund section")
  return within(button)
}

async function prepareRefund(scope = refundSection()) {
  await act(async () => {
    fireEvent.click(scope.getByRole("button", { name: "Prepare this refund" }))
    await vi.advanceTimersByTimeAsync(0)
  })
  return scope
}

describe("refund service health", () => {
  it("pins the starting sentence, the no-response sentence, and the unchanged unavailable note", () => {
    expect(RELAYER_WAKING_TEXT).toBe("Starting the refund service… This can take up to two minutes.")
    expect(RELAYER_NO_RESPONSE_TEXT).toBe(
      "The refund service didn't respond. Nothing was sent. Try again, or refund from your own wallet.",
    )
    expect(RELAYER_DOWN_NOTE).toBe("The refund service is unavailable. Use your wallet to submit instead.")
    expect(RELAYER_HEALTH_RETRY_LABEL).toBe("Try again")
  })

  beforeEach(() => {
    escrowFixture.expiresAt = 1n
    escrowFixture.state = 0
    steps = []
    signCalls.n = 0
    harness.connected = true
    harness.sendTransactionAsync.mockReset()
    harness.sendTransactionAsync.mockImplementation(async () => `0x${"22".repeat(32)}`)
    resetCarriedIds()
    resetSubmitLock()
    resetPendingRuntime()
    localStorage.clear()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"))
    vi.stubEnv("VITE_CLAIM_RELAYER_URL", "https://relayer.example.test")
    installFetch()
    window.history.replaceState(null, "", "/")
  })

  afterEach(() => {
    cleanup()
    resetCarriedIds()
    resetSubmitLock()
    resetPendingRuntime()
    localStorage.clear()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    window.history.replaceState(null, "", "/")
  })

  it("re-checks health on every Prepare and again before a refund post", async () => {
    steps = ["ok", "ok", "ok"]
    render(<FlowPreview escrow={escrow} panel={panel} />)
    const refund = refundSection()
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: claim } })
    await prepareRefund(refund)
    expect(counts.health).toBe(1)
    expect(counts.post).toBe(0)
    await prepareRefund(refund)
    expect(counts.health).toBe(2)
    const button = refund.getByTestId("relayer-submit") as HTMLButtonElement
    expect(button.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(button)
      fireEvent.click(button)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(counts.health).toBe(3)
    expect(counts.post).toBe(1)
    expect((refund.getByTestId("sepolia-submit") as HTMLButtonElement).disabled).toBe(false)
  })

  it("shows Starting through a cold start longer than 8s, then enables with no post", async () => {
    steps = ["hang", "hold"]
    render(<FlowPreview escrow={escrow} panel={panel} />)
    const refund = refundSection()
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: claim } })
    await prepareRefund(refund)
    await flush(8_000)
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_CHECKING_NOTE)
    expect(counts.post).toBe(0)
    await flush(RELAYER_HEALTH_TIMEOUT_MS - 8_000)
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_WAKING_TEXT)
    expect((refund.getByTestId("relayer-submit") as HTMLButtonElement).disabled).toBe(true)
    expect((refund.getByTestId("sepolia-submit") as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(refund.getByTestId("relayer-submit"))
    await flush(0)
    expect(counts.post).toBe(0)
    expect(counts.health).toBe(2)
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_WAKING_TEXT)
    held[1]?.resolve(okHealth())
    await flush(0)
    expect(refund.queryByTestId("relayer-note")).toBeNull()
    expect((refund.getByTestId("relayer-submit") as HTMLButtonElement).disabled).toBe(false)
    expect(counts.post).toBe(0)
  })

  it("treats repeated TypeErrors as starting, then enables with one post on click", async () => {
    steps = ["typeerror", "typeerror", "typeerror", "ok"]
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    render(<FlowPreview escrow={escrow} panel={panel} />)
    const refund = refundSection()
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: claim } })
    await prepareRefund(refund)
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_WAKING_TEXT)
    expect((refund.getByTestId("relayer-submit") as HTMLButtonElement).disabled).toBe(true)
    expect(counts.post).toBe(0)
    expect(signCalls.n).toBe(0)
    await flush(RELAYER_HEALTH_RETRY_MS * 3)
    expect(counts.health).toBe(4)
    expect(refund.queryByTestId("relayer-note")).toBeNull()
    expect((refund.getByTestId("relayer-submit") as HTMLButtonElement).disabled).toBe(false)
    expect(counts.post).toBe(0)
    expect(signCalls.n).toBe(0)
    const line = String(warn.mock.calls[0]?.[0])
    expect(line).toMatch(/^refund health cause=network_or_cors status=none elapsedMs=\d+ firstAt=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    await act(async () => {
      fireEvent.click(refund.getByTestId("relayer-submit"))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(counts.health).toBe(5)
    expect(counts.post).toBe(1)
    expect(signCalls.n).toBe(1)
  })

  it("gives up after a minute of TypeErrors, and Try again checks health only", async () => {
    steps = Array.from({ length: 40 }, () => "typeerror" as const)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    render(<FlowPreview escrow={escrow} panel={panel} />)
    const refund = refundSection()
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: claim } })
    await prepareRefund(refund)
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_WAKING_TEXT)
    await flush(RELAYER_HEALTH_WAKE_CAP_MS)
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_NO_RESPONSE_TEXT)
    expect(refund.getByTestId("relayer-health-retry").textContent).toBe(RELAYER_HEALTH_RETRY_LABEL)
    expect(counts.post).toBe(0)
    expect(signCalls.n).toBe(0)
    const line = String(warn.mock.calls[0]?.[0])
    expect(line).toMatch(/^refund health cause=network_or_cors status=none elapsedMs=\d+ firstAt=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    const beforeRetry = counts.health
    steps = ["ok"]
    fireEvent.click(refund.getByTestId("relayer-health-retry"))
    await flush(0)
    expect(counts.health).toBe(beforeRetry + 1)
    expect(counts.post).toBe(0)
    expect(signCalls.n).toBe(0)
    expect(refund.queryByTestId("relayer-health-retry")).toBeNull()
    expect((refund.getByTestId("relayer-submit") as HTMLButtonElement).disabled).toBe(false)
  })

  it("stops starting at 120s, and Try again restarts only the health check", async () => {
    steps = Array.from({ length: 40 }, () => "502" as const)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    render(<FlowPreview escrow={escrow} panel={panel} />)
    const refund = refundSection()
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: claim } })
    await prepareRefund(refund)
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_WAKING_TEXT)
    const afterFirst = counts.health
    await flush(RELAYER_HEALTH_RETRY_MS - 1)
    expect(counts.health).toBe(afterFirst)
    await flush(1)
    expect(counts.health).toBe(afterFirst + 1)
    await flush(RELAYER_HEALTH_WAKE_CAP_MS)
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_NO_RESPONSE_TEXT)
    expect(refund.getByTestId("relayer-health-retry").textContent).toBe(RELAYER_HEALTH_RETRY_LABEL)
    expect(counts.post).toBe(0)
    expect((refund.getByTestId("sepolia-submit") as HTMLButtonElement).disabled).toBe(false)
    const line = String(warn.mock.calls[0]?.[0])
    expect(line).toMatch(/^refund health cause=http_status status=502 elapsedMs=\d+ firstAt=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(line).not.toContain(claim)
    expect(line).not.toContain(ACCOUNT)
    expect(line).not.toContain("relayer.example.test")
    const beforeRetry = counts.health
    steps = ["ok"]
    fireEvent.click(refund.getByTestId("relayer-health-retry"))
    await flush(0)
    expect(counts.health).toBe(beforeRetry + 1)
    expect(counts.post).toBe(0)
    expect(refund.queryByTestId("relayer-health-retry")).toBeNull()
    expect((refund.getByTestId("relayer-submit") as HTMLButtonElement).disabled).toBe(false)
  })

  it("drops a stale health result when Prepare starts again or the escrow changes", async () => {
    steps = ["hold", "hold", "400"]
    render(<FlowPreview escrow={escrow} panel={panel} />)
    const refund = refundSection()
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: claim } })
    await prepareRefund(refund)
    expect(held).toHaveLength(1)
    const stale = held[0]
    await prepareRefund(refund)
    expect(held).toHaveLength(2)
    stale?.resolve(okHealth())
    await flush(0)
    expect((refund.getByTestId("relayer-submit") as HTMLButtonElement).disabled).toBe(true)
    expect(refund.queryByTestId("relayer-note")?.textContent).not.toBe(RELAYER_DOWN_NOTE)
    held[1]?.resolve(jsonResponse(400, { ok: false }))
    await flush(0)
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_DOWN_NOTE)
    expect((refund.getByTestId("relayer-submit") as HTMLButtonElement).disabled).toBe(true)
    expect(counts.post).toBe(0)

    steps = ["hold"]
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: otherClaim } })
    await flush(0)
    expect(refund.queryByTestId("relayer-submit")).toBeNull()
    held[1]?.resolve(okHealth())
    await flush(0)
    expect(refund.queryByTestId("relayer-submit")).toBeNull()
    await prepareRefund(refund)
    expect((refund.getByTestId("relayer-submit") as HTMLButtonElement).disabled).toBe(true)
    expect(counts.post).toBe(0)
  })

  it("treats submitsDisabled as paused, with no further health checks and no post", async () => {
    steps = ["disabled"]
    render(<FlowPreview escrow={escrow} panel={panel} />)
    const refund = refundSection()
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: claim } })
    await prepareRefund(refund)
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_PAUSED_NOTE)
    const button = refund.getByTestId("relayer-submit") as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(counts.health).toBe(1)
    expect(counts.post).toBe(0)
    await flush(RELAYER_HEALTH_WAKE_CAP_MS + RELAYER_HEALTH_BACKGROUND_MS * 2)
    expect(counts.health).toBe(1)
    expect(counts.post).toBe(0)
    expect(signCalls.n).toBe(0)
    fireEvent.click(button)
    await flush(0)
    expect(counts.health).toBe(1)
    expect(counts.post).toBe(0)
    expect(signCalls.n).toBe(0)
  })

  it("shows Starting through 404 HTML, 200 HTML, and 522, then enables with no post", async () => {
    steps = ["404html", "200html", "522", "ok"]
    render(<FlowPreview escrow={escrow} panel={panel} />)
    const refund = refundSection()
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: claim } })
    await prepareRefund(refund)
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_WAKING_TEXT)
    expect(counts.post).toBe(0)
    await flush(RELAYER_HEALTH_RETRY_MS)
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_WAKING_TEXT)
    await flush(RELAYER_HEALTH_RETRY_MS)
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_WAKING_TEXT)
    await flush(RELAYER_HEALTH_RETRY_MS)
    expect(refund.queryByTestId("relayer-note")).toBeNull()
    expect((refund.getByTestId("relayer-submit") as HTMLButtonElement).disabled).toBe(false)
    expect(counts.health).toBe(4)
    expect(counts.post).toBe(0)
    expect(signCalls.n).toBe(0)
  })

  it("keeps waking on bad replies until the cap, then says the service didn't respond", async () => {
    const cycle = ["404html", "200html", "522", "notok"] as const
    steps = Array.from({ length: 40 }, (_, index) => cycle[index % cycle.length]!)
    render(<FlowPreview escrow={escrow} panel={panel} />)
    const refund = refundSection()
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: claim } })
    await prepareRefund(refund)
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_WAKING_TEXT)
    await flush(RELAYER_HEALTH_WAKE_CAP_MS)
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_NO_RESPONSE_TEXT)
    expect(counts.post).toBe(0)
    expect(signCalls.n).toBe(0)
    expect(counts.health).toBe(Math.ceil(RELAYER_HEALTH_WAKE_CAP_MS / RELAYER_HEALTH_RETRY_MS))
  })

  it("shows the last down reply, and Try again only rechecks health", async () => {
    steps = ["400", "ok"]
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    render(<FlowPreview escrow={escrow} panel={panel} />)
    const refund = refundSection()
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: claim } })
    await prepareRefund(refund)
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_DOWN_NOTE)
    expect(refund.getByTestId("relayer-health-reply").textContent).toBe(
      'status 400, content-type application/json, body {"ok":false}',
    )
    expect(refund.getByTestId("relayer-health-retry").textContent).toBe(RELAYER_HEALTH_RETRY_LABEL)
    const lines = warn.mock.calls.map((call) => String(call[0]))
    expect(lines.some((line) => /^refund health cause=http_status status=400 elapsedMs=\d+ firstAt=/.test(line))).toBe(true)
    expect(lines).toContain('refund health reply status 400, content-type application/json, body {"ok":false}')
    const beforeRetry = counts.health
    fireEvent.click(refund.getByTestId("relayer-health-retry"))
    await flush(0)
    expect(counts.health).toBe(beforeRetry + 1)
    expect(counts.post).toBe(0)
    expect(signCalls.n).toBe(0)
    expect(refund.queryByTestId("relayer-health-retry")).toBeNull()
    expect(refund.queryByTestId("relayer-health-reply")).toBeNull()
    expect((refund.getByTestId("relayer-submit") as HTMLButtonElement).disabled).toBe(false)
  })

  it("rechecks health after the cap and enables submit without posting", async () => {
    steps = Array.from({ length: 31 }, () => "502" as const)
    render(<FlowPreview escrow={escrow} panel={panel} />)
    const refund = refundSection()
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: claim } })
    await prepareRefund(refund)
    await flush(RELAYER_HEALTH_WAKE_CAP_MS)
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_NO_RESPONSE_TEXT)
    expect((refund.getByTestId("relayer-submit") as HTMLButtonElement).disabled).toBe(true)
    const atCap = counts.health
    expect(atCap).toBe(Math.ceil(RELAYER_HEALTH_WAKE_CAP_MS / RELAYER_HEALTH_RETRY_MS))
    await flush(RELAYER_HEALTH_BACKGROUND_MS)
    expect(counts.health).toBe(atCap + 1)
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_NO_RESPONSE_TEXT)
    expect(counts.post).toBe(0)
    await flush(RELAYER_HEALTH_BACKGROUND_MS)
    expect(counts.health).toBe(atCap + 2)
    expect(refund.queryByTestId("relayer-note")).toBeNull()
    expect(refund.queryByTestId("relayer-health-retry")).toBeNull()
    expect((refund.getByTestId("relayer-submit") as HTMLButtonElement).disabled).toBe(false)
    expect(counts.post).toBe(0)
    expect(signCalls.n).toBe(0)
  })

  it("stops background health checks on unmount", async () => {
    steps = Array.from({ length: 80 }, () => "502" as const)
    const view = render(<FlowPreview escrow={escrow} panel={panel} />)
    const refund = refundSection()
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: claim } })
    await prepareRefund(refund)
    await flush(RELAYER_HEALTH_WAKE_CAP_MS)
    const atCap = counts.health
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_NO_RESPONSE_TEXT)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    view.unmount()
    await flush(0)
    expect(vi.getTimerCount()).toBe(0)
    await flush(RELAYER_HEALTH_BACKGROUND_MS * 3)
    expect(counts.health).toBe(atCap)
    expect(counts.post).toBe(0)
  })

  it("stops background health checks when the wallet disconnects", async () => {
    steps = Array.from({ length: 80 }, () => "502" as const)
    const view = render(<FlowPreview escrow={escrow} panel={panel} />)
    const refund = refundSection()
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: claim } })
    await prepareRefund(refund)
    await flush(RELAYER_HEALTH_WAKE_CAP_MS)
    const atCap = counts.health
    harness.connected = false
    view.rerender(<FlowPreview escrow={escrow} panel={panel} />)
    await flush(RELAYER_HEALTH_BACKGROUND_MS * 3)
    expect(counts.health).toBe(atCap)
    expect(counts.post).toBe(0)
  })

  it("stops background health checks after a wallet refund and does not post", async () => {
    steps = Array.from({ length: 80 }, () => "502" as const)
    render(<FlowPreview escrow={escrow} panel={panel} />)
    const refund = refundSection()
    fireEvent.change(refund.getByLabelText("Escrow ID"), { target: { value: claim } })
    await prepareRefund(refund)
    await flush(RELAYER_HEALTH_WAKE_CAP_MS)
    const atCap = counts.health
    expect(refund.getByTestId("relayer-note").textContent).toBe(RELAYER_NO_RESPONSE_TEXT)
    await act(async () => {
      fireEvent.click(refund.getByTestId("sepolia-submit"))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(harness.sendTransactionAsync).toHaveBeenCalledTimes(1)
    await flush(RELAYER_HEALTH_BACKGROUND_MS * 3)
    expect(counts.health).toBe(atCap)
    expect(counts.post).toBe(0)
    expect(signCalls.n).toBe(0)
  })
})
