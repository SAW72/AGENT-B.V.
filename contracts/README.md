# Contracts

Working Solidity for the on-chain layers. **Testnet only.** Mainnet is refused by the deploy script.

## Files
- `Denylist.sol` — fingerprint denylist. Exact, signature, and prompt matches are hard blocks (`ExactBlock`, `SignatureBlock`, `PromptBlock`). The owner can clear an active row; `timesListed` / `everListed` and the `Listed` / `Unlisted` events stay.
- `Vault.sol` — trusted-bot registry with capability tiers and irreversible burn. Constructor: `Vault(denylist)`.
- `interfaces/IVault.sol` — wallet and relayer ABI for the live Vault (register overloads, operator, burn, grant, reads). It does not change Vault bytecode.
- `InsuranceFund.sol` — fee-funded backstop. Constructor: `InsuranceFund(liability)` (immutable `onlyLiability` on `payout`).
- `Liability.sol` — owner → auditor → insurance waterfall. Constructor: `Liability(insuranceFund)` or `Liability(address(0))` then `bindInsurance`.
- `DisputePanel.sol` — 3-arbitrator **allowlist**. Only `setArbitrator` appointees may vote. `openDispute` reverts until three arbitrators are seated.
- `BotAttestationEscrow.sol` — bot-to-bot escrow. While `Open`, only the payer releases. An upheld dispute stays releasable after expiry. A panel unwind refunds the payer. An unresolved dispute refunds only after `expiresAt + RULING_GRACE` (7 days); inside that grace `refund` reverts `RulingPending`. `release` and `refund` credit `pendingWithdrawals` (no ETH push). The recipient calls `withdraw` or `withdrawTo`. That recipient must be an EOA, an EIP-7702 account, or a wallet/contract able to make that call. A non-upgradeable contract that cannot call `withdraw` or `withdrawTo` strands its own credit. There is no gasless claim yet, so a payee with 0 ETH needs gas to withdraw. Dependency swaps stay gated on `lockedValue` only; `totalOwed` is excluded on purpose.

## Deploy order (dependency-correct)

Three scripts, in this order. Agents simulate only. Spencer broadcasts. Record each address in [`deployments/base-sepolia.json`](../deployments/base-sepolia.json). Core addresses and `BotAttestationEscrow` are filled. BVT stays null until that deploy.

### (1) Core — `script/Deploy.s.sol`

Env: `PRIVATE_KEY`, `CORE_TIMELOCK` (required, non-zero, **≠ deployer**).

Liability is created first (with `address(0)` insurance) so `InsuranceFund` can freeze the Liability address as an immutable `onlyLiability` caller, then `bindInsurance` sets the reverse pointer:

1. `Denylist`
2. `Vault(denylist)`
3. `Liability(address(0))`
4. `InsuranceFund(liability)`
5. `liability.bindInsurance(insurance)`
6. `DisputePanel`
7. `transferOwnership(CORE_TIMELOCK)` on Denylist and Vault (OZ **Ownable2Step** — deployer stays owner until CORE_TIMELOCK calls `acceptOwnership`). CORE_TIMELOCK is an EOA (with EIP-7702 delegation), not a timelock; to be replaced by TimelockController ([runbook](../docs/runbooks/CORE_TIMELOCK_MIGRATION.md)).
8. `setOwner(CORE_TIMELOCK)` on InsuranceFund, Liability, DisputePanel (immediate; not two-step)

**Post-step (panel seat, Gate B).** `DisputePanel.openDispute` reverts `panel not seated` until `arbitratorCount >= 3`. After `setOwner`, only `CORE_TIMELOCK` can call `setArbitrator`. The core deploy script does not appoint them. On the live panel Gate B is seated (`arbitratorCount` is 3). Seat txs and the three arbitrators: [`script/DEPLOY_ESCROW_BASE_SEPOLIA.md`](../script/DEPLOY_ESCROW_BASE_SEPOLIA.md).

