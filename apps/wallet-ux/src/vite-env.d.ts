/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BASE_SEPOLIA_RPC_URL?: string
  /**
   * Public Base Sepolia refund relayer origin.
   * Production builds require this from build-env.required.json.
   * Unset in dev keeps escrow submits wallet-direct.
   */
  readonly VITE_CLAIM_RELAYER_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
