import { readSourceCommit, runGitInRepo } from "./out-dir.mjs"

// Build commit stamp. The production build writes the git commit it was built
// from into dist/app/index.html as one <meta> tag, so a served page can say
// which commit it came from. The stamp input is `git rev-parse HEAD` in the app
// root, the same call assemble-site.mjs logs as "wallet-ux source commit". It
// is a pure function of the commit: no timestamp, hostname, or random value.
// The same commit rebuilds byte-identical. A different commit changes only
// this tag when the app sources are unchanged. A commit that changes app
// sources also changes the hashed JS or CSS. The hashed assets do not carry
// the stamp, so their filenames and bytes do not depend on the commit.
export const BUILD_COMMIT_META_NAME = "agent-bv-build-commit"
export const BUILD_COMMIT_PATTERN = /^[0-9a-f]{40}$/

export function buildCommitMetaTag(commit) {
  if (typeof commit !== "string" || !BUILD_COMMIT_PATTERN.test(commit)) {
    throw new Error(`build commit stamp needs a 40-hex commit SHA, got ${JSON.stringify(commit)}.`)
  }
  return `<meta name="${BUILD_COMMIT_META_NAME}" content="${commit}">`
}

// Comments, <script>, and <template> can mention the tag without being a stamp.
// Scripts and templates are stripped first so a "<!--" in one script string and
// a "-->" in another cannot hide a real stamp between them (HTML comments do
// not start inside a script). Then comments are stripped.
function stripIgnoredHtml(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
}

function attributeMap(raw) {
  const attrs = {}
  // Quoted values may contain ">"; unquoted values run to whitespace or ">".
  const attr = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  for (const match of String(raw).matchAll(attr)) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4]
  }
  return attrs
}

// Collect <meta ...> inner text without stopping at a ">" that sits inside a
// quoted attribute (e.g. title="a>b" before name=).
function metaAttributeSources(html) {
  const inners = []
  const open = /<meta\b/gi
  let found
  while ((found = open.exec(html))) {
    let i = found.index + found[0].length
    let quote = null
    while (i < html.length) {
      const c = html[i]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") {
        quote = c
      } else if (c === ">") {
        inners.push(html.slice(found.index + found[0].length, i))
        break
      }
      i += 1
    }
  }
  return inners
}

export function listBuildCommitStamps(html) {
  const visible = stripIgnoredHtml(html)
  const stamps = []
  for (const inner of metaAttributeSources(visible)) {
    const attrs = attributeMap(inner)
    if (attrs.name === BUILD_COMMIT_META_NAME) stamps.push(attrs.content ?? "")
  }
  return stamps
}

// The stamp in an HTML page, or null when the page has none (a build from before
// this stamp existed, or the landing page). More than one real tag is an error.
// Attribute order, single or double quotes, unquoted values, extra attributes,
// spaces around `=`, and `>` inside a quoted attribute are accepted. Tags
// inside comments, <script>, or <template> are ignored. A stamp-like tag that
// is missing content still fails closed.
export function readBuildCommitStamp(html) {
  const found = listBuildCommitStamps(html)
  if (found.length > 1) {
    throw new Error(`build commit stamp appears ${found.length} times; expected at most one.`)
  }
  if (found.length === 0) return null
  const commit = found[0]
  if (!BUILD_COMMIT_PATTERN.test(commit)) {
    throw new Error(`build commit stamp ${JSON.stringify(commit)} is not a 40-hex commit SHA.`)
  }
  return commit
}


// Rules for verify-served-bundle.mjs. Stamps are already parsed (null, a SHA, or
// thrown on more than one / malformed). expectCommit is the raw EXPECT_COMMIT
// string (may be empty). allowUnpinnedRollback is true only for exact "1".
export function evaluateServedStamp({ builtStamp, servedStamp, expectCommit, allowUnpinnedRollback }) {
  const expected = String(expectCommit ?? "").trim().toLowerCase()
  const allowUnpinned = allowUnpinnedRollback === true
  if (expected && !BUILD_COMMIT_PATTERN.test(expected)) {
    return { ok: false, message: "EXPECT_COMMIT must be a 40-hex commit SHA." }
  }
  if (builtStamp !== null && servedStamp !== builtStamp) {
    return {
      ok: false,
      message: `served build commit ${servedStamp ?? "(none)"} does not match the built ${builtStamp}.`,
    }
  }
  if (expected && servedStamp !== expected) {
    return {
      ok: false,
      message: `served build commit ${servedStamp ?? "(none)"} is not the expected ${expected}.`,
    }
  }
  if (!expected && (builtStamp !== null || servedStamp !== null) && !allowUnpinned) {
    return {
      ok: false,
      message: "a stamped page requires EXPECT_COMMIT unless ALLOW_UNPINNED_ROLLBACK=1.",
    }
  }
  return { ok: true }
}

// ALLOW_UNPINNED_ROLLBACK is exact "1" only. Surrounding whitespace is not
// accepted, matching the operator docs and the WALLET_UX_DEPLOY=1 convention.
export function isAllowUnpinnedRollback(value) {
  return value === "1"
}

// Porcelain output of `git status` at cwd, or throws. An empty string is clean.
// Untracked files are included (no -uno). The command forces
// status.showUntrackedFiles=all and core.fsmonitor=false so a repo-local,
// user, or system gitconfig cannot hide untracked files or run an fsmonitor
// hook. Inherited GIT_* vars are dropped and git is run with `git -C <cwd>`,
// so a dummy GIT_DIR/GIT_WORK_TREE cannot hide dirt or retarget the commit.
export function readGitDirtyState(cwd, env = process.env) {
  if (!cwd) throw new Error("readGitDirtyState requires a working directory.")
  let text
  try {
    text = runGitInRepo(cwd, [
      "-c",
      "status.showUntrackedFiles=all",
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain",
    ], env)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`git status --porcelain failed (${detail}).`)
  }
  return text
}

// A WALLET_UX_DEPLOY=1 (production) build may only stamp a clean tree, so the
// stamp SHA matches the bytes that would be produced from that commit. Other
// builds, including the test suite, may run in a dirty tree and still stamp
// HEAD. The dirty state is the `git status --porcelain` text.
export function assertDeployStampAllowed(env, dirtyState) {
  if (env?.WALLET_UX_DEPLOY !== "1") return
  const dirty = String(dirtyState ?? "").replace(/\s+$/u, "")
  if (dirty !== "") {
    throw new Error(`WALLET_UX_DEPLOY=1 build refuses to stamp a dirty git tree:\n${dirty}`)
  }
}

// Vite plugin. Build only: dev and vitest (command "serve") never read git and
// never stamp. A build outside a git checkout fails closed here, the same as
// assemble-site.mjs, which already refuses to run without a commit.
// A WALLET_UX_DEPLOY=1 build also refuses a dirty tree before it writes the tag.
export function walletBuildStampPlugin(
  appRoot,
  readCommit = readSourceCommit,
  readDirty = readGitDirtyState,
  env = process.env,
) {
  let commit = null
  return {
    name: "wallet-ux-build-stamp",
    apply: "build",
    configResolved() {
      assertDeployStampAllowed(env, readDirty(appRoot, env))
      commit = readCommit(appRoot, env)
    },
    transformIndexHtml() {
      buildCommitMetaTag(commit) // validates the SHA before it is written
      return [{ tag: "meta", attrs: { name: BUILD_COMMIT_META_NAME, content: commit }, injectTo: "head" }]
    },
  }
}
