import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import puppeteer from "puppeteer-core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer } from "vite"

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 1 }
const ACCOUNT = "0x6dBe4B1c56494Ee00d6f97FFE9f853F42299D6Ac"
const PAYEE = "0x6C756dacfEcEeA12D5D39536d2eCC175f18bc5A4"
const PAYER_BOT = "0x2c2859b9e712890799696d217e9fe2eec1151822ed1b7168785b38991dc42637"
const PAYEE_BOT = "0xc62c848cf38434b66945ed12b266365ef9390b0281b0ca6bc20ba7ab46a06d2f"
const CONNECT = "Connect a wallet to continue."
const SWITCH = "Switch your wallet to Base Sepolia to continue."
const AMOUNT = "Enter an amount of test ETH, such as 0.001."

function chromePath() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  for (const candidate of [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/local/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]) {
    if (existsSync(candidate)) return candidate
  }
  try {
    return execFileSync(
      "bash",
      ["-lc", "command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser"],
      { encoding: "utf8" },
    ).trim()
  } catch {
    return ""
  }
}

let server
let browser
let base = ""

// Read text in the page and return a boolean. waitForSelector adopts an
// ElementHandle in another world, then DOM.resolveNode throws once a re-render
// replaces that node.
async function waitForReason(page, text) {
  await page.waitForFunction(
    (expected) => {
      const footer = document.querySelector("[data-testid=guided-footer]")
      const reason = document.querySelector("[data-testid=footer-reason]")
      const legal = document.querySelector("footer")
      if (!(footer instanceof HTMLElement) || !footer.isConnected) return false
      if (!(reason instanceof HTMLElement) || !reason.isConnected) return false
      if (!(legal instanceof HTMLElement) || !legal.textContent?.includes("is a product of")) return false
      return reason.textContent === expected
    },
    { timeout: 15_000 },
    text,
  )
}

async function reasonId(page) {
  return page.evaluate(() => {
    const reason = document.querySelector("[data-testid=footer-reason]")
    return reason instanceof HTMLElement && reason.isConnected ? reason.id : ""
  })
}

async function openFund(chainId) {
  // A shared browser context keeps wagmi's localStorage. The next page can
  // reconnect that session and then drop it after Next is already on screen.
  const context = await browser.createBrowserContext()
  let page
  try {
    page = await context.newPage()
  } catch (error) {
    await context.close()
    throw error
  }
  await page.setViewport(VIEWPORT)
  await page.evaluateOnNewDocument(
    (startChain, account) => {
      try {
        localStorage.clear()
        sessionStorage.clear()
      } catch (error) {
        window.__clearError = error instanceof Error ? error.message : String(error)
      }
      // A background tab clamps setInterval, so the connector chain poll never
      // observes a silent chain change. This page is the one under test.
      try {
        Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => false })
        Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => "visible" })
      } catch {
        // The prototype getter is already fixed in this browser.
      }
      const listeners = new Map()
      let chain = startChain
      let accounts = []
      const emit = (event, ...args) => {
        for (const cb of listeners.get(event) ?? []) cb(...args)
      }
      const ethereum = {
        isMetaMask: true,
        request: async ({ method, params }) => {
          if (method === "eth_chainId") return chain
          if (method === "eth_accounts") return accounts.slice()
          if (method === "eth_requestAccounts") {
            accounts = [account]
            return accounts.slice()
          }
          if (method === "wallet_revokePermissions") {
            accounts = []
            return null
          }
          if (method === "wallet_switchEthereumChain") {
            const next = params?.[0]?.chainId
            if (typeof next === "string") {
              chain = next
              emit("chainChanged", chain)
            }
            return null
          }
          const unsupported = new Error("unsupported")
          unsupported.code = -32601
          throw unsupported
        },
        on(event, cb) {
          const set = listeners.get(event) ?? new Set()
          set.add(cb)
          listeners.set(event, set)
        },
        removeListener(event, cb) {
          listeners.get(event)?.delete(cb)
        },
      }
      Object.defineProperty(window, "ethereum", { configurable: true, value: ethereum })
      window.__wallet = {
        setChain(next, notify) {
          chain = next
          if (notify) emit("chainChanged", chain)
        },
      }
    },
    chainId,
    ACCOUNT,
  )
  try {
    await page.goto(`${base}fund`, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await page.bringToFront()
    try {
      const client = await page.createCDPSession()
      await client.send("Page.setWebLifecycleState", { state: "active" })
    } catch {
      // Older headless builds omit this lifecycle command.
    }
    const clearError = await page.evaluate(() => window.__clearError || "")
    if (clearError) throw new Error(`Could not clear wallet storage: ${clearError}`)
    await waitForReason(page, CONNECT)
    return page
  } catch (error) {
    await context.close()
    throw error
  }
}

async function closeFund(page) {
  const context = page.browserContext()
  await context.close()
}

