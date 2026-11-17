import { execFileSync, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  assertReadyToClean,
  cleanVerifiedAppOut,
  createWalletOutDir,
  deployOutDirSignal,
  isDeployBuild,
  OutDirError,
  prepareViteOutDir,
  readSourceCommit,
  resolveWalletOutRoot,
  WALLET_OUT_MARKER,
  WALLET_OUT_OVERRIDE_ENV,
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

function allowOverride(env = {}) {
  return { [WALLET_OUT_OVERRIDE_ENV]: "1", ...env }
}

function scriptEnv(overrides) {
  const env = { ...process.env, [WALLET_OUT_OVERRIDE_ENV]: "1", ...overrides }
  delete env.CF_PAGES
  delete env.GITHUB_WORKFLOW_REF
  return env
}

function productionEnv(overrides) {
  const env = scriptEnv(overrides)
  delete env[WALLET_OUT_OVERRIDE_ENV]
  return env
}

function refused(env) {
  const withFlag = allowOverride(env)
  expect(() => resolveWalletOutRoot(withFlag, appRoot)).toThrow(OutDirError)
  try {
    resolveWalletOutRoot(withFlag, appRoot)
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
    const got = resolveWalletOutRoot(allowOverride({ WALLET_UX_OUT_DIR: child }), appRoot)
    expect(got).toBe(realpathSync(child))
    expect(basename(got)).toMatch(/^wallet-ux-out-[A-Za-z0-9]{6}$/)
    expect(dirname(got)).toBe(realTmp)
    expect(assertReadyToClean(got, appRoot)).toBe(got)
    const marker = readFileSync(join(got, WALLET_OUT_MARKER), "utf8")
    expect(marker).toMatch(/^[0-9a-f]{64}\n[0-9a-f]{64}\n$/)
    const [nonce, binding] = marker.split("\n")
    const expectedBinding = createHash("sha256").update(nonce, "utf8").update("\n", "utf8").update(got, "utf8").digest("hex")
    expect(binding).toBe(expectedBinding)
    const rel = relative(realTmp, got)
    expect(rel !== "" && !rel.startsWith("..")).toBe(true)
    expect(resolveWalletOutRoot(allowOverride({ WALLET_UX_OUT_DIR: "dist" }), appRoot)).toBe(distRoot)
    expect(resolveWalletOutRoot(allowOverride({ WALLET_UX_OUT_DIR: "dist/x" }), appRoot)).toBe(join(distRoot, "x"))
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
    expect(error.message).toContain("contains '..'")
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
      const env = allowOverride({ ...process.env, WALLET_UX_OUT_DIR: sentinelDir })
      // Not a deploy build. Drop CF_PAGES and GITHUB_WORKFLOW_REF so this asserts
      // path confinement. A parent CI shell must not turn the failure into the
      // deploy-build refusal instead. The test-only flag is set so this reaches
      // the path check rather than the production-build refusal.
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
    expect(dotdot.message).toContain("contains '..'")

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
          resolveWalletOutRoot(allowOverride({ WALLET_UX_OUT_DIR: "dist" }), appRoot)
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
    const printed = readSourceCommit(appRoot)
    expect(printed === sha || printed === `${sha}-dirty`).toBe(true)
    expect(sha).toMatch(/^[0-9a-f]{40}$/)

    const child = createWalletOutDir(appRoot)
    temps.push(child)
    mkdirSync(join(child, "app"), { recursive: true })
    writeFileSync(join(child, "app", "index.html"), "<!doctype html><title>wallet</title>\n")
    writeFileSync(join(child, "stray.txt"), "gone")
    const signal = deployOutDirSignal(allowOverride({ WALLET_UX_OUT_DIR: child }), appRoot)
    expect(signal.outDir).toBe(realpathSync(child))
    expect(signal.commit).toBe(printed)
    expect(assertReadyToClean(signal.outDir, appRoot)).toBe(signal.outDir)

    const built = spawnSync(process.execPath, ["scripts/assemble-site.mjs"], {
      cwd: appRoot,
      env: scriptEnv({ WALLET_UX_OUT_DIR: child }),
      encoding: "utf8",
    })
    const builtOutput = `${built.stdout ?? ""}\n${built.stderr ?? ""}`
    expect(built.status, builtOutput).toBe(0)
    expect(builtOutput).toContain(`wallet-ux output dir: ${signal.outDir}`)
    expect(builtOutput).toContain(`wallet-ux source commit: ${printed}`)
    expect(builtOutput).toContain(`wallet-ux pre-delete check: ${signal.outDir}`)
    expect(existsSync(join(child, "stray.txt"))).toBe(false)
    expect(existsSync(join(child, WALLET_OUT_MARKER))).toBe(false)
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
    expect(refusedOutput).toContain(`wallet-ux source commit: ${printed}`)
    expect(refusedOutput).toContain("not the expected")
    expect(refusedOutput).not.toContain("wallet-ux pre-delete check:")
    expect(readFileSync(join(unrelated, "keep.txt"), "utf8")).toBe("keep")
  })

  it("refuses an override that contains '..' even when the path resolves inside dist", () => {
    const error = refused({ WALLET_UX_OUT_DIR: "dist/../dist" })
    expect(error.message).toContain("contains '..'")
    expect(error.message).toContain("dist/../dist")
  })

  it("marks the printed source commit dirty when the work tree has uncommitted changes", () => {
    const repo = mkdtempSync(join(realTmp, "wallet-ux-git-"))
    temps.push(repo)
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Out Dir Test",
      GIT_AUTHOR_EMAIL: "outdir-test@example.com",
      GIT_COMMITTER_NAME: "Out Dir Test",
      GIT_COMMITTER_EMAIL: "outdir-test@example.com",
    }
    const git = (args) =>
      execFileSync("git", args, {
        cwd: repo,
        env: gitEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
    git(["init", "-b", "main"])
    writeFileSync(join(repo, "README"), "one\n")
    git(["add", "README"])
    git(["commit", "-m", "init"])
    const sha = git(["rev-parse", "HEAD"]).trim()
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(readSourceCommit(repo)).toBe(sha)
    writeFileSync(join(repo, "README"), "two\n")
    expect(readSourceCommit(repo)).toBe(`${sha}-dirty`)
  })

  it("refuses a stray WALLET_UX_OUT_DIR on a production build and deletes nothing", () => {
    const child = createWalletOutDir(appRoot)
    temps.push(child)
    writeFileSync(join(child, "keep.txt"), "keep")
    expect(() => resolveWalletOutRoot({ WALLET_UX_OUT_DIR: child }, appRoot)).toThrow(/production build/)
    expect(() => resolveWalletOutRoot({ WALLET_UX_OUT_DIR: child }, appRoot)).toThrow(/exits non-zero/)

    const assembled = spawnSync(process.execPath, ["scripts/assemble-site.mjs"], {
      cwd: appRoot,
      env: productionEnv({ WALLET_UX_OUT_DIR: child }),
      encoding: "utf8",
    })
    const assembledOutput = `${assembled.stdout ?? ""}\n${assembled.stderr ?? ""}`
    expect(assembled.status, assembledOutput).not.toBe(0)
    expect(assembledOutput).toContain("production build")
    expect(assembledOutput).toContain("exits non-zero")
    expect(readFileSync(join(child, "keep.txt"), "utf8")).toBe("keep")
    expect(existsSync(join(child, WALLET_OUT_MARKER))).toBe(true)

    const viteBin = join(appRoot, "node_modules/vite/bin/vite.js")
    const viteRun = spawnSync(process.execPath, [viteBin, "build"], {
      cwd: appRoot,
      env: productionEnv({ WALLET_UX_OUT_DIR: child }),
      encoding: "utf8",
      timeout: 90_000,
    })
    const viteOutput = `${viteRun.stdout ?? ""}\n${viteRun.stderr ?? ""}`
    expect(viteRun.status, viteOutput).not.toBe(0)
    expect(viteOutput).toContain("production build")
    expect(readFileSync(join(child, "keep.txt"), "utf8")).toBe("keep")
    expect(existsSync(join(child, "app"))).toBe(false)
  }, 120_000)

  it("reaches the pre-delete check and refuses a hand-made run directory with nothing deleted", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    const bytes = randomBytes(6)
    let suffix = ""
    for (let i = 0; i < 6; i += 1) suffix += alphabet[bytes[i] % alphabet.length]
    const handmade = join(realTmp, `wallet-ux-out-${suffix}`)
    mkdirSync(handmade)
    temps.push(handmade)
    mkdirSync(join(handmade, "app"))
    writeFileSync(join(handmade, "app", "index.html"), "<!doctype html><title>wallet</title>\n")
    writeFileSync(join(handmade, "keep.txt"), "keep")
    const resolved = realpathSync(handmade)

    expect(resolveWalletOutRoot(allowOverride({ WALLET_UX_OUT_DIR: resolved }), appRoot)).toBe(resolved)
    expect(() => assertReadyToClean(resolved, appRoot)).toThrow(/no creation marker/)

    const run = spawnSync(process.execPath, ["scripts/assemble-site.mjs"], {
      cwd: appRoot,
      env: scriptEnv({ WALLET_UX_OUT_DIR: resolved }),
      encoding: "utf8",
    })
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`
    expect(run.status, output).not.toBe(0)
    expect(output).toContain("no creation marker")
    expect(output).toContain(`wallet-ux output dir: ${resolved}`)
    expect(output).not.toContain("wallet-ux pre-delete check:")
    expect(readFileSync(join(handmade, "keep.txt"), "utf8")).toBe("keep")
    expect(existsSync(join(handmade, "app/index.html"))).toBe(true)

    const nonce = randomBytes(32).toString("hex")
    const wrong = createHash("sha256").update("different-path", "utf8").digest("hex")
    writeFileSync(join(handmade, WALLET_OUT_MARKER), `${nonce}\n${wrong}\n`)
    expect(() => assertReadyToClean(resolved, appRoot)).toThrow(/does not match this directory/)
    const mismatched = spawnSync(process.execPath, ["scripts/assemble-site.mjs"], {
      cwd: appRoot,
      env: scriptEnv({ WALLET_UX_OUT_DIR: resolved }),
      encoding: "utf8",
    })
    const mismatchedOutput = `${mismatched.stdout ?? ""}\n${mismatched.stderr ?? ""}`
    expect(mismatched.status, mismatchedOutput).not.toBe(0)
    expect(mismatchedOutput).toContain("does not match this directory")
    expect(readFileSync(join(handmade, "keep.txt"), "utf8")).toBe("keep")
  })

  it("refuses a symlinked dist before Vite writes and leaves the decoy in place", () => {
    const fixture = mkdtempSync(join(appRoot, ".outdir-fixture-"))
    temps.push(fixture)
    const decoy = mkdtempSync(join(realTmp, "wallet-ux-decoy-"))
    temps.push(decoy)
    mkdirSync(join(decoy, "app"))
    writeFileSync(join(decoy, "app", "keep.txt"), "keep-app")
    writeFileSync(join(decoy, "top.txt"), "keep-top")
    symlinkSync(decoy, join(fixture, "dist"))

    expect(() => prepareViteOutDir({}, fixture)).toThrow(/is a symlink/)
    expect(() => cleanVerifiedAppOut(join(fixture, "dist"), fixture)).toThrow(/is a symlink/)
    expect(readFileSync(join(decoy, "app", "keep.txt"), "utf8")).toBe("keep-app")
    expect(readFileSync(join(decoy, "top.txt"), "utf8")).toBe("keep-top")
    expect(lstatSync(join(fixture, "dist")).isSymbolicLink()).toBe(true)

    const configSource = readFileSync(join(appRoot, "vite.config.ts"), "utf8")
    expect(configSource).toContain("prepareViteOutDir(process.env, appRoot)")
    expect(configSource).toContain("emptyOutDir: prepared.emptyOutDir")
  })

  it("cleans only the verified app directory and leaves emptyOutDir false", () => {
    const fixture = mkdtempSync(join(appRoot, ".outdir-fixture-"))
    temps.push(fixture)
    const dist = join(fixture, "dist")
    mkdirSync(join(dist, "app"), { recursive: true })
    writeFileSync(join(dist, "app", "stale.txt"), "stale")
    writeFileSync(join(dist, "keep.txt"), "keep-root")
    const outside = mkdtempSync(join(realTmp, "wallet-ux-outside-"))
    temps.push(outside)
    writeFileSync(join(outside, "keep.txt"), "keep-outside")

    const prepared = prepareViteOutDir({}, fixture)
    expect(prepared.emptyOutDir).toBe(false)
    expect(prepared.outRoot).toBe(realpathSync(dist))
    cleanVerifiedAppOut(prepared.outRoot, fixture)
    expect(existsSync(join(dist, "app", "stale.txt"))).toBe(false)
    expect(existsSync(join(dist, "app"))).toBe(true)
    expect(readFileSync(join(dist, "keep.txt"), "utf8")).toBe("keep-root")
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep-outside")
  })

  it("refuses the pre-delete check for a symlink path and a path that still contains '..'", () => {
    const pocket = mkdtempSync(join(realTmp, "wallet-ux-link-"))
    temps.push(pocket)
    const target = mkdtempSync(join(realTmp, "wallet-ux-target-"))
    temps.push(target)
    writeFileSync(join(target, "keep.txt"), "keep")
    const link = join(pocket, "linked")
    symlinkSync(target, link)
    temps.push(link)
    expect(() => assertReadyToClean(link, appRoot)).toThrow(/is a symlink/)
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep")

    const spelled = `${distRoot}/../dist`
    expect(spelled.includes("..")).toBe(true)
    expect(() => assertReadyToClean(spelled, appRoot)).toThrow(OutDirError)
  })
})
