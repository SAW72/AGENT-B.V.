import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const defaultConfigPath = join(here, "../landing/testers/page-config.json")

export const LAWYER_SIGNUP_DISCLAIMER =
  "By signing up you confirm: (1) You are at least 18 and agree to the Tester Terms, Privacy Notice, and Sanctions terms. (2) This is free testnet testing on Base Sepolia only. Points have no cash or monetary value, are not transferable, are not tokens, and are not a claim on any token, payment, or other distribution. (3) You are not on, or owned 50% or more or controlled by anyone on, a U.S. sanctions list (including OFAC SDN), and you are not located in, ordinarily resident in, or organized under the laws of a country or region under comprehensive U.S. sanctions; you are not acting on behalf of any such person."

export function loadTestersPageConfig(path = defaultConfigPath) {
  const raw = JSON.parse(readFileSync(path, "utf8"))
  const index = raw.index === true
  const airdropLine = raw.airdropLine === "soft" ? "soft" : "silent"
  const softAirdropLine =
    typeof raw.softAirdropLine === "string" && raw.softAirdropLine.trim()
      ? raw.softAirdropLine.trim()
      : "Points are not a promise of any airdrop, token, or payment."
  return { index, airdropLine, softAirdropLine }
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

export function softAirdropHtml(config) {
  if (config.airdropLine !== "soft") return ""
  return `<p class="soft-airdrop" data-testers-airdrop="soft">${config.softAirdropLine}</p>\n`
}

/** Apply the single page-config switch onto a built/copied site root (dist or landing). */
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
    `data-testers-config="${config.index ? "index" : "noindex"}-${config.airdropLine}"`,
  )
  const soft = softAirdropHtml(config)
  if (!html.includes("<!-- testers:soft-airdrop -->")) {
    throw new Error("testers index.html missing <!-- testers:soft-airdrop --> marker")
  }
  html = html.replace(/<!-- testers:soft-airdrop -->[\s\S]*?<!-- \/testers:soft-airdrop -->/, `<!-- testers:soft-airdrop -->\n${soft}<!-- /testers:soft-airdrop -->`)
  writeFileSync(testersIndex, html)
  writeFileSync(join(siteRoot, "robots.txt"), robotsTxtBody(config))
  writeFileSync(join(siteRoot, "sitemap.xml"), sitemapXmlBody(config))
  return config
}
