# CORE_TIMELOCK migration

`CORE_TIMELOCK` `0x10CC9474b45625ADfd05C209f2518023484878D9` is an EOA (with EIP-7702 delegation), not a timelock; to be replaced by `TimelockController` (this runbook).

Chain ids `84532` (Base Sepolia) and `31337` (Anvil) are allowed. Every other chain reverts. `TIMELOCK_MIN_DELAY` must be at least 300 seconds. A shorter delay reverts.

This runbook does not create a Safe. `SAFE_ADDRESS` is an existing Safe. The scripts never read `PRIVATE_KEY`. Broadcast uses a Foundry keystore (`--account` and `--sender`) and `vm.startBroadcast()` with no key. Agents do not pass `--broadcast`. The only broadcasts in this runbook are the three Spencer runs below: deploy, Ownable2Step `transfer`, and the later immediate `setOwner`.

## What the book owns today

`script/MigrateOwnershipToTimelock.s.sol` reads `deployments/base-sepolia.json`, then `owner()` and `pendingOwner()` on chain. The handoff is the eight contracts whose live owner is `CORE_TIMELOCK`, plus superseded Vault `0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7` (owner is the deployer, `pendingOwner` is `CORE_TIMELOCK`). A row whose `governance()` is `CORE_TIMELOCK` is skipped unless `MIGRATE_ESCROWS=1`. Null BVT slots are not in the nine-row set. This table is a Base Sepolia reading taken while writing the script. The script re-reads at run time.

| Contract | Address | Ownership | In the handoff |
| --- | --- | --- | --- |
| Denylist | `0xeE76876bECcFc1B58fC06fF4E654a517d784B224` | Ownable2Step, owner `CORE_TIMELOCK`, pending `0` | step `transfer`, then timelock `acceptOwnership` |
| Vault | `0x1463D664fA467FBCDA4B05443434494f05e565bc` | Ownable2Step, owner `CORE_TIMELOCK`, pending `0` | step `transfer`, then timelock `acceptOwnership` |
| Liability | `0x554Caf5a214B8d70D675C09186C5EAE24FEB7307` | immediate `setOwner`, owner `CORE_TIMELOCK` | later step `immediate`, only after the two-step accepts have executed |
| InsuranceFund | `0x19fc26B36Cb2031062eD90C19db64b3b09753ab8` | immediate `setOwner`, owner `CORE_TIMELOCK` | later step `immediate`, only after the two-step accepts have executed |
| DisputePanel | `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb` | immediate `setOwner`, owner `CORE_TIMELOCK` | later step `immediate`, only after the two-step accepts have executed |
| BotAttestationEscrow | `0x3d660502D75f1e97b08c110255921b437A3C4C42` | Ownable2Step, owner governanceTimelock, pending `0`. The ESC-M-1 address `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` was this row when the migration was written and is now retired under `retired.BotAttestationEscrowEscM1`. It is not in the nine-row pin. | live book slot. `governance()` is governanceTimelock, so this row is not the CORE-governance skip |
| superseded Denylist | `0xF0f260967D377E07Bdd7840862508ddB23C012b8` | Ownable2Step, owner `CORE_TIMELOCK`, pending `0` | step `transfer`, then timelock `acceptOwnership` |
| superseded Vault | `0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7` | Ownable2Step, owner `0x5D467FA00eC0E92044f779e495a17db66c5964aa`, pending `CORE_TIMELOCK` | step `transfer`: the EOA accepts, then queues the timelock |
| retired BotAttestationEscrow | `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` | Ownable2Step, owner `CORE_TIMELOCK`, pending `0` | skipped unless `MIGRATE_ESCROWS=1`; if set, step `transfer` then timelock `acceptOwnership` |
| BVT, BVTStaking, BVTFeeRouter, BVTTimelock, BVTGovernor | null | not deployed | not in the nine-row set |

`DisputePanel.isArbitrator(CORE_TIMELOCK)` is false. No enumerated contract grants `CORE_TIMELOCK` an AccessControl role.

### Escrows are opt-in, and turning the flag on is the recommendation

The live escrow `0x3d66…4C42` stores `governance() ==` governanceTimelock `0xa1ab…ca33`. The retired escrows `0x1069…298d` and `0x1412…284c` store `governance() == CORE_TIMELOCK`. That address is immutable. `createEscrow` reverts `FundingBeforeGovernance` unless `owner() == governance`. `setDenylist`, `setVault`, and `setDisputePanel` revert `NotGovernance` unless the caller is `governance` and `owner()` is `governance`.

