/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BASE_SEPOLIA_RPC_URL?: string
  /** Public Base Sepolia refund relayer origin. Unset keeps escrow submits wallet-direct. */
  readonly VITE_CLAIM_RELAYER_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
