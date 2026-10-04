# Governance timelock hardening

This is a target for the live Base Sepolia `TimelockController` `0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33`. It is not a new deploy. It does not change any contract address.

The chain still has `getMinDelay() == 300` and an open executor (`EXECUTOR_ROLE` on `address(0)`) until the Safe below submits the batch and that existing delay elapses. `deployments/base-sepolia.json` `governanceTimelockHardening.status` is `target-not-applied`. Do not read `minDelayTarget` `86400` as the live delay.

## Confirm this executor before sending

Spencer did not designate a separate ops wallet. The booked named executor is the timelock itself: `0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33`.

That is a closed executor. The batch grants `EXECUTOR_ROLE` to the timelock and revokes it from `address(0)`. After `executeBatch`, `onlyRoleOrOpenRole(EXECUTOR_ROLE)` requires `msg.sender` to be the timelock. The Safe can still `schedule` and `cancel`. It cannot `execute`. A later grant to the Safe, or to another wallet, cannot be executed by the Safe.

If the Safe or another wallet should keep executing, grant that account `EXECUTOR_ROLE` in this same batch, before the revoke of `address(0)`. This runbook does not add that grant. Confirm the timelock-as-executor choice, or change the batch, before the Safe sends it.

`minDelay` target is `86400` (24 hours). Five minutes is enough for testnet iteration and too weak for mainnet. Twenty-four hours is a common protocol-change delay, and the Safe still holds `CANCELLER_ROLE`, so it can cancel inside that window. The `delay` argument on `scheduleBatch` is the live `getMinDelay()` (300 until this batch executes). It is not 86400. 86400 is the `updateDelay` argument.

## Who sends what

| Call | From | To |
| --- | --- | --- |
| `scheduleBatch` | Safe `0x12b3683A30De9845767c1f27a5D23591cA83dD54` (`PROPOSER_ROLE`, `CANCELLER_ROLE`, not `EXECUTOR_ROLE`) | timelock `0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33` |
| `executeBatch` | any account, while `address(0)` still holds `EXECUTOR_ROLE` | same timelock |
| nothing | this repository's forge script | — |

Agents do not pass `--broadcast`. `script/HardenGovernanceTimelock.s.sol` reverts on `--broadcast` and `--resume`. It prints calldata. The Safe is the only sender of `scheduleBatch`.

## Preview

This command does not broadcast.

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
forge script script/HardenGovernanceTimelock.s.sol:HardenGovernanceTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

The log says `SIMULATE; no transaction will be sent`. `action` is `schedule` while the operation is unset. `LIVE getMinDelay` is the chain value. `TARGET minDelay` is 86400. If those two numbers are the same, and the log says the timelock is already the only executor, stop. The book would still say `target-not-applied` until someone edits it after the chain matches.

## Safe `scheduleBatch`

Predecessor is `bytes32(0)`. Salt is `keccak256("GOVERNANCE_TIMELOCK_HARDENING_V1")`. `delay` is `getMinDelay()` at schedule time (300 while the chain is unchanged). Values are `0`. Every target is the timelock.

Payloads, in order:

1. `updateDelay(uint256)` with `86400`.
2. `grantRole(bytes32,address)` with `EXECUTOR_ROLE` (`keccak256("EXECUTOR_ROLE")`) and the timelock address.
3. `revokeRole(bytes32,address)` with `EXECUTOR_ROLE` and `address(0)`.

`scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)`

Execute this batch before `address(0)` loses `EXECUTOR_ROLE`. The revoke is inside the batch, so the account that submits `executeBatch` still passes the open-executor check.

## `executeBatch` after the existing delay

Wait at least the scheduled `delay` (300 seconds while that is still `getMinDelay()`). Do not wait 24 hours for this installation. Then any account calls:

`executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt)`

Same targets, values, payloads, predecessor, and salt. No delay argument.

After it succeeds, `getMinDelay()` is 86400, the timelock holds `EXECUTOR_ROLE`, and `address(0)` does not. The deployment book is still `target-not-applied` until a follow-up edits `liveMinDelay`, `liveExecutor`, `status`, and `applied` from a fresh chain read. This script does not write the book.