`MIGRATE_ESCROWS` must be exactly `0` or `1`. The script reverts if it is unset or any other value. `1` is recommended. The log says why a row was skipped when the value is `0`: immutable governance; migrating bricks `createEscrow` and the setters.

Spencer chooses `0` or `1` at broadcast. `1` freezes the old escrows: once `owner` is the timelock, `createEscrow` and the setters are dead, so no new funds can enter. `0` leaves both escrows under single-key control by the CORE EOA until each one is retired or replaced by an escrow whose `governance` is the `TimelockController`. This script does not deploy a replacement escrow.

`release` and `refund` are not owner-gated and keep working either way. The deployed bytecode has no `withdraw` or `withdrawTo`. With `MIGRATE_ESCROWS=1`, `postCheck` requires both escrows on the timelock with `pendingOwner == 0`. With `MIGRATE_ESCROWS=0`, `postCheck` requires both still owned by `CORE_TIMELOCK` with `pendingOwner == 0`.

### Immediate `setOwner` is a later transaction

Liability, InsuranceFund, and DisputePanel have no `pendingOwner`. Step `transfer` does not call `setOwner`. It only queues Ownable2Step rows.

After the timelock's `acceptOwnership` batch has executed, every in-scope Ownable2Step row shows `owner() == NEW_TIMELOCK`. A later step, `MIGRATION_STEP=immediate`, then calls `setOwner(NEW_TIMELOCK)` on Liability, InsuranceFund, and DisputePanel. That step reverts if any in-scope two-step row is not already there. `setOwner` has no second accept, and each handoff has no timelock delay. The step is three `setOwner` transactions, one for each of those contracts. They are not bundled with `transferOwnership`.

The risk is that later handoff: once it runs, the EOA names the timelock in three `setOwner` transactions (Liability, InsuranceFund, DisputePanel). Until it runs, those three stay with `CORE_TIMELOCK`. After it runs, later owner calls wait for `TIMELOCK_MIN_DELAY`.

Ownable2Step rows stay owned by the current owner until the timelock's `acceptOwnership` executes. Until that accept, `CORE_TIMELOCK` can still replace `pendingOwner`.

## 0. Deploy the controller

Import the deployer keystore out of band. Do not put the key in the environment.

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
export SAFE_ADDRESS=<existing-safe>
export TIMELOCK_MIN_DELAY=300
# Leave TIMELOCK_EXECUTOR unset for an open executor (address(0)).
# Anyone, CORE included, can then execute an op that is already scheduled and past its delay.
# They still cannot schedule one. Set TIMELOCK_EXECUTOR to the Safe when only the Safe should execute.
# export TIMELOCK_EXECUTOR=$SAFE_ADDRESS
```

`SAFE_ADDRESS` must already have code, and that code must not start with `0xef0100` (an EIP-7702 delegation designator; code length alone is not enough, because `CORE_TIMELOCK` itself passes a length check). `ISafe(SAFE_ADDRESS).getThreshold()` must be at least 2, and `getOwners().length` must be at least that threshold. No owner may be the zero address, a duplicate, `CORE_TIMELOCK`, or the deployer (`msg.sender`). The Safe itself must not be `CORE_TIMELOCK` and must not be the deployer. `TIMELOCK_MIN_DELAY` must be at least 300 seconds. Leaving `TIMELOCK_EXECUTOR` unset means `address(0)` holds `EXECUTOR_ROLE`: anyone, including `CORE_TIMELOCK`, can call `execute` / `executeBatch` once an operation is scheduled and the delay has passed. That account still cannot `schedule`. Set `TIMELOCK_EXECUTOR` to `SAFE_ADDRESS` when only the Safe should execute.

Simulate. This command does not broadcast.

```bash
forge script script/DeployTimelock.s.sol:DeployTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --sender 0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001
```

Spencer deploys. This is the deploy broadcast.

```bash
forge script script/DeployTimelock.s.sol:DeployTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --account <deployer-account> \
  --sender <deployer-address> \
  --broadcast
