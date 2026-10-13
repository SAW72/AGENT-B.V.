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

async function openFund(chainId) {
  const page = await browser.newPage()
  await page.setViewport(VIEWPORT)
  await page.evaluateOnNewDocument(
    (startChain, account) => {
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
  await page.goto(`${base}fund`, { waitUntil: "domcontentloaded", timeout: 30_000 })
  await page.waitForSelector("[data-testid=guided-footer]")
  await page.waitForSelector("footer")
  return page
}

async function setInput(page, selector, value) {
  await page.waitForSelector(selector)
  await page.$eval(
    selector,
    (el, next) => {
      const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
      proto.set.call(el, next)
      el.dispatchEvent(new Event("input", { bubbles: true }))
      el.dispatchEvent(new Event("change", { bubbles: true }))
    },
    value,
  )
}

async function connect(page) {
  await page.waitForSelector("[data-testid=journey-connect]")
  await page.click("[data-testid=journey-connect]")
}

async function clickNext(page) {
  await page.waitForFunction(() => {
    const button = document.querySelector("[data-testid=guided-footer] [data-action-button]")
    return (
      button instanceof HTMLButtonElement &&
      !button.disabled &&
      button.getAttribute("aria-disabled") !== "true" &&
      button.textContent === "Next"
    )
  })
  await page.click("[data-testid=guided-footer] [data-action-button]")
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
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    })
    await server.listen()
    const address = server.httpServer?.address()
    const port = address && typeof address === "object" ? address.port : 0
    base = `http://127.0.0.1:${port}/app/`
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await server?.close()
  })

  it("shows Connect and its reason without overlap or overflow", async () => {
    const page = await openFund("0x14a34")
    try {
      await page.waitForFunction((text) => document.querySelector("[data-testid=footer-reason]")?.textContent === text, {}, CONNECT)
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
      await page.close()
    }
  }, 30_000)

  it("shows Switch and its reason on chain 1 without overlap or overflow", async () => {
    const page = await openFund("0x1")
    try {
      await connect(page)
      await page.waitForFunction((text) => document.querySelector("[data-testid=footer-reason]")?.textContent === text, {}, SWITCH)
      const step = await page.$eval("[data-testid=step-count]", (el) => el.textContent)
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
      await page.close()
    }
  }, 30_000)

  it("shows the conflict reason without overlap or overflow", async () => {
    const page = await openFund("0x14a34")
    try {
      await connect(page)
      await page.waitForFunction(() => {
        const button = document.querySelector("[data-testid=guided-footer] [data-action-button]")
        return button instanceof HTMLButtonElement && button.textContent === "Next"
      })
      await page.evaluate(() => window.__wallet.setChain("0x1", false))
      await page.waitForFunction(
        (text) => document.querySelector("[data-testid=footer-reason]")?.textContent === text,
        { timeout: 8_000 },
        SWITCH,
      )
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
      await page.close()
    }
  }, 30_000)

  it("shows the empty-amount reason without overlap or overflow", async () => {
    const page = await openFund("0x14a34")
    try {
      await connect(page)
      await page.waitForSelector("#create-payee")
      await setInput(page, "#create-payee", PAYEE)
      await clickNext(page)
      await page.waitForSelector("#create-payer-bot")
      await setInput(page, "#create-payer-bot", PAYER_BOT)
      await setInput(page, "#create-payee-bot", PAYEE_BOT)
      await clickNext(page)
      await page.waitForSelector("#create-value")
      await page.waitForFunction((text) => document.querySelector("[data-testid=footer-reason]")?.textContent === text, {}, AMOUNT)
      const disabled = await page.$eval(
        "[data-testid=guided-footer] [data-action-button]",
        (el) =>
          el instanceof HTMLButtonElement &&
          el.getAttribute("aria-disabled") === "true" &&
          !el.disabled &&
          el.textContent === "Next",
      )
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
      await page.close()
    }
  }, 30_000)
})
