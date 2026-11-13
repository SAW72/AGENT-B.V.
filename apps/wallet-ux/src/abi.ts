import type { Abi } from "viem"
import escrowAbiJson from "./abi/BotAttestationEscrow.json"
import denylistAbiJson from "./abi/Denylist.json"
import disputePanelAbiJson from "./abi/DisputePanel.json"
import identityRegistry8004AbiJson from "./abi/IdentityRegistry8004.json"
import insuranceFundAbiJson from "./abi/InsuranceFund.json"
import vaultHookAbiJson from "./abi/IVault.json"
import liabilityAbiJson from "./abi/Liability.json"

export const escrowAbi = escrowAbiJson as Abi
export const denylistAbi = denylistAbiJson as Abi
/** Existing Base Sepolia ERC-8004 Identity Registry. Reads, plus the unsigned register surface. */
export const identityRegistry8004Abi = identityRegistry8004AbiJson as Abi
/** Wallet ABI hook (`contracts/interfaces/IVault.sol`). Reads only. */
export const vaultAbi = vaultHookAbiJson as Abi
export const disputePanelAbi = disputePanelAbiJson as Abi
export const liabilityAbi = liabilityAbiJson as Abi
export const insuranceFundAbi = insuranceFundAbiJson as Abi