### Denylist + Vault redeploy — `script/DeployDenylist.s.sol`

Use this for the tip-bytecode cutover. Do not re-run `Deploy.s.sol` for it. The script deploys a new `Denylist` and `Vault(newDenylist)` only, then `transferOwnership(CORE_TIMELOCK)` on both. It does not deploy Liability, InsuranceFund, DisputePanel, Escrow, or BVT, and it does not call the live Denylist.

Env: `PRIVATE_KEY`, `CORE_TIMELOCK` (required, non-zero, **≠ deployer**). RPC is the forge `--rpc-url` (`BASE_SEPOLIA_RPC_URL`). Same chain guard: Base Sepolia **84532** only; mainnet always reverts.

Agents simulate. Spencer broadcasts. `acceptOwnership` on both new contracts, then the listing migration, are in [`script/DEPLOY_DENYLIST.md`](../script/DEPLOY_DENYLIST.md). Spencer writes the real addresses into `deployments/base-sepolia.json` after broadcast. The live Denylist is superseded only after that cutover.

```bash
forge script script/DeployDenylist.s.sol:DeployDenylist --rpc-url $BASE_SEPOLIA_RPC_URL -vvvv
```

### (2) Escrow — `script/DeployBotAttestationEscrow.s.sol`

Run only after (1), using the deployed addresses. Env (all required, non-zero):

- `PRIVATE_KEY`
- `DENYLIST`
- `VAULT`
- `DISPUTE_PANEL`
- `CORE_TIMELOCK` (≠ deployer)

The script deploys `BotAttestationEscrow(denylist, vault, panel, CORE_TIMELOCK)` and `transferOwnership(CORE_TIMELOCK)`. **Ownable2Step:** CORE_TIMELOCK must `acceptOwnership` or the deployer remains owner. CORE_TIMELOCK is an EOA (with EIP-7702 delegation), not a timelock; to be replaced by TimelockController ([runbook](../docs/runbooks/CORE_TIMELOCK_MIGRATION.md)). `governance` is CORE_TIMELOCK. `createEscrow` reverts until CORE_TIMELOCK has accepted. `setDenylist`, `setVault`, and `setDisputePanel` revert unless `owner() == governance`, and they also revert while `lockedValue != 0`. `totalOwed` (credited, unclaimed ETH) does not keep that gate shut. `release` and `refund` do not transfer ETH; the payee or payer pulls it with `withdraw` / `withdrawTo`. The credited account must be an EOA, an EIP-7702 account, or a wallet/contract that can call those functions. A non-upgradeable contract that cannot call them strands its own credit. There is no gasless claim yet, so a payee with 0 ETH needs gas to withdraw. A denylist swap emits `DenylistUpdated` (previous, new, caller, timestamp). Vault and dispute-panel swaps emit `VaultUpdated` and `DisputePanelUpdated` with that same shape. The constructor emits the initial set with previous `address(0)`. Setting the current address again reverts (`DenylistUnchanged`, `VaultUnchanged`, `DisputePanelUnchanged`). That is a governance event. Production has no hot EOA admin for it. Do not fund before `acceptOwnership`. The script does not redeploy Denylist, Vault, or DisputePanel.

### (3) Optional BVT — `script/DeployBVT.s.sol`

Env: `PRIVATE_KEY`, `BVT_GUARDIAN` (required, non-zero, ≠ deployer). Optional: `BVT_INSURANCE_SINK`, `BVT_TREASURY` (default to the BVT timelock). Does not touch the core or escrow contracts. See the BVT section below.

## Chainid guard

`script/Deploy.s.sol` enforces:

| Chain | ID | Allowed |
| --- | --- | --- |
| Base Sepolia | **84532** | yes (default) |
| Ethereum Sepolia | 11155111 | no, unless you change `ALLOWED_CHAIN_ID` |
| Ethereum mainnet | 1 | **always revert** (`Deploy: mainnet forbidden`) |
| anything else | — | revert |

