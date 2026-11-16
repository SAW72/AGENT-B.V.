// Confines WALLET_UX_OUT_DIR. assemble-site deletes every entry in the out root
// except "app", so the root may only be a strict descendant of the real temp
// directory, or <app>/dist (and descendants of that dist). appRoot itself,
// tmpdir itself, and other app folders are refused.
//
// Deploy-build signals. This repo has no explicit deploy flag. Production is a
// manual operator Direct Upload (apps/wallet-ux/CLOUDFLARE_PAGES.md); Cloudflare
// does not build the site. A build is a deploy build when either signal is set:
// - CF_PAGES === "1" (Cloudflare Pages build environment)
// - GITHUB_WORKFLOW_REF contains "/.github/workflows/deploy-wallet-ux.yml@"
//   (the stale deploy workflow)
import { existsSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

const DEPLOY_WORKFLOW_MARKER = "/.github/workflows/deploy-wallet-ux.yml@"

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

function allowedRoots(appRoot) {
  let appReal
  let tmpReal
  try {
    appReal = realpathSync(appRoot)
    tmpReal = realpathSync(tmpdir())
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new OutDirError(`Cannot resolve the allowed output roots (${detail}).`)
  }
  return { tmpReal, distRoot: join(appReal, "dist") }
}

function refusal(raw, resolved, tmpReal, distRoot, deploy) {
  const allowed = `Allowed output roots: a strict descendant of ${tmpReal}, or ${distRoot} and its descendants.`
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

export function resolveWalletOutRoot(env = process.env, appRoot) {
  if (!appRoot) throw new OutDirError("resolveWalletOutRoot requires appRoot.")
  const { tmpReal, distRoot } = allowedRoots(appRoot)
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
  const resolved = canonicalize(resolve(appRoot, raw))
  if (isStrictDescendant(tmpReal, resolved) || isSameOrDescendant(distRoot, resolved)) return resolved
  throw refusal(raw, resolved, tmpReal, distRoot, false)
}
