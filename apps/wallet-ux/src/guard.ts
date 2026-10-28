import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"

// Chain guard only. This client does not decide sanctions or location.
// The server returns the denial sentence. Show that sentence and nothing else.

export const ETHEREUM_MAINNET_CHAIN_ID = 1
export const BASE_MAINNET_CHAIN_ID = 8453

export type WalletChainId = number | null | "conflict"

export type ReadGuardInput = {
  rpcChainId: number | null
  walletConnected: boolean
  walletChainId: WalletChainId
}

export type GuardCode =
  | "ok"
  | "rpc-pending"
  | "rpc-mainnet"
  | "rpc-base-mainnet"
  | "rpc-other"
  | "wallet-unknown"
  | "wallet-conflict"
  | "wallet-mainnet"
  | "wallet-base-mainnet"
  | "wallet-other"

export type ReadGuard =
  | { ok: true; code: "ok" }
  | { ok: false; code: Exclude<GuardCode, "ok">; reason: string }

const SEPOLIA = `Base Sepolia (${BASE_SEPOLIA_CHAIN_ID})`

export function assertSepoliaOnly(chainIds: readonly number[]): void {
  if (chainIds.includes(ETHEREUM_MAINNET_CHAIN_ID) || chainIds.includes(BASE_MAINNET_CHAIN_ID)) {
    throw new Error("Mainnet is forbidden in the wallet config.")
  }
  if (chainIds.length !== 1 || chainIds[0] !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(`Wallet config must be ${SEPOLIA} only.`)
  }
}

export function resolveWalletChainId(
  accountChainId: number | undefined,
  connectorChainId: number | null,
): WalletChainId {
  if (accountChainId == null) return connectorChainId
  if (connectorChainId == null) return accountChainId
  if (accountChainId !== connectorChainId) return "conflict"
  return accountChainId
}

export function evaluateReadGuard(input: ReadGuardInput): ReadGuard {
  if (input.rpcChainId == null) {
    return { ok: false, code: "rpc-pending", reason: "Checking the RPC chain id." }
  }
  if (input.rpcChainId === ETHEREUM_MAINNET_CHAIN_ID) {
    return {
      ok: false,
      code: "rpc-mainnet",
      reason: "RPC reports Ethereum mainnet (chain id 1). This app never reads or writes mainnet.",
    }
  }
  if (input.rpcChainId === BASE_MAINNET_CHAIN_ID) {
    return {
      ok: false,
      code: "rpc-base-mainnet",
      reason: "RPC reports Base mainnet (chain id 8453). This app never reads or writes mainnet.",
    }
  }
  if (input.rpcChainId !== BASE_SEPOLIA_CHAIN_ID) {
    return {
      ok: false,
      code: "rpc-other",
      reason: `RPC reports chain id ${input.rpcChainId}. Reads are refused unless the RPC is ${SEPOLIA}.`,
    }
  }
  if (!input.walletConnected) return { ok: true, code: "ok" }

  if (input.walletChainId === "conflict") {
    return {
      ok: false,
      code: "wallet-conflict",
      reason: `Wallet chain id is inconsistent. Reads and writes stay off until the wallet reports ${SEPOLIA}.`,
    }
  }
  if (input.walletChainId == null) {
    return {
      ok: false,
      code: "wallet-unknown",
      reason: "Wallet is connected but its chain id is unknown. Reads and writes are refused.",
    }
  }
  if (input.walletChainId === ETHEREUM_MAINNET_CHAIN_ID) {
    return {
      ok: false,
      code: "wallet-mainnet",
      reason: `Wallet is on Ethereum mainnet (chain id 1). Switch to ${SEPOLIA}. Reads and writes are refused.`,
    }
  }
  if (input.walletChainId === BASE_MAINNET_CHAIN_ID) {
    return {
      ok: false,
      code: "wallet-base-mainnet",
      reason: `Wallet is on Base mainnet (chain id 8453). Switch to ${SEPOLIA}. Reads and writes are refused.`,
    }
  }
  if (input.walletChainId !== BASE_SEPOLIA_CHAIN_ID) {
    return {
      ok: false,
      code: "wallet-other",
      reason: `Wallet is on chain id ${input.walletChainId}. Switch to ${SEPOLIA}. Reads and writes are refused.`,
    }
  }
  return { ok: true, code: "ok" }
}