```

Proposers are `[SAFE_ADDRESS]`. OpenZeppelin v5.7.0 also grants that Safe `CANCELLER_ROLE`. `admin` is `address(0)`. `DEFAULT_ADMIN_ROLE` is held by the timelock contract, not by an EOA. Record the logged address as both `NEW_TIMELOCK` and `EXPECTED_TIMELOCK`. Do not write it into `deployments/base-sepolia.json` in this change. After Spencer's DeployTimelock broadcast, set `governanceTimelock` in `deployments/base-sepolia.json` to the TimelockController CREATE `contractAddress` in `broadcast/DeployTimelock.s.sol/84532/run-latest.json` (leave it null until that run) and export that same address as `NEW_TIMELOCK`. Ops calldata mode derives its default salt from the target and the inner calldata, so repeating an identical owner call after it has executed collides on the same operation id: set `TIMELOCK_SALT` to a fresh value to repeat an identical call. If that operation id is already pending or done, calldata mode reverts with that hint.

The constructor arguments are known, and the timelock self-administers, so that provenance is exactly the role grants below. Optional. This command does not broadcast. It lists `RoleGranted` on `NEW_TIMELOCK` in its deploy block. Expect exactly four grants: admin to the timelock itself, `PROPOSER_ROLE` to the Safe, `CANCELLER_ROLE` to the Safe, and `EXECUTOR_ROLE` to the Safe or to `address(0)` when `TIMELOCK_EXECUTOR` is unset (what `DeployTimelock` does).

```bash
cast logs --from-block <DEPLOY_BLOCK> --to-block <DEPLOY_BLOCK> \
  --address "$NEW_TIMELOCK" \
  "RoleGranted(bytes32,address,address)" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

## 1. Transfer Ownable2Step rows, signed by the EOA

`MIGRATION_STEP=transfer` (the default). Before this step, and before every other step, the script reverts unless all of the following hold:

- `NEW_TIMELOCK` has code. The `TimelockController` CREATE in `TIMELOCK_DEPLOY_JSON` (default `broadcast/DeployTimelock.s.sol/<chainid>/run-latest.json`) equals `NEW_TIMELOCK` and `EXPECTED_TIMELOCK`. A missing file, or no matching CREATE, reverts.
- `TIMELOCK_DEPLOY_JSON` must be inside a path `fs_permissions` in `foundry.toml` lets forge read (`./broadcast` by default).
- `SAFE_ADDRESS` is not `CORE_TIMELOCK` and not the deployer, has code, and that code does not start with `0xef0100`.
- `getThreshold()` is at least 2 and `getOwners().length` is at least the threshold. No owner is the zero address, a duplicate, `CORE_TIMELOCK`, or the deployer.
- The Safe holds `PROPOSER_ROLE` and `CANCELLER_ROLE`.
- `DEFAULT_ADMIN_ROLE` is held by the timelock itself, and not by `CORE_TIMELOCK`, the sender, or the Safe.
- `CORE_TIMELOCK` holds none of `PROPOSER_ROLE`, `EXECUTOR_ROLE`, `CANCELLER_ROLE`, or `DEFAULT_ADMIN_ROLE`.
- `getMinDelay()` is at least 300 seconds.

The script skips a two-step row whose `owner` is already `NEW_TIMELOCK` and whose `pendingOwner` is zero, and it skips a two-step row already pending `NEW_TIMELOCK`. It defers Liability, InsuranceFund, and DisputePanel. It also skips both escrows unless `MIGRATE_ESCROWS=1`. Re-running it is safe.

Simulate. This command does not broadcast. On a fork it pranks `CORE_TIMELOCK` and prints the accept batch from the simulated state.

```bash
export NEW_TIMELOCK=<timelock-from-step-0>
export EXPECTED_TIMELOCK=$NEW_TIMELOCK
export SAFE_ADDRESS=<existing-safe>
export MIGRATION_STEP=transfer
# Required: exactly 0 or 1. 1 is recommended (freezes the old escrows). Spencer chooses at broadcast.
export MIGRATE_ESCROWS=1
forge script script/MigrateOwnershipToTimelock.s.sol:MigrateOwnershipToTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Spencer sends step `transfer` from the `CORE_TIMELOCK` keystore. `--sender` is `0x10CC9474b45625ADfd05C209f2518023484878D9`.

```bash
export NEW_TIMELOCK=<timelock-from-step-0>
export EXPECTED_TIMELOCK=$NEW_TIMELOCK
export SAFE_ADDRESS=<existing-safe>
export MIGRATION_STEP=transfer
# Required: exactly 0 or 1. 1 is recommended (freezes the old escrows). Spencer chooses at broadcast.
export MIGRATE_ESCROWS=1
forge script script/MigrateOwnershipToTimelock.s.sol:MigrateOwnershipToTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --account <core-timelock-account> \
  --sender 0x10CC9474b45625ADfd05C209f2518023484878D9 \
  --broadcast
