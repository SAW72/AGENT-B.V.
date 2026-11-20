import { execFileSync, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  assertReadyToClean,
  assertSafeTmpRoot,
  assertWalletAppDir,
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
  vi.restoreAllMocks()
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

function scriptEnv(overrides = {}) {
  const env = { ...process.env }
  // Not a deploy build unless overrides set a signal on purpose. A parent shell
  // may set CF_PAGES, WALLET_UX_DEPLOY, or GITHUB_WORKFLOW_REF (Cloudflare Pages,
  // the manual production signal, or the stale deploy workflow). Those signals
  // refuse any WALLET_UX_OUT_DIR override. Delete first so an intentional signal
  // in overrides still wins.
  delete env.CF_PAGES
  delete env.WALLET_UX_DEPLOY
  delete env.GITHUB_WORKFLOW_REF
  return { ...env, ...overrides }
}

function outputOf(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
}

// vite.config.ts calls resolveWalletOutRoot and assertWalletAppDir when the
// config module loads, so a refused override exits before tsc or rollup.
const viteBin = join(appRoot, "node_modules", "vite", "bin", "vite.js")

function runViteConfigLoad(env) {
  return spawnSync(process.execPath, [viteBin, "build"], {
    cwd: appRoot,
    env,
    encoding: "utf8",
    timeout: 60_000,
  })
}

function runAssemble(env) {
  return spawnSync(process.execPath, ["scripts/assemble-site.mjs"], {
    cwd: appRoot,
    env,
    encoding: "utf8",
    timeout: 60_000,
  })
}

function seedSentinels(dir) {
  mkdirSync(join(dir, "app"), { recursive: true })
  mkdirSync(join(dir, "sub"), { recursive: true })
  writeFileSync(join(dir, "SENTINEL.txt"), "keep")
  writeFileSync(join(dir, "app", "SENTINEL_APP.txt"), "keep")
  writeFileSync(join(dir, "sub", "SENTINEL_SUB.txt"), "keep")
}

function expectSentinels(dir) {
  expect(readFileSync(join(dir, "SENTINEL.txt"), "utf8")).toBe("keep")
  expect(readFileSync(join(dir, "app", "SENTINEL_APP.txt"), "utf8")).toBe("keep")
  expect(readFileSync(join(dir, "sub", "SENTINEL_SUB.txt"), "utf8")).toBe("keep")
}

function withUid(st, uid) {
  return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid })
}