To switch the script to Ethereum Sepolia, change `ALLOWED_CHAIN_ID` to `ETH_SEPOLIA_CHAIN_ID` (11155111). Do not remove the mainnet check.

## Spencer deploy (you broadcast; agents do not)

Keys and RPC come from the environment only. Never commit `PRIVATE_KEY`, paste it into a PR, or pass it on a recorded command line if you can avoid it.

```bash
# one-time
curl -L https://foundry.paradigm.xyz | bash
foundryup
forge install foundry-rs/forge-std

export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
# PRIVATE_KEY is a Base Sepolia funded key — export it in your shell, do not commit it
# CORE_TIMELOCK is an EOA (with EIP-7702 delegation), not a timelock; to be replaced by TimelockController (docs/runbooks/CORE_TIMELOCK_MIGRATION.md). Must not be the deployer.

# compile + local tests (no RPC, no key)
forge build
forge test

# simulate against Base Sepolia (no broadcast). CORE_TIMELOCK required (≠ deployer).
forge script script/Deploy.s.sol:Deploy --rpc-url "$BASE_SEPOLIA_RPC_URL"

# YOU run this. Agents must not --broadcast.
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --broadcast

# After the create tx: CORE_TIMELOCK acceptOwnership() on Denylist and Vault.
# Then CORE_TIMELOCK setArbitrator three times so DisputePanel.openDispute can succeed.
```

Optional verify (needs a Basescan key in the environment, not the repo):

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --broadcast \
  --verify \
  --etherscan-api-key "$BASESCAN_API_KEY"
```

After a successful broadcast, paste addresses below and in [`deployments/base-sepolia.json`](../deployments/base-sepolia.json). Do not commit `.env`.

### Escrow deploy (after core addresses exist)

Pre-filled simulate command, Spencer-only broadcast, Gate B seating, and the accept-then-paste steps: [`script/DEPLOY_ESCROW_BASE_SEPOLIA.md`](../script/DEPLOY_ESCROW_BASE_SEPOLIA.md). SIMULATE is not a live deploy. Agents do not pass `--broadcast`. The block below is the same script with the live addresses filled in.

```bash
# PRIVATE_KEY from the shell. Deployer, not CORE_TIMELOCK. Never commit it.
export DENYLIST=0xeE76876bECcFc1B58fC06fF4E654a517d784B224
export VAULT=0x1463D664fA467FBCDA4B05443434494f05e565bc
export DISPUTE_PANEL=0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb
export CORE_TIMELOCK=0x10CC9474b45625ADfd05C209f2518023484878D9  # must not be the deployer

# simulate (no broadcast)
forge script script/DeployBotAttestationEscrow.s.sol:DeployBotAttestationEscrow \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"