```

For the superseded Vault, this transaction calls `acceptOwnership` (the EOA is `pendingOwner`) and then `transferOwnership(NEW_TIMELOCK)`.

## 2. Timelock accepts Ownable2Step ownership

Do not broadcast this step. The same `NEW_TIMELOCK` checks run before any calldata is printed. After step `transfer`, print the batch. The targets are only rows whose `pendingOwner` is already `NEW_TIMELOCK`. Escrow rows are omitted unless `MIGRATE_ESCROWS=1`.

```bash
export NEW_TIMELOCK=<timelock-from-step-0>
export EXPECTED_TIMELOCK=$NEW_TIMELOCK
export SAFE_ADDRESS=<existing-safe>
export MIGRATION_STEP=accept
# Required: exactly 0 or 1. 1 is recommended (freezes the old escrows). Spencer chooses at broadcast.
export MIGRATE_ESCROWS=1
forge script script/MigrateOwnershipToTimelock.s.sol:MigrateOwnershipToTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

The log is the Safe proposal. Predecessor is `bytes32(0)`. Salt is `keccak256("CORE_TIMELOCK_MIGRATION_ACCEPT_V1")`. Delay is `getMinDelay()`. Each payload is `acceptOwnership()` (`0x79ba5097`). Values are `0`.

The Safe calls `scheduleBatch(targets, values, payloads, predecessor, salt, delay)` on `NEW_TIMELOCK`. After the delay, `executeBatch(targets, values, payloads, predecessor, salt)` runs. An open executor (`TIMELOCK_EXECUTOR` unset or `address(0)`) means any account can execute an operation that is already scheduled and past its delay. That includes `CORE_TIMELOCK`. An open executor does not let that account schedule. Set `TIMELOCK_EXECUTOR` to the Safe when only the Safe should execute.

If the remaining set changes, the operation id changes. Cancel the previously scheduled operation from the Safe before scheduling a different batch. `acceptOwnership` on a row that already completed reverts, and that reverts the whole batch.

Liability, InsuranceFund, and DisputePanel are not in this batch. Their owner is still `CORE_TIMELOCK` until step `immediate`.

## 3. Immediate `setOwner`, signed by the EOA

Run this only after `executeBatch` from step 2 has succeeded. The script reverts unless every in-scope Ownable2Step row already shows `owner() == NEW_TIMELOCK` and `pendingOwner == 0`. With `MIGRATE_ESCROWS=1`, both escrows are in scope, so their accepts must have executed too. With `MIGRATE_ESCROWS=0`, the escrows are not in that gate and stay on `CORE_TIMELOCK`.

`setOwner` has no second accept. These three transactions (Liability, InsuranceFund, DisputePanel) do not wait out `TIMELOCK_MIN_DELAY`. They are not the same transactions as step `transfer`.

Simulate. This command does not broadcast.

```bash
export NEW_TIMELOCK=<timelock-from-step-0>
export EXPECTED_TIMELOCK=$NEW_TIMELOCK
export SAFE_ADDRESS=<existing-safe>
export MIGRATION_STEP=immediate
# Required: exactly 0 or 1. 1 is recommended (freezes the old escrows). Spencer chooses at broadcast.
export MIGRATE_ESCROWS=1
forge script script/MigrateOwnershipToTimelock.s.sol:MigrateOwnershipToTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Spencer sends this step from the `CORE_TIMELOCK` keystore.

```bash
export NEW_TIMELOCK=<timelock-from-step-0>
export EXPECTED_TIMELOCK=$NEW_TIMELOCK
export SAFE_ADDRESS=<existing-safe>
export MIGRATION_STEP=immediate
# Required: exactly 0 or 1. 1 is recommended (freezes the old escrows). Spencer chooses at broadcast.
export MIGRATE_ESCROWS=1
forge script script/MigrateOwnershipToTimelock.s.sol:MigrateOwnershipToTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --account <core-timelock-account> \
  --sender 0x10CC9474b45625ADfd05C209f2518023484878D9 \
  --broadcast