async function setInput(page, selector, value) {
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel)
    return el instanceof HTMLInputElement && el.isConnected
  }, {}, selector)
  const wrote = await page.evaluate((sel, next) => {
    const el = document.querySelector(sel)
    if (!(el instanceof HTMLInputElement) || !el.isConnected) return false
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
    proto?.set?.call(el, next)
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
    return el.value === next
  }, selector, value)
  if (!wrote) throw new Error(`Could not set ${selector}`)
}

async function clickWhen(page, ready) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const clicked = await page.evaluate(ready)
    if (clicked) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("The button was not ready to click")
}

async function connect(page) {
  await clickWhen(page, () => {
    const button = document.querySelector("[data-testid=journey-connect]")
    if (!(button instanceof HTMLButtonElement) || !button.isConnected || button.disabled) return false
    if (button.textContent !== "Connect wallet") return false
    button.click()
    return true
  })
}

async function clickNext(page) {
  await clickWhen(page, () => {
    const button = document.querySelector("[data-testid=guided-footer] [data-action-button]")
    if (!(button instanceof HTMLButtonElement) || !button.isConnected) return false
    if (button.disabled || button.getAttribute("aria-disabled") === "true" || button.textContent !== "Next") return false
    button.click()
    return true
  })
}

async function actionOffset(page) {
  return page.evaluate(() => {
    const footer = document.querySelector("[data-testid=guided-footer]")
    const action = document.querySelector(
      "[data-testid=guided-footer] [data-testid=journey-connect], [data-testid=guided-footer] [data-testid=journey-switch], [data-testid=guided-footer] [data-action-button]",
    )
    if (!(footer instanceof HTMLElement) || !(action instanceof HTMLElement)) return null
    return Math.round(action.getBoundingClientRect().top - footer.getBoundingClientRect().top)
  })
}

async function measure(page) {
  await page.evaluate(() => document.querySelector("[data-testid=guided-footer]")?.scrollIntoView({ block: "center" }))
  return page.evaluate(() => {
    function box(el) {
      if (!el) return null
      const rect = el.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height }
    }
    function hits(a, b) {
      if (!a || !b) return false
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      return overlapY > 0.5 && overlapX > 0.5
    }
    function seen(rect) {
      return (
        rect != null &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top >= -1 &&
        rect.bottom <= window.innerHeight + 1 &&
        rect.left >= -1 &&
        rect.right <= window.innerWidth + 1
      )
    }
    const reason = document.querySelector("[data-testid=footer-reason]")
    const actions = document.querySelector("[data-testid=guided-footer] .step-actions")
    const action = document.querySelector(
      "[data-testid=guided-footer] [data-testid=journey-connect], [data-testid=guided-footer] [data-testid=journey-switch], [data-testid=guided-footer] [data-action-button]",
    )
    const legal = [...document.querySelectorAll("footer p")].find((el) => el.textContent.includes("is a product of"))
    const reasonBox = box(reason)
    const actionsBox = box(actions)
    const actionBox = box(action)
    const footer = document.querySelector("[data-testid=guided-footer]")
    return {
      reasonText: reason?.textContent ?? "",
      actionText: action?.textContent ?? "",
      reasonSeen: seen(reasonBox),
      actionSeen: seen(actionBox),
      actionsSeen: seen(actionsBox),
      reasonOverlapsActions: hits(reasonBox, actionsBox),
      footerOverlapsLegal: hits(box(footer), box(legal)),
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      footerOverflow: footer ? footer.scrollWidth > footer.clientWidth + 1 : true,
    }
  })
}

