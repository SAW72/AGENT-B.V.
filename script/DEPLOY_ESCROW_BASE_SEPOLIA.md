# BotAttestationEscrow on Base Sepolia

`BotAttestationEscrow` is **live** on Base Sepolia against the live core stack. Gate B is **seated** on the live `DisputePanel` (`arbitratorCount` is 3). This file records that state. It does not deploy anything by itself.

**SIMULATE is not live.** `forge script` without `--broadcast` forks Base Sepolia and prints the calls. Nothing is sent. A green simulation is not a deployment. Do not paste a simulated address over the live book.

**HARD STOP**

- Agents do not pass `--broadcast` or `--resume`.
- Do not touch Ethereum mainnet. Every script here reverts on chainid `1`.
- Do not redeploy Denylist, Vault, or DisputePanel. Gate A is done. Gate B is seated. Use the live addresses below.
- Do not broadcast an escrow redeploy until the Auditor re-audit PASSES and the Verifier APPROVES. Spencer broadcasts. Agents do not.
- Do not overwrite `BotAttestationEscrow.address` in `deployments/base-sepolia.json` with a simulation address. The live slot is the pull-payment redeploy `0x3d660502D75f1e97b08c110255921b437A3C4C42`. The ESC-M-1 escrow is under `retired.BotAttestationEscrowEscM1`. The previous escrow is under `retired.BotAttestationEscrow`.
- Do not deploy BVT in this pack.
- Do not call `createEscrow` from an agent session.

The live escrow is the pull-payment redeploy `0x3d660502D75f1e97b08c110255921b437A3C4C42`, built from commit `7fe4a863e9bce0b70b629dab76ddd2728c97b536`. The retired ESC-M-1 contract `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` (retired 2026-10-06, commit `444c427`) includes the H-1 fix and the ESC-M-1 dispute-link checks. The retired contract at `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` does not include those checks (ESC-M-1 redeploy, retired 2026-09-26). This pack does not change Denylist, Vault, or DisputePanel bytecode.

Retired history, not the live escrow: Gate B was seated (block 47299643), then the retired escrow was created and `transferOwnership` ran (block 47299930), then `CORE_TIMELOCK` called `acceptOwnership` on that retired escrow (block 47300275).

## Live addresses (chainid 84532)

| Role | Address |
| --- | --- |
| Denylist | `0xeE76876bECcFc1B58fC06fF4E654a517d784B224` |
| Vault | `0x1463D664fA467FBCDA4B05443434494f05e565bc` |
| DisputePanel | `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb` |
| BotAttestationEscrow | `0x3d660502D75f1e97b08c110255921b437A3C4C42` |
| CORE_TIMELOCK | `0x10CC9474b45625ADfd05C209f2518023484878D9` |

`acceptOwnership` on the live escrow is complete. `owner()` is governanceTimelock `0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33`. `pendingOwner` is the zero address. The accept tx is `0xb7e819961fbe644eef1122c7da4554090a4412083a87366b21c7da09124dd769` (block 47760929, 2026-10-06 12:35:46 UTC, status 1). The deployer `0x5D467FA00eC0E92044f779e495a17db66c5964aa` is no longer owner.

`DisputePanel.owner()` is `CORE_TIMELOCK`. Gate B is seated: `arbitratorCount` is **3**. `openDispute` reverts `panel not seated` only if that count later drops below 3.

| # | Arbitrator | Seat tx (block 47299643) |
| --- | --- | --- |
| 1 | `0xD5ee9fA366C3698b34204722c635989E5197B018` | `0xa97b518ad87489ab1d45ec4bef5e548c1d4bf3b9c940552e8cba1752fed7553c` |
| 2 | `0xF4253A3a3C102Ee59e38b2AA92989C3232eDcC30` | `0xf1ad4d9221b2393863d9bc6a72c1a716cf389532d2cfa63fd4df682303ed6df6` |
| 3 | `0xB87Ed5F74276AC6172ef53fE866675093F75936E` | `0xa1f8f0fb6ad78dd2d9fd9d33dabf9cde5b73195a1b292869e7d96cc985cb79a3` |

Live escrow create tx `0x0d39f2502956d1199bb9d264704aacab85ca7a5d54de3e1634b201c730b62b6c` is block 47715415 (2026-10-05 11:18:38 UTC, indexer and relayer start block), from commit `7fe4a863e9bce0b70b629dab76ddd2728c97b536`. `transferOwnership` tx `0xe7f8fed585fd148c8ca34ae57b2cc92516cf4a48a0fbd992a34fa0b381aeb5fa`. Constructor args: denylist `0xeE76876bECcFc1B58fC06fF4E654a517d784B224`, vault `0x1463D664fA467FBCDA4B05443434494f05e565bc`, panel `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb`, governance `0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33`. Sourcify exact match (verifiedAt 2026-10-05T11:18:43Z): `https://repo.sourcify.dev/84532/0x3d660502D75f1e97b08c110255921b437A3C4C42`. Blockscout `is_verified` is true: `https://base-sepolia.blockscout.com/address/0x3d660502D75f1e97b08c110255921b437A3C4C42`. Basescan verification was not confirmed. The escrow is linked to DisputePanel `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb`. Canonical copy: [`deployments/base-sepolia.json`](../deployments/base-sepolia.json).

Retired ESC-M-1 escrow (pull-payment redeploy, retired 2026-10-06): `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d`, create tx `0x7ab17bac1f046ad50299e905f6f5fed47455fdebd3e3004094b899c7f801d8aa`, block 47345163, commit `444c427`. Its `acceptOwnership` tx `0xe4286328ff1d177c724888255d3607187e4b4ea68d0f1e66d697e6152367e0e9` is block 47345442. Recorded under `retired.BotAttestationEscrowEscM1`.

Retired escrow (ESC-M-1 redeploy, retired 2026-09-26): create tx `0x700d9bac95e8833bd7e93721a88d689a0fb839c9e6108858c52560eae111948e` and `transferOwnership` tx `0x00aaef315f23de346bfe63e77e0f04d3fbcadc370b0db21bb7abb8f8e12c40f2` are both block 47299930. Its `acceptOwnership` tx `0xd2e982568811c3706eec074d296ef7fa4c54838de714e1a5bfc8afc9fbb73983` is block 47300275. That contract is `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c`. It is history, not the book address.

