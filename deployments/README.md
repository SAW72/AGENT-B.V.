# Deployments

Committed address book for networks this repo is allowed to deploy. **Base Sepolia (chain id 84532) only.** Mainnet is refused by every deploy script.

## `base-sepolia.json`

Core contract addresses and `BotAttestationEscrow` are filled in. The BVT slots stay `null` with empty `deployTx`. Do not invent addresses. Do not commit `PRIVATE_KEY`, RPC credentials, or API keys.

JSON has no comments. Field meanings:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1`. Bump only if the shape changes. |
| `chainId` | Must stay `84532` (Base Sepolia). |
| `network` | `base-sepolia`. |
| `status` | `live` once core contracts are on Base Sepolia. BVT can still be null. |
| `notes` | Free text. Keep the warning that agents do not `--broadcast`. |
| `coreTimelock` | `CORE_TIMELOCK` address, or `null`. CORE_TIMELOCK is an EOA (with EIP-7702 delegation), not a timelock; to be replaced by TimelockController ([runbook](../docs/runbooks/CORE_TIMELOCK_MIGRATION.md)). Not the deployer. |
| `bvtGuardian` | `BVT_GUARDIAN` address, or `null`. |
| `claimRelayerWallet` | EOA for claim-relayer signing and funding on Base Sepolia (`0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861`, `…31861`). Not a contract. Derived from `RELAYER_PRIVATE_KEY` on the hosted service. Never commit the private key. |
| `<Contract>.address` | Deployed contract address, or `null`. Live `Denylist` and `Vault` are the current pair. |
| `<Contract>.deployTx` | Broadcast transaction hash that created the contract, or `""`. |
| `<Contract>.transferOwnershipTx` | Optional. Tx that called `transferOwnership`. This is not `acceptOwnership`. |
| `<Contract>.acceptOwnership` | Optional. `pending` until `coreTimelock` accepts, then `complete`. |
| `<Contract>.acceptOwnershipTx` | Optional. Tx hash of a successful `acceptOwnership`. |
| `<Contract>.acceptOwnershipBlock` | Optional. Block number of that accept tx. |
| `<Contract>.deployBlock` / `startBlock` | Optional. Create-tx block. For `BotAttestationEscrow` this is the indexer and relayer start block. |
| `<Contract>.commit` | Optional. Source commit the deployed bytecode was built from. |
| `superseded` | Previous Denylist and Vault. Each keeps `address`, `deployTx`, `supersededBy`, and why it was replaced. These are not the live slots. |
| `retired` | History that is not a live slot. `retired.BotAttestationEscrow` is the pre-ESC-M-1 escrow. `retired.BotAttestationEscrowEscM1` is the ESC-M-1 escrow, retired 2026-10-06. |

Contract slots, in deploy order:

1. `Denylist`, `Vault`, `Liability`, `InsuranceFund`, `DisputePanel` — `script/Deploy.s.sol`
2. `BotAttestationEscrow` — `script/DeployBotAttestationEscrow.s.sol`
3. `BVT`, `BVTStaking`, `BVTFeeRouter`, `BVTTimelock`, `BVTGovernor` — optional `script/DeployBVT.s.sol`

`Denylist`, `Vault`, and `BotAttestationEscrow` use OpenZeppelin **Ownable2Step**. After `transferOwnership` the deployer is still owner until the pending owner calls `acceptOwnership`. On the current book that accept is `complete` for the live Denylist, the live Vault, and the live `BotAttestationEscrow`: `owner` is governanceTimelock `0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33` and `pendingOwner` is the zero address. The live escrow accept tx is `0xb7e819961fbe644eef1122c7da4554090a4412083a87366b21c7da09124dd769` (block 47760929, 2026-10-06 12:35:46 UTC, status 1). The previous Denylist and Vault are under `superseded` and stay on chain. The superseded Denylist `owner` is `coreTimelock` and its `pendingOwner` is zero; it was not touched by the PR #11 redeploy. The superseded Vault still points at that old Denylist. Listing migration replay of `Listed` / `Unlisted` from the old Denylist was empty (0 Exact / 0 Signature / 0 Prompt).

`BotAttestationEscrow` is live at `0x3d660502D75f1e97b08c110255921b437A3C4C42` (pull-payment redeploy from commit `7fe4a863e9bce0b70b629dab76ddd2728c97b536`, deploy tx `0x0d39f2502956d1199bb9d264704aacab85ca7a5d54de3e1634b201c730b62b6c`, block 47715415, 2026-10-05 11:18:38 UTC). `transferOwnership` is `0xe7f8fed585fd148c8ca34ae57b2cc92516cf4a48a0fbd992a34fa0b381aeb5fa`. Block 47715415 is the indexer and relayer start block. Constructor governance is governanceTimelock. It is linked to DisputePanel `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb`. Sourcify exact match (verifiedAt 2026-10-05T11:18:43Z): `https://repo.sourcify.dev/84532/0x3d660502D75f1e97b08c110255921b437A3C4C42`. Blockscout `is_verified` is true: `https://base-sepolia.blockscout.com/address/0x3d660502D75f1e97b08c110255921b437A3C4C42`. Basescan verification was not confirmed. `acceptOwnership` is complete (`0xb7e819961fbe644eef1122c7da4554090a4412083a87366b21c7da09124dd769`, block 47760929): `owner` is governanceTimelock and `pendingOwner` is the zero address. A simulation must not overwrite this address.