function absentRunDir() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = randomBytes(6)
  let suffix = ""
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length]
  const dir = join(realTmp, `wallet-ux-out-${suffix}`)
  if (existsSync(dir)) return absentRunDir()
  return dir
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
    expect(isDeployBuild({ WALLET_UX_DEPLOY: "1" })).toBe(true)
    expect(isDeployBuild({ WALLET_UX_DEPLOY: "true" })).toBe(false)
    expect(isDeployBuild({ WALLET_UX_DEPLOY: "0" })).toBe(false)
    expect(isDeployBuild({ GITHUB_WORKFLOW_REF: deployRef })).toBe(true)
    expect(isDeployBuild({ GITHUB_WORKFLOW_REF: "SAW72/AGENT-B.V./.github/workflows/ci.yml@refs/heads/main" })).toBe(false)

    const child = mkdtempSync(join(tmpdir(), "wallet-ux-deploy-"))
    temps.push(child)
    for (const env of [
      { CF_PAGES: "1", WALLET_UX_OUT_DIR: child },
      { WALLET_UX_DEPLOY: "1", WALLET_UX_OUT_DIR: child },
      { GITHUB_WORKFLOW_REF: deployRef, WALLET_UX_OUT_DIR: "dist" },
      { CF_PAGES: "1", GITHUB_WORKFLOW_REF: deployRef, WALLET_UX_OUT_DIR: "dist/x" },
    ]) {
      const error = refused(env)
      expect(error.message).toContain("deploy build")
      expect(error.message).toContain("CF_PAGES=1")
      expect(error.message).toContain("WALLET_UX_DEPLOY=1")
      expect(error.message).toContain("/.github/workflows/deploy-wallet-ux.yml@")
    }
    expect(resolveWalletOutRoot({ CF_PAGES: "1" }, appRoot)).toBe(distRoot)
    expect(resolveWalletOutRoot({ WALLET_UX_DEPLOY: "1" }, appRoot)).toBe(distRoot)
    expect(resolveWalletOutRoot({ GITHUB_WORKFLOW_REF: deployRef }, appRoot)).toBe(distRoot)
    expect(resolveWalletOutRoot({ CF_PAGES: "1", WALLET_UX_OUT_DIR: "" }, appRoot)).toBe(distRoot)
    expect(resolveWalletOutRoot({ WALLET_UX_DEPLOY: "1", WALLET_UX_OUT_DIR: "" }, appRoot)).toBe(distRoot)
    expect(resolveWalletOutRoot({ GITHUB_WORKFLOW_REF: deployRef, WALLET_UX_OUT_DIR: "" }, appRoot)).toBe(distRoot)
  })

  it("refuses an outside directory before vite writes", () => {
    // apps/.outdir-sentinel-XXXX is outside apps/wallet-ux and outside tmpdir.
    const sentinelDir = mkdtempSync(join(appRoot, "..", ".outdir-sentinel-"))
    const sentinel = join(sentinelDir, "sentinel.txt")
    const payload = randomBytes(32)
    try {
      writeFileSync(sentinel, payload)
      // Not a deploy build. scriptEnv drops CF_PAGES, WALLET_UX_DEPLOY, and
      // GITHUB_WORKFLOW_REF so this asserts path confinement. A parent CI shell
      // must not turn the failure into the deploy-build refusal instead.
      // Config load calls resolveWalletOutRoot before Vite writes.
      const result = runViteConfigLoad(scriptEnv({ WALLET_UX_OUT_DIR: sentinelDir }))
      const output = outputOf(result)
      expect(result.status, output).not.toBe(0)
      expect(output).toContain("outside the allowed output roots")
      expect(output).toContain(sentinelDir)
      expect(readFileSync(sentinel).equals(payload)).toBe(true)
      expect(readdirSync(sentinelDir)).toEqual(["sentinel.txt"])
    } finally {
      rmSync(sentinelDir, { recursive: true, force: true })
    }
  }, 90_000)

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

describe("assertWalletAppDir", () => {
  it("returns when app is missing or a real directory, and refuses a symlink without following it", () => {
    const missing = createWalletOutDir(appRoot)
    temps.push(missing)
    expect(existsSync(join(missing, "app"))).toBe(false)
    expect(() => assertWalletAppDir(missing)).not.toThrow()

    const real = createWalletOutDir(appRoot)
    temps.push(real)
    mkdirSync(join(real, "app"))
    writeFileSync(join(real, "app", "index.html"), "<!doctype html>\n")
    expect(() => assertWalletAppDir(real)).not.toThrow()
    expect(readFileSync(join(real, "app", "index.html"), "utf8")).toBe("<!doctype html>\n")

    const linked = createWalletOutDir(appRoot)
    temps.push(linked)
    const sentinel = mkdtempSync(join(tmpdir(), "wallet-ux-app-target-"))
    temps.push(sentinel)
    writeFileSync(join(sentinel, "SENTINEL.txt"), "keep")
    const appLink = join(linked, "app")
    symlinkSync(sentinel, appLink)
    let caught
    try {
      assertWalletAppDir(linked)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OutDirError)
    expect(caught.message).toContain(appLink)
    expect(caught.message).toContain("symlink")
    expect(lstatSync(appLink).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(sentinel, "SENTINEL.txt"), "utf8")).toBe("keep")
    expect(readdirSync(sentinel)).toEqual(["SENTINEL.txt"])

    const loaded = runViteConfigLoad(scriptEnv({ WALLET_UX_OUT_DIR: linked }))
    const output = outputOf(loaded)
    expect(loaded.status, output).not.toBe(0)
    expect(output).toContain(appLink)
    expect(output).toContain("symlink")
    expect(readFileSync(join(sentinel, "SENTINEL.txt"), "utf8")).toBe("keep")
    expect(readdirSync(sentinel)).toEqual(["SENTINEL.txt"])
    expect(lstatSync(appLink).isSymbolicLink()).toBe(true)
  }, 90_000)
})

