import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { randomBytes32 } from "./bytes32"

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path))
      continue
    }
    if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue
    if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path)
  }
  return out
}

describe("random ids", () => {
  it("draws 32 bytes from crypto.getRandomValues", () => {
    const spy = vi.spyOn(crypto, "getRandomValues")
    const id = randomBytes32()
    expect(spy).toHaveBeenCalledTimes(1)
    const bytes = spy.mock.calls[0]?.[0]
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect((bytes as Uint8Array).length).toBe(32)
    expect(id).toMatch(/^0x[0-9a-f]{64}$/)
    spy.mockRestore()
  })

  it("does not use Math.random in id code", () => {
    const src = dirname(fileURLToPath(import.meta.url))
    const hits: string[] = []
    for (const path of sourceFiles(src)) {
      const text = readFileSync(path, "utf8")
      if (!text.includes("Math.random")) continue
      const file = path.slice(path.lastIndexOf("/") + 1)
      hits.push(file)
    }
    expect(hits).toEqual([])
    const bytes = readFileSync(join(src, "bytes32.ts"), "utf8")
    expect(bytes).toContain("crypto.getRandomValues")
    expect(bytes).not.toContain("Math.random")
  })
})
