import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import puppeteer from "puppeteer-core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer } from "vite"

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const ESCROW = `0x${"ab".repeat(32)}`
const DISPUTE = `0x${"cd".repeat(32)}`
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 1 }

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

async function openFlow(path, ready) {
  const page = await browser.newPage()
  await page.setViewport(VIEWPORT)
  await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded", timeout: 30_000 })
  if (ready.click) {
    const deadline = Date.now() + 15_000
    let clicked = false
    while (Date.now() < deadline && !clicked) {
      clicked = await page.evaluate((selector) => {
        const el = document.querySelector(selector)
        if (!(el instanceof HTMLElement) || !el.isConnected) return false
        el.click()
        return true
      }, ready.click)
      if (!clicked) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!clicked) throw new Error(`Could not click ${ready.click}`)
  }
  await page.waitForFunction((selector) => {
    const target = document.querySelector(selector)
    const legal = document.querySelector("footer")
    const actions = document.querySelector(".step-actions")
    return Boolean(
      target instanceof HTMLElement &&
        target.isConnected &&
        legal instanceof HTMLElement &&
        legal.isConnected &&
        legal.textContent?.includes("is a product of") &&
        actions instanceof HTMLElement &&
        actions.isConnected,
    )
  }, {}, ready.selector)
  return page
}

async function coverage(page) {
  return page.evaluate(() => {
    const bar = document.querySelector(".step-actions")
    const barBox = bar.getBoundingClientRect()
    function hits(el) {
      if (!el) return false
      const box = el.getBoundingClientRect()
      const overlapY = Math.min(barBox.bottom, box.bottom) - Math.max(barBox.top, box.top)
      const overlapX = Math.min(barBox.right, box.right) - Math.max(barBox.left, box.left)
      return overlapY > 0.5 && overlapX > 0.5
    }
    const legal = [...document.querySelectorAll("footer p")].find((el) => el.textContent.includes("is a product of"))
    const id = document.querySelector("[data-testid=filled-from-link], [data-testid=vote-filled], [data-testid=withdraw-escrow]")
    const legalBox = legal.getBoundingClientRect()
    return {
      scrollY: window.scrollY,
      legal: hits(legal),
      id: hits(id),
      legalInView: legalBox.top >= -0.5 && legalBox.bottom <= window.innerHeight + 0.5,
    }
  })
}

describe("guided step footer at 390x844", () => {
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
    // Test-only: server.watcher.close() in the layout and footer-overlap test servers depends on Vite internals. A page reload was observed; QA could not confirm the cause, so this keeps the watcher closed.
    await server.watcher.close()
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

  it.each([
    ["carried-escrow", `?escrow=${ESCROW}`, { click: "[data-testid=task-release] a", selector: "[data-testid=filled-from-link]" }],
    ["release", `release?escrow=${ESCROW}`, { selector: "[data-testid=filled-from-link]" }],
    ["vote", `vote?dispute=${DISPUTE}`, { selector: "[data-testid=vote-filled]" }],
    ["withdraw", "withdraw", { selector: "[data-testid=withdraw-escrow]" }],
  ])("%s keeps the id and the legal line clear of the step footer", async (_name, path, ready) => {
    const page = await openFlow(path, ready)
    try {
      const max = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - window.innerHeight))
      const covered = []
      for (let y = 0; y <= max; y += 24) {
        await page.evaluate((top) => window.scrollTo(0, top), y)
        const view = await coverage(page)
        if (view.legal || view.id) covered.push(view)
      }
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      const bottom = await coverage(page)
      expect(covered).toEqual([])
      expect(bottom.legal).toBe(false)
      expect(bottom.id).toBe(false)
      expect(bottom.legalInView).toBe(true)
    } finally {
      await page.close()
    }
  }, 30_000)
})