describe("deploy build entry points", () => {
  it("refuses WALLET_UX_DEPLOY=1 for an allowed override and writes nothing", () => {
    const out = createWalletOutDir(appRoot)
    temps.push(out)
    writeFileSync(join(out, "SENTINEL.txt"), "keep")
    const allowed = resolveWalletOutRoot({ WALLET_UX_OUT_DIR: out }, appRoot)
    expect(allowed).toBe(realpathSync(out))

    const unit = refused({ WALLET_UX_DEPLOY: "1", WALLET_UX_OUT_DIR: out })
    expect(unit.message).toContain("deploy build")
    expect(readFileSync(join(out, "SENTINEL.txt"), "utf8")).toBe("keep")
    expect(readdirSync(out)).toEqual(["SENTINEL.txt"])

    const ghost = absentRunDir()
    expect(existsSync(ghost)).toBe(false)
    const ghostError = refused({ WALLET_UX_DEPLOY: "1", WALLET_UX_OUT_DIR: ghost })
    expect(ghostError.message).toContain("deploy build")
    expect(existsSync(ghost)).toBe(false)

    // "true" is not the signal. An allowed override still resolves.
    expect(resolveWalletOutRoot({ WALLET_UX_DEPLOY: "true", WALLET_UX_OUT_DIR: out }, appRoot)).toBe(allowed)
    expect(readdirSync(out)).toEqual(["SENTINEL.txt"])

    const env = scriptEnv({ WALLET_UX_OUT_DIR: out, WALLET_UX_DEPLOY: "1" })
    for (const result of [runViteConfigLoad(env), runAssemble(env)]) {
      const output = outputOf(result)
      expect(result.status, output).not.toBe(0)
      expect(output).toContain("deploy build")
      expect(readFileSync(join(out, "SENTINEL.txt"), "utf8")).toBe("keep")
      expect(readdirSync(out)).toEqual(["SENTINEL.txt"])
      expect(existsSync(join(out, "index.html"))).toBe(false)
      expect(existsSync(join(out, "app"))).toBe(false)
    }
  }, 90_000)

  it("refuses CF_PAGES=1 at vite config load and does not create an allowed override", () => {
    const out = absentRunDir()
    expect(existsSync(out)).toBe(false)
    const result = runViteConfigLoad(scriptEnv({ WALLET_UX_OUT_DIR: out, CF_PAGES: "1" }))
    const output = outputOf(result)
    expect(result.status, output).not.toBe(0)
    expect(output).toContain("deploy build")
    expect(existsSync(out)).toBe(false)
    expect(existsSync(join(out, "app"))).toBe(false)
    expect(existsSync(join(out, "index.html"))).toBe(false)
  }, 90_000)

  it("refuses a deploy workflow ref at vite config load and does not create an allowed override", () => {
    const out = absentRunDir()
    expect(existsSync(out)).toBe(false)
    const result = runViteConfigLoad(scriptEnv({ WALLET_UX_OUT_DIR: out, GITHUB_WORKFLOW_REF: deployRef }))
    const output = outputOf(result)
    expect(result.status, output).not.toBe(0)
    expect(output).toContain("deploy build")
    expect(existsSync(out)).toBe(false)
    expect(existsSync(join(out, "app"))).toBe(false)
    expect(existsSync(join(out, "index.html"))).toBe(false)
  }, 90_000)
})

