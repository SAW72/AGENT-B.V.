import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  OUT_MARKER_NAME,
  assertSameOutRoot,
  assertWalletAppDir,
  deleteStaleOutEntries,
  isDeployBuild,
  openWalletOutRoot,
  OutDirError,
  resolveWalletOutRoot,
} from "./out-dir.mjs"

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const distRoot = join(realpathSync(appRoot), "dist")
const repoRoot = realpathSync(resolve(appRoot, "../.."))
const realTmp = realpathSync(tmpdir())
const deployRef = "SAW72/AGENT-B.V./.github/workflows/deploy-wallet-ux.yml@refs/heads/main"
const temps = []

afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function track(directory) {
  temps.push(directory)
  return directory
}

function tempRoot() {
  const directory = track(mkdtempSync(join(tmpdir(), "wallet-ux-root-")))
  chmodSync(directory, 0o700)
  return directory
}

function hex() {
  return randomBytes(4).toString("hex")
}

function outputOf(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
}

function childEnv(extra = {}) {
  const env = { ...process.env }
  delete env.CF_PAGES
  delete env.WALLET_UX_DEPLOY
  delete env.GITHUB_WORKFLOW_REF
  return { ...env, ...extra }
}

function runBuild(env) {
  return spawnSync("npm", ["run", "build"], {
    cwd: appRoot,
    env,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  })
}

// vite.config.ts calls resolveWalletOutRoot when the config module loads, so a
// refused override exits before tsc or rollup. assemble-site.mjs opens the same
// root before it copies or deletes. One real `npm run build` stays at the bottom.
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

