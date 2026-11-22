import { execFileSync } from "node:child_process"
import { readSourceCommit } from "./out-dir.mjs"

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
const BUILD_COMMIT_TAG = new RegExp(
  `<meta\\s+name="${BUILD_COMMIT_META_NAME}"\\s+content="([^"]*)"\\s*/?>`,
  "g",
)

export function buildCommitMetaTag(commit) {
  if (typeof commit !== "string" || !BUILD_COMMIT_PATTERN.test(commit)) {
    throw new Error(`build commit stamp needs a 40-hex commit SHA, got ${JSON.stringify(commit)}.`)
  }
  return `<meta name="${BUILD_COMMIT_META_NAME}" content="${commit}">`
}

export function listBuildCommitStamps(html) {
  return [...String(html).matchAll(BUILD_COMMIT_TAG)].map((match) => match[1])
}

// The stamp in an HTML page, or null when the page has none (a build from before
// this stamp existed, or the landing page). More than one tag is an error.
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

// Porcelain output of `git status` at cwd, or throws. An empty string is clean.
export function readGitDirtyState(cwd) {
  if (!cwd) throw new Error("readGitDirtyState requires a working directory.")
  let text
  try {
    text = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
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
      assertDeployStampAllowed(env, readDirty(appRoot))
      commit = readCommit(appRoot)
    },
    transformIndexHtml() {
      buildCommitMetaTag(commit) // validates the SHA before it is written
      return [{ tag: "meta", attrs: { name: BUILD_COMMIT_META_NAME, content: commit }, injectTo: "head" }]
    },
  }
}