describe("temp root mode and owner", () => {
  it("refuses a world-writable temp root without the sticky bit and accepts 01777", () => {
    const parent = mkdtempSync(join(tmpdir(), "wallet-ux-mode-"))
    temps.push(parent)
    const saved = lstatSync(parent).mode
    try {
      chmodSync(parent, 0o777)
      withTmpdir(parent, () => {
        expect(resolveWalletOutRoot({}, appRoot)).toBe(distRoot)
        expect(() => resolveWalletOutRoot({ WALLET_UX_OUT_DIR: "dist" }, appRoot)).toThrow(
          /world-writable without the sticky bit/,
        )
      })
      chmodSync(parent, 0o1777)
      withTmpdir(parent, () => {
        expect(resolveWalletOutRoot({}, appRoot)).toBe(distRoot)
        expect(resolveWalletOutRoot({ WALLET_UX_OUT_DIR: "dist" }, appRoot)).toBe(distRoot)
        const child = createWalletOutDir(appRoot)
        temps.push(child)
        expect(basename(child)).toMatch(/^wallet-ux-out-[A-Za-z0-9]{6}$/)
        expect(dirname(child)).toBe(realpathSync(parent))
        expect(resolveWalletOutRoot({ WALLET_UX_OUT_DIR: child }, appRoot)).toBe(realpathSync(child))
      })
    } finally {
      try {
        chmodSync(parent, saved)
      } catch {
        // The directory is removed in afterEach when chmod cannot restore it.
      }
    }
  })

  it("refuses a temp root owned by neither the current user nor root", () => {
    const parent = mkdtempSync(join(tmpdir(), "wallet-ux-owner-"))
    temps.push(parent)
    chmodSync(parent, 0o700)
    const parentReal = realpathSync(parent)
    const foreign = (path) => {
      const st = lstatSync(path)
      if (path === parent || path === parentReal) return withUid(st, 65534)
      return st
    }
    const asRoot = (path) => {
      const st = lstatSync(path)
      if (path === parent || path === parentReal) return withUid(st, 0)
      return st
    }
    withTmpdir(parent, () => {
      expect(assertSafeTmpRoot(appRoot).tmpReal).toBe(parentReal)
      expect(assertSafeTmpRoot(appRoot, { lstat: asRoot }).tmpReal).toBe(parentReal)
      let caught
      try {
        assertSafeTmpRoot(appRoot, { lstat: foreign })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(OutDirError)
      expect(caught.message).toMatch(/neither the current user nor root/)
      expect(caught.message).toContain("65534")
      expect(caught.message).toContain(parentReal)
    })
  })
})

describe("historical R1 directories", () => {
  it("refuses qa-x and a wrong-prefix directory before vite or assemble writes", () => {
    const parent = mkdtempSync(join(tmpdir(), "wallet-ux-r1-"))
    temps.push(parent)
    chmodSync(parent, 0o700)
    const qa = join(parent, "qa-x")
    const foreign = join(parent, "wallet-ux-foreign")
    mkdirSync(qa)
    mkdirSync(foreign)
    seedSentinels(qa)
    seedSentinels(foreign)
    for (const dir of [qa, foreign]) {
      const env = scriptEnv({ TMPDIR: parent, WALLET_UX_OUT_DIR: dir })
      for (const result of [runViteConfigLoad(env), runAssemble(env)]) {
        const output = outputOf(result)
        expect(result.status, output).not.toBe(0)
        expect(output).toContain("outside the allowed output roots")
        expectSentinels(qa)
        expectSentinels(foreign)
        expect(readdirSync(qa).sort()).toEqual(["SENTINEL.txt", "app", "sub"].sort())
        expect(readdirSync(foreign).sort()).toEqual(["SENTINEL.txt", "app", "sub"].sort())
        expect(existsSync(join(dir, "index.html"))).toBe(false)
      }
    }
  }, 90_000)

  it("refuses a .X11-unix basename under a private temp root", () => {
    const parent = mkdtempSync(join(tmpdir(), "wallet-ux-x11-"))
    temps.push(parent)
    chmodSync(parent, 0o700)
    const x11 = join(parent, ".X11-unix")
    mkdirSync(x11, { mode: 0o700 })
    writeFileSync(join(x11, "SENTINEL.txt"), "keep")
    withTmpdir(parent, () => {
      expect(() => resolveWalletOutRoot({ WALLET_UX_OUT_DIR: x11 }, appRoot)).toThrow(/outside the allowed output roots/)
    })
    expect(readFileSync(join(x11, "SENTINEL.txt"), "utf8")).toBe("keep")
    expect(readdirSync(x11)).toEqual(["SENTINEL.txt"])
  })

  it("refuses a dangling symlink and a symlink to a real directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "wallet-ux-linkroot-"))
    temps.push(parent)
    chmodSync(parent, 0o700)
    const dangling = join(parent, "wallet-ux-dangling")
    symlinkSync(join(parent, "missing-target"), dangling)
    withTmpdir(parent, () => {
      expect(() => resolveWalletOutRoot({ WALLET_UX_OUT_DIR: dangling }, appRoot)).toThrow(/symlink/)
    })
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true)
    expect(existsSync(join(parent, "missing-target"))).toBe(false)

    const target = join(parent, "real-target")
    mkdirSync(target)
    writeFileSync(join(target, "SENTINEL.txt"), "keep")
    const link = join(parent, "wallet-ux-linked")
    symlinkSync(target, link)
    withTmpdir(parent, () => {
      expect(() => resolveWalletOutRoot({ WALLET_UX_OUT_DIR: link }, appRoot)).toThrow(/symlink/)
    })
    expect(readFileSync(join(target, "SENTINEL.txt"), "utf8")).toBe("keep")
    expect(readdirSync(target)).toEqual(["SENTINEL.txt"])
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
  })

  it("refuses a HOME-equivalent TMPDIR before emptying an otherwise allowed out dir", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "wallet-ux-home-"))
    temps.push(fakeHome)
    chmodSync(fakeHome, 0o700)
    const out = join(fakeHome, "wallet-ux-out-Home01")
    mkdirSync(out)
    seedSentinels(out)
    const env = scriptEnv({ HOME: fakeHome, TMPDIR: fakeHome, WALLET_UX_OUT_DIR: out })
    for (const result of [runViteConfigLoad(env), runAssemble(env)]) {
      const output = outputOf(result)
      expect(result.status, output).not.toBe(0)
      expect(output).toContain("which is refused")
      expect(output).toContain(realpathSync(fakeHome))
      expectSentinels(out)
      expect(existsSync(join(out, "index.html"))).toBe(false)
      expect(existsSync(join(out, "app", "index.html"))).toBe(false)
    }
  }, 90_000)
})