```

## 4. Post-check

This command does not broadcast. The same `NEW_TIMELOCK` checks run first. `postCheck` then requires exactly these nine addresses, in this order, on chain id `84532`:

1. `0xeE76876bECcFc1B58fC06fF4E654a517d784B224`
2. `0x1463D664fA467FBCDA4B05443434494f05e565bc`
3. `0x554Caf5a214B8d70D675C09186C5EAE24FEB7307`
4. `0x19fc26B36Cb2031062eD90C19db64b3b09753ab8`
5. `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb`
6. `0x3d660502D75f1e97b08c110255921b437A3C4C42`
7. `0xF0f260967D377E07Bdd7840862508ddB23C012b8`
8. `0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7`
9. `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c`

Any other address in that set reverts. A row with an unexpected owner reverts. The script does not skip it. With `MIGRATE_ESCROWS=0`, rows 6 and 9 must still be owned by `CORE_TIMELOCK` with `pendingOwner == 0`, and the other seven must be owned by `NEW_TIMELOCK` with `pendingOwner == 0`. With `MIGRATE_ESCROWS=1`, all nine must be owned by `NEW_TIMELOCK` with `pendingOwner == 0`. Immutable `governance` is unchanged either way. Set the flag on this command to the same value used at broadcast.

```bash
export NEW_TIMELOCK=<timelock-from-step-0>
export EXPECTED_TIMELOCK=$NEW_TIMELOCK
export SAFE_ADDRESS=<existing-safe>
export MIGRATION_STEP=check
# Required: exactly 0 or 1. 1 is recommended (freezes the old escrows). Spencer chooses at broadcast.
export MIGRATE_ESCROWS=1
forge script script/MigrateOwnershipToTimelock.s.sol:MigrateOwnershipToTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

## Before funding any contract

Do this again immediately before sending ETH or opening an escrow. These commands do not broadcast.

An escrow left on `CORE_TIMELOCK` (`MIGRATE_ESCROWS=0`) is still a single key. Do not fund it. Fund only after that escrow is retired or replaced by one whose `governance` is `NEW_TIMELOCK`, and after the checks below match. `1` is recommended at broadcast so these old escrows cannot take new funds. Spencer chooses `0` or `1` at broadcast time.

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
export CORE_TIMELOCK=0x10CC9474b45625ADfd05C209f2518023484878D9
export SAFE_ADDRESS=<existing-safe>
export NEW_TIMELOCK=<timelock-from-step-0>
export EXPECTED_TIMELOCK=$NEW_TIMELOCK

cast code "$SAFE_ADDRESS" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$SAFE_ADDRESS" "getThreshold()(uint256)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$SAFE_ADDRESS" "getOwners()(address[])" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_TIMELOCK" "getMinDelay()(uint256)" --rpc-url "$BASE_SEPOLIA_RPC_URL"

PROPOSER_ROLE=$(cast keccak "PROPOSER_ROLE")
EXECUTOR_ROLE=$(cast keccak "EXECUTOR_ROLE")
CANCELLER_ROLE=$(cast keccak "CANCELLER_ROLE")
DEFAULT_ADMIN_ROLE=0x0000000000000000000000000000000000000000000000000000000000000000

cast call "$NEW_TIMELOCK" "hasRole(bytes32,address)(bool)" "$PROPOSER_ROLE" "$SAFE_ADDRESS" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_TIMELOCK" "hasRole(bytes32,address)(bool)" "$CANCELLER_ROLE" "$SAFE_ADDRESS" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_TIMELOCK" "hasRole(bytes32,address)(bool)" "$DEFAULT_ADMIN_ROLE" "$NEW_TIMELOCK" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_TIMELOCK" "hasRole(bytes32,address)(bool)" "$DEFAULT_ADMIN_ROLE" "$SAFE_ADDRESS" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_TIMELOCK" "hasRole(bytes32,address)(bool)" "$PROPOSER_ROLE" "$CORE_TIMELOCK" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_TIMELOCK" "hasRole(bytes32,address)(bool)" "$EXECUTOR_ROLE" "$CORE_TIMELOCK" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_TIMELOCK" "hasRole(bytes32,address)(bool)" "$CANCELLER_ROLE" "$CORE_TIMELOCK" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_TIMELOCK" "hasRole(bytes32,address)(bool)" "$DEFAULT_ADMIN_ROLE" "$CORE_TIMELOCK" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

