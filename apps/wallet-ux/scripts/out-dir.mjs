// Confines WALLET_UX_OUT_DIR. assemble-site deletes every top-level entry in the
// out root except "app" and the marker, so an override may only be:
// - <app>/dist exactly (same path as an unset override, no extra checks), or
// - a strict descendant of <app>/dist, or
// - a direct child of the validated temp root whose name starts with "wallet-ux-".
// Descendants and temp children must be real directories we created: owner is
// the current user, mode is 0700 (no group or other bits), and either the
// directory is empty or it already holds the ".wallet-ux-out" marker.
// The final path component is lstat'd and never followed.
//
// Deploy-build signals. A build is a deploy build when any signal is set:
// - CF_PAGES === "1" (Cloudflare Pages build environment)
// - WALLET_UX_DEPLOY === "1" (manual production build; see CLOUDFLARE_PAGES.md)
// - GITHUB_WORKFLOW_REF contains "/.github/workflows/deploy-wallet-ux.yml@"
//   (the stale deploy workflow)
// Deploy builds refuse every override. Unset still writes <app>/dist.
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

const DEPLOY_WORKFLOW_MARKER = "/.github/workflows/deploy-wallet-ux.yml@"
export const OUT_MARKER_NAME = ".wallet-ux-out"
const MARKER_BODY = "wallet-ux\n"
const GROUP_OR_OTHER = 0o077
const WORLD_WRITABLE = 0o002
const STICKY = 0o1000

export class OutDirError extends Error {
  constructor(message) {
    super(message)
    this.name = "OutDirError"
  }
}

export function isDeployBuild(env = process.env) {
  if (env.CF_PAGES === "1") return true
  if (env.WALLET_UX_DEPLOY === "1") return true
  const ref = env.GITHUB_WORKFLOW_REF
  return typeof ref === "string" && ref.includes(DEPLOY_WORKFLOW_MARKER)
}

function fsDeps(overrides = {}) {
  return {
    lstat: overrides.lstat ?? lstatSync,
    realpath: overrides.realpath ?? realpathSync,
    mkdir: overrides.mkdir ?? mkdirSync,
    chmod: overrides.chmod ?? chmodSync,
    writeFile: overrides.writeFile ?? writeFileSync,
    readdir: overrides.readdir ?? readdirSync,
    homedir: overrides.homedir ?? homedir,
    getuid:
      overrides.getuid ??
      (() => {
        if (typeof process.getuid !== "function") return null
        const uid = process.getuid()
        return uid == null ? null : uid
      }),
  }
}

function errorCode(error) {
  if (error && typeof error === "object" && "code" in error) return error.code
  return undefined
}

function errorText(error) {
  const code = errorCode(error)
  if (code) return String(code)
  return error instanceof Error ? error.message : String(error)
}

