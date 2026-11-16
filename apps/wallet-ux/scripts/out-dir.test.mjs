import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { isDeployBuild, OutDirError, resolveWalletOutRoot } from "./out-dir.mjs"

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const distRoot = join(realpathSync(appRoot), "dist")
const realTmp = realpathSync(tmpdir())
const deployRef = "SAW72/AGENT-B.V./.github/workflows/deploy-wallet-ux.yml@refs/heads/main"
const temps = []

afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function refused(env) {
  expect(() => resolveWalletOutRoot(env, appRoot)).toThrow(OutDirError)
  try {
    resolveWalletOutRoot(env, appRoot)
  } catch (error) {
    expect(error).toBeInstanceOf(OutDirError)
    expect(error.message).toContain(env.WALLET_UX_OUT_DIR)
    expect(error.message).toContain(realTmp)
    expect(error.message).toContain(distRoot)
    expect(error.message).toMatch(/resolves to \S|resolved \S/)
    return error
  }
  throw new Error("unreachable")
}

describe("resolveWalletOutRoot", () => {
  it("uses app dist when WALLET_UX_OUT_DIR is unset or empty", () => {
    expect(resolveWalletOutRoot({}, appRoot)).toBe(distRoot)
    expect(resolveWalletOutRoot({ WALLET_UX_OUT_DIR: "" }, appRoot)).toBe(distRoot)
  })

  it("accepts a tmpdir child and a dist descendant", () => {
    const child = mkdtempSync(join(tmpdir(), "wallet-ux-ok-"))
    temps.push(child)
    const got = resolveWalletOutRoot({ WALLET_UX_OUT_DIR: child }, appRoot)
    expect(got).toBe(realpathSync(child))
    const rel = relative(realTmp, got)
    expect(rel !== "" && !rel.startsWith("..")).toBe(true)
    expect(resolveWalletOutRoot({ WALLET_UX_OUT_DIR: "dist" }, appRoot)).toBe(distRoot)
    expect(resolveWalletOutRoot({ WALLET_UX_OUT_DIR: "dist/x" }, appRoot)).toBe(join(distRoot, "x"))
  })

  it("refuses tmpdir itself, the app root, a climb out, and other app folders", () => {
    refused({ WALLET_UX_OUT_DIR: tmpdir() })
    refused({ WALLET_UX_OUT_DIR: realTmp })
    refused({ WALLET_UX_OUT_DIR: appRoot })
    refused({ WALLET_UX_OUT_DIR: "../../" })
    refused({ WALLET_UX_OUT_DIR: "src" })
    refused({ WALLET_UX_OUT_DIR: join(appRoot, "src") })
    refused({ WALLET_UX_OUT_DIR: "landing" })
    refused({ WALLET_UX_OUT_DIR: "scripts" })
    refused({ WALLET_UX_OUT_DIR: "node_modules" })
  })

  it("refuses an absolute sibling of tmpdir", () => {
    const raw = join(dirname(realTmp), `wallet-ux-outside-${randomBytes(4).toString("hex")}`)
    const error = refused({ WALLET_UX_OUT_DIR: raw })
    expect(error.message).toContain("outside the allowed output roots")
  })

  it("refuses a symlink inside tmpdir that points outside tmpdir", () => {
    const pocket = mkdtempSync(join(tmpdir(), "wallet-ux-link-"))
    temps.push(pocket)
    const link = join(pocket, "escape")
    symlinkSync(join(appRoot, "src"), link)
    const error = refused({ WALLET_UX_OUT_DIR: link })
    expect(error.message).toContain(realpathSync(join(appRoot, "src")))
    const deeper = refused({ WALLET_UX_OUT_DIR: join(link, "not-created-yet") })
    expect(deeper.message).toContain(realpathSync(join(appRoot, "src")))
  })

  it("refuses a path with .. that climbs out of tmpdir", () => {
    const pocket = mkdtempSync(join(realTmp, "wallet-ux-climb-"))
    temps.push(pocket)
    // path.join would collapse "..". Keep the segments so the resolver has to.
    const raw = `${pocket}/../../wallet-ux-climbed-out`
    expect(raw.includes("..")).toBe(true)
    const error = refused({ WALLET_UX_OUT_DIR: raw })
    expect(error.message).toContain("outside the allowed output roots")
  })

  it("refuses any override during a deploy build and still accepts an unset out dir", () => {
    expect(isDeployBuild({})).toBe(false)
    expect(isDeployBuild({ CF_PAGES: "0" })).toBe(false)
    expect(isDeployBuild({ CF_PAGES: "1" })).toBe(true)
    expect(isDeployBuild({ GITHUB_WORKFLOW_REF: deployRef })).toBe(true)
    expect(isDeployBuild({ GITHUB_WORKFLOW_REF: "SAW72/AGENT-B.V./.github/workflows/ci.yml@refs/heads/main" })).toBe(false)

    const child = mkdtempSync(join(tmpdir(), "wallet-ux-deploy-"))
    temps.push(child)
    for (const env of [
      { CF_PAGES: "1", WALLET_UX_OUT_DIR: child },
      { GITHUB_WORKFLOW_REF: deployRef, WALLET_UX_OUT_DIR: "dist" },
      { CF_PAGES: "1", GITHUB_WORKFLOW_REF: deployRef, WALLET_UX_OUT_DIR: "dist/x" },
    ]) {
      const error = refused(env)
      expect(error.message).toContain("deploy build")
    }
    expect(resolveWalletOutRoot({ CF_PAGES: "1" }, appRoot)).toBe(distRoot)
    expect(resolveWalletOutRoot({ GITHUB_WORKFLOW_REF: deployRef }, appRoot)).toBe(distRoot)
    expect(resolveWalletOutRoot({ CF_PAGES: "1", WALLET_UX_OUT_DIR: "" }, appRoot)).toBe(distRoot)
  })

  it("refuses an outside directory before vite writes", () => {
    // apps/.outdir-sentinel-XXXX is outside apps/wallet-ux and outside tmpdir.
    const sentinelDir = mkdtempSync(join(appRoot, "..", ".outdir-sentinel-"))
    const sentinel = join(sentinelDir, "sentinel.txt")
    const payload = randomBytes(32)
    try {
      writeFileSync(sentinel, payload)
      const env = { ...process.env, WALLET_UX_OUT_DIR: sentinelDir }
      // Not a deploy build. Drop CF_PAGES and GITHUB_WORKFLOW_REF so this asserts
      // path confinement. A parent CI shell must not turn the failure into the
      // deploy-build refusal instead.
      delete env.CF_PAGES
      delete env.GITHUB_WORKFLOW_REF
      const result = spawnSync("npm", ["run", "build"], {
        cwd: appRoot,
        env,
        encoding: "utf8",
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
      })
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      expect(result.status, output).not.toBe(0)
      expect(output).toContain("outside the allowed output roots")
      expect(output).toContain(sentinelDir)
      expect(readFileSync(sentinel).equals(payload)).toBe(true)
      expect(readdirSync(sentinelDir)).toEqual(["sentinel.txt"])
    } finally {
      rmSync(sentinelDir, { recursive: true, force: true })
    }
  }, 200_000)
})