`cast code` on the Safe must not start with `0xef0100`. `getThreshold()` must be at least 2, and `getOwners()` must return at least that many addresses. `EXPECTED_TIMELOCK` must equal `NEW_TIMELOCK`. `getMinDelay()` must be at least 300. The Safe's proposer and canceller results must be `true`. The timelock's own admin result must be `true`. The Safe's admin result must be `false`. Every `CORE_TIMELOCK` role result must be `false`.

Ownable2Step rows. `owner()` must be `NEW_TIMELOCK` and `pendingOwner()` must be `0`. The two escrows are in this list only when `MIGRATE_ESCROWS=1`. Otherwise their `owner()` is still `CORE_TIMELOCK`, and they stay under that single key.

```bash
for addr in \
  0xeE76876bECcFc1B58fC06fF4E654a517d784B224 \
  0x1463D664fA467FBCDA4B05443434494f05e565bc \
  0xF0f260967D377E07Bdd7840862508ddB23C012b8 \
  0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7
do
  cast call "$addr" "owner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
  cast call "$addr" "pendingOwner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
done
```

Immediate `setOwner` rows have no `pendingOwner()`. After step `immediate`, `owner()` must be `NEW_TIMELOCK`. Before that step, `owner()` is still `CORE_TIMELOCK`.

```bash
for addr in \
  0x554Caf5a214B8d70D675C09186C5EAE24FEB7307 \
  0x19fc26B36Cb2031062eD90C19db64b3b09753ab8 \
  0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb
do
  cast call "$addr" "owner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
done
```

## Kill switch / rollback

Nothing is instant once the timelock owns a contract. `transferOwnership`, `setOwner`, and every other owner call wait for `getMinDelay()` before they can execute. Cancelling a waiting operation does not undo one that has already executed.

The immediate `setOwner` handoff is the exception on the way in: those three transactions (Liability, InsuranceFund, DisputePanel) do not wait. They cannot run until the Ownable2Step accepts have executed, and they are not bundled with those `transferOwnership` calls. After they land, moving those three contracts again waits for the delay.

### Cancel a scheduled operation

The Safe holds `CANCELLER_ROLE`. It calls `cancel(bytes32 id)` on `NEW_TIMELOCK`.

For one call, the id is the timelock's pure `hashOperation`:

```text
id = hashOperation(target, value, data, predecessor, salt)
```

For a batch, including the accept batch, the id is `hashOperationBatch`:

```text
id = hashOperationBatch(targets, values, payloads, predecessor, salt)
```

The arguments are the same ones that were scheduled. The migration accept batch uses predecessor `bytes32(0)` and salt `keccak256("CORE_TIMELOCK_MIGRATION_ACCEPT_V1")`. `cancel` succeeds only while the operation is waiting or ready.

### Move ownership back

The Safe proposes a new schedule on `NEW_TIMELOCK`, waits out `getMinDelay()`, then executes. There is no same-transaction return to the EOA.

- Ownable2Step (`Denylist`, `Vault`, and the superseded pair, plus the escrows if they were opted in): the payload is `transferOwnership(address)` aimed at the return address. After execute, that address is only `pendingOwner`. It must call `acceptOwnership()` itself. Until that call, the timelock remains owner.
- Immediate `setOwner` (Liability, InsuranceFund, DisputePanel): the payload is `setOwner(address)` aimed at the return address. Execute sets the owner in that transaction. The delay is the wait before execute. There is no second accept.

## Outflow paths

Live ETH balances on the enumerated contracts were 0 at the reading used for this runbook. `lockedValue()` on both escrows was 0.

The value-at-risk rows below describe the ESC-M-1 bytecode that was live when this migration was written. That contract is now retired at `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d`. The current live escrow is `0x3d660502D75f1e97b08c110255921b437A3C4C42` (commit `7fe4a863e9bce0b70b629dab76ddd2728c97b536`), which is the pull-payment design (payer-only `release`, `RULING_GRACE`, `withdraw` / `withdrawTo`).

Source of truth for that retired ESC-M-1 escrow `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d`:

- `deployments/base-sepolia.json` `retired.BotAttestationEscrowEscM1` records commit `444c427` (`444c42734b414390416853c32df0c0395a3da74c`), deploy tx `0x7ab17bac1f046ad50299e905f6f5fed47455fdebd3e3004094b899c7f801d8aa`, block `47345163`.
- `git show 444c427:contracts/BotAttestationEscrow.sol` matches the Blockscout-verified source (`BotAttestationEscrow`, solc `v0.8.20+commit.a1b79de6`, optimizer 200, shanghai). `cast code` matches that deployed bytecode.
- Selectors present include `release(bytes32)` `0x67d42a8b` and `refund(bytes32)` `0x7249fbb6`. Selectors absent include `withdraw()` `0x3ccfd60b`, `withdrawTo(address)` `0x72b0d90c`, `totalOwed()` `0xe7fa9f7d`, and `RULING_GRACE()` `0x3cfbadae`.

