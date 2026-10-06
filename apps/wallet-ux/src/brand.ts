/** Product name. Change this line to swap the working name. */
export const PRODUCT_NAME = "Agent-BV"

/** Full display form. Title, header, manifest name, and the footer use this. */
export const DISPLAY_NAME = `${PRODUCT_NAME} (Agent Bot Verifier)`

export const PRODUCT_TITLE = DISPLAY_NAME

export const TESTNET_LINE = "Base Sepolia testnet only"

export const OPERATOR_LINE = `${DISPLAY_NAME} is a product of Steward of the King LLC, an Ohio (USA) limited liability company.`

const CLAIM_SIGNING_LINE =
  "To send a claim through the relayer, your wallet signs a typed (EIP-712) claim request. The relayer then submits the transaction and pays the gas. Signing alone moves no funds."

export const DISCLAIMER_LINE = `Experimental testnet tool. Not a certification, safety guarantee, or insurance product. Ethereum mainnet and Base mainnet are refused. ${CLAIM_SIGNING_LINE}`

/** Footer on the wallet page. Signing a claim is typed data; the relayer broadcasts and pays gas. */
export const PAGE_FOOTER = `Experimental Base Sepolia view. Not a certification or an insurance product. Escrow and dispute calls can be submitted from a connected Base Sepolia wallet. Ethereum mainnet and Base mainnet are refused. ${CLAIM_SIGNING_LINE}`

export const DESCRIPTION = `${DISPLAY_NAME}: read-only Gate A status and claim tools on Base Sepolia testnet (chain id 84532). Testnet only, no mainnet.`

const HTML_TOKENS: Record<string, string> = {
  "%PRODUCT_TITLE%": PRODUCT_TITLE,
  "%PRODUCT_DESCRIPTION%": DESCRIPTION,
}

export function applyBrandHtml(html: string): string {
  return Object.entries(HTML_TOKENS).reduce((result, [token, value]) => result.replaceAll(token, value), html)
}

export function brandManifest() {
  return {
    name: PRODUCT_TITLE,
    short_name: PRODUCT_NAME,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  }
}

export function brandManifestSource(): string {
  return `${JSON.stringify(brandManifest(), null, 2)}\n`
}
