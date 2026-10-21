import type { WalletChainId } from "./guard"
import { FirstRun } from "./firstRun"
import { TaskPicker } from "./taskPicker"
import { walletReadiness } from "./walkthrough"

/** Status only. The switch control is the first-run card's button, not this label. */
export function HeaderNetwork({
  connected,
  chainId,
}: {
  connected: boolean
  chainId: WalletChainId | null
}) {
  const readiness = walletReadiness(connected, chainId)
  if (readiness === "disconnected") return null
  return (
    <span className="chip-network" data-testid="header-network">
      {readiness === "ready" ? "Base Sepolia" : "Not on Base Sepolia"}
    </span>
  )
}

/** The guard reason, with no switch button. */
export function ChainBanner({ reason }: { reason: string }) {
  return (
    <div className="banner" role="alert" data-testid="chain-banner">
      <p>{reason}</p>
    </div>
  )
}

/** First-run card plus the task picker. Picker controls stay secondary while the card is on screen. */
export function HomeScreen({ voteReason }: { voteReason: string | null }) {
  return (
    <>
      <FirstRun />
      <TaskPicker voteReason={voteReason} secondary />
    </>
  )
}
