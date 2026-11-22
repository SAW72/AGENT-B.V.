import { describe, expect, it } from "vitest"
import {
  BUILD_COMMIT_META_NAME,
  buildCommitMetaTag,
  readBuildCommitStamp,
  walletBuildStampPlugin,
} from "./build-stamp.mjs"

const shaA = "0123456789abcdef0123456789abcdef01234567"
const shaB = "fedcba9876543210fedcba9876543210fedcba98"

function stamped(commit) {
  const plugin = walletBuildStampPlugin("/app-root", () => commit)
  plugin.configResolved()
  return plugin.transformIndexHtml()
}

describe("build commit stamp", () => {
  it("writes one meta tag, and reads it back", () => {
    expect(buildCommitMetaTag(shaA)).toBe(`<meta name="agent-bv-build-commit" content="${shaA}">`)
    expect(readBuildCommitStamp(`<head>${buildCommitMetaTag(shaA)}</head>`)).toBe(shaA)
    expect(readBuildCommitStamp("<head></head>")).toBeNull()
  })

  it("accepts only a 40-hex lowercase commit SHA", () => {
    for (const bad of ["", "abc", "A".repeat(40), "g".repeat(40), `${shaA}0`, null, undefined, 7]) {
      expect(() => buildCommitMetaTag(bad)).toThrow("40-hex")
    }
    expect(() => readBuildCommitStamp('<meta name="agent-bv-build-commit" content="nope">')).toThrow("40-hex")
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
    const plugin = walletBuildStampPlugin("/app-root", () => shaA)
    expect(plugin.apply).toBe("build")
    const bad = walletBuildStampPlugin("/app-root", () => "not-a-sha")
    bad.configResolved()
    expect(() => bad.transformIndexHtml()).toThrow("40-hex")
    const noGit = walletBuildStampPlugin("/app-root", () => {
      throw new Error("git rev-parse HEAD failed")
    })
    expect(() => noGit.configResolved()).toThrow("git rev-parse HEAD failed")
  })
})
