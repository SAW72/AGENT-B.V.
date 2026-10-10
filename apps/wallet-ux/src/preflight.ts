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