`CORE_TIMELOCK` (`0x10CC9474b45625ADfd05C209f2518023484878D9`) is an EOA (with EIP-7702 delegation), not a timelock; to be replaced by TimelockController ([runbook](../docs/runbooks/CORE_TIMELOCK_MIGRATION.md)). Delegation target `0x63c0c19a282a1b52b07dd5a65b58948a07dae32b`. `getMinDelay` reverts. It is the same account that owns the live Denylist and Vault. `onlyOwner` is `msg.sender == owner()`. A transaction whose sender is `CORE_TIMELOCK` is the owner call. See [`script/OPS_LIVE_DENYLIST_VAULT.md`](OPS_LIVE_DENYLIST_VAULT.md).

Liability `0x554Caf5a214B8d70D675C09186C5EAE24FEB7307` and InsuranceFund `0x19fc26B36Cb2031062eD90C19db64b3b09753ab8` stay as they are. This pack does not call them.

## Escrow simulate env

`script/DeployBotAttestationEscrow.s.sol` reads these. All four addresses are required and must be the live rows above. The script reverts on any other Denylist, Vault, panel, or `CORE_TIMELOCK`. It deploys only `BotAttestationEscrow`. The deployer is `msg.sender`, which `forge` sets from `--sender` on a dry run and from `--account` plus `--sender` on a broadcast. The script does not read a signing key from the environment. `CORE_TIMELOCK` must not equal the deployer.

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
export DENYLIST=0xeE76876bECcFc1B58fC06fF4E654a517d784B224
export VAULT=0x1463D664fA467FBCDA4B05443434494f05e565bc
export DISPUTE_PANEL=0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb
export CORE_TIMELOCK=0x10CC9474b45625ADfd05C209f2518023484878D9
```

| Variable | Meaning |
| --- | --- |
| `DENYLIST` | Live Denylist above. The script does not redeploy it. |
| `VAULT` | Live Vault above. The script does not redeploy it. |
| `DISPUTE_PANEL` | Live DisputePanel above. The script does not redeploy it. |
| `CORE_TIMELOCK` | Immutable escrow `governance` and Ownable2Step owner after `acceptOwnership`. An EOA (with EIP-7702 delegation), not a timelock; to be replaced by TimelockController ([runbook](../docs/runbooks/CORE_TIMELOCK_MIGRATION.md)). |
| `BASE_SEPOLIA_RPC_URL` | Base Sepolia RPC. Chainid must be `84532`. Any other chain reverts. |

## Escrow simulate (not live)

Dry-run sender is `0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001` (`SIMULATE_SENDER`), the public burn EOA. No private key. No `--broadcast`. Forge checks that sender's real balance while estimating gas, and this address already holds dust on Base Sepolia. It is not the deployer Spencer will use, and it is not `CORE_TIMELOCK`.

Anvil default key #0 (`0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`) has EIP-7702 delegation code on Base Sepolia forks. Do not use it as the fork deployer. On a local anvil fork of Base Sepolia at block `47396186` (chainid `84532`), `cast code 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --rpc-url "$BASE_SEPOLIA_RPC_URL"` returned `0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b`. Anvil defaults 1 through 9 also returned 23-byte `0xef0100…` delegation code on that same fork, so none of those accounts is an empty deployer. The fork-only deployer with no code is `SIMULATE_SENDER`. The same `cast code` on `0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001` returned `0x`.

```bash
forge script script/DeployBotAttestationEscrow.s.sol:DeployBotAttestationEscrow \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --sender 0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001
```

The log line `SIMULATE; no transaction will be sent` is the dry run. The address printed for `BotAttestationEscrow` exists only inside that process. Do not paste it into the address book.

Re-run on 2026-09-28 from main `a66ef6439dec6fd2e5ad49d53fa4ce98d373d787`, `forge script` with no `--broadcast`, `--sender` `SIMULATE_SENDER`, and `--rpc-url` set to that anvil fork (block `47396186`). `contracts/BotAttestationEscrow.sol` is the same file at `da47d9a12d64cd4bea4b6fce0b2166b4c55a0427` and at `a66ef64`. Nothing was broadcast. Log summary:

```
SIMULATE; no transaction will be sent
chainid 84532
deployer 0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001
BotAttestationEscrow 0x4e3AC0f579eCA30B37C6F7C2ccD21bA69742A999
constructor Denylist 0xeE76876bECcFc1B58fC06fF4E654a517d784B224
constructor Vault 0x1463D664fA467FBCDA4B05443434494f05e565bc
constructor DisputePanel 0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb
constructor governance 0x10CC9474b45625ADfd05C209f2518023484878D9
owner 0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001
pendingOwner 0x10CC9474b45625ADfd05C209f2518023484878D9
Do not write this address into deployments/base-sepolia.json.
Wiring is a separate PR after a human broadcast.
Agents must not --broadcast.
```

Forge also printed `Estimated total gas used for script: 2823486`, `Estimated amount required: 0.000031058346 ETH`, and `SIMULATION COMPLETE`. The dry-run artifact has two transactions: `CREATE` of `BotAttestationEscrow` at `0x4e3AC0f579eCA30B37C6F7C2ccD21bA69742A999`, then `transferOwnership(address)` (`0xf2fde38b`) to `0x10CC9474b45625ADfd05C209f2518023484878D9`. It does not call `acceptOwnership`.

Chain guard: chainid `1` reverts `DeployEscrow: mainnet forbidden`. Any chain other than `84532` reverts. There is no Ethereum Sepolia switch unless someone edits `ALLOWED_CHAIN_ID` on purpose. Do not.

## ESC-M-1 escrow-only redeploy (conditional GO)

Spencer gave a conditional GO for an **escrow-only** redeploy on Base Sepolia (chainid `84532`) once the Auditor re-audit PASSES and the Verifier APPROVES. This section is the historical runbook that produced the ESC-M-1 escrow, now retired. It does not broadcast. A human broadcasts. Do not replace the live escrow `0x3d660502D75f1e97b08c110255921b437A3C4C42` with a simulation address. The address `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` stays the recorded result of this historical broadcast.

The script deploys one `BotAttestationEscrow` and calls `transferOwnership(CORE_TIMELOCK)`. Constructor arguments are the live Denylist, Vault, DisputePanel, and `CORE_TIMELOCK`. It does not deploy a new Denylist, Vault, or panel. `acceptOwnership` is a second transaction from `CORE_TIMELOCK`, not from the deployer, and not inside the deploy script.

### Keystore (one time, on the human machine)

Spencer's signing uses a Foundry keystore. No key on the command line, and no signing key in the environment. `cast wallet import --interactive` prompts for the key and stores it in the local keystore.

```bash
cast wallet import agentbv-deployer --interactive
cast wallet address --account agentbv-deployer
```

Import the `CORE_TIMELOCK` account the same way when that key is available on this machine:

```bash
cast wallet import core-timelock --interactive
```

If that account lives in a browser wallet, skip the `core-timelock` import. After the source is verified, `acceptOwnership()` can be sent from Basescan's Write Contract tab instead.

`<DEPLOYER_ADDRESS>` below is the address printed by `cast wallet address --account agentbv-deployer`. It must not be `CORE_TIMELOCK`.

### Broadcast (human only, after Auditor PASS and Verifier APPROVE)

The broadcast that landed for `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` used main at the squash-merge commit of PR #30 (`444c427`). That commit is before PR #40 and PR #44. It is history for that address. The next escrow deploy does not check out `444c427`. It checks out `main` at `da47d9a12d64cd4bea4b6fce0b2166b4c55a0427` or later. The recommended checkout is `a66ef6439dec6fd2e5ad49d53fa4ce98d373d787` (`a66ef64`). Its escrow source matches `da47d9a`. See [New escrow deploy](#new-escrow-deploy).

The command that landed, from that historical commit, was:

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
export DENYLIST=0xeE76876bECcFc1B58fC06fF4E654a517d784B224
export VAULT=0x1463D664fA467FBCDA4B05443434494f05e565bc
export DISPUTE_PANEL=0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb
export CORE_TIMELOCK=0x10CC9474b45625ADfd05C209f2518023484878D9

forge script script/DeployBotAttestationEscrow.s.sol:DeployBotAttestationEscrow \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --account agentbv-deployer \
  --sender <DEPLOYER_ADDRESS> \
  --broadcast
```