`governanceTimelockHardening` is `applied`. Read-only against `https://sepolia.base.org`: `getMinDelay()` is 86400, `EXECUTOR_ROLE` for `address(0)` is false, and Spencer's Safe `0x12b3683A30De9845767c1f27a5D23591cA83dD54` is the only executor (grant and revoke in tx `0x71e927ff869292edb8e9c49a67333a5069c1a71a677a1376fef73b293836302f`, block 47677255). The Safe is 2-of-2, so losing either key freezes admin changes.

The ESC-M-1 escrow `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` is retired (2026-10-06) under `retired.BotAttestationEscrowEscM1`. Its deploy tx `0x7ab17bac1f046ad50299e905f6f5fed47455fdebd3e3004094b899c7f801d8aa` is block 47345163, commit `444c427`. Its `acceptOwnership` `0xe4286328ff1d177c724888255d3607187e4b4ea68d0f1e66d697e6152367e0e9` (block 47345442) was complete. That history stays. It is not the live slot.

The previous escrow `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` is retired (ESC-M-1 redeploy, retired 2026-09-26) under `retired.BotAttestationEscrow`. Its deploy tx `0x700d9bac95e8833bd7e93721a88d689a0fb839c9e6108858c52560eae111948e` and `transferOwnership` `0x00aaef315f23de346bfe63e77e0f04d3fbcadc370b0db21bb7abb8f8e12c40f2` are both block 47299930. Its `acceptOwnership` `0xd2e982568811c3706eec074d296ef7fa4c54838de714e1a5bfc8afc9fbb73983` (block 47300275) was complete. That history stays. It is not the live slot.

`DisputePanel` ownership moves immediately via `setOwner`. `openDispute` reverts with `panel not seated` until that owner has called `setArbitrator` for three addresses (`arbitratorCount >= 3`). On the live panel Gate B is seated: `arbitratorCount` is 3. Arbitrators: `0xD5ee9fA366C3698b34204722c635989E5197B018`, `0xF4253A3a3C102Ee59e38b2AA92989C3232eDcC30`, `0xB87Ed5F74276AC6172ef53fE866675093F75936E`. Seat txs (block 47299643): `0xa97b518ad87489ab1d45ec4bef5e548c1d4bf3b9c940552e8cba1752fed7553c`, `0xf1ad4d9221b2393863d9bc6a72c1a716cf389532d2cfa63fd4df682303ed6df6`, `0xa1f8f0fb6ad78dd2d9fd9d33dabf9cde5b73195a1b292869e7d96cc985cb79a3`. Commands: [`script/DEPLOY_ESCROW_BASE_SEPOLIA.md`](../script/DEPLOY_ESCROW_BASE_SEPOLIA.md).

`claimRelayerWallet` is the public funding and signing EOA for the Base Sepolia claim relayer. It is not a deployed contract and it is not a live slot the wallet UI reads. The hosted service derives it from `RELAYER_PRIVATE_KEY`. Record only the address. Never commit the private key.

Spencer fills this file. Agents do not `--broadcast`.

A tip-bytecode Denylist + Vault redeploy is `script/DeployDenylist.s.sol` (see [`script/DEPLOY_DENYLIST.md`](../script/DEPLOY_DENYLIST.md)). That script does not edit `base-sepolia.json`. After Spencer broadcasts, replace `Denylist` and `Vault` `address` and `deployTx` with the real values from that broadcast. Until then the live addresses in the JSON stay. After cutover, Denylist `0xF0f260967D377E07Bdd7840862508ddB23C012b8` and Vault `0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7` are superseded. Liability, InsuranceFund, and DisputePanel are not part of that redeploy.
The read-only wallet UI loads live slots from this file (`apps/wallet-ux`). `superseded` is not a read target. If this book fails validation, the UI falls back to the corrected Gate A pin in `apps/wallet-ux/src/book.ts`.
