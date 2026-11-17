import { execFileSync, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  assertReadyToClean,
  createWalletOutDir,
  deployOutDirSignal,
  isDeployBuild,
  OutDirError,
  readSourceCommit,
  resolveWalletOutRoot,
} from "./out-dir.mjs"

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const distRoot = join(realpathSync(appRoot), "dist")
const realTmp = realpathSync(tmpdir())
const deployRef = "SAW72/AGENT-B.V./.github/workflows/deploy-wallet-ux.yml@refs/heads/main"
const temps = []

afterEach(() => {
  for (const directory of temps.splice(0)) {
    try {
      if (lstatSync(directory).isSymbolicLink()) unlinkSync(directory)
      else rmSync(directory, { recursive: true, force: true })
    } catch {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

function withTmpdir(value, fn) {
  const saved = process.env.TMPDIR
  process.env.TMPDIR = value
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = saved
  }
}

function scriptEnv(overrides) {
  const env = { ...process.env, ...overrides }
  delete env.CF_PAGES
  delete env.GITHUB_WORKFLOW_REF
  return env
}

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

  it("accepts a wallet-ux-out- directory this module created, and a dist descendant", () => {
    const child = createWalletOutDir(appRoot)
    temps.push(child)
    const got = resolveWalletOutRoot({ WALLET_UX_OUT_DIR: child }, appRoot)
    expect(got).toBe(realpathSync(child))
    expect(basename(got)).toMatch(/^wallet-ux-out-[A-Za-z0-9]{6}$/)
    expect(dirname(got)).toBe(realTmp)
    expect(assertReadyToClean(got, appRoot)).toBe(got)
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

  it("refuses '..', '/', $HOME, a symlink, and an unrelated /tmp child", () => {
    const dotdot = refused({ WALLET_UX_OUT_DIR: ".." })
    expect(dotdot.message).toContain("outside the allowed output roots")

    const root = refused({ WALLET_UX_OUT_DIR: "/" })
    expect(root.message).toContain("resolves to /")

    const home = homedir()
    const homeError = refused({ WALLET_UX_OUT_DIR: home })
    expect(homeError.message).toContain(realpathSync(home))

    const real = createWalletOutDir(appRoot)
    temps.push(real)
    const link = join(realTmp, "wallet-ux-out-SymLnk")
    symlinkSync(real, link)
    temps.push(link)
    const linkError = refused({ WALLET_UX_OUT_DIR: link })
    expect(linkError.message).toContain("symlink")
    expect(lstatSync(link).isSymbolicLink()).toBe(true)

    const unrelated = mkdtempSync(join(tmpdir(), "unrelated-"))
    temps.push(unrelated)
    writeFileSync(join(unrelated, "keep.txt"), "keep")
    const unrelatedError = refused({ WALLET_UX_OUT_DIR: unrelated })
    expect(unrelatedError.message).toContain("outside the allowed output roots")
    expect(readFileSync(join(unrelated, "keep.txt"), "utf8")).toBe("keep")

    const wrongPrefix = mkdtempSync(join(tmpdir(), "wallet-ux-ok-"))
    temps.push(wrongPrefix)
    refused({ WALLET_UX_OUT_DIR: wrongPrefix })
  })

  it("refuses a temp root of /, $HOME, the repo, an ancestor, a relative path, or '..'", () => {
    const repoRoot = realpathSync(resolve(appRoot, "../.."))
    expect(existsSync(join(repoRoot, ".git"))).toBe(true)
    const cases = [
      ["/", "resolves to /, which is refused"],
      [homedir(), `$HOME (${realpathSync(homedir())})`],
      [repoRoot, `repo root (${repoRoot})`],
      [appRoot, `app root (${realpathSync(appRoot)})`],
      [dirname(repoRoot), "ancestor of the app root"],
      ["relative-tmp", "must be an absolute path"],
      [`${realTmp}/../${basename(realTmp)}`, "must not contain '..'"],
    ]
    for (const [value, snippet] of cases) {
      withTmpdir(value, () => {
        let caught
        try {
          resolveWalletOutRoot({ WALLET_UX_OUT_DIR: "dist" }, appRoot)
        } catch (error) {
          caught = error
        }
        expect(caught, `TMPDIR=${value}`).toBeInstanceOf(OutDirError)
        expect(caught.message, `TMPDIR=${value}`).toContain(snippet)
      })
    }
  })

  it("prints the resolved out dir and source commit, and exits non-zero when the dir is not expected", () => {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: appRoot, encoding: "utf8" }).trim()
    expect(readSourceCommit(appRoot)).toBe(sha)
    expect(sha).toMatch(/^[0-9a-f]{40}$/)

    const child = createWalletOutDir(appRoot)
    temps.push(child)
    mkdirSync(join(child, "app"), { recursive: true })
    writeFileSync(join(child, "app", "index.html"), "<!doctype html><title>wallet</title>\n")
    writeFileSync(join(child, "stray.txt"), "gone")
    const signal = deployOutDirSignal({ WALLET_UX_OUT_DIR: child }, appRoot)
    expect(signal.outDir).toBe(realpathSync(child))
    expect(signal.commit).toBe(sha)
    expect(assertReadyToClean(signal.outDir, appRoot)).toBe(signal.outDir)

    const built = spawnSync(process.execPath, ["scripts/assemble-site.mjs"], {
      cwd: appRoot,
      env: scriptEnv({ WALLET_UX_OUT_DIR: child }),
      encoding: "utf8",
    })
    const builtOutput = `${built.stdout ?? ""}\n${built.stderr ?? ""}`
    expect(built.status, builtOutput).toBe(0)
    expect(builtOutput).toContain(`wallet-ux output dir: ${signal.outDir}`)
    expect(builtOutput).toContain(`wallet-ux source commit: ${sha}`)
    expect(existsSync(join(child, "stray.txt"))).toBe(false)
    expect(existsSync(join(child, "index.html"))).toBe(true)
    expect(existsSync(join(child, "app/index.html"))).toBe(true)

    const unrelated = mkdtempSync(join(tmpdir(), "unrelated-"))
    temps.push(unrelated)
    writeFileSync(join(unrelated, "keep.txt"), "keep")
    const refusedRun = spawnSync(process.execPath, ["scripts/assemble-site.mjs"], {
      cwd: appRoot,
      env: scriptEnv({ WALLET_UX_OUT_DIR: unrelated }),
      encoding: "utf8",
    })
    const refusedOutput = `${refusedRun.stdout ?? ""}\n${refusedRun.stderr ?? ""}`
    expect(refusedRun.status, refusedOutput).not.toBe(0)
    expect(refusedOutput).toContain(`wallet-ux source commit: ${sha}`)
    expect(refusedOutput).toContain("not the expected")
    expect(readFileSync(join(unrelated, "keep.txt"), "utf8")).toBe("keep")
  })
})