function refused(env, deps) {
  expect(() => resolveWalletOutRoot(env, appRoot, deps)).toThrow(OutDirError)
  try {
    resolveWalletOutRoot(env, appRoot, deps)
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

function withDistParent(run) {
  const existed = existsSync(distRoot)
  if (!existed) mkdirSync(distRoot, { mode: 0o755 })
  const child = join(distRoot, `case-${hex()}`)
  try {
    run(child)
  } finally {
    rmSync(child, { recursive: true, force: true })
    if (!existed && existsSync(distRoot) && readdirSync(distRoot).length === 0) {
      rmSync(distRoot, { recursive: true, force: true })
    }
  }
}

describe("resolveWalletOutRoot", () => {
  it("uses app dist when WALLET_UX_OUT_DIR is unset or empty and ignores TMPDIR", () => {
    const marker = join(distRoot, OUT_MARKER_NAME)
    const before = existsSync(marker)
    const distExisted = existsSync(distRoot)
    expect(resolveWalletOutRoot({}, appRoot)).toBe(distRoot)
    expect(resolveWalletOutRoot({ WALLET_UX_OUT_DIR: "" }, appRoot)).toBe(distRoot)
    expect(resolveWalletOutRoot({ TMPDIR: "/", WALLET_UX_OUT_DIR: "" }, appRoot)).toBe(distRoot)
    expect(resolveWalletOutRoot({ TMPDIR: "/", HOME: "/" }, appRoot)).toBe(distRoot)
    expect(existsSync(marker)).toBe(before)
    expect(existsSync(distRoot)).toBe(distExisted)
  })

  it("treats an override that canonicalizes to app dist like the default", () => {
    const marker = join(distRoot, OUT_MARKER_NAME)
    const before = existsSync(marker)
    expect(resolveWalletOutRoot({ WALLET_UX_OUT_DIR: "dist" }, appRoot)).toBe(distRoot)
    expect(resolveWalletOutRoot({ WALLET_UX_OUT_DIR: distRoot }, appRoot)).toBe(distRoot)
    expect(existsSync(marker)).toBe(before)
  })

  it("accepts a wallet-ux- tmpdir child and a dist descendant", () => {
    const child = track(mkdtempSync(join(tmpdir(), "wallet-ux-ok-")))
    chmodSync(child, 0o700)
    const got = resolveWalletOutRoot({ WALLET_UX_OUT_DIR: child }, appRoot)
    expect(got).toBe(realpathSync(child))
    const rel = relative(realTmp, got)
    expect(rel !== "" && !rel.startsWith("..") && !rel.includes("/")).toBe(true)
    expect(lstatSync(join(got, OUT_MARKER_NAME)).isFile()).toBe(true)

    withDistParent((distChild) => {
      mkdirSync(distChild, { mode: 0o700 })
      chmodSync(distChild, 0o700)
      expect(resolveWalletOutRoot({ WALLET_UX_OUT_DIR: distChild }, appRoot)).toBe(realpathSync(distChild))
      expect(lstatSync(join(distChild, OUT_MARKER_NAME)).isFile()).toBe(true)
    })
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
    const raw = join(dirname(realTmp), `wallet-ux-outside-${hex()}`)
    try {
      const error = refused({ WALLET_UX_OUT_DIR: raw })
      expect(error.message).toContain("outside the allowed output roots")
      expect(existsSync(raw)).toBe(false)
    } finally {
      if (existsSync(raw)) rmSync(raw, { recursive: true, force: true })
    }
  })

  it("refuses a nested symlink inside tmpdir that points outside tmpdir", () => {
    const pocket = track(mkdtempSync(join(tmpdir(), "wallet-ux-link-")))
    const link = join(pocket, "escape")
    symlinkSync(join(appRoot, "src"), link)
    const error = refused({ WALLET_UX_OUT_DIR: link })
    expect(error.message).toContain("outside the allowed output roots")
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    const deeper = refused({ WALLET_UX_OUT_DIR: join(link, "not-created-yet") })
    expect(deeper.message).toContain(realpathSync(join(appRoot, "src")))
  })

  it("refuses a path with .. that climbs out of tmpdir", () => {
    const pocket = track(mkdtempSync(join(realTmp, "wallet-ux-climb-")))
    // path.join would collapse "..". Keep the segments so the resolver has to.
    const raw = `${pocket}/../../wallet-ux-climbed-out`
    expect(raw.includes("..")).toBe(true)
    const climbed = join(dirname(realTmp), "wallet-ux-climbed-out")
    try {
      const error = refused({ WALLET_UX_OUT_DIR: raw })
      expect(error.message).toContain("outside the allowed output roots")
      expect(existsSync(climbed)).toBe(false)
    } finally {
      if (existsSync(climbed)) rmSync(climbed, { recursive: true, force: true })
    }
  })

  it("refuses any override during a deploy build and still accepts an unset out dir", () => {
    expect(isDeployBuild({})).toBe(false)
    expect(isDeployBuild({ CF_PAGES: "0" })).toBe(false)
    expect(isDeployBuild({ CF_PAGES: "1" })).toBe(true)
    expect(isDeployBuild({ WALLET_UX_DEPLOY: "1" })).toBe(true)
    expect(isDeployBuild({ WALLET_UX_DEPLOY: "true" })).toBe(false)
    expect(isDeployBuild({ GITHUB_WORKFLOW_REF: deployRef })).toBe(true)
    expect(isDeployBuild({ GITHUB_WORKFLOW_REF: "SAW72/AGENT-B.V./.github/workflows/ci.yml@refs/heads/main" })).toBe(false)

    const child = track(mkdtempSync(join(tmpdir(), "wallet-ux-deploy-")))
    for (const env of [
      { CF_PAGES: "1", WALLET_UX_OUT_DIR: child },
      { WALLET_UX_DEPLOY: "1", WALLET_UX_OUT_DIR: child },
      { GITHUB_WORKFLOW_REF: deployRef, WALLET_UX_OUT_DIR: "dist" },
      { CF_PAGES: "1", GITHUB_WORKFLOW_REF: deployRef, WALLET_UX_OUT_DIR: "dist/x" },
    ]) {
      const error = refused(env)
      expect(error.message).toContain("deploy build")
    }
    expect(existsSync(join(child, OUT_MARKER_NAME))).toBe(false)
    expect(resolveWalletOutRoot({ CF_PAGES: "1" }, appRoot)).toBe(distRoot)
    expect(resolveWalletOutRoot({ WALLET_UX_DEPLOY: "1" }, appRoot)).toBe(distRoot)
    expect(resolveWalletOutRoot({ GITHUB_WORKFLOW_REF: deployRef }, appRoot)).toBe(distRoot)
    expect(resolveWalletOutRoot({ CF_PAGES: "1", WALLET_UX_OUT_DIR: "" }, appRoot)).toBe(distRoot)
    expect(resolveWalletOutRoot({ WALLET_UX_DEPLOY: "1", WALLET_UX_OUT_DIR: "" }, appRoot)).toBe(distRoot)
  })
})

describe("temp overrides", () => {
  it("refuses a qa-x basename and a nested wallet-ux path", () => {
    const parent = tempRoot()
    const qa = join(parent, "qa-x")
    mkdirSync(qa, { mode: 0o700 })
    chmodSync(qa, 0o700)
    seedSentinels(qa)
    const nested = join(parent, "wallet-ux-nest", "wallet-ux-child")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, "SENTINEL.txt"), "keep")
    const qaError = (() => {
      try {
        resolveWalletOutRoot({ TMPDIR: parent, WALLET_UX_OUT_DIR: qa }, appRoot)
      } catch (error) {
        return error
      }
      return null
    })()
    expect(qaError).toBeInstanceOf(OutDirError)
    expect(qaError.message).toContain("outside the allowed output roots")
    expect(qaError.message).toContain("wallet-ux-")
    expectSentinels(qa)
    expect(existsSync(join(qa, OUT_MARKER_NAME))).toBe(false)
    expect(() => resolveWalletOutRoot({ TMPDIR: parent, WALLET_UX_OUT_DIR: nested }, appRoot)).toThrow(OutDirError)
    expect(readFileSync(join(nested, "SENTINEL.txt"), "utf8")).toBe("keep")
  })

  it("refuses a .X11-unix basename under a private temp root", () => {
    // The shared /tmp/.X11-unix directory is not used. The basename rule is the same.
    const parent = tempRoot()
    const x11 = join(parent, ".X11-unix")
    mkdirSync(x11, { mode: 0o700 })
    chmodSync(x11, 0o700)
    writeFileSync(join(x11, "SENTINEL.txt"), "keep")
    expect(() => resolveWalletOutRoot({ TMPDIR: parent, WALLET_UX_OUT_DIR: x11 }, appRoot)).toThrow(
      /outside the allowed output roots/,
    )
    expect(readFileSync(join(x11, "SENTINEL.txt"), "utf8")).toBe("keep")
    expect(existsSync(join(x11, OUT_MARKER_NAME))).toBe(false)
  })

  it("refuses a dangling symlink and a symlink to a real directory", () => {
    const parent = tempRoot()
    const dangling = join(parent, "wallet-ux-dangling")
    symlinkSync(join(parent, "missing-target"), dangling)
    expect(() => resolveWalletOutRoot({ TMPDIR: parent, WALLET_UX_OUT_DIR: dangling }, appRoot)).toThrow(/symlink/)
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true)
    expect(existsSync(join(parent, "missing-target"))).toBe(false)

    const target = join(parent, "real-target")
    mkdirSync(target, { mode: 0o700 })
    writeFileSync(join(target, "SENTINEL.txt"), "keep")
    const link = join(parent, "wallet-ux-linked")
    symlinkSync(target, link)
    expect(() => resolveWalletOutRoot({ TMPDIR: parent, WALLET_UX_OUT_DIR: link }, appRoot)).toThrow(/symlink/)
    expect(readFileSync(join(target, "SENTINEL.txt"), "utf8")).toBe("keep")
    expect(readdirSync(target)).toEqual(["SENTINEL.txt"])
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
  })

  it("refuses a non-empty directory without the marker and leaves sentinels", () => {
    const parent = tempRoot()
    const dir = join(parent, "wallet-ux-foreign")
    mkdirSync(dir, { mode: 0o700 })
    chmodSync(dir, 0o700)
    seedSentinels(dir)
    expect(() => resolveWalletOutRoot({ TMPDIR: parent, WALLET_UX_OUT_DIR: dir }, appRoot)).toThrow(
      /not created by wallet-ux/,
    )
    expectSentinels(dir)
    expect(existsSync(join(dir, OUT_MARKER_NAME))).toBe(false)
  })

  it("refuses a mode 0755 directory and does not change it", () => {
    const parent = tempRoot()
    const dir = join(parent, "wallet-ux-open")
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    writeFileSync(join(dir, "SENTINEL.txt"), "keep")
    writeFileSync(join(dir, OUT_MARKER_NAME), "wallet-ux\n", { mode: 0o600 })
    expect(() => resolveWalletOutRoot({ TMPDIR: parent, WALLET_UX_OUT_DIR: dir }, appRoot)).toThrow(/0700/)
    expect(readFileSync(join(dir, "SENTINEL.txt"), "utf8")).toBe("keep")
    expect((lstatSync(dir).mode & 0o777) === 0o755).toBe(true)
  })

  it("accepts an empty 0700 wallet-ux- directory and writes the marker", () => {
    const parent = tempRoot()
    const dir = join(parent, "wallet-ux-empty")
    mkdirSync(dir, { mode: 0o700 })
    chmodSync(dir, 0o700)
    const root = resolveWalletOutRoot({ TMPDIR: parent, WALLET_UX_OUT_DIR: dir }, appRoot)
    expect(root).toBe(realpathSync(dir))
    const dirStat = lstatSync(dir)
    expect(dirStat.isDirectory()).toBe(true)
    expect(dirStat.isSymbolicLink()).toBe(false)
    expect(dirStat.mode & 0o077).toBe(0)
    const marker = lstatSync(join(dir, OUT_MARKER_NAME))
    expect(marker.isFile()).toBe(true)
    expect(marker.isSymbolicLink()).toBe(false)
    expect(marker.mode & 0o077).toBe(0)
    expect(marker.uid).toBe(process.getuid())
  })

  it("creates a missing wallet-ux- directory at 0700 and writes the marker", () => {
    const parent = tempRoot()
    const dir = join(parent, "wallet-ux-created")
    expect(existsSync(dir)).toBe(false)
    const opened = openWalletOutRoot({ TMPDIR: parent, WALLET_UX_OUT_DIR: dir }, appRoot)
    expect(opened.prepared).toBe(true)
    expect(opened.root).toBe(realpathSync(dir))
    expect(opened.dev).toBe(lstatSync(dir).dev)
    expect(opened.ino).toBe(lstatSync(dir).ino)
    expect(lstatSync(dir).mode & 0o077).toBe(0)
    expect(lstatSync(join(dir, OUT_MARKER_NAME)).isFile()).toBe(true)
  })

  it("accepts a directory that already has our marker and keeps other files", () => {
    const parent = tempRoot()
    const dir = join(parent, "wallet-ux-marked")
    mkdirSync(dir, { mode: 0o700 })
    chmodSync(dir, 0o700)
    writeFileSync(join(dir, OUT_MARKER_NAME), "wallet-ux\n", { mode: 0o600 })
    writeFileSync(join(dir, "keep.txt"), "keep")
    const root = resolveWalletOutRoot({ TMPDIR: parent, WALLET_UX_OUT_DIR: dir }, appRoot)
    expect(root).toBe(realpathSync(dir))
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("keep")
    expect(lstatSync(join(dir, OUT_MARKER_NAME)).isFile()).toBe(true)
  })

  it("refuses a foreign owner via an injected lstat", () => {
    // The owner check is injected. Creating a directory owned by another uid needs root.
    const parent = tempRoot()
    const dir = join(parent, "wallet-ux-foreign-uid")
    mkdirSync(dir, { mode: 0o700 })
    chmodSync(dir, 0o700)
    writeFileSync(join(dir, "SENTINEL.txt"), "keep")
    const realUid = lstatSync(dir).uid
    const dirReal = realpathSync(dir)
    const lstat = (path) => {
      const st = lstatSync(path)
      if (path === dir || path === dirReal) return withUid(st, realUid + 1)
      try {
        if (realpathSync(path) === dirReal) return withUid(st, realUid + 1)
      } catch {
        // The path is not a real directory. Keep the original stat.
      }
      return st
    }
    expect(() => resolveWalletOutRoot({ TMPDIR: parent, WALLET_UX_OUT_DIR: dir }, appRoot, { lstat })).toThrow(/owner/)
    expect(readFileSync(join(dir, "SENTINEL.txt"), "utf8")).toBe("keep")
    expect(existsSync(join(dir, OUT_MARKER_NAME))).toBe(false)
  })

  it("refuses a marker that an injected lstat reports as foreign-owned", () => {
    const parent = tempRoot()
    const dir = join(parent, "wallet-ux-marker-uid")
    mkdirSync(dir, { mode: 0o700 })
    chmodSync(dir, 0o700)
    const marker = join(dir, OUT_MARKER_NAME)
    writeFileSync(marker, "wallet-ux\n", { mode: 0o600 })
    writeFileSync(join(dir, "SENTINEL.txt"), "keep")
    const realUid = lstatSync(marker).uid
    const markerReal = realpathSync(marker)
    const lstat = (path) => {
      const st = lstatSync(path)
      if (path === marker || path === markerReal) return withUid(st, realUid + 1)
      try {
        if (realpathSync(path) === markerReal) return withUid(st, realUid + 1)
      } catch {
        // The path is not a real file. Keep the original stat.
      }
      return st
    }
    expect(() => resolveWalletOutRoot({ TMPDIR: parent, WALLET_UX_OUT_DIR: dir }, appRoot, { lstat })).toThrow(
      /marker/,
    )
    expect(readFileSync(join(dir, "SENTINEL.txt"), "utf8")).toBe("keep")
  })

  it("refuses a dist descendant that is a symlink or a non-empty dir without a marker", () => {
    const parent = tempRoot()
    const target = join(parent, "dist-target")
    mkdirSync(target, { mode: 0o700 })
    writeFileSync(join(target, "SENTINEL.txt"), "keep")
    withDistParent((link) => {
      symlinkSync(target, link)
      expect(() => resolveWalletOutRoot({ WALLET_UX_OUT_DIR: link }, appRoot)).toThrow(/symlink/)
      expect(readFileSync(join(target, "SENTINEL.txt"), "utf8")).toBe("keep")
    })
    withDistParent((dir) => {
      mkdirSync(dir, { mode: 0o700 })
      chmodSync(dir, 0o700)
      writeFileSync(join(dir, "SENTINEL.txt"), "keep")
      expect(() => resolveWalletOutRoot({ WALLET_UX_OUT_DIR: dir }, appRoot)).toThrow(/not created by wallet-ux/)
      expect(readFileSync(join(dir, "SENTINEL.txt"), "utf8")).toBe("keep")
      expect(existsSync(join(dir, OUT_MARKER_NAME))).toBe(false)
    })
  })

  it("refuses to empty an app symlink and still deletes other top-level names", () => {
    const parent = tempRoot()
    const dir = join(parent, "wallet-ux-app-link")
    mkdirSync(dir, { mode: 0o700 })
    chmodSync(dir, 0o700)
    const opened = openWalletOutRoot({ TMPDIR: parent, WALLET_UX_OUT_DIR: dir }, appRoot)
    const target = join(parent, "app-target")
    mkdirSync(target, { mode: 0o700 })
    writeFileSync(join(target, "SENTINEL.txt"), "keep")
    symlinkSync(target, join(opened.root, "app"))
    writeFileSync(join(opened.root, "stale-root.txt"), "stale")
    expect(() => assertWalletAppDir(opened.root)).toThrow(/symlink/)
    expect(readFileSync(join(target, "SENTINEL.txt"), "utf8")).toBe("keep")
    deleteStaleOutEntries(opened)
    expect(readFileSync(join(target, "SENTINEL.txt"), "utf8")).toBe("keep")
    expect(lstatSync(join(opened.root, "app")).isSymbolicLink()).toBe(true)
    expect(existsSync(join(opened.root, "stale-root.txt"))).toBe(false)
    expect(existsSync(join(opened.root, OUT_MARKER_NAME))).toBe(true)
  })
})

