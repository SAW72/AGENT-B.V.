import { createServer } from "node:http"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"
import {
  assertBundle,
  assertConfiguredEscrow,
  GuardError,
  allowlistedRetiredCount,
  LIVE_ESCROW,
  PHRASES,
  RETIRED_ESCROW,
  RETIRED_ESCROW_ESC_M1,
} from "./guard-escrow-addresses.mjs"
import { DOMAIN_NAME, FORBIDDEN_DASHES, scanDist, scanDistBuffer, scanSourceBuffer, scanSources } from "./guard-domain-dashes.mjs"
import {
  APP_CSP,
  IMMUTABLE_CACHE_CONTROL,
  LANDING_CSP_HEADER,
  PAGES_HEADERS_FILE,
  assertPagesHeaders,
  matchingRules,
  parseCsp,
  parsePagesHeaders,
} from "./guard-pages-headers.mjs"
import { PINNED_RELAYER_HOST, RPC_HOST_ALLOWLIST } from "./require-build-env.mjs"
import { DEFAULT_RPC_URL } from "../src/read.ts"

const HEADER = "x-claim-secret"
const ENV_NAME = "VITE_CLAIM_API_SECRET"
const temps = []

afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), "wallet-ux-guard-"))
  temps.push(directory)
  return directory
}

function bundleSource(retiredCount) {
  const escM1Count = allowlistedRetiredCount(RETIRED_ESCROW_ESC_M1)
  return [
    LIVE_ESCROW,
    ...PHRASES,
    ...Array.from({ length: retiredCount }, () => RETIRED_ESCROW),
    ...Array.from({ length: escM1Count }, () => RETIRED_ESCROW_ESC_M1),
  ].join("\n")
}

function writeBundle(retiredCount) {
  const directory = tempDir()
  mkdirSync(join(directory, "assets"))
  writeFileSync(join(directory, "assets", "app.js"), bundleSource(retiredCount))
  return directory
}

function runNode(script, args, env) {
  return spawnSync("node", ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
  })
}

function runNodeAsync(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script, ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
      },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("close", (status) => resolve({ status, stdout, stderr }))
  })
}