Source of truth for retired escrow `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c`:

- The book records deploy tx `0x700d9bac95e8833bd7e93721a88d689a0fb839c9e6108858c52560eae111948e`, block `47299930`, no commit hash, retired `2026-09-26`. Blockscout has no verified source for this address.
- The runtime selector scan is the source of truth: the same `release(bytes32)` and `refund(bytes32)` selectors are present, and `withdraw`, `withdrawTo`, `totalOwed`, and `RULING_GRACE` are absent. The parent revision of the live escrow file (`e311044`) has the same anyone-can-`release`, ETH `call{value}` push, and expiry refund with no grace. This runbook does not treat the retired contract as verified source.

Deployed behavior, from that verified live source (and the same shape on the retired bytecode):

| Function | Who can trigger it today | Who after migration | Limit |
| --- | --- | --- | --- |
| `release(bytes32)` | Anyone. There is no `msg.sender` check. While `Open`, the escrow must be unexpired and both bots must still verify. While `Disputed`, only after the panel upholds, and that path skips re-attestation. Not the owner. | Same. Not the timelock. | Pushes `amount` to the create-time payee with `payee.call{value}`. |
| `refund(bytes32)` | Anyone. While `Open`, only after `block.timestamp > expiresAt`, with no grace. While `Disputed`, an upheld ruling cannot refund; before expiry an unwind ruling is required; after expiry the refund is the backstop, with no `RULING_GRACE`. | Same. | Pushes `amount` to the payer with `payer.call{value}`. |
| `withdraw` / `withdrawTo` | Not present on the deployed bytecode. | Not present. | No such outflow. |
| `createEscrow` | Inflow, and only while `owner() == governance` (`CORE_TIMELOCK`). | Unchanged while the escrows are skipped, so the single CORE key can still open escrows. With `MIGRATE_ESCROWS=1`, reverts `FundingBeforeGovernance`. No new funds can enter. | Not an outflow. |

The Vault holds no ETH and has no token balance and no withdrawal function. Owner calls are `register`, `setOperator`, and `burn`. Today `CORE_TIMELOCK` calls them. After the Vault's Ownable2Step accept, those calls wait on the Safe plus the delay. `burn` stays irreversible.

Denylist listing writes are `addExact`, `addSignature`, `addPrompt`, and `remove`, all `onlyOwner`. Today that owner is `CORE_TIMELOCK`. After the Denylist's accept, the timelock calls them via the Safe, after the delay.

DisputePanel `setArbitrator` is `onlyOwner`. `CORE_TIMELOCK` is not a seated arbitrator. Today the owner is `CORE_TIMELOCK`. The owner change itself is the later `setOwner` transaction, which has no delay and runs only after the two-step accepts have executed. After that, `setArbitrator` waits on the Safe plus the delay. The seat list is not cleared by this migration.

Liability can hold ETH (`receive`). `settle` when the liable party is `Owner` sends `claim.amount` to the claimant. Today `CORE_TIMELOCK` files the claim and settles it, up to the contract's ETH balance. After step `immediate`, only the timelock can, via the Safe, after the delay. The auditor branch reverts. The insurance branch calls `InsuranceFund.payout`.

InsuranceFund can hold ETH (`fund`). `payout` is `onlyLiability`, not the owner. The owner cannot withdraw. ETH leaves only when Liability `settle` calls `payout`, capped by the fund's accounted `balance` and the claim amount. Today that caller path is `CORE_TIMELOCK` as Liability owner. After step `immediate` it is the timelock, via the Safe, after the delay.

After `MIGRATE_ESCROWS=0` (escrows left in place), `CORE_TIMELOCK` is not `owner` or `pendingOwner` of the seven non-escrow rows. It still owns both escrows, and it remains their immutable `governance`, so `createEscrow` and the setters keep working for that EOA. That is single-key control. With `MIGRATE_ESCROWS=1`, it is not `owner` or `pendingOwner` of those escrows either, `createEscrow` and the setters revert, and no new funds can enter. `release` and `refund` still work, and `governance` is still the EOA.
