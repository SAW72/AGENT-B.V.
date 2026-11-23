import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readSourceCommit } from "./out-dir.mjs"
import {
  BUILD_COMMIT_META_NAME,
  assertDeployStampAllowed,
  buildCommitMetaTag,
  evaluateServedStamp,
  isAllowUnpinnedRollback,
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

function initRepo(root, message = "init") {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" })
  git(["-c", "init.defaultBranch=main", "init", "-q"])
  git(["config", "user.email", "stamp@test"])
  git(["config", "user.name", "stamp"])
  writeFileSync(join(root, "file.txt"), "ok\n")
  git(["add", "file.txt"])
  git(["-c", "commit.gpgsign=false", "commit", "-m", message])
  return git
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

  it("parses official and odd stamp forms, and ignores comment/script/template tags", () => {
    const official = `<meta name="agent-bv-build-commit" content="${shaA}">`
    const cases = [
      { html: official, stamp: shaA, name: "official name-then-content, double quotes" },
      { html: `<meta content="${shaA}" name="agent-bv-build-commit">`, stamp: shaA, name: "reversed attributes" },
      { html: `<meta name='agent-bv-build-commit' content='${shaA}'>`, stamp: shaA, name: "single quotes" },
      { html: `<meta content='${shaA}' name="agent-bv-build-commit">`, stamp: shaA, name: "mixed quotes, reversed" },
      {
        html: `<meta  data-x="1" name = "${shaA ? "agent-bv-build-commit" : ""}"  content = "${shaA}" charset="utf-8" />`,
        stamp: shaA,
        name: "extra attributes and spaces around =",
      },
      { html: `<META NAME="agent-bv-build-commit" CONTENT="${shaA}">`, stamp: shaA, name: "uppercase tag and attrs" },
      { html: `<!-- <meta name="agent-bv-build-commit" content="${shaA}"> -->`, stamp: null, name: "only a comment" },
      { html: `<script><meta name="agent-bv-build-commit" content="${shaA}"></script>`, stamp: null, name: "only in script" },
      {
        html: `<template><meta name="agent-bv-build-commit" content="${shaA}"></template>`,
        stamp: null,
        name: "only in template",
      },
      {
        html: `<!-- <meta name="agent-bv-build-commit" content="${shaB}"> -->${official}`,
        stamp: shaA,
        name: "real tag plus a commented tag",
      },
      {
        html: `<script>const x = '<meta name="agent-bv-build-commit" content="${shaB}">'</script>${official}`,
        stamp: shaA,
        name: "real tag plus a script string",
      },
      {
        html: `<template><meta name="agent-bv-build-commit" content="${shaB}"></template>${official}`,
        stamp: shaA,
        name: "real tag plus a template tag",
      },
    ]
    for (const row of cases) {
      expect(readBuildCommitStamp(`<head>${row.html}</head>`), row.name).toBe(row.stamp)
    }
  })

  it("refuses more than one real stamp tag, even when the first is a valid SHA or the second is hidden in a comment it would have counted before", () => {
    const two = `<head>${buildCommitMetaTag(shaA)}${buildCommitMetaTag(shaB)}</head>`
    const twice = `<head>${buildCommitMetaTag(shaA)}${buildCommitMetaTag(shaA)}</head>`
    const reversed = `<head><meta content="${shaA}" name="agent-bv-build-commit"><meta name='agent-bv-build-commit' content='${shaB}'></head>`
    expect(listBuildCommitStamps(two)).toEqual([shaA, shaB])
    expect(() => readBuildCommitStamp(two)).toThrow("appears 2 times; expected at most one")
    expect(() => readBuildCommitStamp(twice)).toThrow("appears 2 times; expected at most one")
    expect(() => readBuildCommitStamp(reversed)).toThrow("appears 2 times; expected at most one")
    // A commented second tag is not a real stamp, so the page still has exactly one.
    expect(
      readBuildCommitStamp(`<head>${buildCommitMetaTag(shaA)}<!-- ${buildCommitMetaTag(shaB)} --></head>`),
    ).toBe(shaA)
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

  it("reads git status --porcelain from a real repo, including untracked files, and fails closed without git", () => {
    const root = mkdtempSync(join(tmpdir(), "stamp-git-"))
    const missing = mkdtempSync(join(tmpdir(), "stamp-nogit-"))
    try {
      initRepo(root)
      expect(readGitDirtyState(root)).toBe("")
      writeFileSync(join(root, "file.txt"), "dirty\n")
      expect(readGitDirtyState(root)).toMatch(/file\.txt/)
      expect(() => assertDeployStampAllowed({ WALLET_UX_DEPLOY: "1" }, readGitDirtyState(root))).toThrow("file.txt")
      writeFileSync(join(root, "untracked.txt"), "new\n")
      const withUntracked = readGitDirtyState(root)
      expect(withUntracked).toMatch(/\?\? untracked\.txt/)
      expect(() => assertDeployStampAllowed({ WALLET_UX_DEPLOY: "1" }, withUntracked)).toThrow("untracked.txt")

      // Only untracked dirt, no tracked changes.
      const clean = mkdtempSync(join(tmpdir(), "stamp-untracked-"))
      try {
        initRepo(clean)
        writeFileSync(join(clean, "only-untracked.txt"), "x\n")
        const porcelain = readGitDirtyState(clean)
        expect(porcelain).toMatch(/\?\? only-untracked\.txt/)
        expect(() => assertDeployStampAllowed({ WALLET_UX_DEPLOY: "1" }, porcelain)).toThrow("only-untracked.txt")
      } finally {
        rmSync(clean, { recursive: true, force: true })
      }

      expect(() => readGitDirtyState(missing)).toThrow(/git status --porcelain failed/)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(missing, { recursive: true, force: true })
    }
  })

  it("ignores inherited GIT_DIR and GIT_WORK_TREE, so a clean dummy repo cannot hide a dirty tree or retarget the SHA", () => {
    const app = mkdtempSync(join(tmpdir(), "stamp-app-"))
    const dummy = mkdtempSync(join(tmpdir(), "stamp-dummy-"))
    const previous = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
    }
    try {
      const appGit = initRepo(app, "app")
      initRepo(dummy, "dummy")
      const appSha = appGit(["rev-parse", "HEAD"]).trim()
      const dummySha = execFileSync("git", ["-C", dummy, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
      expect(appSha).not.toBe(dummySha)
      writeFileSync(join(app, "file.txt"), "dirty-app\n")
      writeFileSync(join(app, "extra.txt"), "untracked\n")

      const dummyGitDir = execFileSync("git", ["-C", dummy, "rev-parse", "--absolute-git-dir"], {
        encoding: "utf8",
      }).trim()
      const env = {
        ...process.env,
        GIT_DIR: dummyGitDir,
        GIT_WORK_TREE: dummy,
        GIT_COMMON_DIR: dummyGitDir,
      }
      process.env.GIT_DIR = dummyGitDir
      process.env.GIT_WORK_TREE = dummy
      process.env.GIT_COMMON_DIR = dummyGitDir

      // Unsanitized git would report the dummy as clean and return dummySha.
      const dirty = readGitDirtyState(app, env)
      expect(dirty).toMatch(/file\.txt/)
      expect(dirty).toMatch(/\?\? extra\.txt/)
      expect(() => assertDeployStampAllowed({ WALLET_UX_DEPLOY: "1" }, dirty)).toThrow(/dirty git tree/)
      expect(readSourceCommit(app, env)).toBe(appSha)
      expect(readSourceCommit(app, env)).not.toBe(dummySha)

      const plugin = walletBuildStampPlugin(app, readSourceCommit, readGitDirtyState, {
        ...env,
        WALLET_UX_DEPLOY: "1",
      })
      expect(() => plugin.configResolved()).toThrow(/dirty git tree/)
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(app, { recursive: true, force: true })
      rmSync(dummy, { recursive: true, force: true })
    }
  })
})

describe("evaluateServedStamp matrix", () => {
  const rows = [
    { name: "unstamped, EXPECT unset, no flag: pre-stamp rollback passes", built: null, served: null, expect: "", flag: false, ok: true },
    { name: "unstamped, EXPECT unset, flag: flag is a no-op, still passes", built: null, served: null, expect: "", flag: true, ok: true },
    { name: "unstamped, EXPECT set: fails, flag does not override", built: null, served: null, expect: shaA, flag: false, ok: false, message: "served build commit (none) is not the expected" },
    { name: "unstamped, EXPECT set, flag: still fails", built: null, served: null, expect: shaA, flag: true, ok: false, message: "served build commit (none) is not the expected" },
    { name: "stamped match, EXPECT set: new deploy passes", built: shaA, served: shaA, expect: shaA, flag: false, ok: true },
    { name: "stamped match, uppercase EXPECT: still passes", built: shaA, served: shaA, expect: shaA.toUpperCase(), flag: false, ok: true },
    { name: "stamped match, EXPECT unset, no flag: fails closed", built: shaA, served: shaA, expect: "", flag: false, ok: false, message: "a stamped page requires EXPECT_COMMIT unless ALLOW_UNPINNED_ROLLBACK=1" },
    { name: "stamped match, EXPECT unset, flag: documented unpinned rollback", built: shaA, served: shaA, expect: "", flag: true, ok: true },
    { name: "stamped match, wrong EXPECT, flag: still fails", built: shaA, served: shaA, expect: shaB, flag: true, ok: false, message: `served build commit ${shaA} is not the expected ${shaB}` },
    { name: "stamped mismatch, EXPECT unset: built/served first", built: shaA, served: shaB, expect: "", flag: false, ok: false, message: `served build commit ${shaB} does not match the built ${shaA}` },
    { name: "stamped mismatch, flag: still a mismatch", built: shaA, served: shaB, expect: "", flag: true, ok: false, message: `served build commit ${shaB} does not match the built ${shaA}` },
    { name: "served stamp, unstamped built, EXPECT unset: fails", built: null, served: shaA, expect: "", flag: false, ok: false, message: "a stamped page requires EXPECT_COMMIT unless ALLOW_UNPINNED_ROLLBACK=1" },
    { name: "served stamp, unstamped built, EXPECT=served: passes", built: null, served: shaA, expect: shaA, flag: false, ok: true },
    { name: "built stamp, unstamped served: mismatch", built: shaA, served: null, expect: "", flag: false, ok: false, message: "served build commit (none) does not match" },
    { name: "short EXPECT_COMMIT: fails closed", built: shaA, served: shaA, expect: "cdb3232", flag: false, ok: false, message: "EXPECT_COMMIT must be a 40-hex commit SHA" },
  ]
  it.each(rows)("$name", (row) => {
    const decision = evaluateServedStamp({
      builtStamp: row.built,
      servedStamp: row.served,
      expectCommit: row.expect,
      allowUnpinnedRollback: row.flag,
    })
    expect(decision.ok, row.name).toBe(row.ok)
    if (!row.ok) expect(decision.message, row.name).toContain(row.message)
  })
})

describe("GIT_CONFIG_* and GIT_INDEX_FILE are dropped (P3-3)", () => {
  const cases = (dir) => {
    const cfg = join(dir, "global.cfg")
    writeFileSync(cfg, "[status]\n\tshowUntrackedFiles = no\n")
    return {
      "GIT_CONFIG_COUNT/KEY/VALUE": { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "status.showUntrackedFiles", GIT_CONFIG_VALUE_0: "no" },
      "GIT_CONFIG_PARAMETERS": { GIT_CONFIG_PARAMETERS: "'status.showUntrackedFiles=no'" },
      "GIT_CONFIG_GLOBAL": { GIT_CONFIG_GLOBAL: cfg },
    }
  }
  it("an inherited config cannot hide an untracked file from the dirty read", () => {
    const app = mkdtempSync(join(tmpdir(), "stamp-cfg-app-"))
    const side = mkdtempSync(join(tmpdir(), "stamp-cfg-side-"))
    try {
      initRepo(app)
      writeFileSync(join(app, "untracked-only.txt"), "x\n")
      for (const [name, vars] of Object.entries(cases(side))) {
        const dirty = readGitDirtyState(app, { ...process.env, ...vars })
        expect(dirty, name).toMatch(/\?\? untracked-only\.txt/)
        expect(() => assertDeployStampAllowed({ WALLET_UX_DEPLOY: "1" }, dirty), name).toThrow(/dirty git tree/)
      }
    } finally {
      rmSync(app, { recursive: true, force: true })
      rmSync(side, { recursive: true, force: true })
    }
  })
  it("GIT_INDEX_FILE cannot make a clean tree look dirty or hide edits", () => {
    const app = mkdtempSync(join(tmpdir(), "stamp-idx-app-"))
    const side = mkdtempSync(join(tmpdir(), "stamp-idx-side-"))
    try {
      initRepo(app)
      const env = { ...process.env, GIT_INDEX_FILE: join(side, "other-index") }
      expect(readGitDirtyState(app, env)).toBe("")
      writeFileSync(join(app, "file.txt"), "changed\n")
      expect(readGitDirtyState(app, env)).toMatch(/file\.txt/)
    } finally {
      rmSync(app, { recursive: true, force: true })
      rmSync(side, { recursive: true, force: true })
    }
  })
  it("the build plugin on a dirty tree refuses with config env set, and passes env to both readers", () => {
    const app = mkdtempSync(join(tmpdir(), "stamp-plug-app-"))
    try {
      initRepo(app)
      writeFileSync(join(app, "u.txt"), "x\n")
      const env = {
        ...process.env,
        WALLET_UX_DEPLOY: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "status.showUntrackedFiles",
        GIT_CONFIG_VALUE_0: "no",
      }
      expect(() => walletBuildStampPlugin(app, readSourceCommit, readGitDirtyState, env).configResolved()).toThrow(/dirty git tree/)
    } finally {
      rmSync(app, { recursive: true, force: true })
    }
  })
})

describe("isAllowUnpinnedRollback (P3-1)", () => {
  it("is exact \"1\" only: surrounding whitespace, 0, and true are refused", () => {
    expect(isAllowUnpinnedRollback("1")).toBe(true)
    for (const value of [" 1 ", "1 ", " 1", "\t1", "1\n", "true", "0", "yes", "", undefined, null]) {
      expect(isAllowUnpinnedRollback(value), JSON.stringify(value)).toBe(false)
    }
  })
})

describe("stamp parser fail-closed edges (P3-2)", () => {
  const official = `<meta name="agent-bv-build-commit" content="${shaA}">`
  const cases = [
    { name: "unquoted name and content", html: `<meta name=agent-bv-build-commit content=${shaA}>`, stamp: shaA },
    { name: "unquoted name only", html: `<meta name=agent-bv-build-commit content="${shaA}">`, stamp: shaA },
    { name: "unquoted content only", html: `<meta name="agent-bv-build-commit" content=${shaA}>`, stamp: shaA },
    { name: "> inside a quoted attr before name", html: `<meta title="a>b" name="agent-bv-build-commit" content="${shaA}">`, stamp: shaA },
    { name: "> inside a quoted attr after content", html: `<meta name="agent-bv-build-commit" content="${shaA}" title="a>b">`, stamp: shaA },
    {
      name: "comment opener in one script and closer in another, stamp between",
      html: `<script>var a="<!--"</script><meta name="agent-bv-build-commit" content="${shaA}"><script>var b="-->"</script>`,
      stamp: shaA,
    },
  ]
  it.each(cases)("$name is a real stamp", (row) => {
    expect(readBuildCommitStamp(`<head>${row.html}</head>`), row.name).toBe(row.stamp)
  })

  it("a prefixed or suffixed name is not a stamp", () => {
    expect(readBuildCommitStamp(`<head>${official}<meta name="x-agent-bv-build-commit" content="${shaB}"></head>`)).toBe(shaA)
    expect(readBuildCommitStamp(`<head><meta name="agent-bv-build-commit-2" content="${shaB}"></head>`)).toBeNull()
  })

  it("a stamp tag with no content attribute is refused, not read as no stamp", () => {
    expect(() => readBuildCommitStamp(`<head><meta name="agent-bv-build-commit"></head>`)).toThrow("40-hex")
  })

  it("the name value is matched exactly (case)", () => {
    expect(readBuildCommitStamp(`<head><meta name="AGENT-BV-BUILD-COMMIT" content="${shaA}"></head>`)).toBeNull()
  })

  it("a stamp only inside a real HTML comment is still ignored after script-first stripping", () => {
    expect(readBuildCommitStamp(`<head><!-- ${official} --></head>`)).toBeNull()
    expect(readBuildCommitStamp(`<head>${official}<!-- <meta name="agent-bv-build-commit" content="${shaB}"> --></head>`)).toBe(shaA)
  })
})

describe("dirty-tree git -c overrides (P3-4)", () => {
  it("repo-local status.showUntrackedFiles=no cannot hide an untracked file", () => {
    const app = mkdtempSync(join(tmpdir(), "stamp-untracked-cfg-"))
    try {
      const git = initRepo(app)
      git(["config", "status.showUntrackedFiles", "no"])
      writeFileSync(join(app, "hidden-untracked.txt"), "x\n")
      const raw = execFileSync("git", ["-C", app, "status", "--porcelain"], { encoding: "utf8" })
      expect(raw, "control: repo config hides untracked without -c").not.toMatch(/hidden-untracked/)
      const dirty = readGitDirtyState(app)
      expect(dirty).toMatch(/\?\? hidden-untracked\.txt/)
      expect(() => assertDeployStampAllowed({ WALLET_UX_DEPLOY: "1" }, dirty)).toThrow(/dirty git tree/)
    } finally {
      rmSync(app, { recursive: true, force: true })
    }
  })

  it("an included gitconfig that sets showUntrackedFiles=no cannot hide dirt", () => {
    const app = mkdtempSync(join(tmpdir(), "stamp-include-cfg-"))
    try {
      const git = initRepo(app)
      const included = join(app, "hide-untracked.cfg")
      writeFileSync(included, "[status]\n\tshowUntrackedFiles = no\n")
      git(["config", "include.path", included])
      writeFileSync(join(app, "included-untracked.txt"), "x\n")
      const dirty = readGitDirtyState(app)
      expect(dirty).toMatch(/\?\? included-untracked\.txt/)
    } finally {
      rmSync(app, { recursive: true, force: true })
    }
  })

  it("repo-local core.fsmonitor is not executed and untracked files still appear", () => {
    const app = mkdtempSync(join(tmpdir(), "stamp-fsmonitor-app-"))
    const side = mkdtempSync(join(tmpdir(), "stamp-fsmonitor-side-"))
    try {
      const git = initRepo(app)
      writeFileSync(join(app, "u.txt"), "x\n")
      const marker = join(side, "fsmonitor-ran")
      const hook = join(side, "fsmonitor.sh")
      writeFileSync(hook, `#!/bin/sh\nprintf ran > "${marker}"\nexit 0\n`)
      chmodSync(hook, 0o755)
      git(["config", "core.fsmonitor", hook])
      const dirty = readGitDirtyState(app)
      expect(dirty).toMatch(/\?\? u\.txt/)
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(app, { recursive: true, force: true })
      rmSync(side, { recursive: true, force: true })
    }
  })
})