Recorded `NEW_ESCROW` for this historical broadcast is `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d`, now retired (2026-10-06). Recorded `DEPLOY_TX` is `0x7ab17bac1f046ad50299e905f6f5fed47455fdebd3e3004094b899c7f801d8aa` (block 47345163). The previous book address `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` is retired (ESC-M-1 redeploy, retired 2026-09-26). Broadcast from Foundry's default sender `0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38` or from the simulate burn address reverts `DeployEscrow: pass --account and --sender`.

### acceptOwnership (CORE_TIMELOCK, not the deployer)

History: already done; do not re-run. This block is the landed `acceptOwnership` for `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` only.

`CORE_TIMELOCK` was the pending owner. On `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` this call has landed: tx `0xe4286328ff1d177c724888255d3607187e4b4ea68d0f1e66d697e6152367e0e9`, block 47345442, status 1, from `CORE_TIMELOCK`.

```bash
export NEW_ESCROW="<NEW_ESCROW_ADDRESS>"

cast send "$NEW_ESCROW" "acceptOwnership()" --rpc-url "$BASE_SEPOLIA_RPC_URL" --account core-timelock
```

Before this call, `owner()` is the deployer and `pendingOwner()` is `CORE_TIMELOCK`. After it, `owner()` is `0x10CC9474b45625ADfd05C209f2518023484878D9` and `pendingOwner()` is the zero address.

### Verify (Sourcify, then Basescan via Etherscan v2)

Compiler settings match `foundry.toml`: solc `0.8.20`, optimizer on, 200 runs, `shanghai`. Moving `foundry.toml` `evm_version` from `cancun` to `shanghai` is output-neutral for these contracts: solc 0.8.20 does not implement Cancun, so the compiler was already emitting Shanghai bytecode. Basescan verification reads `ETHERSCAN_API_KEY` from the environment. Never commit it. Set it in the shell without echoing it:

```bash
read -s ETHERSCAN_API_KEY && export ETHERSCAN_API_KEY
```

```bash
export NEW_ESCROW="<NEW_ESCROW_ADDRESS>"
export DEPLOY_TX="<DEPLOY_TX_HASH>"
CTOR_ARGS="$(cast abi-encode "constructor(address,address,address,address)" \
  0xeE76876bECcFc1B58fC06fF4E654a517d784B224 \
  0x1463D664fA467FBCDA4B05443434494f05e565bc \
  0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb \
  0x10CC9474b45625ADfd05C209f2518023484878D9)"

forge verify-contract \
  --chain 84532 \
  --verifier sourcify \
  --compiler-version 0.8.20 \
  --num-of-optimizations 200 \
  --evm-version shanghai \
  --creation-transaction-hash "$DEPLOY_TX" \
  "$NEW_ESCROW" \
  contracts/BotAttestationEscrow.sol:BotAttestationEscrow

forge verify-contract \
  --chain 84532 \
  --verifier etherscan \
  --verifier-url "https://api.etherscan.io/v2/api?chainid=84532" \
  --compiler-version 0.8.20 \
  --num-of-optimizations 200 \
  --evm-version shanghai \
  --constructor-args "$CTOR_ARGS" \
  "$NEW_ESCROW" \
  contracts/BotAttestationEscrow.sol:BotAttestationEscrow
```