describe("same-process dev/ino recheck", () => {
  it("refuses to clean when the resolved directory is replaced before delete", () => {
    const out = createWalletOutDir(appRoot)
    temps.push(out)
    mkdirSync(join(out, "app"))
    writeFileSync(join(out, "SENTINEL.txt"), "keep")
    writeFileSync(join(out, "app", "SENTINEL_APP.txt"), "keep")
    const resolved = resolveWalletOutRoot({ WALLET_UX_OUT_DIR: out }, appRoot)
    const listed = lstatSync(resolved)
    const identity = { dev: listed.dev, ino: listed.ino }
    expect(assertReadyToClean(resolved, appRoot, identity)).toBe(resolved)

    const kept = `${resolved}-kept`
    renameSync(resolved, kept)
    temps.push(kept)
    mkdirSync(resolved)
    writeFileSync(join(resolved, "SENTINEL.txt"), "keep")
    mkdirSync(join(resolved, "sub"))
    writeFileSync(join(resolved, "sub", "SENTINEL_SUB.txt"), "keep")
    let caught
    try {
      assertReadyToClean(resolved, appRoot, identity)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OutDirError)
    expect(caught.message).toContain("changed identity")
    expect(readFileSync(join(kept, "SENTINEL.txt"), "utf8")).toBe("keep")
    expect(readFileSync(join(kept, "app", "SENTINEL_APP.txt"), "utf8")).toBe("keep")
    expect(readFileSync(join(resolved, "SENTINEL.txt"), "utf8")).toBe("keep")
    expect(readFileSync(join(resolved, "sub", "SENTINEL_SUB.txt"), "utf8")).toBe("keep")

    rmSync(resolved, { recursive: true, force: true })
    const target = mkdtempSync(join(tmpdir(), "wallet-ux-swap-target-"))
    temps.push(target)
    writeFileSync(join(target, "SENTINEL.txt"), "keep")
    writeFileSync(join(target, "also.txt"), "keep")
    symlinkSync(target, resolved)
    expect(() => assertReadyToClean(resolved, appRoot, identity)).toThrow(OutDirError)
    expect(readFileSync(join(target, "SENTINEL.txt"), "utf8")).toBe("keep")
    expect(readFileSync(join(target, "also.txt"), "utf8")).toBe("keep")
    expect(readdirSync(target).sort()).toEqual(["SENTINEL.txt", "also.txt"].sort())
    expect(lstatSync(resolved).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(kept, "SENTINEL.txt"), "utf8")).toBe("keep")
  })
})