describe("guided footer reasons at 390x844", () => {
  beforeAll(async () => {
    const executablePath = chromePath()
    if (!executablePath) throw new Error("Chrome is required for the 390x844 footer layout test")
    server = await createServer({
      configFile: join(appRoot, "vite.config.ts"),
      logLevel: "error",
      // Coverage files land while other workers run. A watching dev server
      // would full-reload this page and destroy the puppeteer context.
      server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null },
    })
    await server.listen()
    const address = server.httpServer?.address()
    const port = address && typeof address === "object" ? address.port : 0
    base = `http://127.0.0.1:${port}/app/`
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
      ],
    })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await server?.close()
  })

  it("keeps Next in place when the footer reason is empty", async () => {
    const page = await openFund("0x14a34")
    try {
      const withReason = await actionOffset(page)
      expect(withReason).toBeGreaterThan(0)
      await connect(page)
      await page.waitForFunction(() => {
        const reason = document.querySelector("[data-testid=footer-reason]")
        const button = document.querySelector("[data-testid=guided-footer] [data-action-button]")
        return reason instanceof HTMLElement && reason.textContent === "" && button instanceof HTMLButtonElement && button.textContent === "Next"
      })
      expect(await actionOffset(page)).toBe(withReason)
    } finally {
      await closeFund(page)
    }
  }, 30_000)

  it("shows Connect and its reason without overlap or overflow", async () => {
    const page = await openFund("0x14a34")
    try {
      const view = await measure(page)
      expect(view.reasonText).toBe(CONNECT)
      expect(view.actionText).toBe("Connect wallet")
      expect(view.reasonSeen).toBe(true)
      expect(view.actionSeen).toBe(true)
      expect(view.actionsSeen).toBe(true)
      expect(view.reasonOverlapsActions).toBe(false)
      expect(view.footerOverlapsLegal).toBe(false)
      expect(view.pageOverflow).toBe(false)
      expect(view.footerOverflow).toBe(false)
    } finally {
      await closeFund(page)
    }
  }, 30_000)

  it("shows Switch and its reason on chain 1 without overlap or overflow", async () => {
    const page = await openFund("0x1")
    try {
      const before = await reasonId(page)
      expect(before).not.toBe("")
      await connect(page)
      await waitForReason(page, SWITCH)
      // The chain change swaps the action. It must not remount the footer.
      expect(await reasonId(page)).toBe(before)
      const step = await page.evaluate(() => document.querySelector("[data-testid=step-count]")?.textContent ?? "")
      expect(step).toBe("Step 1 of 4")
      const view = await measure(page)
      expect(view.reasonText).toBe(SWITCH)
      expect(view.actionText).toBe("Switch to Base Sepolia")
      expect(view.reasonSeen).toBe(true)
      expect(view.actionSeen).toBe(true)
      expect(view.actionsSeen).toBe(true)
      expect(view.reasonOverlapsActions).toBe(false)
      expect(view.footerOverlapsLegal).toBe(false)
      expect(view.pageOverflow).toBe(false)
      expect(view.footerOverflow).toBe(false)
    } finally {
      await closeFund(page)
    }
  }, 30_000)

  it("shows the conflict reason without overlap or overflow", async () => {
    const page = await openFund("0x14a34")
    try {
      await connect(page)
      // Next has to stay up with an empty reason before the silent chain change.
      // A reconnect can flash Next and then drop the session back to Connect.
      await page.waitForFunction(() => {
        const reason = document.querySelector("[data-testid=footer-reason]")
        const button = document.querySelector("[data-testid=guided-footer] [data-action-button]")
        return (
          reason instanceof HTMLElement &&
          reason.isConnected &&
          reason.textContent === "" &&
          button instanceof HTMLButtonElement &&
          button.isConnected &&
          button.textContent === "Next"
        )
      })
      const before = await reasonId(page)
      expect(before).not.toBe("")
      await page.bringToFront()
      await page.evaluate(() => window.__wallet.setChain("0x1", false))
      try {
        await waitForReason(page, SWITCH)
      } catch (error) {
        const snap = await page.evaluate(() => {
          const primary = document.querySelector(
            "[data-testid=journey-connect], [data-testid=journey-switch], [data-testid=guided-footer] [data-action-button]",
          )
          return {
            reason: document.querySelector("[data-testid=footer-reason]")?.textContent ?? "",
            primary: primary?.textContent ?? "",
            chip: document.querySelector("[data-testid=wallet-chip]")?.textContent ?? "",
            hidden: document.hidden,
          }
        })
        throw new Error(`Switch sentence did not appear (${JSON.stringify(snap)})`, { cause: error })
      }
      expect(await reasonId(page)).toBe(before)
      const view = await measure(page)
      expect(view.reasonText).toBe(SWITCH)
      expect(view.actionText).toBe("Switch to Base Sepolia")
      expect(view.reasonSeen).toBe(true)
      expect(view.actionSeen).toBe(true)
      expect(view.reasonOverlapsActions).toBe(false)
      expect(view.footerOverlapsLegal).toBe(false)
      expect(view.pageOverflow).toBe(false)
      expect(view.footerOverflow).toBe(false)
    } finally {
      await closeFund(page)
    }
  }, 45_000)

  it("shows the empty-amount reason without overlap or overflow", async () => {
    const page = await openFund("0x14a34")
    try {
      const before = await reasonId(page)
      expect(before).not.toBe("")
      await connect(page)
      await setInput(page, "#create-payee", PAYEE)
      await clickNext(page)
      await setInput(page, "#create-payer-bot", PAYER_BOT)
      await setInput(page, "#create-payee-bot", PAYEE_BOT)
      await clickNext(page)
      await waitForReason(page, AMOUNT)
      expect(await reasonId(page)).toBe(before)
      const disabled = await page.evaluate(() => {
        const el = document.querySelector("[data-testid=guided-footer] [data-action-button]")
        return (
          el instanceof HTMLButtonElement &&
          el.isConnected &&
          el.getAttribute("aria-disabled") === "true" &&
          !el.disabled &&
          el.textContent === "Next"
        )
      })
      expect(disabled).toBe(true)
      const view = await measure(page)
      expect(view.reasonText).toBe(AMOUNT)
      expect(view.actionText).toBe("Next")
      expect(view.reasonSeen).toBe(true)
      expect(view.actionSeen).toBe(true)
      expect(view.actionsSeen).toBe(true)
      expect(view.reasonOverlapsActions).toBe(false)
      expect(view.footerOverlapsLegal).toBe(false)
      expect(view.pageOverflow).toBe(false)
      expect(view.footerOverflow).toBe(false)
    } finally {
      await closeFund(page)
    }
  }, 30_000)
})
