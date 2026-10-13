import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import type { WalletChainId } from "./guard"
import type { FlowId } from "./routes"

/** Home walkthrough for someone opening the app for the first time. */
export const WALKTHROUGH_LABELS = [
  "Connect your wallet",
  "Fund an escrow",
  "Send the first transaction",
] as const

export const CONNECT_NOTE = "Connect a wallet on Base Sepolia. You sign each transaction in that wallet."
export const WRONG_NETWORK_NOTE =
  "This wallet is not on Base Sepolia. Switch to Base Sepolia before you send test ETH."
export const TEST_ETH_NOTE =
  "You need a little Base Sepolia test ETH for the amount and the gas fee. Get it from a faucet. It has no real value."

/** Plain names for the fields inside a flow. The state word (Done, Now, Later) stays in front. */
export const FLOW_STEP_LABELS: Record<FlowId, readonly string[]> = {
  fund: ["Who is paid", "Which bots", "Amount and time", "Review and send"],
  release: ["The payment", "Review and send"],
  refund: ["The payment", "Review and send"],
  dispute: ["The case", "Review and send"],
  vote: ["Your vote", "Review and send"],
  withdraw: ["Your balance", "Review and send"],
}

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

export function walkthroughStep(states: readonly WalkthroughState[]): number {
  const index = states.findIndex((state) => state === "current")
  return (index === -1 ? states.length : index) + 1
}

export function journeyNow(wallet: WalkthroughWallet, place: WalkthroughPlace): string {
  const states = walkthroughStates(wallet, place)
  const index = states.findIndex((state) => state === "current")
  return `Now · ${WALKTHROUGH_LABELS[index]}`
}