# YOU run this. Agents must not --broadcast.
forge script script/DeployBotAttestationEscrow.s.sol:DeployBotAttestationEscrow \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --broadcast
```

On the live escrow, `acceptOwnership` is complete. `owner` is `CORE_TIMELOCK` and `pendingOwner` is the zero address. The accept tx is `0xe4286328ff1d177c724888255d3607187e4b4ea68d0f1e66d697e6152367e0e9` (block 47345442, status 1, from `CORE_TIMELOCK`). Denylist changes go through `setDenylist` from CORE_TIMELOCK, an EOA (with EIP-7702 delegation), not a timelock; to be replaced by TimelockController ([runbook](../docs/runbooks/CORE_TIMELOCK_MIGRATION.md)). That call reverts while `lockedValue != 0`. Agents do not `--broadcast` and do not call `createEscrow` from this repo session.

## Base Sepolia addresses (84532)

Core stack is live. Canonical copy: [`deployments/base-sepolia.json`](../deployments/base-sepolia.json).

PR #11 `DeployDenylist` redeployed **Denylist and Vault only**. Liability, InsuranceFund, and DisputePanel addresses are unchanged. `BotAttestationEscrow` is live and linked to that DisputePanel. BVT is not deployed. The new Vault `denylist()` is the new Denylist.

**Gate A is done on the new pair.** `acceptOwnership` is complete on both the new Denylist and the new Vault. On both, `owner` is `CORE_TIMELOCK` (`0x10CC9474b45625ADfd05C209f2518023484878D9`) and `pendingOwner` is the zero address.

`acceptOwnership` txs (status success): Denylist `0xc8ad34d956d802b3d0d8d032178c9b6786ead6afec1bd502158f1f603b3e3949` (block 47294619), Vault `0xb2aa7515c4c9bac0bbe3403bbd0bb6b8afa72452a4d4ed9ad626fc26944df9b0` (block 47294624). The earlier `transferOwnership(CORE_TIMELOCK)` txs were Denylist `0xb9767bc6c2b54ff4ae805c09b401c0c5ffb0079be0a54b7925eb9dd41758443c` (block 47294165) and Vault `0xd2b0aef1af321729e7361305a591ed7d8aacb2d84724968f979598e8be2d4076` (block 47294166).

Listing migration replay of `Listed` / `Unlisted` from the previous Denylist was empty: **0 Exact / 0 Signature / 0 Prompt**.

| Contract | Address | Tx |
| --- | --- | --- |
| Denylist | `0xeE76876bECcFc1B58fC06fF4E654a517d784B224` | `0xc4f2bf7ac1b256f79aaa566db6c88973761b41ae0e510d16e49cc2c7897c0c32` |
| Vault | `0x1463D664fA467FBCDA4B05443434494f05e565bc` | `0xeb0b97ac3c7abd49ffd99baef18703cb44563ff906e664d494325174ef6a8171` |
| InsuranceFund | `0x19fc26B36Cb2031062eD90C19db64b3b09753ab8` | `0xa71db2c304d8e80e4043e4d093a0c102ec619624ab0500d0bc7246dc27d3edd7` |
| Liability | `0x554Caf5a214B8d70D675C09186C5EAE24FEB7307` | `0x99865db9b9f4a6807b085cec8c50d22160025c4df09afc609fb52b9758fe6261` |
| DisputePanel | `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb` | `0x9ecd10d67054fbf9e63ad25dd1520ed809fbf94c4ab1f19ad84e81899562b77f` |
| BotAttestationEscrow | `0x3d660502D75f1e97b08c110255921b437A3C4C42` | `0x0d39f2502956d1199bb9d264704aacab85ca7a5d54de3e1634b201c730b62b6c` |

`DisputePanel.owner()` is `CORE_TIMELOCK`. Gate B is seated: `arbitratorCount` is 3.

| # | Arbitrator | Seat tx (block 47299643) |
| --- | --- | --- |
| 1 | `0xD5ee9fA366C3698b34204722c635989E5197B018` | `0xa97b518ad87489ab1d45ec4bef5e548c1d4bf3b9c940552e8cba1752fed7553c` |
| 2 | `0xF4253A3a3C102Ee59e38b2AA92989C3232eDcC30` | `0xf1ad4d9221b2393863d9bc6a72c1a716cf389532d2cfa63fd4df682303ed6df6` |
| 3 | `0xB87Ed5F74276AC6172ef53fE866675093F75936E` | `0xa1f8f0fb6ad78dd2d9fd9d33dabf9cde5b73195a1b292869e7d96cc985cb79a3` |

`BotAttestationEscrow` is the pull-payment redeploy at `0x3d660502D75f1e97b08c110255921b437A3C4C42`, built from commit `7fe4a863e9bce0b70b629dab76ddd2728c97b536`, and linked to DisputePanel `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb`. Create tx `0x0d39f2502956d1199bb9d264704aacab85ca7a5d54de3e1634b201c730b62b6c` is block 47715415 (2026-10-05 11:18:38 UTC, indexer and relayer start block). Deployer `0x5D467FA00eC0E92044f779e495a17db66c5964aa` called `transferOwnership` in `0xe7f8fed585fd148c8ca34ae57b2cc92516cf4a48a0fbd992a34fa0b381aeb5fa`. Constructor governance is governanceTimelock. `acceptOwnership` is complete. `owner` is governanceTimelock (`0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33`) and `pendingOwner` is the zero address. The accept tx is `0xb7e819961fbe644eef1122c7da4554090a4412083a87366b21c7da09124dd769` (block 47760929, 2026-10-06 12:35:46 UTC, status 1). Sourcify exact match (verifiedAt 2026-10-05T11:18:43Z): `https://repo.sourcify.dev/84532/0x3d660502D75f1e97b08c110255921b437A3C4C42`. Blockscout `is_verified` is true: `https://base-sepolia.blockscout.com/address/0x3d660502D75f1e97b08c110255921b437A3C4C42`. Basescan verification was not confirmed for this address.

