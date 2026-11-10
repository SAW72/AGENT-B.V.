import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const defaultConfigPath = join(here, "../landing/testers/page-config.json")

/** Lawyer exact signup disclaimer (BUILD-GO-2026-11-05). No airdrop wording. No free-service-year. */
export const LAWYER_SIGNUP_DISCLAIMER =
  "By signing up you confirm: (1) You are at least 18 and agree to the Tester Terms, Privacy Notice, and Sanctions terms. (2) This is free testnet testing on Base Sepolia only. Points have no cash or monetary value, cannot be sold, transferred, or converted into any token or currency, are not tokens, and are not a claim on any token, payment, or other distribution. (3) You are not on, or owned 50% or more or controlled by anyone on, a U.S. sanctions list (including OFAC SDN), and you are not located in, ordinarily resident in, or organized under the laws of a country or region under comprehensive U.S. sanctions; you are not acting on behalf of any such person."

export function loadTestersPageConfig(path = defaultConfigPath) {
  const raw = JSON.parse(readFileSync(path, "utf8"))
  return { index: raw.index === true }
}

export function robotsMetaContent(config) {
  return config.index ? "index, follow" : "noindex, nofollow"
}

export function robotsTxtBody(config) {
  const lines = ["User-agent: *", "Allow: /"]
  if (!config.index) lines.push("Disallow: /testers/")
  lines.push("", "Sitemap: https://agent-bv.pages.dev/sitemap.xml", "")
  return lines.join("\n")
}

export function sitemapXmlBody(config) {
  const urls = ["https://agent-bv.pages.dev/", "https://agent-bv.pages.dev/app/"]
  if (config.index) urls.push("https://agent-bv.pages.dev/testers/")
  const entries = urls
    .map(
      (loc) => `  <url>
    <loc>${loc}</loc>
  </url>`,
    )
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`
}

/** Apply the index switch onto a built/copied site root (dist or landing). */
export function applyTestersPageConfig(siteRoot, config = loadTestersPageConfig()) {
  const testersIndex = join(siteRoot, "testers/index.html")
  if (!existsSync(testersIndex)) throw new Error(`missing ${testersIndex}`)
  let html = readFileSync(testersIndex, "utf8")
  const meta = robotsMetaContent(config)
  if (!/<meta\s+name="robots"\s+content="[^"]*"\s*>/.test(html)) {
    throw new Error("testers index.html missing robots meta tag")
  }
  html = html.replace(
    /<meta\s+name="robots"\s+content="[^"]*"\s*>/,
    `<meta name="robots" content="${meta}">`,
  )
  html = html.replace(
    /data-testers-config="[^"]*"/,
    `data-testers-config="${config.index ? "index" : "noindex"}"`,
  )
  // Strip any leftover soft-airdrop markers if present (airdrop switch removed).
  html = html.replace(/\s*<!-- testers:soft-airdrop -->[\s\S]*?<!-- \/testers:soft-airdrop -->\s*/g, "\n")
  writeFileSync(testersIndex, html)
  writeFileSync(join(siteRoot, "robots.txt"), robotsTxtBody(config))
  writeFileSync(join(siteRoot, "sitemap.xml"), sitemapXmlBody(config))
  return config
}
