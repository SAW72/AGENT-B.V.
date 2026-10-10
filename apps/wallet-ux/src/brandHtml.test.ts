import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "vite"
import { describe, expect, it } from "vitest"
import {
  applyBrandHtml,
  brandManifest,
  brandManifestSource,
  DESCRIPTION,
  DISPLAY_NAME,
  OPERATOR_LINE,
  PAGE_TITLE,
  PRODUCT_NAME,
  PRODUCT_TITLE,
} from "./brand"

/** Retired product word, split so this file does not contain it. */
const retired = "Audit" + "or"
const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      if (name === "node_modules" || name === ".git") continue
      const path = join(current, name)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(path)
    }
  }
  walk(dir)
  return out
}

function hitsIn(paths: string[]): string[] {
  const hits: string[] = []
  for (const path of paths) {
    const text = readFileSync(path)
    if (text.includes(retired)) hits.push(relative(appRoot, path))
  }
  return hits
}

describe("brand html", () => {
  it("pins the confirmed title, descriptor, and operator line", () => {
    expect(DISPLAY_NAME).toBe("Agent-BV (Agent Bot Verifier)")
    expect(PAGE_TITLE).toBe("Agent-BV (Agent Bot Verifier) — Base Sepolia")
    expect(PRODUCT_TITLE).toBe(DISPLAY_NAME)
    expect(OPERATOR_LINE).toBe(
      "Agent-BV (Agent Bot Verifier) is a product of Steward of the King LLC, an Ohio (USA) limited liability company.",
    )
    expect(brandManifest().name).toBe(DISPLAY_NAME)
    expect(brandManifest().short_name).toBe(PRODUCT_NAME)
    expect(PRODUCT_NAME).toBe("Agent-BV")
    const app = readFileSync(join(appRoot, "src", "App.tsx"), "utf8")
    expect(app).toContain("DISPLAY_NAME")
    expect(app).toContain('<h1 className="wordmark">{DISPLAY_NAME}</h1>')
    expect(app).toContain("OPERATOR_LINE")
  })

  it("keeps the retired product word out of sources, the page shell, and the build", async () => {
    const indexPath = join(appRoot, "index.html")
    const sourceHits = hitsIn([indexPath, ...filesUnder(join(appRoot, "src")), ...filesUnder(join(appRoot, "public"))])
    expect(sourceHits).toEqual([])

    const index = readFileSync(indexPath, "utf8")
    expect(index).toContain("%PAGE_TITLE%")
    expect(index).toContain("%PRODUCT_DESCRIPTION%")
    expect(index).toContain('rel="manifest"')
    const branded = applyBrandHtml(index)
    expect(branded).toContain(`<title>${PAGE_TITLE}</title>`)
    expect(branded).toContain(`property="og:title" content="${PAGE_TITLE}"`)
    expect(branded).toContain(`property="og:description" content="${DESCRIPTION}"`)
    expect(branded).toContain(DISPLAY_NAME)
    expect(branded.includes(retired)).toBe(false)
    expect(PAGE_TITLE.startsWith(PRODUCT_TITLE)).toBe(true)
    expect(brandManifest().name).toBe(PRODUCT_TITLE)
    expect(brandManifestSource().includes(retired)).toBe(false)
    expect(readFileSync(join(appRoot, "src", "App.tsx"), "utf8")).toContain("DISPLAY_NAME")

    await build({
      configFile: join(appRoot, "vite.config.ts"),
      root: appRoot,
      logLevel: "error",
      mode: "production",
    })

    const distHits = hitsIn(filesUnder(join(appRoot, "dist")))
    expect(distHits).toEqual([])
    const built = readFileSync(join(appRoot, "dist", "index.html"), "utf8")
    expect(built).toContain("<title>Agent-BV (Agent Bot Verifier) — Base Sepolia</title>")
    expect(built).toContain(`<title>${PAGE_TITLE}</title>`)
    expect(built).toContain(`property="og:title" content="${PAGE_TITLE}"`)
    expect(built).toContain('rel="manifest"')
    const manifest = readFileSync(join(appRoot, "dist", "manifest.webmanifest"), "utf8")
    expect(manifest).toContain(PRODUCT_TITLE)
    expect(manifest.includes(retired)).toBe(false)
  })
})
