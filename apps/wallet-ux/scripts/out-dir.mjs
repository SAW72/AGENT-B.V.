// Confines WALLET_UX_OUT_DIR. assemble-site deletes every entry in the out root
// except "app", so that root may only be:
// - <app>/dist, or a descendant of that dist, or
// - a dedicated per-run directory this module created with mkdtemp and the
//   prefix wallet-ux-out-.
// The temp root comes from TMPDIR / os.tmpdir(). It is realpath'd and refused
// when it is not absolute, contains '..', or is /, $HOME, the repo root, the
// app root, or any ancestor of the app root. A symlink or an unrelated child
// of the temp directory is refused. Ownership and the mkdtemp prefix are
// checked again before any removal.
//
// Deploy-build signals. This repo has no explicit deploy flag. Production is a
// manual operator Direct Upload (apps/wallet-ux/CLOUDFLARE_PAGES.md); Cloudflare
// does not build the site. A build is a deploy build when either signal is set:
// - CF_PAGES === "1" (Cloudflare Pages build environment)
// - GITHUB_WORKFLOW_REF contains "/.github/workflows/deploy-wallet-ux.yml@"
//   (the stale deploy workflow)
import { execFileSync } from "node:child_process"
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

const DEPLOY_WORKFLOW_MARKER = "/.github/workflows/deploy-wallet-ux.yml@"
export const WALLET_OUT_TMP_PREFIX = "wallet-ux-out-"
// fs.mkdtemp appends exactly six characters from this alphabet.
const WALLET_OUT_TMP_BASENAME = /^wallet-ux-out-[A-Za-z0-9]{6}$/

export class OutDirError extends Error {
  constructor(message) {
    super(message)
    this.name = "OutDirError"
  }
}

export function isDeployBuild(env = process.env) {
  if (env.CF_PAGES === "1") return true
  const ref = env.GITHUB_WORKFLOW_REF
  return typeof ref === "string" && ref.includes(DEPLOY_WORKFLOW_MARKER)
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

function isAncestor(parent, child) {
  return isStrictDescendant(parent, child)
}

function pathHasDotDot(value) {
  return String(value).split(/[\\/]/).includes("..")
}

// realpath the deepest existing ancestor and re-append the missing remainder,
// so a symlink or ".." cannot escape after the path is normalized.
function canonicalize(absPath) {
  const missing = []
  let current = absPath
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) {
      throw new OutDirError(`Cannot resolve an existing ancestor of ${absPath}.`)
    }
    missing.push(basename(current))
    current = parent
  }
  let real = realpathSync(current)
  for (const part of missing.reverse()) real = join(real, part)
  return real
}

function findRepoRoot(appReal) {
  let current = appReal
  while (true) {
    if (existsSync(join(current, ".git"))) return current
    const parent = dirname(current)
    if (parent === current) {
      throw new OutDirError(`Cannot find the repo root above ${appReal}.`)
    }
    current = parent
  }
}

function allowedText(tmpReal, distRoot) {
  return (
    `Allowed output roots: ${distRoot} and its descendants, or a direct child of ${tmpReal} ` +
    `named ${WALLET_OUT_TMP_PREFIX} plus 6 characters, owned by the current user, and not a symlink.`
  )
}