describe("temp root", () => {
  it("refuses TMPDIR /", () => {
    const parent = tempRoot()
    const ghost = join(parent, "wallet-ux-not-created")
    expect(() => resolveWalletOutRoot({ TMPDIR: "/", WALLET_UX_OUT_DIR: ghost }, appRoot)).toThrow(
      /Refusing temp root/,
    )
    expect(existsSync(ghost)).toBe(false)
  })

  it("refuses TMPDIR equal to the home directory", () => {
    const fakeHome = tempRoot()
    const ghost = join(fakeHome, "qa-not-created")
    expect(existsSync(ghost)).toBe(false)
    expect(() =>
      resolveWalletOutRoot({ TMPDIR: fakeHome, WALLET_UX_OUT_DIR: ghost }, appRoot, { homedir: () => fakeHome }),
    ).toThrow(/Refusing temp root/)
    expect(existsSync(ghost)).toBe(false)
    const realHomeGhost = join(homedir(), `.wallet-ux-not-created-${hex()}`)
    expect(existsSync(realHomeGhost)).toBe(false)
    try {
      expect(() => resolveWalletOutRoot({ TMPDIR: homedir(), WALLET_UX_OUT_DIR: realHomeGhost }, appRoot)).toThrow(
        /Refusing temp root/,
      )
      expect(existsSync(realHomeGhost)).toBe(false)
    } finally {
      if (existsSync(realHomeGhost)) rmSync(realHomeGhost, { recursive: true, force: true })
    }
  })

  it("refuses TMPDIR that is an ancestor of the repo", () => {
    const ancestor = dirname(repoRoot)
    const ghost = join(ancestor, `qa-not-created-${hex()}`)
    expect(existsSync(ghost)).toBe(false)
    try {
      expect(() => resolveWalletOutRoot({ TMPDIR: ancestor, WALLET_UX_OUT_DIR: ghost }, appRoot)).toThrow(
        /Refusing temp root/,
      )
      expect(existsSync(ghost)).toBe(false)
    } finally {
      if (existsSync(ghost)) rmSync(ghost, { recursive: true, force: true })
    }
  })

  it("names the repo when TMPDIR is an ancestor of the repo", () => {
    const ancestor = dirname(repoRoot)
    const ghost = join(ancestor, `qa-repo-named-${hex()}`)
    expect(existsSync(ghost)).toBe(false)
    try {
      let caught = null
      try {
        resolveWalletOutRoot({ TMPDIR: ancestor, WALLET_UX_OUT_DIR: ghost }, appRoot)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(OutDirError)
      expect(caught.message).toContain("contains the repo directory")
      expect(existsSync(ghost)).toBe(false)
    } finally {
      if (existsSync(ghost)) rmSync(ghost, { recursive: true, force: true })
    }
  })

  it("refuses a world-writable temp root without the sticky bit", () => {
    const parent = tempRoot()
    chmodSync(parent, 0o777)
    const child = join(parent, "wallet-ux-child")
    expect(() => resolveWalletOutRoot({ TMPDIR: parent, WALLET_UX_OUT_DIR: child }, appRoot)).toThrow(/sticky/)
    expect(existsSync(child)).toBe(false)
  })

  it("accepts a world-writable temp root that has the sticky bit", () => {
    const parent = tempRoot()
    chmodSync(parent, 0o1777)
    const child = join(parent, "wallet-ux-sticky")
    mkdirSync(child, { mode: 0o700 })
    chmodSync(child, 0o700)
    const root = resolveWalletOutRoot({ TMPDIR: parent, WALLET_UX_OUT_DIR: child }, appRoot)
    expect(root).toBe(realpathSync(child))
    expect(lstatSync(join(child, OUT_MARKER_NAME)).isFile()).toBe(true)
  })

  it("refuses a temp root owned by neither the current user nor root", () => {
    const parent = tempRoot()
    const child = join(parent, "wallet-ux-child")
    const parentReal = realpathSync(parent)
    const lstat = (path) => {
      const st = lstatSync(path)
      if (path === parent || path === parentReal) return withUid(st, 65534)
      return st
    }
    expect(() => resolveWalletOutRoot({ TMPDIR: parent, WALLET_UX_OUT_DIR: child }, appRoot, { lstat })).toThrow(
      /neither the current user nor root/,
    )
    expect(existsSync(child)).toBe(false)
  })
})

describe("assemble-time check", () => {
  it("throws and deletes nothing when the prepared root is swapped for a symlink", () => {
    const parent = tempRoot()
    const dir = join(parent, "wallet-ux-live")
    mkdirSync(dir, { mode: 0o700 })
    chmodSync(dir, 0o700)
    const opened = openWalletOutRoot({ TMPDIR: parent, WALLET_UX_OUT_DIR: dir }, appRoot)
    expect(opened.prepared).toBe(true)
    const sentinel = join(parent, "sentinel-target")
    mkdirSync(sentinel, { mode: 0o700 })
    writeFileSync(join(sentinel, "SENTINEL.txt"), "keep")
    writeFileSync(join(sentinel, "also.txt"), "keep")
    const kept = `${opened.root}-real`
    renameSync(opened.root, kept)
    symlinkSync(sentinel, opened.root)
    expect(() => deleteStaleOutEntries(opened)).toThrow(/symlink/)
    expect(readFileSync(join(sentinel, "SENTINEL.txt"), "utf8")).toBe("keep")
    expect(readdirSync(sentinel).sort()).toEqual(["SENTINEL.txt", "also.txt"].sort())
    expect(existsSync(join(kept, OUT_MARKER_NAME))).toBe(true)
    expect(() => assertSameOutRoot(opened)).toThrow(OutDirError)
  })

  it("keeps the marker and app and removes other top-level entries", () => {
    const parent = tempRoot()
    const dir = join(parent, "wallet-ux-clean")
    mkdirSync(dir, { mode: 0o700 })
    chmodSync(dir, 0o700)
    const opened = openWalletOutRoot({ TMPDIR: parent, WALLET_UX_OUT_DIR: dir }, appRoot)
    writeFileSync(join(opened.root, "stale-root.txt"), "stale")
    mkdirSync(join(opened.root, "app"))
    writeFileSync(join(opened.root, "app", "stale.js"), "stale")
    deleteStaleOutEntries(opened)
    expect(existsSync(join(opened.root, "stale-root.txt"))).toBe(false)
    expect(readFileSync(join(opened.root, "app", "stale.js"), "utf8")).toBe("stale")
    expect(existsSync(join(opened.root, OUT_MARKER_NAME))).toBe(true)
  })
})

describe("build entry points refuse before writing", () => {
  it("refuses an outside directory before vite writes", () => {
    const sentinelDir = track(mkdtempSync(join(appRoot, "..", ".outdir-sentinel-")))
    const sentinel = join(sentinelDir, "sentinel.txt")
    const payload = randomBytes(32)
    writeFileSync(sentinel, payload)
    const result = runViteConfigLoad(childEnv({ WALLET_UX_OUT_DIR: sentinelDir }))
    const output = outputOf(result)
    expect(result.status, output).not.toBe(0)
    expect(output).toContain("outside the allowed output roots")
    expect(output).toContain(sentinelDir)
    expect(readFileSync(sentinel).equals(payload)).toBe(true)
    expect(readdirSync(sentinelDir)).toEqual(["sentinel.txt"])
  })

  it("refuses the QA R1 pre-existing qa-x and wallet-ux-foreign directories", () => {
    const parent = tempRoot()
    const qa = join(parent, "qa-x")
    const foreign = join(parent, "wallet-ux-foreign")
    mkdirSync(qa, { mode: 0o700 })
    mkdirSync(foreign, { mode: 0o700 })
    chmodSync(qa, 0o700)
    chmodSync(foreign, 0o700)
    seedSentinels(qa)
    seedSentinels(foreign)
    const qaEnv = childEnv({ TMPDIR: parent, WALLET_UX_OUT_DIR: qa })
    for (const result of [runViteConfigLoad(qaEnv), runAssemble(qaEnv)]) {
      const output = outputOf(result)
      expect(result.status, output).not.toBe(0)
      expect(output).toContain("OutDirError")
      expectSentinels(qa)
      expectSentinels(foreign)
      expect(existsSync(join(qa, OUT_MARKER_NAME))).toBe(false)
      expect(existsSync(join(foreign, OUT_MARKER_NAME))).toBe(false)
    }
    const foreignEnv = childEnv({ TMPDIR: parent, WALLET_UX_OUT_DIR: foreign })
    for (const result of [runViteConfigLoad(foreignEnv), runAssemble(foreignEnv)]) {
      const output = outputOf(result)
      expect(result.status, output).not.toBe(0)
      expect(output).toContain("not created by wallet-ux")
      expectSentinels(qa)
      expectSentinels(foreign)
      expect(existsSync(join(qa, OUT_MARKER_NAME))).toBe(false)
      expect(existsSync(join(foreign, OUT_MARKER_NAME))).toBe(false)
    }
  })

  it("refuses a HOME-equivalent TMPDIR before emptying an otherwise allowed out dir", () => {
    const fakeHome = tempRoot()
    const out = join(fakeHome, "wallet-ux-r2")
    mkdirSync(out, { mode: 0o700 })
    chmodSync(out, 0o700)
    writeFileSync(join(out, OUT_MARKER_NAME), "wallet-ux\n", { mode: 0o600 })
    seedSentinels(out)
    const env = childEnv({
      HOME: fakeHome,
      TMPDIR: fakeHome,
      WALLET_UX_OUT_DIR: out,
    })
    for (const result of [runViteConfigLoad(env), runAssemble(env)]) {
      const output = outputOf(result)
      expect(result.status, output).not.toBe(0)
      expect(output).toContain("Refusing temp root")
      expectSentinels(out)
      expect(existsSync(join(out, "index.html"))).toBe(false)
      expect(existsSync(join(out, "app", "index.html"))).toBe(false)
    }
  })

  it("refuses WALLET_UX_DEPLOY=1 with an otherwise allowed override and writes nothing", () => {
    const out = track(mkdtempSync(join(tmpdir(), "wallet-ux-deploy-")))
    chmodSync(out, 0o700)
    writeFileSync(join(out, "SENTINEL.txt"), "keep")
    const env = childEnv({ WALLET_UX_OUT_DIR: out, WALLET_UX_DEPLOY: "1" })
    for (const result of [runViteConfigLoad(env), runAssemble(env)]) {
      const output = outputOf(result)
      expect(result.status, output).not.toBe(0)
      expect(output).toContain("deploy build")
      expect(readFileSync(join(out, "SENTINEL.txt"), "utf8")).toBe("keep")
      expect(existsSync(join(out, OUT_MARKER_NAME))).toBe(false)
      expect(existsSync(join(out, "app"))).toBe(false)
      expect(existsSync(join(out, "index.html"))).toBe(false)
    }
  })

  it("refuses CF_PAGES=1 at vite config load and does not create an allowed override", () => {
    const out = track(join(tmpdir(), `wallet-ux-cf-${hex()}`))
    expect(existsSync(out)).toBe(false)
    const result = runViteConfigLoad(childEnv({ WALLET_UX_OUT_DIR: out, CF_PAGES: "1" }))
    const output = outputOf(result)
    expect(result.status, output).not.toBe(0)
    expect(output).toContain("deploy build")
    expect(existsSync(out)).toBe(false)
    expect(existsSync(join(out, OUT_MARKER_NAME))).toBe(false)
    expect(existsSync(join(out, "app"))).toBe(false)
    expect(existsSync(join(out, "index.html"))).toBe(false)
  })

  it("refuses a deploy workflow ref at vite config load and does not create an allowed override", () => {
    const out = track(join(tmpdir(), `wallet-ux-gh-${hex()}`))
    expect(existsSync(out)).toBe(false)
    const result = runViteConfigLoad(childEnv({ WALLET_UX_OUT_DIR: out, GITHUB_WORKFLOW_REF: deployRef }))
    const output = outputOf(result)
    expect(result.status, output).not.toBe(0)
    expect(output).toContain("deploy build")
    expect(existsSync(out)).toBe(false)
    expect(existsSync(join(out, OUT_MARKER_NAME))).toBe(false)
    expect(existsSync(join(out, "app"))).toBe(false)
    expect(existsSync(join(out, "index.html"))).toBe(false)
  })
})

describe("npm run build (single end-to-end)", () => {
  it("empties a prepared wallet-ux directory and keeps the marker", () => {
    const out = track(mkdtempSync(join(tmpdir(), "wallet-ux-")))
    chmodSync(out, 0o700)
    writeFileSync(join(out, OUT_MARKER_NAME), "wallet-ux\n", { mode: 0o600 })
    writeFileSync(join(out, "stale-root.txt"), "stale")
    mkdirSync(join(out, "app"))
    writeFileSync(join(out, "app", "stale.js"), "stale")
    const result = runBuild(childEnv({ WALLET_UX_OUT_DIR: out }))
    const output = outputOf(result)
    expect(result.status, output).toBe(0)
    expect(existsSync(join(out, "stale-root.txt"))).toBe(false)
    expect(existsSync(join(out, "app", "stale.js"))).toBe(false)
    expect(existsSync(join(out, "app", "index.html"))).toBe(true)
    expect(existsSync(join(out, "index.html"))).toBe(true)
    expect(lstatSync(join(out, OUT_MARKER_NAME)).isFile()).toBe(true)
    expect(output).toContain(`wallet-ux output dir: ${realpathSync(out)}`)
    expect(output).toContain(`assembled ${realpathSync(out)}: landing at /, wallet app at /app/`)
  }, 200_000)
})
