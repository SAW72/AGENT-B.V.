# Governance timelock hardening

This hardening is applied on the live Base Sepolia `TimelockController` `0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33`. It is not a new deploy. It does not change any contract address.

Read-only against `https://sepolia.base.org`: `getMinDelay()` is 86400. `EXECUTOR_ROLE` for `address(0)` is false. Spencer's Safe `0x12b3683A30De9845767c1f27a5D23591cA83dD54` is the only executor. `deployments/base-sepolia.json` `governanceTimelockHardening.status` is `applied`, `liveMinDelay` is 86400, and `liveExecutor` is `closed`. The Safe is 2-of-2, so losing either key freezes admin changes. The batch procedure below is the one that already landed. Do not send it again.

## Executor

Spencer delegated the executor choice to Pete. The booked named executor is the governance Safe `0x12b3683A30De9845767c1f27a5D23591cA83dD54`.

That Safe holds `PROPOSER_ROLE`, `CANCELLER_ROLE`, and `EXECUTOR_ROLE`. `address(0)` does not hold `EXECUTOR_ROLE`. Spencer delegated the executor choice to Pete. The grant to the Safe and the revoke from `address(0)` are in tx `0x71e927ff869292edb8e9c49a67333a5069c1a71a677a1376fef73b293836302f`, block 47677255. The Safe is 2-of-2, so losing either key freezes admin changes. The batch that landed granted `EXECUTOR_ROLE` to the Safe, revoked it from `address(0)`, and set the delay to 86400.

`minDelay` target is `86400` (24 hours). Five minutes is enough for testnet iteration and too weak for mainnet. Twenty-four hours is a common protocol-change delay, and the Safe still holds `CANCELLER_ROLE`, so it can cancel inside that window. The `delay` argument on `scheduleBatch` is the live `getMinDelay()` (300 until this batch executes). It is not 86400. 86400 is the `updateDelay` argument.

## Who sends what

| Call | From | To |
| --- | --- | --- |
| `scheduleBatch` | Safe `0x12b3683A30De9845767c1f27a5D23591cA83dD54` | timelock `0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33` |
| `executeBatch` | any account, while `address(0)` still holds `EXECUTOR_ROLE` | same timelock |
| later `execute` / `executeBatch` | the same Safe, after this batch lands | same timelock |
| nothing | this repository's forge script | — |

Agents do not pass `--broadcast`. `script/HardenGovernanceTimelock.s.sol` reverts on `--broadcast` and `--resume`. It prints calldata. The Safe is the sender of `scheduleBatch`.

## Preview

This command does not broadcast.

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
forge script script/HardenGovernanceTimelock.s.sol:HardenGovernanceTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

The log says `SIMULATE; no transaction will be sent` and `named executor is the governance Safe`. `LIVE getMinDelay` is the chain value. `TARGET minDelay` is 86400. `TARGET executor` is the Safe. The chain already matches both, so stop. The book records `applied`.

## Safe `scheduleBatch`

Predecessor is `bytes32(0)`. Salt is `keccak256("GOVERNANCE_TIMELOCK_HARDENING_V1")`. `delay` is `getMinDelay()` at schedule time (300 while the chain is unchanged). Values are `0`. Every target is the timelock.

Payloads, in order:

1. `grantRole(bytes32,address)` with `EXECUTOR_ROLE` (`keccak256("EXECUTOR_ROLE")`) and the Safe `0x12b3683A30De9845767c1f27a5D23591cA83dD54`.
2. `revokeRole(bytes32,address)` with `EXECUTOR_ROLE` and `address(0)`.
3. `updateDelay(uint256)` with `86400`.

`scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)`

Execute this batch before `address(0)` loses `EXECUTOR_ROLE`. The revoke is inside the batch, so the account that submits `executeBatch` still passes the open-executor check. The grant is in the same batch, so the Safe can execute the next operation.

## `executeBatch` after the existing delay

Wait at least the scheduled `delay` (300 seconds while that is still `getMinDelay()`). Do not wait 24 hours for this installation. Then any account calls:

`executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt)`

Same targets, values, payloads, predecessor, and salt. No delay argument.

This batch has landed. `getMinDelay()` is 86400, the Safe holds `EXECUTOR_ROLE`, and `address(0)` does not. The book records `applied` from that chain read (`liveMinDelay` 86400, `liveExecutor` `closed`). This script does not write the book.
