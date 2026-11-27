import { formatTransactionRequest, numberToHex } from "viem"
import { baseSepolia } from "viem/chains"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"

export function formatSepoliaTransactionRequest(
  request: Parameters<typeof formatTransactionRequest>[0],
) {
  return {
    ...formatTransactionRequest(request),
    chainId: numberToHex(BASE_SEPOLIA_CHAIN_ID),
  }
}

export const sepoliaTransactionRequest = {
  type: "transactionRequest" as const,
  format: formatSepoliaTransactionRequest,
}

export const sepoliaChain = {
  ...baseSepolia,
  formatters: {
    ...(baseSepolia.formatters ?? {}),
    transactionRequest: sepoliaTransactionRequest,
  },
} as typeof baseSepolia