function octalMode(mode) {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`
}

// path.relative, not a string prefix. "" is the parent itself.
function isStrictDescendant(parent, child) {
  const rel = relative(parent, child)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

function isSameOrDescendant(parent, child) {
  const rel = relative(parent, child)
  return !isAbsolute(rel) && !rel.startsWith("..")
}

function isDirectChild(parent, child) {
  const rel = relative(parent, child)
  return rel !== "" && rel !== "." && rel !== ".." && !rel.includes("/") && !rel.includes("\\") && !isAbsolute(rel)
}

// Node's os.tmpdir() reads process.env. Read the passed env when it names a
// temp variable so tests can pin TMPDIR without mutating the process.
function rawTempFromEnv(env) {
  const has = (key) => Object.prototype.hasOwnProperty.call(env, key)
  if (has("TMPDIR") || has("TMP") || has("TEMP")) {
    const path = env.TMPDIR || env.TMP || env.TEMP || "/tmp"
    if (path.length > 1 && (path.endsWith("/") || path.endsWith("\\"))) {
      return path.replace(/[/\\]+$/, "") || path
    }
    return path
  }
  return tmpdir()
}

function appDistRoot(appRoot, fs) {
  let appReal
  try {
    appReal = fs.realpath(appRoot)
  } catch (error) {
    throw new OutDirError(`Cannot resolve the app root (${errorText(error)}).`)
  }
  return { appReal, distRoot: join(appReal, "dist") }
}

// realpath the parent only. The final component is not followed.
function locate(raw, appRoot, fs) {
  const abs = resolve(appRoot, raw)
  const parent = dirname(abs)
  const base = basename(abs)
  if (!base) return abs
  let parentReal
  try {
    parentReal = fs.realpath(parent)
  } catch (error) {
    throw new OutDirError(
      `WALLET_UX_OUT_DIR ${JSON.stringify(raw)} resolves to ${abs}, but ${parent} does not exist (${errorText(error)}).`,
    )
  }
  return join(parentReal, base)
}

function peekTmp(env, fs) {
  const rawTemp = rawTempFromEnv(env)
  try {
    return fs.realpath(rawTemp)
  } catch {
    return rawTemp
  }
}

function allowedSentence(tmpReal, distRoot) {
  return (
    `Allowed output roots: a direct child of ${tmpReal} whose name starts with "wallet-ux-", ` +
    `or ${distRoot} and its descendants.`
  )
}

function outsideMessage(raw, resolved, tmpReal, distRoot) {
  return new OutDirError(
    `WALLET_UX_OUT_DIR ${JSON.stringify(raw)} resolves to ${resolved}, which is outside the allowed output roots. ` +
      allowedSentence(tmpReal, distRoot),
  )
}

function deployMessage(raw, resolved, tmpReal, distRoot) {
  return new OutDirError(
    `WALLET_UX_OUT_DIR ${JSON.stringify(raw)} is refused in a deploy build (resolved ${resolved}). ` +
      `Deploy builds write only ${distRoot}. ${allowedSentence(tmpReal, distRoot)} ` +
      `Deploy signals: CF_PAGES=1, WALLET_UX_DEPLOY=1, or GITHUB_WORKFLOW_REF containing ${DEPLOY_WORKFLOW_MARKER}.`,
  )
}

function realOrThrow(path, fs, label) {
  try {
    return fs.realpath(path)
  } catch (error) {
    throw new OutDirError(`Refusing temp root because ${label} ${path} cannot be resolved (${errorText(error)}).`)
  }
}

// Called only when an override is not the default dist path and is not under dist.
function assertTempRoot(env, appRoot, appReal, fs) {
  const rawTemp = rawTempFromEnv(env)
  const tmpReal = realOrThrow(rawTemp, fs, "the temp directory")
  const root = tmpReal === "/" || tmpReal.endsWith(":\\") || tmpReal.endsWith(":/")
  if (root || tmpReal === "") {
    throw new OutDirError(`Refusing temp root ${tmpReal || rawTemp}: a temp root of the filesystem root is not allowed.`)
  }
  const homeReal = realOrThrow(fs.homedir(), fs, "the home directory")
  const repoReal = realOrThrow(resolve(appRoot, "../.."), fs, "the repo root")
  const protectedDirs = [
    ["home", homeReal],
    ["repo", repoReal],
    ["app", appReal],
  ]
  if (typeof env.HOME === "string" && env.HOME !== "") {
    try {
      const homeEnv = fs.realpath(env.HOME)
      if (homeEnv !== homeReal) protectedDirs.push(["HOME", homeEnv])
    } catch (error) {
      throw new OutDirError(`Refusing temp root ${tmpReal}: HOME ${env.HOME} cannot be resolved (${errorText(error)}).`)
    }
  }
  for (const [label, target] of protectedDirs) {
    if (isSameOrDescendant(tmpReal, target)) {
      throw new OutDirError(`Refusing temp root ${tmpReal}: it contains the ${label} directory ${target}.`)
    }
  }
  let st
  try {
    st = fs.lstat(tmpReal)
  } catch (error) {
    throw new OutDirError(`Refusing temp root ${tmpReal}: ${errorText(error)}.`)
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new OutDirError(`Refusing temp root ${tmpReal}: it is not a real directory.`)
  }
  if ((st.mode & WORLD_WRITABLE) !== 0 && (st.mode & STICKY) === 0) {
    throw new OutDirError(`Refusing temp root ${tmpReal}: it is world-writable without the sticky bit.`)
  }
  const uid = fs.getuid()
  if (uid != null && st.uid !== uid && st.uid !== 0) {
    throw new OutDirError(
      `Refusing temp root ${tmpReal}: owner uid ${st.uid} is neither the current user nor root.`,
    )
  }
  return tmpReal
}

function markerPath(dir) {
  return join(dir, OUT_MARKER_NAME)
}

function assertMarker(dir, fs) {
  const path = markerPath(dir)
  let st
  try {
    st = fs.lstat(path)
  } catch {
    throw new OutDirError(`WALLET_UX_OUT_DIR ${dir} was not created by wallet-ux.`)
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new OutDirError(`WALLET_UX_OUT_DIR ${dir} marker ${path} is not a regular file.`)
  }
  const uid = fs.getuid()
  if (uid != null && st.uid !== uid) {
    throw new OutDirError(`WALLET_UX_OUT_DIR ${dir} marker ${path} is not owned by the current user.`)
  }
}

function writeMarker(dir, fs) {
  try {
    fs.writeFile(markerPath(dir), MARKER_BODY, { flag: "wx", mode: 0o600 })
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw new OutDirError(`Could not create the wallet-ux marker in ${dir} (${errorText(error)}).`)
    }
    assertMarker(dir, fs)
  }
}

function lstatOrThrow(dir, fs) {
  try {
    return fs.lstat(dir)
  } catch (error) {
    throw new OutDirError(`WALLET_UX_OUT_DIR ${dir} is not a directory (${errorText(error)}).`)
  }
}

function mustBeRealDir(dir, fs) {
  const st = lstatOrThrow(dir, fs)
  if (st.isSymbolicLink()) {
    throw new OutDirError(`WALLET_UX_OUT_DIR ${dir} is a symlink. Refusing to follow it.`)
  }
  if (!st.isDirectory()) {
    throw new OutDirError(`WALLET_UX_OUT_DIR ${dir} is not a directory.`)
  }
  return st
}

function assertOwnerAndMode(dir, st, fs) {
  const uid = fs.getuid()
  if (uid != null && st.uid !== uid) {
    throw new OutDirError(`WALLET_UX_OUT_DIR ${dir} owner uid ${st.uid} is not the current user.`)
  }
  if ((st.mode & GROUP_OR_OTHER) !== 0) {
    throw new OutDirError(`WALLET_UX_OUT_DIR ${dir} mode ${octalMode(st.mode)} is not 0700.`)
  }
}

function snapshot(dir, st) {
  return { root: dir, dev: st.dev, ino: st.ino, uid: st.uid, mode: st.mode, prepared: true }
}

function acceptExisting(dir, fs) {
  const st = mustBeRealDir(dir, fs)
  assertOwnerAndMode(dir, st, fs)
  let names
  try {
    names = fs.readdir(dir)
  } catch (error) {
    throw new OutDirError(`WALLET_UX_OUT_DIR ${dir} cannot be read (${errorText(error)}).`)
  }
  if (names.length === 0) writeMarker(dir, fs)
  else if (names.includes(OUT_MARKER_NAME)) assertMarker(dir, fs)
  else throw new OutDirError(`WALLET_UX_OUT_DIR ${dir} was not created by wallet-ux.`)
  const after = mustBeRealDir(dir, fs)
  if (after.dev !== st.dev || after.ino !== st.ino) {
    throw new OutDirError(`WALLET_UX_OUT_DIR ${dir} changed identity. Refusing to use it.`)
  }
  assertOwnerAndMode(dir, after, fs)
  assertMarker(dir, fs)
  return snapshot(dir, after)
}

function createDir(dir, fs) {
  try {
    fs.mkdir(dir, { mode: 0o700 })
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      // Someone raced a directory or a symlink into place. Never follow it.
      return acceptExisting(dir, fs)
    }
    if (errorCode(error) === "ENOENT") {
      throw new OutDirError(`WALLET_UX_OUT_DIR ${dir} cannot be created because a parent directory is missing.`)
    }
    throw new OutDirError(`WALLET_UX_OUT_DIR ${dir} cannot be created (${errorText(error)}).`)
  }
  const created = mustBeRealDir(dir, fs)
  fs.chmod(dir, 0o700)
  const after = mustBeRealDir(dir, fs)
  if (after.dev !== created.dev || after.ino !== created.ino) {
    throw new OutDirError(`WALLET_UX_OUT_DIR ${dir} changed while it was created. Refusing to use it.`)
  }
  if ((after.mode & GROUP_OR_OTHER) !== 0) {
    throw new OutDirError(`WALLET_UX_OUT_DIR ${dir} mode ${octalMode(after.mode)} is not 0700.`)
  }
  writeMarker(dir, fs)
  const ready = mustBeRealDir(dir, fs)
  assertMarker(dir, fs)
  return snapshot(dir, ready)
}

function prepare(dir, fs) {
  try {
    const st = fs.lstat(dir)
    if (st.isSymbolicLink()) {
      throw new OutDirError(`WALLET_UX_OUT_DIR ${dir} is a symlink. Refusing to follow it.`)
    }
    if (!st.isDirectory()) {
      throw new OutDirError(`WALLET_UX_OUT_DIR ${dir} is not a directory.`)
    }
  } catch (error) {
    if (error instanceof OutDirError) throw error
    if (errorCode(error) !== "ENOENT") {
      throw new OutDirError(`WALLET_UX_OUT_DIR ${dir} cannot be inspected (${errorText(error)}).`)
    }
    return createDir(dir, fs)
  }
  return acceptExisting(dir, fs)
}

function unprepared(distRoot) {
  return { root: distRoot, prepared: false }
}

export function openWalletOutRoot(env = process.env, appRoot, deps) {
  if (!appRoot) throw new OutDirError("resolveWalletOutRoot requires appRoot.")
  const fs = fsDeps(deps)
  const { appReal, distRoot } = appDistRoot(appRoot, fs)
  const raw = env.WALLET_UX_OUT_DIR
  const unset = raw == null || raw === ""
  // Unset never reads TMPDIR. Production output stays <app>/dist with no marker.
  if (unset) return unprepared(distRoot)
  if (isDeployBuild(env)) {
    let resolved
    try {
      resolved = locate(raw, appRoot, fs)
    } catch {
      resolved = resolve(appRoot, raw)
    }
    throw deployMessage(raw, resolved, peekTmp(env, fs), distRoot)
  }
  const located = locate(raw, appRoot, fs)
  if (located === distRoot) return unprepared(distRoot)
  if (isStrictDescendant(distRoot, located)) return prepare(located, fs)
  const tmpReal = assertTempRoot(env, appRoot, appReal, fs)
  if (isDirectChild(tmpReal, located) && basename(located).startsWith("wallet-ux-")) return prepare(located, fs)
  throw outsideMessage(raw, located, tmpReal, distRoot)
}

export function resolveWalletOutRoot(env = process.env, appRoot, deps) {
  return openWalletOutRoot(env, appRoot, deps).root
}

// Re-lstat immediately before a delete. A swapped symlink, or a changed
// dev/ino/owner/mode, refuses. The marker must still be our regular file.
export function assertSameOutRoot(opened, deps) {
  if (!opened || typeof opened.root !== "string" || !opened.prepared) {
    throw new OutDirError("assertSameOutRoot requires a prepared output root.")
  }
  const fs = fsDeps(deps)
  const st = mustBeRealDir(opened.root, fs)
  if (st.dev !== opened.dev || st.ino !== opened.ino) {
    throw new OutDirError(`WALLET_UX_OUT_DIR ${opened.root} changed identity before delete. Refusing to delete.`)
  }
  const uid = fs.getuid()
  if (uid != null && st.uid !== uid) {
    throw new OutDirError(
      `WALLET_UX_OUT_DIR ${opened.root} owner uid ${st.uid} is not the current user. Refusing to delete.`,
    )
  }
  if (opened.uid != null && st.uid !== opened.uid) {
    throw new OutDirError(`WALLET_UX_OUT_DIR ${opened.root} changed owner before delete. Refusing to delete.`)
  }
  if ((st.mode & 0o7777) !== (opened.mode & 0o7777)) {
    throw new OutDirError(`WALLET_UX_OUT_DIR ${opened.root} changed mode before delete. Refusing to delete.`)
  }
  if ((st.mode & GROUP_OR_OTHER) !== 0) {
    throw new OutDirError(`WALLET_UX_OUT_DIR ${opened.root} mode ${octalMode(st.mode)} is not 0700. Refusing to delete.`)
  }
  assertMarker(opened.root, fs)
  return st
}

export function deleteStaleOutEntries(opened) {
  if (!opened || typeof opened.root !== "string") {
    throw new OutDirError("deleteStaleOutEntries requires an output root.")
  }
  if (opened.prepared) assertSameOutRoot(opened)
  for (const name of readdirSync(opened.root)) {
    if (name === "app" || name === OUT_MARKER_NAME) continue
    rmSync(join(opened.root, name), { recursive: true, force: true })
  }
}

// Vite emptyOutDir writes <root>/app. A symlink there would empty the target.
export function assertWalletAppDir(root, deps) {
  const fs = fsDeps(deps)
  const appDir = join(root, "app")
  let st
  try {
    st = fs.lstat(appDir)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return
    throw new OutDirError(`Cannot inspect ${appDir} (${errorText(error)}).`)
  }
  if (st.isSymbolicLink()) {
    throw new OutDirError(`WALLET_UX_OUT_DIR app directory ${appDir} is a symlink. Refusing to empty it.`)
  }
}
