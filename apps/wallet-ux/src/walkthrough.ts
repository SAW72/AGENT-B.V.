import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import type { WalletChainId } from "./guard"

export { FLOW_STEP_LABELS } from "./routes"

/** Home walkthrough for someone opening the app for the first time. */
export const CONNECT_STEP_LABEL = "Connect your wallet"
export const SWITCH_STEP_LABEL = "Switch to Base Sepolia"
export const FILL_ESCROW_LABEL = "Fill in the escrow"
export const REVIEW_SEND_LABEL = "Review and send"

export const CONNECT_NOTE = "Connect a wallet on Base Sepolia. You sign each transaction in that wallet."
export const WRONG_NETWORK_NOTE =
  "This wallet is not on Base Sepolia. Switch to Base Sepolia before you send test ETH."
/** Official Base docs. The older network-faucets paths redirect here. */
export const BASE_SEPOLIA_FAUCET_DOCS_URL = "https://docs.base.org/get-started/get-funds"
export const TEST_ETH_LINK_LABEL = "Base Sepolia faucet"
export const TEST_ETH_NOTE = "Get free test ETH from a Base Sepolia faucet. It has no real value."

export type WalkthroughWallet = "disconnected" | "wrong-network" | "ready"
export type WalkthroughPlace = "home" | "funding" | "review"
export type WalkthroughState = "done" | "current" | "upcoming"

export function walletReadiness(connected: boolean, chainId: WalletChainId | null): WalkthroughWallet {
  if (!connected) return "disconnected"
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return "ready"
  return "wrong-network"
}

/** Exactly one step is current. Earlier steps are done. Later steps are upcoming. */
export function walkthroughStates(
  wallet: WalkthroughWallet,
  place: WalkthroughPlace,
): [WalkthroughState, WalkthroughState, WalkthroughState] {
  if (wallet !== "ready") return ["current", "upcoming", "upcoming"]
  if (place === "review") return ["done", "done", "current"]
  return ["done", "current", "upcoming"]
}

/** Three steps. The first name follows the wallet: connect, or switch when the chain is wrong. */
export function walkthroughLabels(wallet: WalkthroughWallet): readonly [string, string, string] {
  return [
    wallet === "wrong-network" ? SWITCH_STEP_LABEL : CONNECT_STEP_LABEL,
    FILL_ESCROW_LABEL,
    REVIEW_SEND_LABEL,
  ]
}

export function walkthroughStep(states: readonly WalkthroughState[]): number {
  const index = states.findIndex((state) => state === "current")
  return (index === -1 ? states.length : index) + 1
}

export function journeyNow(wallet: WalkthroughWallet, place: WalkthroughPlace): string {
  const states = walkthroughStates(wallet, place)
  const index = states.findIndex((state) => state === "current")
  return `Now · ${walkthroughLabels(wallet)[index]}`
}
