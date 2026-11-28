import type { Address, Hex } from "viem"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import deploymentBook from "./base-sepolia.json"

/** Booked Base Sepolia refund relayer wallet. Simulations of relayer submits use this as `from`. */
export const CLAIM_RELAYER_WALLET = deploymentBook.claimRelayerWallet as Address

export type PreflightCall = {
  account?: Address
  to: Address
  data: Hex
  value?: bigint
}

/** Narrow client so tests can pass a mock. A wagmi public client satisfies this. */
export type PreflightClient = {
  call: (args: PreflightCall) => Promise<unknown>
}

/**
 * Base Sepolia eth_call with the same calldata the wallet would send.
 * A revert throws and the wallet prompt is not opened.
 */
export async function submitAfterPreflight<T>(input: {
  chainId: number
  client: PreflightClient
  account?: Address
  to: Address
  data: Hex
  value: bigint
  send: () => Promise<T>
}): Promise<T> {
  if (input.chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error("This check only runs on the Base Sepolia network. Nothing was sent.")
  }
  await input.client.call({
    account: input.account,
    to: input.to,
    data: input.data,
    value: input.value,
  })
  return input.send()
}

/** Simulate the escrow as the relayer wallet, then POST only if the call succeeds. */
export async function submitRelayerAfterPreflight<T>(input: {
  client: PreflightClient
  to: Address
  data: Hex
  value: bigint
  post: () => Promise<T>
}): Promise<T> {
  return submitAfterPreflight({
    chainId: BASE_SEPOLIA_CHAIN_ID,
    client: input.client,
    account: CLAIM_RELAYER_WALLET,
    to: input.to,
    data: input.data,
    value: input.value,
    send: input.post,
  })
}

export function parseRpcChainId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || value.trim() === "") return null
  const parsed = value.trim().startsWith("0x") || value.trim().startsWith("0X") ? Number.parseInt(value, 16) : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Fail closed if a live eth_chainId read is not Base Sepolia. A missing request function,
 * a thrown read, and a value that does not parse all refuse the send.
 */
export async function assertLiveChain84532(
  request: ((args: { method: "eth_chainId" }) => Promise<unknown>) | null,
): Promise<void> {
  const id = request ? parseRpcChainId(await request({ method: "eth_chainId" })) : null
  if (id !== BASE_SEPOLIA_CHAIN_ID) {
    throw Object.assign(new Error("This check only runs on the Base Sepolia network. Nothing was sent."), {
      name: "ChainMismatchError",
    })
  }
}