describe("unset out dir skips temp mode checks", () => {
  it("skips the sticky-bit and owner checks when WALLET_UX_OUT_DIR is unset", () => {
    const parent = mkdtempSync(join(tmpdir(), "wallet-ux-unset-"))
    temps.push(parent)
    const saved = lstatSync(parent).mode
    const parentReal = realpathSync(parent)
    const foreign = (path) => {
      const st = lstatSync(path)
      if (path === parent || path === parentReal) return withUid(st, 65534)
      return st
    }
    try {
      chmodSync(parent, 0o700)
      withTmpdir(parent, () => {
        expect(assertSafeTmpRoot(appRoot, { skipModeAndOwner: true, lstat: foreign }).distRoot).toBe(distRoot)
        expect(() => assertSafeTmpRoot(appRoot, { lstat: foreign })).toThrow(/neither the current user nor root/)
      })
      chmodSync(parent, 0o777)
      withTmpdir(parent, () => {
        expect(resolveWalletOutRoot({}, appRoot)).toBe(distRoot)
        expect(resolveWalletOutRoot({ WALLET_UX_OUT_DIR: "" }, appRoot)).toBe(distRoot)
        expect(resolveWalletOutRoot({ WALLET_UX_DEPLOY: "1" }, appRoot)).toBe(distRoot)
        expect(resolveWalletOutRoot({ WALLET_UX_DEPLOY: "1", WALLET_UX_OUT_DIR: "" }, appRoot)).toBe(distRoot)
        expect(() => resolveWalletOutRoot({ WALLET_UX_OUT_DIR: "dist" }, appRoot)).toThrow(/sticky/)
        let caught
        try {
          assertReadyToClean(distRoot, appRoot)
        } catch (error) {
          caught = error
        }
        if (existsSync(distRoot)) {
          expect(caught).toBeUndefined()
        } else {
          expect(caught).toBeInstanceOf(OutDirError)
          expect(caught.message).not.toMatch(/sticky/)
          expect(caught.message).toMatch(/not the expected directory/)
        }
      })
    } finally {
      try {
        chmodSync(parent, saved)
      } catch {
        // afterEach removes the directory when the mode cannot be restored.
      }
    }
  })
})

describe("assemble-site app symlink", () => {
  it("refuses a symlink at app before it writes", () => {
    const out = createWalletOutDir(appRoot)
    temps.push(out)
    const target = mkdtempSync(join(tmpdir(), "wallet-ux-app-assemble-"))
    temps.push(target)
    writeFileSync(join(target, "index.html"), "<!doctype html><title>sentinel</title>\n")
    writeFileSync(join(target, "SENTINEL.txt"), "keep")
    symlinkSync(target, join(out, "app"))
    const before = readdirSync(target).sort()
    const result = runAssemble(scriptEnv({ WALLET_UX_OUT_DIR: out }))
    const output = outputOf(result)
    expect(result.status, output).not.toBe(0)
    expect(output).toContain(join(out, "app"))
    expect(output).toContain("symlink")
    expect(readdirSync(target).sort()).toEqual(before)
    expect(existsSync(join(target, "assets", "404.html"))).toBe(false)
    expect(readFileSync(join(target, "SENTINEL.txt"), "utf8")).toBe("keep")
    expect(lstatSync(join(out, "app")).isSymbolicLink()).toBe(true)
  }, 90_000)
})