Create txs: Denylist block 47294163, Vault block 47294164, BotAttestationEscrow block 47715415. The Tx column is the create transaction.

### Retired escrows

The ESC-M-1 `BotAttestationEscrow` `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` is retired (pull-payment redeploy, retired 2026-10-06) under `retired.BotAttestationEscrowEscM1`. Its create tx `0x7ab17bac1f046ad50299e905f6f5fed47455fdebd3e3004094b899c7f801d8aa` is block 47345163, commit `444c427`. Its `acceptOwnership` `0xe4286328ff1d177c724888255d3607187e4b4ea68d0f1e66d697e6152367e0e9` (block 47345442) was complete. Constructor governance on that contract is `CORE_TIMELOCK`. Basescan is verified for that retired address. It is history, not the live slot.

The previous `BotAttestationEscrow` `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` is retired (ESC-M-1 redeploy, retired 2026-09-26). It stays on chain under `retired.BotAttestationEscrow`. Its create tx `0x700d9bac95e8833bd7e93721a88d689a0fb839c9e6108858c52560eae111948e` and `transferOwnership` `0x00aaef315f23de346bfe63e77e0f04d3fbcadc370b0db21bb7abb8f8e12c40f2` are both block 47299930. Its `acceptOwnership` `0xd2e982568811c3706eec074d296ef7fa4c54838de714e1a5bfc8afc9fbb73983` (block 47300275) was complete, so on that contract `owner` is `CORE_TIMELOCK` and `pendingOwner` is zero. `supersededBy` on that record stays `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d`. That record is history. It is not the live slot.

### Superseded (deprecated, left on chain)

The previous pair still has code. This redeploy did not delete it. The old Vault `denylist()` is still the old Denylist.

| Contract | Address | Tx | Status |
| --- | --- | --- | --- |
| Denylist | `0xF0f260967D377E07Bdd7840862508ddB23C012b8` | `0x739331697a228684f18a69c54d312baa7557dfcb92c7875c48fa7b2e4c84a429` | Deprecated. Superseded by `0xeE76876bECcFc1B58fC06fF4E654a517d784B224`. Owner remains `CORE_TIMELOCK`; `pendingOwner` is zero. Untouched by the redeploy. |
| Vault | `0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7` | `0xe2524dd91b6485f1e484409610659cf3c3819ee7c0e7b5044cda5651f26a447b` | Deprecated. Superseded by `0x1463D664fA467FBCDA4B05443434494f05e565bc`. Still points at the old Denylist. |

## Live Denylist and Vault ops

The live pair has no listings and no Vault bots. Operator scripts call the existing addresses. They do not redeploy Denylist or Vault. Simulate commands, cast recipes, and failure modes: [`script/OPS_LIVE_DENYLIST_VAULT.md`](../script/OPS_LIVE_DENYLIST_VAULT.md).

## BVT stack (additive)