// Resolve TMPDIR / os.tmpdir() and refuse a root that would make every path,
// or the app itself, look like an allowed temp child.
export function assertSafeTmpRoot(appRoot) {
  if (!appRoot) throw new OutDirError("assertSafeTmpRoot requires appRoot.")
  const raw = tmpdir()
  if (typeof raw !== "string" || raw === "" || !isAbsolute(raw) || pathHasDotDot(raw)) {
    throw new OutDirError(
      `tmpdir() ${JSON.stringify(raw)} is refused. It must be an absolute path and must not contain '..'.`,
    )
  }
  let tmpReal
  let appReal
  let repoReal
  let homeReal
  try {
    tmpReal = realpathSync(raw)
    appReal = realpathSync(appRoot)
    repoReal = findRepoRoot(appReal)
    homeReal = realpathSync(homedir())
  } catch (error) {
    if (error instanceof OutDirError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new OutDirError(`Cannot resolve TMPDIR or the app root (${detail}).`)
  }
  if (!isAbsolute(tmpReal) || pathHasDotDot(tmpReal)) {
    throw new OutDirError(
      `tmpdir() ${JSON.stringify(raw)} resolves to ${JSON.stringify(tmpReal)}, which is refused.`,
    )
  }
  if (
    tmpReal === "/" ||
    tmpReal === homeReal ||
    tmpReal === repoReal ||
    tmpReal === appReal ||
    isAncestor(tmpReal, appReal)
  ) {
    throw new OutDirError(
      `tmpdir() ${JSON.stringify(raw)} resolves to ${tmpReal}, which is refused. ` +
        `The temp root must not be /, $HOME (${homeReal}), the repo root (${repoReal}), ` +
        `the app root (${appReal}), or any ancestor of the app root ${appReal}.`,
    )
  }
  return { tmpReal, appReal, repoReal, homeReal, distRoot: join(appReal, "dist") }
}

function refusal(raw, resolved, tmpReal, distRoot, deploy) {
  const allowed = allowedText(tmpReal, distRoot)
  if (deploy) {
    return new OutDirError(
      `WALLET_UX_OUT_DIR ${JSON.stringify(raw)} is refused in a deploy build (resolved ${resolved}). ` +
        `Deploy builds write only ${distRoot}. ${allowed} ` +
        `Deploy signals: CF_PAGES=1 or GITHUB_WORKFLOW_REF containing ${DEPLOY_WORKFLOW_MARKER}.`,
    )
  }
  return new OutDirError(
    `WALLET_UX_OUT_DIR ${JSON.stringify(raw)} resolves to ${resolved}, which is outside the allowed output roots. ${allowed}`,
  )
}

function currentUid() {
  if (typeof process.getuid !== "function") {
    throw new OutDirError("Cannot verify directory ownership on this platform. Refusing to remove anything.")
  }
  return process.getuid()
}

// Open with O_NOFOLLOW so a swapped symlink fails before any rm.
function verifyOwnedDirectory(resolved) {
  const uid = currentUid()
  const noFollow = constants.O_NOFOLLOW
  if (typeof noFollow !== "number" || typeof constants.O_DIRECTORY !== "number") {
    throw new OutDirError(
      `wallet-ux output dir ${resolved} is not the expected directory: O_NOFOLLOW is unavailable. Refusing to remove anything.`,
    )
  }
  let fd
  try {
    fd = openSync(resolved, constants.O_RDONLY | constants.O_DIRECTORY | noFollow)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new OutDirError(
      `wallet-ux output dir ${resolved} is not the expected directory (${detail}). Refusing to remove anything.`,
    )
  }
  try {
    const st = fstatSync(fd)
    if (!st.isDirectory() || st.uid !== uid) {
      throw new OutDirError(
        `wallet-ux output dir ${resolved} is not owned by uid ${uid}. Refusing to remove anything.`,
      )
    }
  } finally {
    closeSync(fd)
  }
}

function assertDedicatedRunDir(resolved, tmpReal) {
  if (dirname(resolved) !== tmpReal || !WALLET_OUT_TMP_BASENAME.test(basename(resolved))) {
    throw new OutDirError(
      `directory ${resolved} is not a dedicated ${WALLET_OUT_TMP_PREFIX} mkdtemp directory under ${tmpReal}.`,
    )
  }
  const listed = lstatSync(resolved)
  if (listed.isSymbolicLink() || !listed.isDirectory()) {
    throw new OutDirError(`directory ${resolved} is a symlink or not a real directory.`)
  }
  verifyOwnedDirectory(resolved)
}

// The only temp override this module creates. Callers that need a per-run
// directory use this, then pass the returned path as WALLET_UX_OUT_DIR.
export function createWalletOutDir(appRoot) {
  const { tmpReal } = assertSafeTmpRoot(appRoot)
  const created = mkdtempSync(join(tmpReal, WALLET_OUT_TMP_PREFIX))
  try {
    const resolved = realpathSync(created)
    assertDedicatedRunDir(resolved, tmpReal)
    return resolved
  } catch (error) {
    rmSync(created, { recursive: true, force: true })
    throw error
  }
}

export function resolveWalletOutRoot(env = process.env, appRoot) {
  if (!appRoot) throw new OutDirError("resolveWalletOutRoot requires appRoot.")
  const { tmpReal, distRoot } = assertSafeTmpRoot(appRoot)
  const raw = env.WALLET_UX_OUT_DIR
  const unset = raw == null || raw === ""
  if (!unset && isDeployBuild(env)) {
    let resolved
    try {
      resolved = canonicalize(resolve(appRoot, raw))
    } catch {
      resolved = resolve(appRoot, raw)
    }
    throw refusal(raw, resolved, tmpReal, distRoot, true)
  }
  if (unset) return distRoot
  if (pathHasDotDot(raw)) {
    throw refusal(raw, resolve(appRoot, raw), tmpReal, distRoot, false)
  }
  const abs = resolve(appRoot, raw)
  let listed = null
  try {
    listed = lstatSync(abs)
  } catch {
    listed = null
  }
  if (listed?.isSymbolicLink()) {
    let resolved = abs
    try {
      resolved = realpathSync(abs)
    } catch {
      resolved = abs
    }
    throw new OutDirError(
      `WALLET_UX_OUT_DIR ${JSON.stringify(raw)} resolves to ${resolved}, which is a symlink and is outside the allowed output roots. ${allowedText(tmpReal, distRoot)}`,
    )
  }
  const resolved = canonicalize(abs)
  if (isSameOrDescendant(distRoot, resolved)) return resolved
  if (isStrictDescendant(tmpReal, resolved)) {
    try {
      assertDedicatedRunDir(resolved, tmpReal)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new OutDirError(
        `WALLET_UX_OUT_DIR ${JSON.stringify(raw)} resolves to ${resolved}, which is outside the allowed output roots. ${detail} ${allowedText(tmpReal, distRoot)}`,
      )
    }
    return resolved
  }
  throw refusal(raw, resolved, tmpReal, distRoot, false)
}

export function readSourceCommit(cwd) {
  if (!cwd) throw new OutDirError("readSourceCommit requires a working directory.")
  let sha
  try {
    sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new OutDirError(`git rev-parse HEAD failed (${detail}).`)
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new OutDirError(
      `git rev-parse HEAD returned ${JSON.stringify(sha)}, which is not a commit SHA.`,
    )
  }
  return sha
}

// Re-check realpath, prefix, and ownership immediately before assemble-site deletes.
export function assertReadyToClean(resolved, appRoot) {
  const { tmpReal, distRoot } = assertSafeTmpRoot(appRoot)
  if (typeof resolved !== "string" || !isAbsolute(resolved) || pathHasDotDot(resolved)) {
    throw new OutDirError(
      `wallet-ux output dir ${JSON.stringify(resolved)} is not the expected directory. Refusing to remove anything.`,
    )
  }
  let listed
  try {
    listed = lstatSync(resolved)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new OutDirError(
      `wallet-ux output dir ${resolved} is not the expected directory (${detail}). Refusing to remove anything.`,
    )
  }
  if (listed.isSymbolicLink()) {
    throw new OutDirError(
      `wallet-ux output dir ${resolved} is a symlink, not the expected directory. Refusing to remove anything.`,
    )
  }
  const real = realpathSync(resolved)
  if (real !== resolved) {
    throw new OutDirError(
      `wallet-ux output dir ${resolved} is not the expected ${real}. Refusing to remove anything.`,
    )
  }
  if (isSameOrDescendant(distRoot, real)) {
    verifyOwnedDirectory(real)
    return real
  }
  try {
    assertDedicatedRunDir(real, tmpReal)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new OutDirError(
      `wallet-ux output dir ${real} is not the expected directory. ${detail} Refusing to remove anything.`,
    )
  }
  return real
}

// Resolved out dir plus the source commit assemble-site prints before it cleans.
export function deployOutDirSignal(env = process.env, appRoot) {
  const commit = readSourceCommit(appRoot)
  const outDir = resolveWalletOutRoot(env, appRoot)
  return { outDir, commit }
}