describe("dedicated run dir guards", () => {
  it("refuses a correctly named, empty run dir owned by someone else", () => {
    // The temp root must be root-owned, or mocking getuid also fails the temp-root
    // owner check and never reaches verifyOwnedDirectory. /tmp is that root here.
    const candidates = []
    try {
      candidates.push(realpathSync(tmpdir()))
    } catch {
      // The process temp dir is checked below.
    }
    try {
      candidates.push(realpathSync("/tmp"))
    } catch {
      // /tmp is absent. The assertion below reports that.
    }
    let rootOwned = null
    for (const dir of candidates) {
      const st = lstatSync(dir)
      if (st.isDirectory() && !st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o1000) !== 0) {
        rootOwned = dir
        break
      }
    }
    expect(rootOwned, "a root-owned sticky temp root").toBeTruthy()
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    const bytes = randomBytes(6)
    let suffix = ""
    for (const byte of bytes) suffix += alphabet[byte % alphabet.length]
    const dir = join(rootOwned, `wallet-ux-out-${suffix}`)
    expect(existsSync(dir)).toBe(false)
    withTmpdir(rootOwned, () => {
      mkdirSync(dir, { mode: 0o700 })
      temps.push(dir)
      const realUid = process.getuid()
      vi.spyOn(process, "getuid").mockReturnValue(realUid + 4242)
      try {
        expect(() => resolveWalletOutRoot({ WALLET_UX_OUT_DIR: dir }, appRoot)).toThrow(OutDirError)
        expect(() => assertReadyToClean(dir, appRoot)).toThrow(/not owned by uid/)
        expect(readdirSync(dir)).toEqual([])
      } finally {
        vi.restoreAllMocks()
      }
    })
  })

  it("refuses a nested run dir and wrong-length or wrong-charset names", () => {
    const outer = mkdtempSync(join(realTmp, "wallet-ux-out-"))
    temps.push(outer)
    const inner = mkdtempSync(join(outer, "wallet-ux-out-"))
    expect(() => resolveWalletOutRoot({ WALLET_UX_OUT_DIR: inner }, appRoot)).toThrow(OutDirError)
    expect(basename(inner)).toMatch(/^wallet-ux-out-[A-Za-z0-9]{6}$/)
    expect(dirname(inner)).not.toBe(realTmp)
    for (const name of ["wallet-ux-out-AAAAA", "wallet-ux-out-AAAAAAA", "wallet-ux-out-AA_AAA", "wallet-ux-out-AAAAA."]) {
      const dir = join(realTmp, name)
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { mode: 0o700 })
      temps.push(dir)
      expect(() => resolveWalletOutRoot({ WALLET_UX_OUT_DIR: dir }, appRoot), name).toThrow(OutDirError)
      expect(readdirSync(dir)).toEqual([])
    }
  })

  it("refuses a string-prefix sibling of dist", () => {
    const sibling = join(appRoot, "dist-qa-sibling")
    mkdirSync(sibling, { recursive: true })
    temps.push(sibling)
    writeFileSync(join(sibling, "SENTINEL.txt"), "keep")
    expect(() => resolveWalletOutRoot({ WALLET_UX_OUT_DIR: sibling }, appRoot)).toThrow(OutDirError)
    expect(readFileSync(join(sibling, "SENTINEL.txt"), "utf8")).toBe("keep")
    expect(readdirSync(sibling)).toEqual(["SENTINEL.txt"])
  })
})
