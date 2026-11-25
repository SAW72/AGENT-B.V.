import { NETWORK_PILL } from "../registerCopy"

export function NetworkPill() {
  return (
    <p className="pill info" data-testid="network-pill">
      {NETWORK_PILL}
    </p>
  )
}