The retired ESC-M-1 escrow `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` was recorded on Basescan (Pass - Verified) via Etherscan v2 as solc `v0.8.20+commit.a1b79de6`, standard JSON, evm version shanghai: `https://sepolia.basescan.org/address/0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d#code`. That shanghai label is Basescan metadata for `0x1069…` only. This repo compiles with `foundry.toml` `evm_version = "shanghai"` (solc `0.8.20`, optimizer 200 runs). The pull-payment deploy in [Deploy and retire](#deploy-and-retire) is verified with `--evm-version shanghai`, the same flag as the commands above.

### Read-only smoke checks

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
export NEW_ESCROW="<NEW_ESCROW_ADDRESS>"

cast call "$NEW_ESCROW" "owner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_ESCROW" "pendingOwner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_ESCROW" "vault()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_ESCROW" "disputePanel()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_ESCROW" "denylist()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_ESCROW" "lockedValue()(uint256)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast balance "$NEW_ESCROW" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Expected after `acceptOwnership`: `owner` is `0x10CC9474b45625ADfd05C209f2518023484878D9`, `pendingOwner` is `0x0000000000000000000000000000000000000000`, `vault` is `0x1463D664fA467FBCDA4B05443434494f05e565bc`, `disputePanel` is `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb`, `denylist` is `0xeE76876bECcFc1B58fC06fF4E654a517d784B224`, `lockedValue` is `0`, and the contract balance is `0`.

`dispute` on an escrow id that was never created reverts `not a party` on `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` and `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` when the caller is a nonzero address. The zero escrow has payer and payee `address(0)`, and the default state is `Open`, so the party check is the revert. `--from` keeps the caller off `address(0)`. That string is the behavior of those two contracts. It is not the check for a deploy from `da47d9a12d64cd4bea4b6fce0b2166b4c55a0427` or later. Use [New escrow deploy](#new-escrow-deploy) for that.

```bash
cast call "$NEW_ESCROW" \
  "dispute(bytes32,bytes32)" \
  0x0000000000000000000000000000000000000000000000000000000000000001 \
  0x0000000000000000000000000000000000000000000000000000000000000002 \
  --from 0x0000000000000000000000000000000000000001 \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Expected revert data on those two contracts is `Error(string)` with `"not a party"`.

Retiring does not stop Finding B on `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` and `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c`. A zero-value `refund` of a missing id still succeeds on both. No funds are at risk. Indexers should ignore retired addresses.

## Retired escrow broadcast (history)

The broadcast that created `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` already landed. That address is retired (ESC-M-1 redeploy, retired 2026-09-26). It is not the book address. Do not treat a simulation address as a replacement. The ESC-M-1 broadcast above is a later human broadcast, not a rerun of this historical deploy.

## Retired escrow ownership (history)

1. `CORE_TIMELOCK` called `acceptOwnership()` on the retired `BotAttestationEscrow` `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c`. On that contract, `owner` is `CORE_TIMELOCK` and `pendingOwner` is the zero address. The accept tx is `0xd2e982568811c3706eec074d296ef7fa4c54838de714e1a5bfc8afc9fbb73983` (block 47300275).
2. That retired address and its create-tx hash are under `retired.BotAttestationEscrow` in [`deployments/base-sepolia.json`](../deployments/base-sepolia.json). The live slot is `0x3d660502D75f1e97b08c110255921b437A3C4C42`. The ESC-M-1 escrow `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` is retired under `retired.BotAttestationEscrowEscM1`.
3. `setDenylist`, `setVault`, and `setDisputePanel` revert unless `owner() == governance`, and they revert while `lockedValue != 0`. On the live escrow, `acceptOwnership` is complete, so `owner()` is `governance`.

`acceptOwnership` on the retired escrow was an owner-to-be call from `CORE_TIMELOCK`, same as Gate A on Denylist and Vault. It is not part of the deploy script. Agents do not send it again. The same call on the retired ESC-M-1 escrow has landed (tx `0xe4286328ff1d177c724888255d3607187e4b4ea68d0f1e66d697e6152367e0e9`, block 47345442). The live escrow accept is `0xb7e819961fbe644eef1122c7da4554090a4412083a87366b21c7da09124dd769` (block 47760929).

## Gate B — seated

Gate B is seated. `arbitratorCount` is 3. The three arbitrators and seat txs are in the live-address section above. `openDispute` reverts `panel not seated` if `arbitratorCount` drops below 3. The escrow deploy script does not appoint arbitrators. The ops scripts below call the live panel only. They do not deploy a new panel. Agents do not `--broadcast` them.

Same broadcast rule as [`OpsDenylist`](OpsDenylist.s.sol) / [`OpsVault`](OpsVault.s.sol): dry-run `prank`s `CORE_TIMELOCK` and does not read a signing key. `--broadcast` and `--resume` revert unless the signer is `CORE_TIMELOCK`. Those ops scripts still use the older signing path. This escrow redeploy does not. The remaining runbook is [`OPS_LIVE_DENYLIST_VAULT.md`](OPS_LIVE_DENYLIST_VAULT.md).

The three live seats are already on the panel. The placeholders below are for a future add or remove. They are not the seated arbitrators. Replace them before any new panel op.

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
export DISPUTE_PANEL=0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb
export CORE_TIMELOCK=0x10CC9474b45625ADfd05C209f2518023484878D9

# Replace. These are documentation placeholders, not live arbitrators.
export ARBITRATOR_1=0x0000000000000000000000000000000000000A11
export ARBITRATOR_2=0x0000000000000000000000000000000000000A22
export ARBITRATOR_3=0x0000000000000000000000000000000000000A33
```

| Variable | Used by | Meaning |
| --- | --- | --- |
| `DISPUTE_PANEL` | every panel op | Must be the live panel above. Any other address reverts. |
| `CORE_TIMELOCK` | every panel op | Must be the live owner above, and must equal `owner()`. |
| `ARBITRATOR` | add and remove | One address. |
| `ARBITRATOR_1`, `ARBITRATOR_2`, `ARBITRATOR_3` | seat | Three distinct non-zero addresses. |

### Simulate (not live)

The log line `SIMULATE; no transaction will be sent` is the dry run.

```bash
# Preferred Gate B batch. Three setArbitrator(account, true) calls.
forge script script/OpsDisputePanel.s.sol:OpsDisputePanelSeat \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"

# One add, or one remove.
export ARBITRATOR="$ARBITRATOR_1"
forge script script/OpsDisputePanel.s.sol:OpsDisputePanelAdd \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
forge script script/OpsDisputePanel.s.sol:OpsDisputePanelRemove \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Accounts that already have the requested allowlist bit are skipped. No empty transaction is built for them.

### Broadcast (Spencer only)

Agents must not run this. The signer must be `CORE_TIMELOCK`. A deployer key reverts before `startBroadcast`.

```bash
forge script script/OpsDisputePanel.s.sol:OpsDisputePanelSeat \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --broadcast
```

One address at a time, still Spencer-only:

```bash
export ARBITRATOR="$ARBITRATOR_1"
forge script script/OpsDisputePanel.s.sol:OpsDisputePanelAdd \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --broadcast

forge script script/OpsDisputePanel.s.sol:OpsDisputePanelRemove \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --broadcast
```

### Reads and calldata

```bash
cast call "$DISPUTE_PANEL" "owner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$DISPUTE_PANEL" "arbitratorCount()(uint256)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$DISPUTE_PANEL" "isArbitrator(address)(bool)" "$ARBITRATOR_1" --rpc-url "$BASE_SEPOLIA_RPC_URL"

cast calldata "setArbitrator(address,bool)" "$ARBITRATOR_1" true
cast calldata "setArbitrator(address,bool)" "$ARBITRATOR_1" false
```

A direct `cast send` of `setArbitrator` is not part of this escrow redeploy. Agents must not run it. The command still lives in [`OPS_LIVE_DENYLIST_VAULT.md`](OPS_LIVE_DENYLIST_VAULT.md) and still uses the older signing path. Check `owner()` first: `cast send` does not enforce the script's address book. After three successful adds, `arbitratorCount` is at least 3 and `openDispute` can succeed. Dropping below 3 makes `openDispute` revert `panel not seated` again.

## Failure modes

| Revert | When |
| --- | --- |
| `OpsLive: mainnet forbidden` | Panel ops on chainid `1` |
| `OpsLive: Base Sepolia (84532) only` | Panel ops on any other chain, including Ethereum Sepolia and Anvil |
| `DeployEscrow: mainnet forbidden` | Escrow deploy on chainid `1` |
| `DeployEscrow: Base Sepolia (84532) only; ...` | Escrow deploy on any other chain |
| `DeployEscrow: CORE_TIMELOCK unset` / `must not be deployer` | Escrow env |
| `DeployEscrow: DENYLIST unset` / `VAULT unset` / `DISPUTE_PANEL unset` | Escrow env missing or zero |
| `DeployEscrow: DENYLIST is not the live Base Sepolia Denylist` | Env denylist is not `0xeE76876bECcFc1B58fC06fF4E654a517d784B224` |
| `DeployEscrow: VAULT is not the live Base Sepolia Vault` | Env vault is not `0x1463D664fA467FBCDA4B05443434494f05e565bc` |
| `DeployEscrow: DISPUTE_PANEL is not the live Base Sepolia DisputePanel` | Env panel is not `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb` |
| `DeployEscrow: CORE_TIMELOCK is not the live owner` | `CORE_TIMELOCK` env is not `0x10CC9474b45625ADfd05C209f2518023484878D9` |
| `DeployEscrow: pass --account and --sender` | Escrow `--broadcast` from Foundry's default sender or from `SIMULATE_SENDER` |
| `OpsPanel: DISPUTE_PANEL unset` / `ARBITRATOR unset` / `ARBITRATOR_1 unset` (and `_2`, `_3`) | Missing or zero panel-op env |
| `OpsLive: CORE_TIMELOCK unset` | Panel op missing the `CORE_TIMELOCK` env |
| `OpsPanel: DISPUTE_PANEL is not the live Base Sepolia DisputePanel` | Env panel is not the live address |
| `OpsLive: CORE_TIMELOCK is not the live owner` | `CORE_TIMELOCK` env is not the book address |
| `OpsPanel: DisputePanel.owner is not CORE_TIMELOCK` | On-chain owner moved |
| `OpsPanel: zero arbitrator` / `duplicate arbitrator` | Seat list |
| `OpsLive` signer is not the live owner | Panel `--broadcast` with any signer other than `CORE_TIMELOCK` |
| `OpsLive: owner unset` | Empty owner passed into the helper |
| `not owner` | `setArbitrator` from anyone except `owner()` |
| `zero arbitrator` | Panel rejects `address(0)` if a call reaches it |
| `panel not seated` | `openDispute` while `arbitratorCount < 3` |
| `FundingBeforeGovernance` | `createEscrow` before `acceptOwnership` |

## Deploy and retire

This pull-payment cutover ships as a **new** `BotAttestationEscrow` on Base Sepolia (chainid `84532`). It is not an upgrade of `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` or `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c`. Neither contract is upgradeable. Agents never broadcast. Spencer signs. Agents do not pass `--broadcast` or `--resume`, and they do not handle a signing key. No signing key goes in the repo, in this file, or in the PR.

Deploy stays on hold until Spencer broadcasts. Do not paste a simulation address into the book.

### New escrow deploy

The recommended checkout is `a66ef6439dec6fd2e5ad49d53fa4ce98d373d787` (`a66ef64`). Its `contracts/BotAttestationEscrow.sol` and `script/DeployBotAttestationEscrow.s.sol` match `da47d9a12d64cd4bea4b6fce0b2166b4c55a0427`. `da47d9a` is the squash-merge of PR #44. It includes PR #40 pull-payment (`function withdraw() external` and `withdrawTo(address)`) and PR #44 `error EscrowNotFound(bytes32 id)`. `444c427` is before both. Do not deploy from `444c427`. A later `main` commit is fine only when those two files are still the same.

```bash
git fetch origin main
git checkout a66ef6439dec6fd2e5ad49d53fa4ce98d373d787
forge build
```

#### Pre-broadcast check

Run this on that checkout, after `forge build`, before any broadcast. Take the signatures from `contracts/BotAttestationEscrow.sol`: `function withdraw() external` and `error EscrowNotFound(bytes32 id)`. `cast sig` prints a `0x` selector. `forge inspect … --json` prints the same selector without `0x`. Stop if either comparison fails. Do not broadcast an artifact that lacks `withdraw` or `EscrowNotFound`.

```bash
WITHDRAW_SIG="$(cast sig "withdraw()" | sed 's/^0x//')"
NOT_FOUND_SIG="$(cast sig "EscrowNotFound(bytes32)" | sed 's/^0x//')"

test "$(forge inspect BotAttestationEscrow methodIdentifiers --json | jq -er '.["withdraw()"]')" = "$WITHDRAW_SIG"
test "$(forge inspect BotAttestationEscrow errors --json | jq -er '.["EscrowNotFound(bytes32)"]')" = "$NOT_FOUND_SIG"
```

The same entries, without selectors, from the built ABI:

```bash
jq -e '.abi[] | select(.type=="function" and .name=="withdraw" and (.inputs|length)==0)' \
  out/BotAttestationEscrow.sol/BotAttestationEscrow.json
jq -e '.abi[] | select(.type=="error" and .name=="EscrowNotFound" and ((.inputs|map(.type)|join(","))=="bytes32"))' \
  out/BotAttestationEscrow.sol/BotAttestationEscrow.json
```

`forge inspect BotAttestationEscrow methodIdentifiers` and `forge inspect BotAttestationEscrow errors` print those pairs in a table. The `--json` form above is the comparison against `cast sig`.

On this exact checkout, re-run the Escrow SIMULATE block (no `--broadcast`) and confirm `SIMULATE; no transaction will be sent`, chainid `84532`, the constructor args, and `pendingOwner` = `CORE_TIMELOCK` `0x10CC9474b45625ADfd05C209f2518023484878D9` before broadcasting. The recommended checkout is `a66ef64`. Its escrow source matches `da47d9a`.

That block is the `forge script` under [Escrow simulate (not live)](#escrow-simulate-not-live) with `--sender 0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001` and no `--broadcast`. Confirm these lines in the log:

```text
SIMULATE; no transaction will be sent
chainid 84532
constructor Denylist 0xeE76876bECcFc1B58fC06fF4E654a517d784B224
constructor Vault 0x1463D664fA467FBCDA4B05443434494f05e565bc
constructor DisputePanel 0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb
constructor governance 0x10CC9474b45625ADfd05C209f2518023484878D9
pendingOwner 0x10CC9474b45625ADfd05C209f2518023484878D9
```

Stop if any line is missing or different. Nothing is sent. Do not add `--broadcast` to this re-run.

Spencer signs the broadcast. Agents never broadcast. Same script and constructor args as the historical broadcast above (live Denylist, Vault, DisputePanel, and `CORE_TIMELOCK`). `<DEPLOYER_ADDRESS>` is the address printed by `cast wallet address --account agentbv-deployer`. It must not be `CORE_TIMELOCK`.

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
export DENYLIST=0xeE76876bECcFc1B58fC06fF4E654a517d784B224
export VAULT=0x1463D664fA467FBCDA4B05443434494f05e565bc
export DISPUTE_PANEL=0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb
export CORE_TIMELOCK=0x10CC9474b45625ADfd05C209f2518023484878D9

forge script script/DeployBotAttestationEscrow.s.sol:DeployBotAttestationEscrow \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --account agentbv-deployer \
  --sender <DEPLOYER_ADDRESS> \
  --broadcast
```

Record `<NEW_ESCROW_ADDRESS>` and `<DEPLOY_BLOCK>` (the block of the deploy transaction).

#### acceptOwnership (CORE_TIMELOCK, not the deployer)

The deploy script does not call `acceptOwnership`. `deploy` in `script/DeployBotAttestationEscrow.s.sol` (lines 117–126) deploys `BotAttestationEscrow` and then calls `transferOwnership(timelock)` at line 125 only. The header comment at lines 10–12 says `CORE_TIMELOCK` is an EOA with EIP-7702 delegation, not a timelock contract, and that account must call `acceptOwnership`. OpenZeppelin `Ownable2Step.acceptOwnership` (`lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol`, lines 60–66) succeeds only when `pendingOwner() == msg.sender`. There is no `schedule` or `execute` on `0x10CC9474b45625ADfd05C209f2518023484878D9`. Do not send this call through the appendix `TimelockController` blobs.

Spencer sends one plain transaction from `CORE_TIMELOCK`. Agents do not send it. No `--broadcast` from an agent session.

Spencer only:

```bash
export NEW_ESCROW="<NEW_ESCROW_ADDRESS>"

cast send "$NEW_ESCROW" "acceptOwnership()" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --account core-timelock
```

Read-only check. No key. No `cast send`.

```bash
export NEW_ESCROW="<NEW_ESCROW_ADDRESS>"

cast call "$NEW_ESCROW" "owner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Expected `owner()` is `0x10CC9474b45625ADfd05C209f2518023484878D9`.

#### Post-deploy checks

Read-only. No key. No `--broadcast`.

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
export NEW_ESCROW="<NEW_ESCROW_ADDRESS>"

cast call "$NEW_ESCROW" "owner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_ESCROW" "pendingOwner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_ESCROW" "governance()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

`governance()` is `0x10CC9474b45625ADfd05C209f2518023484878D9` from the constructor. Before `acceptOwnership`, `owner()` is the deployer and `pendingOwner()` is `CORE_TIMELOCK`. After `acceptOwnership`, `owner()` is `0x10CC…` and `pendingOwner()` is the zero address.

`refund(bytes32)` and `release(bytes32)` of a missing id must revert `EscrowNotFound`. `cast sig "EscrowNotFound(bytes32)"` is `0x338d8d16`. Do not run this pass-check against `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` or `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c`. On those contracts a zero-value `refund` of a missing id succeeds.

```bash
cast call "$NEW_ESCROW" "refund(bytes32)" \
  0x0000000000000000000000000000000000000000000000000000000000000001 \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_ESCROW" "release(bytes32)" \
  0x0000000000000000000000000000000000000000000000000000000000000001 \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

`renounceOwnership()` does not read `lockedValue`. The `lockedValue == 0` read below is the recommended check. If the returned `uint256` is not 0, stop. Do not send `renounceOwnership`. There is a small window between reading `lockedValue` and renouncing, during which someone can still `createEscrow`. Funds are not stranded if that happens.

After the renounce, `release`, `refund`, and `dispute` keep working. Setters (`setDenylist`, `setVault`, and `setDisputePanel`) and ownership are lost. `createEscrow` reverts `FundingBeforeGovernance`. `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` and `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` have no `withdraw`. On the new pull-payment escrow, `totalOwed` may be nonzero when `lockedValue` is 0: credited accounts still call `withdraw` / `withdrawTo` after the owner is gone.

Retiring does not stop Finding B on `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` and `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c`. A zero-value `refund` of a missing id still succeeds on both: unset storage reads as `Open` with expiry 0, so the call credits 0 to `address(0)`. `renounceOwnership` does not change that bytecode. No funds are at risk. Indexers should ignore retired addresses.

`CORE_TIMELOCK` (`0x10CC9474b45625ADfd05C209f2518023484878D9`) is an EOA (with EIP-7702 delegation), not a timelock; to be replaced by TimelockController ([runbook](../docs/runbooks/CORE_TIMELOCK_MIGRATION.md)). Delegation target `0x63c0c19a282a1b52b07dd5a65b58948a07dae32b` (`EIP7702StatelessDeleGator` 1.3.0). It is not an OpenZeppelin `TimelockController`. `getMinDelay()` reverts. There is no `schedule` or `execute` on that account. `onlyOwner` is `msg.sender == owner()`. The retirement transaction is a transaction whose sender is `CORE_TIMELOCK`, whose `to` is the escrow, and whose `data` is `renounceOwnership()` (`0x715018a6`). Spencer signs it. The OpenZeppelin `TimelockController` `schedule` and `execute` blobs for that same inner call, with placeholder predecessor, salt, and delay, are in the [appendix](#appendix-openzeppelin-timelockcontroller-schedule-and-execute-calldata) at the end of this file. Do not submit them to `0x10CC…`.

### Check `lockedValue` first

Read-only. No key. No `--broadcast`.

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"

# Retired ESC-M-1 escrow (retired 2026-10-06). Retire only when this prints 0.
cast call 0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d \
  "lockedValue()(uint256)" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"

# ESC-M-1-pre escrow (pre-pull-payment, still live-callable). Still owned by CORE_TIMELOCK. Same gate.
cast call 0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c \
  "lockedValue()(uint256)" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Selector `lockedValue()` is `0xd2c46932`.

### `renounceOwnership` calldata

```bash
cast sig "renounceOwnership()"
cast calldata "renounceOwnership()"
```

Both print `0x715018a6`. After cutover, and only while that contract's `lockedValue()` is 0, Spencer sends one transaction per escrow:

| Field | Retired ESC-M-1 escrow (retired 2026-10-06) | ESC-M-1-pre escrow (pre-pull-payment, still live-callable) |
| --- | --- | --- |
| from | `CORE_TIMELOCK` `0x10CC9474b45625ADfd05C209f2518023484878D9` | same |
| to | `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` | `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` |
| value | `0` | `0` |
| data | `0x715018a6` | `0x715018a6` |
| chainid | `84532` | `84532` |

After each call, `owner()` is the zero address. After the renounce, `release`, `refund`, and `dispute` keep working. Setters (`setDenylist`, `setVault`, and `setDisputePanel`) and ownership are lost. `createEscrow` reverts `FundingBeforeGovernance`, so the escrow takes no new deposits. That is the point of retiring it. These contracts have no `withdraw`. Retiring does not stop Finding B on either address: a zero-value `refund` of a missing id still succeeds. No funds are at risk. Indexers should ignore retired addresses.

### After the new escrow is live

Update the address book and the consumers that pin it. Do that in a follow-up commit after the deploy transaction exists. This section does not change those files. Agents never broadcast.

1. Record `<NEW_ESCROW_ADDRESS>` in the address book (`deployments/base-sepolia.json`), including `deployBlock` and `startBlock` set to `<DEPLOY_BLOCK>`. Then copy the book into wallet-ux: from `apps/wallet-ux`, `npm run sync-book` (`scripts/sync-book.mjs`) writes `apps/wallet-ux/src/base-sepolia.json`. `addresses.ts` reads `ADDRESSES.botAttestationEscrow` from that file. Wallet-ux has no escrow-address env. On main `a66ef6439dec6fd2e5ad49d53fa4ce98d373d787`, `apps/wallet-ux/.env.example` lists `VITE_BASE_SEPOLIA_RPC_URL` (line 7) and `VITE_CLAIM_RELAYER_URL` (line 14). Line 12 says this app does not send a shared secret. `VITE_CLAIM_API_SECRET` is not in that file. #46 removed it. `FALLBACK_PIN.botAttestationEscrow` in `apps/wallet-ux/src/book.ts` is a code pin; updating it is a follow-up code change.
2. Set relayer config on the Render service `bot-verifier-claim-relayer`. Set `ESCROW_ADDRESS` to `<NEW_ESCROW_ADDRESS>`. That key is in `claim-relayer/render.yaml` with `sync: false` (dashboard value; do not commit it). Set the start block to `<DEPLOY_BLOCK>`, the deploy block, as `ESCROW_START_BLOCK`. `claim-relayer/config.mjs` reads `ESCROW_START_BLOCK` when the address is not the hardcoded `BOOKED_SEPOLIA_ESCROW`. `ESCROW_START_BLOCK` is not a key in `render.yaml`. A non-integer or negative value refuses boot (`invalid_escrow_start_block`). `RELAYER_PRIVATE_KEY` stays dashboard-only. Setting `ESCROW_ADDRESS` does not retarget a broadcast: `claim-relayer/broadcast.mjs` uses `BOOKED_SEPOLIA_ESCROW` as `to` and refuses any other address (`escrow_not_booked_sepolia`). A follow-up code change has to set `BOOKED_SEPOLIA_ESCROW` and `BOOKED_SEPOLIA_ESCROW_START_BLOCK` to `<NEW_ESCROW_ADDRESS>` and `<DEPLOY_BLOCK>`. This document does not change that code.
3. ABI sync is the procedure from PR #48. On a tree that contains `scripts/gen-escrow-abi.sh` (that PR's branch `cursor/escrow-abi-from-forge-94de`, or `main` after #48 merges), after `forge build` on `da47d9a12d64cd4bea4b6fce0b2166b4c55a0427` or later: `forge build && ./scripts/gen-escrow-abi.sh`. From `apps/wallet-ux`, the same script is `npm run gen-escrow-abi`. It reads `out/BotAttestationEscrow.sol/BotAttestationEscrow.json` (the `.abi` array) and writes `apps/wallet-ux/src/abi/BotAttestationEscrow.json`. The generated file includes `withdraw`, `withdrawTo`, and `EscrowNotFound(bytes32)`. `npm run sync-abis` still refreshes the other ABIs; on PR #48 it regenerates the escrow ABI through this script. This document does not add the script.

4. Redeploy the relayer after the env change, and publish wallet-ux from the book and ABI update (Pages project `agent-a-wallet-ux`, root `apps/wallet-ux`). Do not run `wrangler pages deploy`.

Address book:

- `deployments/base-sepolia.json`
  - `BotAttestationEscrow.address` is `0x3d660502D75f1e97b08c110255921b437A3C4C42` (deploy tx `0x0d39f2502956d1199bb9d264704aacab85ca7a5d54de3e1634b201c730b62b6c`, block 47715415, commit `7fe4a863e9bce0b70b629dab76ddd2728c97b536`). `acceptOwnership` is complete (`0xb7e819961fbe644eef1122c7da4554090a4412083a87366b21c7da09124dd769`, block 47760929). `basescan` is `unconfirmed`.
  - The retired ESC-M-1 escrow `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` is `retired.BotAttestationEscrowEscM1` (retired 2026-10-06, `supersededBy` the live address). `retired.BotAttestationEscrow` stays the pre-ESC-M-1 escrow `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c`, and its `supersededBy` stays `0x1069…`. wallet-ux and the claim-relayer block both retired keys. The relayer refuse list contains both, and a retired `ESCROW_ADDRESS` boots with submits disabled instead of exiting.
  - Top-level `notes` names the live escrow. `coreTimelock` stays `0x10CC9474b45625ADfd05C209f2518023484878D9`.
- Wallet copy of the same JSON: `apps/wallet-ux/src/base-sepolia.json` (same `BotAttestationEscrow` keys).
- README tables and prose that repeat the live address: `contracts/README.md` (BotAttestationEscrow row), `deployments/README.md`, `apps/wallet-ux/README.md`, `apps/wallet-ux/CLOUDFLARE_PAGES.md`, `claim-relayer/README.md`, `GO_LIVE.md`.

Wallet-ux escrow address config:

- `apps/wallet-ux/src/book.ts`: `FALLBACK_PIN.botAttestationEscrow` is `0x3d66…`. `SUPERSEDED.botAttestationEscrow` stays `0x141214…`. `SUPERSEDED.botAttestationEscrowEscM1` is `0x1069…`.
- `apps/wallet-ux/src/addresses.ts` reads `ADDRESSES.botAttestationEscrow` from that book. It has no separate address literal.
- Tests that pin `0x1069…`: `apps/wallet-ux/src/book.test.ts`, `addresses.test.ts`, `submit.test.ts`, `relayer.test.ts`, `preview.test.ts`.

Claim-relayer escrow address config:

- `claim-relayer/config.mjs`: `BOOKED_SEPOLIA_ESCROW` is `0x3d66…` and `BOOKED_SEPOLIA_ESCROW_START_BLOCK` is `47715415`. Env overrides are `ESCROW_ADDRESS` and `ESCROW_START_BLOCK`. `RETIRED_SEPOLIA_ESCROWS` contains both retired escrows. A retired configured escrow does not exit the process.
- `claim-relayer/addressBook.mjs`: reads `BotAttestationEscrow.address`, then `deployBlock` or `startBlock`. `SUPERSEDED` pins both retired escrows.
- `claim-relayer/broadcast.mjs` refuses any `to` that is not `BOOKED_SEPOLIA_ESCROW`.

## Checklist

- [x] Gate B seated (`arbitratorCount` is 3; seat txs in block 47299643)
- [x] Retired escrow deployed (`0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c`, block 47299930). ESC-M-1 redeploy, retired 2026-09-26.
- [x] `CORE_TIMELOCK` `acceptOwnership` on that retired escrow (block 47300275; `pendingOwner` is zero).
- [x] Live escrow address and txs are in `deployments/base-sepolia.json` and `contracts/README.md` (`0x3d660502D75f1e97b08c110255921b437A3C4C42`, block 47715415, commit `7fe4a863e9bce0b70b629dab76ddd2728c97b536`). The ESC-M-1 escrow `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` (block 47345163, commit `444c427`) is retired.
- [x] Agents do not `--broadcast` and do not touch mainnet
- [x] ESC-M-1 escrow-only redeploy landed (deploy tx `0x7ab17bac1f046ad50299e905f6f5fed47455fdebd3e3004094b899c7f801d8aa`)
- [x] Wiring records the live escrow `0x3d660502D75f1e97b08c110255921b437A3C4C42` and retires `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d`. `acceptOwnership` on the live escrow is complete (`0xb7e819961fbe644eef1122c7da4554090a4412083a87366b21c7da09124dd769`, block 47760929, 2026-10-06 12:35:46 UTC). Basescan for the live address is unconfirmed. The retired ESC-M-1 address stays Basescan-verified.

## Appendix: OpenZeppelin TimelockController schedule and execute calldata

**Do not submit these to CORE_TIMELOCK `0x10CC…`; it is an EIP-7702 EOA, not a TimelockController. The real retire tx is a plain call from CORE_TIMELOCK with data `0x715018a6`.**

Placeholders only: `value` `0`, `predecessor` `bytes32(0)`, `salt` `bytes32(0)`, `delay` `0`. Inner `data` is `renounceOwnership()` (`0x715018a6`). No key. These `cast calldata` commands do not reach a node. Both targets predate the pull-payment fix. After the renounce, `release`, `refund`, and `dispute` keep working. Setters and ownership are lost. `createEscrow` reverts. These contracts have no `withdraw`. Retiring does not stop Finding B on either address: a zero-value `refund` of a missing id still succeeds. No funds are at risk. Indexers should ignore retired addresses.

```bash
INNER=0x715018a6
PREDECESSOR=0x0000000000000000000000000000000000000000000000000000000000000000
SALT=0x0000000000000000000000000000000000000000000000000000000000000000
DELAY=0

# Retired ESC-M-1 escrow (retired 2026-10-06) 0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d
cast calldata "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" \
  0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d 0 "$INNER" "$PREDECESSOR" "$SALT" "$DELAY"
cast calldata "execute(address,uint256,bytes,bytes32,bytes32)" \
  0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d 0 "$INNER" "$PREDECESSOR" "$SALT"

# ESC-M-1-pre escrow (pre-pull-payment, still live-callable) 0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c
cast calldata "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" \
  0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c 0 "$INNER" "$PREDECESSOR" "$SALT" "$DELAY"
cast calldata "execute(address,uint256,bytes,bytes32,bytes32)" \
  0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c 0 "$INNER" "$PREDECESSOR" "$SALT"
```

`schedule(address,uint256,bytes,bytes32,bytes32,uint256)` selector `0x01d5062a`. `execute(address,uint256,bytes,bytes32,bytes32)` selector `0x134008d3`.

Encoded with those placeholders (delay word is zero):

Retired ESC-M-1 escrow (retired 2026-10-06) `schedule`:

```
0x01d5062a0000000000000000000000001069aa6597f08f1e8b8ad39aa40ede1d0c77298d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004715018a600000000000000000000000000000000000000000000000000000000
```

Retired ESC-M-1 escrow (retired 2026-10-06) `execute`:

```
0x134008d30000000000000000000000001069aa6597f08f1e8b8ad39aa40ede1d0c77298d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004715018a600000000000000000000000000000000000000000000000000000000
```

ESC-M-1-pre escrow (pre-pull-payment, still live-callable) `schedule`:

```
0x01d5062a000000000000000000000000141214f04b0e1d949b6e6bf32d019ad7ab5b284c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004715018a600000000000000000000000000000000000000000000000000000000
```

ESC-M-1-pre escrow (pre-pull-payment, still live-callable) `execute`:

```
0x134008d3000000000000000000000000141214f04b0e1d949b6e6bf32d019ad7ab5b284c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004715018a600000000000000000000000000000000000000000000000000000000
```
