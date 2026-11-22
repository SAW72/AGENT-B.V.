import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  BUILD_COMMIT_META_NAME,
  assertDeployStampAllowed,
  buildCommitMetaTag,
  listBuildCommitStamps,
  readBuildCommitStamp,
  readGitDirtyState,
  walletBuildStampPlugin,
} from "./build-stamp.mjs"

const shaA = "0123456789abcdef0123456789abcdef01234567"
const shaB = "fedcba9876543210fedcba9876543210fedcba98"

function stamped(commit) {
  const plugin = walletBuildStampPlugin("/app-root", () => commit, () => "", {})
  plugin.configResolved()
  return plugin.transformIndexHtml()
}

describe("build commit stamp", () => {
  it("writes one meta tag, and reads it back", () => {
    expect(buildCommitMetaTag(shaA)).toBe(`<meta name="agent-bv-build-commit" content="${shaA}">`)
    expect(readBuildCommitStamp(`<head>${buildCommitMetaTag(shaA)}</head>`)).toBe(shaA)
    expect(readBuildCommitStamp("<head></head>")).toBeNull()
    expect(listBuildCommitStamps("<head></head>")).toEqual([])
  })

  it("accepts only a 40-hex lowercase commit SHA", () => {
    for (const bad of ["", "abc", "A".repeat(40), "g".repeat(40), `${shaA}0`, null, undefined, 7]) {
      expect(() => buildCommitMetaTag(bad)).toThrow("40-hex")
    }
    expect(() => readBuildCommitStamp('<meta name="agent-bv-build-commit" content="nope">')).toThrow("40-hex")
  })

  it("refuses more than one stamp tag, even when the first is a valid SHA", () => {
    const two = `<head>${buildCommitMetaTag(shaA)}${buildCommitMetaTag(shaB)}</head>`
    const twice = `<head>${buildCommitMetaTag(shaA)}${buildCommitMetaTag(shaA)}</head>`
    expect(listBuildCommitStamps(two)).toEqual([shaA, shaB])
    expect(() => readBuildCommitStamp(two)).toThrow("appears 2 times; expected at most one")
    expect(() => readBuildCommitStamp(twice)).toThrow("appears 2 times; expected at most one")
  })

  it("is a pure function of the commit: same commit, same tag. Another commit changes only the SHA", () => {
    const first = stamped(shaA)
    const again = stamped(shaA)
    expect(JSON.stringify(first)).toBe(JSON.stringify(again))
    const other = stamped(shaB)
    expect(first).toEqual([{ tag: "meta", attrs: { name: BUILD_COMMIT_META_NAME, content: shaA }, injectTo: "head" }])
    expect(other).toEqual([{ tag: "meta", attrs: { name: BUILD_COMMIT_META_NAME, content: shaB }, injectTo: "head" }])
  })

  it("runs in vite build only, and fails closed on a bad commit", () => {
    const plugin = walletBuildStampPlugin("/app-root", () => shaA, () => "", {})
    expect(plugin.apply).toBe("build")
    const bad = walletBuildStampPlugin("/app-root", () => "not-a-sha", () => "", {})
    bad.configResolved()
    expect(() => bad.transformIndexHtml()).toThrow("40-hex")
    const noGit = walletBuildStampPlugin(
      "/app-root",
      () => {
        throw new Error("git rev-parse HEAD failed")
      },
      () => "",
      {},
    )
    expect(() => noGit.configResolved()).toThrow("git rev-parse HEAD failed")
  })
})

describe("deploy stamp dirty-tree guard", () => {
  const dirty = " M apps/wallet-ux/src/App.tsx\n?? scratch.txt"

  it("refuses a dirty tree only when WALLET_UX_DEPLOY=1, and names the dirty state", () => {
    expect(() => assertDeployStampAllowed({ WALLET_UX_DEPLOY: "1" }, dirty)).toThrow(
      /WALLET_UX_DEPLOY=1 build refuses to stamp a dirty git tree/,
    )
    expect(() => assertDeployStampAllowed({ WALLET_UX_DEPLOY: "1" }, dirty)).toThrow("M apps/wallet-ux/src/App.tsx")
    expect(() => assertDeployStampAllowed({ WALLET_UX_DEPLOY: "1" }, dirty)).toThrow("?? scratch.txt")
    expect(() => assertDeployStampAllowed({ WALLET_UX_DEPLOY: "1" }, "")).not.toThrow()
    expect(() => assertDeployStampAllowed({ WALLET_UX_DEPLOY: "1" }, "\n")).not.toThrow()
    // Not a production deploy: dirty is allowed (test builds, local builds).
    expect(() => assertDeployStampAllowed({}, dirty)).not.toThrow()
    expect(() => assertDeployStampAllowed({ WALLET_UX_DEPLOY: "true" }, dirty)).not.toThrow()
    expect(() => assertDeployStampAllowed({ WALLET_UX_DEPLOY: "0" }, dirty)).not.toThrow()
  })

  it("the vite plugin fails closed on a dirty tree before it stamps, only for a deploy build", () => {
    const refused = walletBuildStampPlugin("/app-root", () => shaA, () => dirty, { WALLET_UX_DEPLOY: "1" })
    expect(() => refused.configResolved()).toThrow(/dirty git tree/)
    expect(() => refused.configResolved()).toThrow("M apps/wallet-ux/src/App.tsx")
    const allowed = walletBuildStampPlugin("/app-root", () => shaA, () => dirty, {})
    expect(() => allowed.configResolved()).not.toThrow()
    const cleanDeploy = walletBuildStampPlugin("/app-root", () => shaA, () => "", { WALLET_UX_DEPLOY: "1" })
    expect(() => cleanDeploy.configResolved()).not.toThrow()
    expect(cleanDeploy.transformIndexHtml()[0].attrs.content).toBe(shaA)
  })

  it("reads git status --porcelain from a real repo (unit, no production build)", () => {
    const root = mkdtempSync(join(tmpdir(), "stamp-git-"))
    try {
      const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" })
      git(["-c","init.defaultBranch=main","init","-q"])
      git(["config", "user.email", "stamp@test"])
      git(["config", "user.name", "stamp"])
      writeFileSync(join(root, "file.txt"), "ok\n")
      git(["add", "file.txt"])
      git(["-c","commit.gpgsign=false","commit","-m","init"])
      expect(readGitDirtyState(root)).toBe("")
      writeFileSync(join(root, "file.txt"), "dirty\n")
      expect(readGitDirtyState(root)).toMatch(/file\.txt/)
      expect(() => assertDeployStampAllowed({ WALLET_UX_DEPLOY: "1" }, readGitDirtyState(root))).toThrow("file.txt")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