Agent-BV Token (BVT) lives under `contracts/bvt/`. It does **not** change Denylist / Vault / Liability / InsuranceFund / DisputePanel. Those contracts can later call `IBVTFeeGate` / `IAuditorStakeView` (see `contracts/bvt/IBVTHooks.sol`). Core deploy already starts Ownable2Step handoff of Denylist / Vault to `CORE_TIMELOCK`.

| File | Role |
| --- | --- |
| `bvt/BVT.sol` | ERC-20. Product label **Agent-BV Token (BVT)**. On-chain `name()` remains **Bot Verifier Token**; symbol **BVT**. No constructor mint. |
| `bvt/BVTStaking.sol` | Auditor lock, operator bootstrap, slash. |
| `bvt/BVTFeeRouter.sol` | Registration / audit / vault fees + usage earn mint. |
| `bvt/BVTGovernor.sol` + `bvt/BVTTimelock.sol` | Stake-weighted votes; **48h** timelock. |
| `bvt/IBVTHooks.sol` | Interfaces for a later Vault/Denylist wire-up. |

Tokenomics (who mints, slash roles, fee sinks, delays): [`docs/BVT_TOKENOMICS.md`](../docs/BVT_TOKENOMICS.md).

### BVT deploy (you broadcast; agents do not)

Same chainid rules as the core script: Base Sepolia **84532** only; **mainnet always reverts**. Supply after deploy is **0**.

**Roles:** `DeployBVT.run` calls **`wireAndHarden`** (single path): timelock holds `EARNER` / `BOOTSTRAP` / `SLASHER` / `DEFAULT_ADMIN`; deployer **renounces** those plus governance/admin. Harden **reverts** if the deployer still holds any hot role. Sinks default to the **timelock**. **`BVT_GUARDIAN` is required** (non-zero, ≠ deployer — typically a multisig) and may cancel during the delay. Long-lived/valued deploys: timelock + multisig only — see SECURITY in [`docs/BVT_TOKENOMICS.md`](../docs/BVT_TOKENOMICS.md#security).

```bash
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge build && forge test

export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
# PRIVATE_KEY from env only — never commit
# required: BVT_GUARDIAN = non-deployer multisig (must not equal PRIVATE_KEY address)
# optional: BVT_INSURANCE_SINK, BVT_TREASURY (default = timelock)

# simulate
forge script script/DeployBVT.s.sol:DeployBVT --rpc-url "$BASE_SEPOLIA_RPC_URL"

# YOU run this. Agents must not --broadcast.
forge script script/DeployBVT.s.sol:DeployBVT --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast
```

To switch the BVT script to Ethereum Sepolia, change `ALLOWED_CHAIN_ID` to `ETH_SEPOLIA_CHAIN_ID` (11155111). Do not remove the mainnet check.

### Base Sepolia BVT addresses (84532)

Fill in after Spencer broadcasts `script/DeployBVT.s.sol`.

| Contract | Address | Tx |
| --- | --- | --- |
| BVT | _pending Spencer deploy_ | |
| BVTStaking | _pending_ | |
| BVTFeeRouter | _pending_ | |
| BVTTimelock | _pending_ | |
| BVTGovernor | _pending_ | |

## Notes
- Denylist `remove(id, bucket)` clears active membership only. History stays (`everListed`, `timesListed`, `Listed` / `Unlisted`). `bytes32(0)` is rejected. `check` stays a view and does not emit; reads are not the audit trail.
- `PromptBlock` is a hard block. Vault `register` and escrow `_verifyBot` fail closed on every `MatchLevel` other than `None`.
- Escrow `setDenylist` is callable only by immutable `governance` while that address is owner, and only when no ETH is locked. See the escrow section above.
- These are unaudited. Get a real audit before any mainnet discussion.
- Pair with `blockchain_bot/example_policy.sol` for the action leash.
- BVT is not a sale token. Mint only via earn (`BVTFeeRouter`) or operator bootstrap (`BVTStaking.bootstrapOperator`).
