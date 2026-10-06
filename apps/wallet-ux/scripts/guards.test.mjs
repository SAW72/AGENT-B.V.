import { createServer } from "node:http"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
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

  function fixture({ servedHtml, javascript, extra }) {
    const directory = tempDir()
    const built = `<script src="/assets/${hash}.js"></script><link href="/assets/${hash}.css">`
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

  async function verify(setup) {
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
