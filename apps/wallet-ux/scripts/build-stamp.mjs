import { readSourceCommit } from "./out-dir.mjs"

// Build commit stamp. The production build writes the git commit it was built
// from into dist/app/index.html as one <meta> tag, so a served page can say
// which commit it came from. The stamp input is `git rev-parse HEAD` in the app
// root, the same call assemble-site.mjs logs as "wallet-ux source commit". It
// is a pure function of the commit: the same commit rebuilds byte-identical,
// and a different commit changes only this tag. No timestamp, no hostname, no
// random value. The hashed JS and CSS do not carry the stamp, so their
// filenames and bytes do not depend on the commit.
export const BUILD_COMMIT_META_NAME = "agent-bv-build-commit"
export const BUILD_COMMIT_PATTERN = /^[0-9a-f]{40}$/

export function buildCommitMetaTag(commit) {
  if (typeof commit !== "string" || !BUILD_COMMIT_PATTERN.test(commit)) {
    throw new Error(`build commit stamp needs a 40-hex commit SHA, got ${JSON.stringify(commit)}.`)
  }
  return `<meta name="${BUILD_COMMIT_META_NAME}" content="${commit}">`
}

// The stamp in an HTML page, or null when the page has none (a build from before
// this stamp existed, or the landing page).
export function readBuildCommitStamp(html) {
  const tag = new RegExp(`<meta\\s+name="${BUILD_COMMIT_META_NAME}"\\s+content="([^"]*)"\\s*/?>`)
  const found = tag.exec(String(html))
  if (!found) return null
  const commit = found[1]
  if (!BUILD_COMMIT_PATTERN.test(commit)) {
    throw new Error(`build commit stamp ${JSON.stringify(commit)} is not a 40-hex commit SHA.`)
  }
  return commit
}

// Vite plugin. Build only: dev and vitest (command "serve") never read git and
// never stamp. A build outside a git checkout fails closed here, the same as
// assemble-site.mjs, which already refuses to run without a commit.
export function walletBuildStampPlugin(appRoot, readCommit = readSourceCommit) {
  let commit = null
  return {
    name: "wallet-ux-build-stamp",
    apply: "build",
    configResolved() {
      commit = readCommit(appRoot)
    },
    transformIndexHtml() {
      buildCommitMetaTag(commit) // validates the SHA before it is written
      return [{ tag: "meta", attrs: { name: BUILD_COMMIT_META_NAME, content: commit }, injectTo: "head" }]
    },
  }
}