function encodedForms(value) {
  const standard = Buffer.from(value, "utf8").toString("base64")
  const urlSafe = standard.replaceAll("+", "-").replaceAll("/", "_")
  const hex = Buffer.from(value, "utf8").toString("hex")
  const labeled = [
    ["base64", standard],
    ["base64-without-padding", standard.replace(/=+$/, "")],
    ["base64url", urlSafe],
    ["base64url-without-padding", urlSafe.replace(/=+$/, "")],
    ["url", encodeURIComponent(value)],
    ["hex", hex],
    ["hex-uppercase", hex.toUpperCase()],
    ["json", JSON.stringify(value).slice(1, -1)],
  ]
  const seen = new Set([value])
  const unique = []
  for (const entry of labeled) {
    if (!entry[1] || seen.has(entry[1])) continue
    seen.add(entry[1])
    unique.push(entry)
  }
  return unique
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

describe("guard-escrow-addresses", () => {
  it("accepts the configured book and a bundle with three retired occurrences", () => {
    const cli = runNode("scripts/guard-escrow-addresses.mjs", [])
    expect(cli.status).toBe(0)
    expect(cli.stdout).toContain(LIVE_ESCROW)
    expect(cli.stdout).toContain("SUPERSEDED.botAttestationEscrow is " + RETIRED_ESCROW)
    expect(() => assertBundle(writeBundle(3), 3)).not.toThrow()
  })

  it("fails when the bundle has four retired occurrences instead of three", () => {
    const directory = writeBundle(4)
    expect(() => assertBundle(directory, 3)).toThrow(GuardError)
    expect(() => assertBundle(directory, 3)).toThrow(/4 time\(s\).*3 time\(s\)/)
  })

  it("fails when the configured escrow is not the live address", () => {
    expect(() =>
      assertConfiguredEscrow(
        { botAttestationEscrow: "0x0000000000000000000000000000000000000001" },
        { botAttestationEscrow: LIVE_ESCROW },
        { botAttestationEscrow: RETIRED_ESCROW },
      ),
    ).toThrow(/not the live escrow/)
  })
})

describe("guard-claim-secret", () => {
  it("passes when neither retired marker is present", () => {
    const clean = tempDir()
    writeFileSync(join(clean, "clean.txt"), "Submitting through the claim relayer")
    const passed = runNode("scripts/guard-claim-secret.mjs", [join(clean, "clean.txt")])
    expect(passed.status).toBe(0)
    expect(passed.stdout).toContain("Claim leak scan passed")

    const directory = tempDir()
    mkdirSync(join(directory, "assets"))
    writeFileSync(join(directory, "assets", "index-abc123.js"), "Submitting through the claim relayer")
    const dirResult = runNode("scripts/guard-claim-secret.mjs", [directory])
    expect(dirResult.status).toBe(0)
    expect(dirResult.stdout).toContain("Claim leak scan passed")
  })

  it("fails when the directory is empty", () => {
    const directory = tempDir()
    const result = runNode("scripts/guard-claim-secret.mjs", [directory])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("no JavaScript scanned")
  })

  it("fails when the directory contains only empty files", () => {
    const directory = tempDir()
    mkdirSync(join(directory, "assets"))
    writeFileSync(join(directory, "index.html"), "")
    writeFileSync(join(directory, "assets", "index-empty.js"), "")
    writeFileSync(join(directory, "assets", "chunk.js"), "")
    const result = runNode("scripts/guard-claim-secret.mjs", [directory])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("no JavaScript scanned")
  })

  it("fails when the bundle contains x-claim-secret in any case or encoded form", () => {
    const raw = tempDir()
    writeFileSync(join(raw, "leak.txt"), `headers["${HEADER}"]`)
    const rawResult = runNode("scripts/guard-claim-secret.mjs", [join(raw, "leak.txt")])
    expect(rawResult.status).not.toBe(0)
    expect(rawResult.stderr).toContain(`the raw form of ${HEADER} is present`)

    const mixed = tempDir()
    writeFileSync(join(mixed, "leak.txt"), "X-Claim-Secret")
    const mixedResult = runNode("scripts/guard-claim-secret.mjs", [join(mixed, "leak.txt")])
    expect(mixedResult.status).not.toBe(0)
    expect(mixedResult.stderr).toContain(`the raw form of ${HEADER} is present`)

    for (const [label, value] of encodedForms(HEADER)) {
      const directory = tempDir()
      const file = join(directory, "leak.txt")
      writeFileSync(file, `prefix ${value} suffix`)
      const result = runNode("scripts/guard-claim-secret.mjs", [file])
      expect(result.status, label).not.toBe(0)
      expect(result.stderr, label).toContain(`${label} form of ${HEADER}`)
    }
  })

  it("also scans build-env.required.json", () => {
    const clean = tempDir()
    writeFileSync(join(clean, "clean.txt"), "ok")
    const passed = runNode("scripts/guard-claim-secret.mjs", [join(clean, "clean.txt")])
    expect(passed.status).toBe(0)
    expect(passed.stdout).toContain("Claim leak scan passed for 2 path(s).")

    const leak = tempDir()
    writeFileSync(join(leak, "build-env.required.json"), `{"note":"${ENV_NAME}"}\n`)
    const leaked = runNode("scripts/guard-claim-secret.mjs", [join(leak, "build-env.required.json")])
    expect(leaked.status).not.toBe(0)
    expect(leaked.stderr).toContain(`the raw form of ${ENV_NAME} is present`)
  })

  it("fails when the bundle contains VITE_CLAIM_API_SECRET", () => {
    const raw = tempDir()
    writeFileSync(join(raw, "leak.txt"), `import.meta.env.${ENV_NAME}`)
    const rawResult = runNode("scripts/guard-claim-secret.mjs", [join(raw, "leak.txt")])
    expect(rawResult.status).not.toBe(0)
    expect(rawResult.stderr).toContain(`the raw form of ${ENV_NAME} is present`)

    for (const [label, value] of encodedForms(ENV_NAME)) {
      const directory = tempDir()
      const file = join(directory, "leak.txt")
      writeFileSync(file, `prefix ${value} suffix`)
      const result = runNode("scripts/guard-claim-secret.mjs", [file])
      expect(result.status, label).not.toBe(0)
      expect(result.stderr, label).toContain(`${label} form of ${ENV_NAME}`)
    }
  })
})

describe("verify-served-bundle", () => {
  const hash = "app-abc123"

  function fixture({ servedHtml, javascript, extra, builtStamp, builtHtml }) {
    const directory = tempDir()
    const built = builtHtml ?? `<script src="/assets/${hash}.js"></script><link href="/assets/${hash}.css">${builtStamp ? stampTag(builtStamp) : ""}`
    writeFileSync(join(directory, "built.html"), built)
    const served = servedHtml ?? built
    const files = new Map([
      ["/", { body: served, type: "text/html; charset=utf-8" }],
      [`/assets/${hash}.js`, { body: javascript ?? bundleSource(3), type: "application/javascript; charset=utf-8" }],
      [`/assets/${hash}.css`, { body: "body{}", type: "text/css; charset=utf-8" }],
    ])
    if (extra) {
      for (const [path, value] of extra) files.set(path, value)
    }
    return { directory, files }
  }

  function assertCleanExit(result) {
    expect(result.status).toBe(1)
    const lines = result.stderr.trim().split("\n").filter((line) => line.length > 0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^Verify failed:/)
    expect(result.stderr).not.toMatch(/\bat (?:node:|async )/)
    expect(result.stderr).not.toContain("Unhandled")
  }

  const stampTag = (commit) => `<meta name="agent-bv-build-commit" content="${commit}">`
  const shaA = "a".repeat(40)
  const shaB = "b".repeat(40)
  const pages = `<script src="/assets/${hash}.js"></script><link href="/assets/${hash}.css">`

  async function verify(setup, env = {}) {
    const server = await listen((request, response) => {
      const entry = setup.files.get(request.url ?? "")
      if (entry === undefined) {
        response.writeHead(404)
        response.end("missing")
        return
      }
      const body = typeof entry === "string" ? entry : entry.body
      const type = typeof entry === "string" ? "text/html; charset=utf-8" : entry.type
      response.writeHead(200, { "content-type": type })
      response.end(body)
    })
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    const result = await runNodeAsync("scripts/verify-served-bundle.mjs", [], {
      DEPLOYMENT_URL: `http://127.0.0.1:${port}`,
      DIST_INDEX: join(setup.directory, "built.html"),
      ...env,
    })
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    return result
  }

  it("passes when index.html matches the built hashes and the bundle count is 3", async () => {
    const result = await verify(fixture({}))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`/assets/${hash}.js`)
    expect(result.stdout).toContain("retired escrow count 3")
  })

  it("passes when the served build commit stamp equals the built one and EXPECT_COMMIT", async () => {
    const result = await verify(fixture({ builtStamp: shaA, servedHtml: `${pages}${stampTag(shaA)}` }), {
      EXPECT_COMMIT: shaA,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`Served build commit: ${shaA}.`)
  })

  it("fails closed when a matching stamp is present and EXPECT_COMMIT is unset", async () => {
    const result = await verify(fixture({ builtStamp: shaA, servedHtml: `${pages}${stampTag(shaA)}` }))
    assertCleanExit(result)
    expect(result.stderr).toContain("a stamped page requires EXPECT_COMMIT unless ALLOW_UNPINNED_ROLLBACK=1")
    const flagged = await verify(fixture({ builtStamp: shaA, servedHtml: `${pages}${stampTag(shaA)}` }), {
      ALLOW_UNPINNED_ROLLBACK: "1",
    })
    expect(flagged.status, flagged.stderr).toBe(0)
    const notOne = await verify(fixture({ builtStamp: shaA, servedHtml: `${pages}${stampTag(shaA)}` }), {
      ALLOW_UNPINNED_ROLLBACK: "true",
    })
    assertCleanExit(notOne)
    expect(notOne.stderr).toContain("a stamped page requires EXPECT_COMMIT unless ALLOW_UNPINNED_ROLLBACK=1")
  })

  it("fails when the served build commit differs from the built one, even with the same asset hashes", async () => {
    const result = await verify(fixture({ builtStamp: shaA, servedHtml: `${pages}${stampTag(shaB)}` }))
    assertCleanExit(result)
    expect(result.stderr).toContain(`served build commit ${shaB} does not match the built ${shaA}`)
  })

  it("fails when the local build has a stamp and the served page has none", async () => {
    const result = await verify(fixture({ builtStamp: shaA, servedHtml: pages }))
    assertCleanExit(result)
    expect(result.stderr).toContain("served build commit (none) does not match")
  })

  it("still verifies a build from before the stamp existed (rollback), and says there is none", async () => {
    const result = await verify(fixture({}))
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("Served index.html has no build commit stamp.")
  })

  it("requires the served stamp to equal EXPECT_COMMIT when it is set", async () => {
    const stamped = { builtStamp: shaA, servedHtml: `${pages}${stampTag(shaA)}` }
    const same = await verify(fixture(stamped), { EXPECT_COMMIT: shaA.toUpperCase() })
    expect(same.status, same.stderr).toBe(0)
    const other = await verify(fixture(stamped), { EXPECT_COMMIT: shaB })
    assertCleanExit(other)
    expect(other.stderr).toContain(`served build commit ${shaA} is not the expected ${shaB}`)
    const none = await verify(fixture({}), { EXPECT_COMMIT: shaA })
    assertCleanExit(none)
    expect(none.stderr).toContain("served build commit (none) is not the expected")
    const bad = await verify(fixture(stamped), { EXPECT_COMMIT: "cdb3232" })
    assertCleanExit(bad)
    expect(bad.stderr).toContain("EXPECT_COMMIT must be a 40-hex commit SHA")
  })

  it("rejects a malformed stamp on either page", async () => {
    const result = await verify(fixture({ servedHtml: `${pages}${stampTag("not-a-sha")}` }))
    assertCleanExit(result)
    expect(result.stderr).toContain("is not a 40-hex commit SHA")
  })

  it("fails when the served or built page has more than one stamp tag, even if the first matches", async () => {
    const one = stampTag(shaA)
    const two = `${one}${stampTag(shaB)}`
    const servedDup = await verify(fixture({ builtStamp: shaA, servedHtml: `${pages}${two}` }))
    assertCleanExit(servedDup)
    expect(servedDup.stderr).toContain("served index")
    expect(servedDup.stderr).toContain("appears 2 times; expected at most one")
    const builtDup = await verify(fixture({ builtHtml: `${pages}${two}`, servedHtml: `${pages}${one}` }))
    assertCleanExit(builtDup)
    expect(builtDup.stderr).toContain("built index")
    expect(builtDup.stderr).toContain("appears 2 times; expected at most one")
  })

  it("fails when served index.html references a different asset hash", async () => {
    const result = await verify(
      fixture({
        servedHtml: '<script src="/assets/app-deadbeef.js"></script><link href="/assets/app-deadbeef.css">',
      }),
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("does not reference the built asset hashes")
  })

  it("fails when index.html adds a fourth retired address", async () => {
    const result = await verify(
      fixture({
        servedHtml: `<script src="/assets/${hash}.js"></script><link href="/assets/${hash}.css">${RETIRED_ESCROW}`,
      }),
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("4 time(s)")
    expect(result.stderr).toContain("3 time(s)")
  })

  it("fails when index.html contains x-claim-secret", async () => {
    const result = await verify(
      fixture({
        servedHtml: `<script src="/assets/${hash}.js"></script><link href="/assets/${hash}.css">${HEADER}`,
      }),
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(`the raw form of ${HEADER} is present`)
  })

  it("fails when index.html contains VITE_CLAIM_API_SECRET", async () => {
    const result = await verify(
      fixture({
        servedHtml: `<script src="/assets/${hash}.js"></script><link href="/assets/${hash}.css">${ENV_NAME}`,
      }),
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(`the raw form of ${ENV_NAME} is present`)
  })

  it("fails when index-*.js is JavaScript but a lazy chunk is served as index.html", async () => {
    const indexName = "index-abc123"
    const chunkName = "lazy-def456"
    const directory = tempDir()
    const built = `<script type="module" src="/assets/${indexName}.js"></script>`
    writeFileSync(join(directory, "built.html"), built)
    const files = new Map([
      ["/", { body: built, type: "text/html; charset=utf-8" }],
      [
        `/assets/${indexName}.js`,
        { body: `${bundleSource(3)}\nimport("./${chunkName}.js")\n`, type: "application/javascript" },
      ],
      [
        `/assets/${chunkName}.js`,
        { body: "<!doctype html><html><body>index</body></html>", type: "text/html" },
      ],
    ])
    const result = await verify({ directory, files })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`/assets/${chunkName}.js`)
    expect(result.stderr).toContain("content-type is not JavaScript")
    expect(result.stderr).not.toMatch(/\bat (?:node:|async )/)
  })

  it("fails when a JavaScript response body starts with < after whitespace", async () => {
    const result = await verify(
      fixture({
        javascript: "\n  <!doctype html><html></html>",
      }),
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("starts with '<'")
  })

  it("fails when a JavaScript chunk is empty", async () => {
    const result = await verify(fixture({ javascript: "" }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`/assets/${hash}.js`)
    expect(result.stderr).toContain("JavaScript is empty after stripping a UTF-8 BOM")
  })

  it("fails when a JavaScript chunk is whitespace-only", async () => {
    const result = await verify(fixture({ javascript: " \n\t\r " }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`/assets/${hash}.js`)
    expect(result.stderr).toContain("JavaScript is empty after stripping a UTF-8 BOM")
  })

  it("fails when a JavaScript chunk is only a UTF-8 BOM", async () => {
    const result = await verify(fixture({ javascript: "\uFEFF" }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`/assets/${hash}.js`)
    expect(result.stderr).toContain("JavaScript is empty after stripping a UTF-8 BOM")
  })

  it("passes when a JavaScript chunk has a UTF-8 BOM before real source", async () => {
    const result = await verify(fixture({ javascript: `\uFEFF${bundleSource(3)}` }))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("retired escrow count 3")
  })

  it("prints one error line and exits 1 when the host is unreachable or DNS fails", async () => {
    const refused = await runNodeAsync("scripts/verify-served-bundle.mjs", [], {
      DEPLOYMENT_URL: "http://127.0.0.1:9",
    })
    assertCleanExit(refused)

    const dns = await runNodeAsync("scripts/verify-served-bundle.mjs", [], {
      DEPLOYMENT_URL: "http://wallet-ux-guard-does-not-exist.invalid",
    })
    assertCleanExit(dns)
  }, 20000)
})

describe("guard-domain-dashes", () => {
  function dashedName(id) {
    return Buffer.concat([
      Buffer.from('const domainName = "Agent', "utf8"),
      Buffer.from(id, "hex"),
      Buffer.from('BV Relayer"\n', "utf8"),
    ])
  }

  it("accepts the claim-intent sources in this repo", () => {
    expect(scanSources()).toEqual([])
  })

  it("rejects each non-ASCII dash on a domain-name line and inside claimIntent files", () => {
    for (const dash of FORBIDDEN_DASHES) {
      const line = dashedName(dash.id)
      expect(scanSourceBuffer(line, "claim-relayer/README.md").length).toBeGreaterThan(0)
      expect(scanSourceBuffer(line, "apps/wallet-ux/src/claimIntent.ts").length).toBeGreaterThan(0)
      const commentOnly = Buffer.concat([
        Buffer.from("// aside ", "utf8"),
        dash.bytes,
        Buffer.from('\nexport const domainName = "Agent-BV Relayer"\n', "utf8"),
      ])
      expect(scanSourceBuffer(commentOnly, "apps/wallet-ux/src/claimIntent.ts").length).toBeGreaterThan(0)
      expect(scanSourceBuffer(commentOnly, "claim-relayer/README.md")).toEqual([])
    }
  })

  it("rejects a non-ASCII dash next to the domain name in dist and requires the ASCII name", () => {
    const near = Buffer.concat([
      Buffer.from("Agent", "utf8"),
      Buffer.from("e28093", "hex"),
      Buffer.from("BV Relayer", "utf8"),
    ])
    expect(scanDistBuffer(near, "dist/assets/index.js").length).toBeGreaterThan(0)

    const far = Buffer.concat([
      Buffer.from(DOMAIN_NAME, "utf8"),
      Buffer.alloc(200, 0x61),
      Buffer.from("e28094", "hex"),
      Buffer.from(" title", "utf8"),
    ])
    expect(scanDistBuffer(far, "dist/assets/index.js")).toEqual([])

    const directory = tempDir()
    mkdirSync(join(directory, "assets"))
    writeFileSync(join(directory, "assets", "index.js"), `const name = ${JSON.stringify(DOMAIN_NAME)}\n`)
    expect(scanDist(directory)).toEqual([])

    const missing = tempDir()
    mkdirSync(join(missing, "assets"))
    writeFileSync(join(missing, "assets", "index.js"), 'const name = "refund relayer"\n')
    expect(scanDist(missing).join("\n")).toContain("does not embed")

    const bad = tempDir()
    mkdirSync(join(bad, "assets"))
    writeFileSync(join(bad, "assets", "index.js"), near)
    expect(scanDist(bad).length).toBeGreaterThan(0)
  })

  it("passes the CLI when dist embeds the ASCII domain name", () => {
    const directory = tempDir()
    mkdirSync(join(directory, "assets"))
    writeFileSync(join(directory, "assets", "index.js"), `const name = ${JSON.stringify(DOMAIN_NAME)}\n`)
    const passed = runNode("scripts/guard-domain-dashes.mjs", [directory])
    expect(passed.status).toBe(0)
    expect(passed.stdout).toContain("Domain dash scan passed")

    const bad = tempDir()
    mkdirSync(join(bad, "assets"))
    writeFileSync(join(bad, "assets", "index.js"), dashedName("e28094"))
    const failed = runNode("scripts/guard-domain-dashes.mjs", [bad])
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain("e28094")
  })
})

describe("deploy-wallet-ux workflow", () => {
  it("installs claim-relayer deps before Test", () => {
    const workflow = readFileSync(new URL("../../../.github/workflows/deploy-wallet-ux.yml", import.meta.url), "utf8")
    const installAt = workflow.indexOf("working-directory: claim-relayer\n        run: npm ci\n")
    const testAt = workflow.indexOf("\n      - name: Test\n")
    expect(installAt).toBeGreaterThanOrEqual(0)
    expect(testAt).toBeGreaterThan(installAt)
  })
})

describe("pages security headers", () => {
  const rules = parsePagesHeaders(PAGES_HEADERS_FILE)
  const valuesFor = (path, name) =>
    matchingRules(rules, path)
      .flatMap((rule) => rule.set.filter(([header]) => header === name).map(([, value]) => value))

  it("keeps landing/_headers byte-for-byte as the pinned file", () => {
    const file = readFileSync(new URL("../landing/_headers", import.meta.url), "utf8")
    expect(file).toBe(PAGES_HEADERS_FILE)
    expect(file).toContain("X-Content-Type-Options: nosniff")
    expect(file).toContain("Referrer-Policy: strict-origin-when-cross-origin")
    expect(() => assertPagesHeaders()).not.toThrow()
    const cli = runNode("scripts/guard-pages-headers.mjs", [])
    expect(cli.status).toBe(0)
    expect(cli.stdout).toContain("Pages headers unchanged")
  })

  it("sends a CSP with frame-ancestors none and X-Frame-Options DENY on /, /app/ and every /app route", () => {
    for (const path of ["/", "/app/", "/app/identity", "/app/fund", "/app/assets/index-abc.js"]) {
      expect(valuesFor(path, "x-frame-options"), path).toEqual(["DENY"])
      const csp = valuesFor(path, "content-security-policy")
      expect(csp, path).toHaveLength(1)
      expect(parseCsp(csp[0])["frame-ancestors"], path).toEqual(["'none'"])
    }
    expect(valuesFor("/", "content-security-policy")).toEqual([LANDING_CSP_HEADER])
    expect(valuesFor("/app/", "content-security-policy")).toEqual([APP_CSP])
    expect(valuesFor("/app/identity", "content-security-policy")).toEqual([APP_CSP])
  })

  it("keeps the app CSP strict and limited to the hosts the app calls", () => {
    const csp = parseCsp(APP_CSP)
    expect(APP_CSP).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|wasm-unsafe-eval/)
    expect(APP_CSP).not.toMatch(/\*|https?:\/\/\*|\bdata:|\bblob:/)
    expect(csp["default-src"]).toEqual(["'none'"])
    expect(csp["script-src"]).toEqual(["'self'"])
    expect(csp["style-src"]).toEqual(["'self'"])
    expect(csp["object-src"]).toEqual(["'none'"])
    expect(csp["base-uri"]).toEqual(["'none'"])
    expect(csp["form-action"]).toEqual(["'none'"])
    // connect-src is exactly the RPC the app reads and the relayer edge Worker it pins. A change to
    // either constant must change this CSP in the same commit.
    const rpcHost = new URL(DEFAULT_RPC_URL).hostname
    expect(RPC_HOST_ALLOWLIST).toEqual([rpcHost])
    expect([...csp["connect-src"]].sort()).toEqual([`https://${rpcHost}`, `https://${PINNED_RELAYER_HOST}`].sort())
    // No wallet-provider or WalletConnect host: wagmi uses injected() only.
    const wagmi = readFileSync(new URL("../src/wagmi.ts", import.meta.url), "utf8")
    expect(wagmi).toContain("connectors: [injected()]")
  })

  it("sets Cache-Control only on the hashed /app/assets files and never on HTML", () => {
    expect(valuesFor("/app/assets/index-abc123.js", "cache-control")).toEqual([IMMUTABLE_CACHE_CONTROL])
    expect(valuesFor("/app/assets/index-abc123.css", "cache-control")).toEqual([IMMUTABLE_CACHE_CONTROL])
    for (const html of ["/", "/index.html", "/app/", "/app/index.html", "/app/identity", "/app/fund", "/legal/", "/testers/"]) {
      expect(valuesFor(html, "cache-control"), html).toEqual([])
    }
    // The shared 404 page is not content-hashed, so it detaches the header.
    for (const path of ["/app/assets/404.html", "/app/assets/404"]) {
      const detached = matchingRules(rules, path).flatMap((rule) => rule.detach)
      expect(detached, path).toContain("cache-control")
    }
    // Only one rule sets Cache-Control, so Pages cannot join two values into one header.
    const setters = rules.filter((rule) => rule.set.some(([name]) => name === "cache-control"))
    expect(setters.map((rule) => rule.pattern)).toEqual(["/app/assets/*"])
    // /* carries only the two headers no other rule sets.
    expect(rules[0].pattern).toBe("/*")
    expect(rules[0].set.map(([name]) => name)).toEqual(["x-content-type-options", "referrer-policy"])
  })

  it("rejects a changed headers file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pages-headers-"))
    try {
      mkdirSync(join(dir, "landing"))
      writeFileSync(join(dir, "landing", "_headers"), PAGES_HEADERS_FILE.replace("DENY", "SAMEORIGIN"))
      expect(() => assertPagesHeaders(dir)).toThrow("landing/_headers content changed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
