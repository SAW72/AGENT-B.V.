# Security summary

**Status:** testnet only. This is an operator snapshot of the code on `main`, not a third-party audit and not a mainnet go.

**Reviewed:** 2026-10-20. **HEAD:** `488e8ed`.

Security reports go through this policy and carry no points and no bounty.

## Where it runs

Base Sepolia (84532) only. Mainnet execution is refused. The live escrow is `0x3d660502D75f1e97b08c110255921b437A3C4C42`, owned by governanceTimelock `0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33`. The ESC-M-1 escrow `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` is retired (2026-10-06). The previous escrow `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` is retired (2026-09-26). Addresses and the stage checklist are in [GO_LIVE.md](GO_LIVE.md) and `deployments/base-sepolia.json`.

## What holds

- `release` and `refund` credit `pendingWithdrawals`. They do not push ETH to the payee or payer inside that call. The party pulls with `withdraw` or `withdrawTo`.
- An open release re-checks the Vault (bots still active, not denylisted, Financial+ tier) and the operators stored on the escrow. An upheld dispute skips that re-check on purpose, so a later denylist hit or operator rotation cannot strand the locked ETH. Refund stays closed after an uphold.
- `dispute()` is the payer or the payee, and only while the escrow is `Open` and `block.timestamp` is at or before `expiresAt`. It opens the panel case in that same transaction. The subject is `panelSubject`: `keccak256(abi.encode(block.chainid, address(this), escrowId, createdAt))`. If the panel reverts, the escrow stays `Open`.
- Constructor `governance` on the live escrow is the TimelockController in the address above. `script/DeployBotAttestationEscrow.s.sol` refuses `NEW_TIMELOCK` when it is the pre-migration CORE address `0x10CC9474b45625ADfd05C209f2518023484878D9`, when the address has no code, or when it is an EIP-7702 delegation.
- Live `POST /v1/claims` requires an EIP-712 `ClaimIntent` signed by the payer or payee. The relayer refuses mainnet.

## Open before mainnet

No contract item from issues #31 and #32 remains open in this tree. This page is still not a mainnet go. See [Not claimed](#not-claimed).

## Closed in this tree

1. **One ruling can settle two deployments** ([#32](https://github.com/SAW72/AGENT-B.V./issues/32)) is closed in this contract. `dispute()` does not use the bare `escrowId` as the panel subject. `panelSubject` is `keccak256(abi.encode(block.chainid, address(this), escrowId, createdAt))`, and `dispute()` passes that value to `openDispute` in the same transaction. Two deployments that share a panel, an `escrowId`, and a `createdAt` still hash apart. GitHub issue #32 is closed.
2. **An early vote blocks the link** ([#31](https://github.com/SAW72/AGENT-B.V./issues/31)) is closed in this contract. `dispute()` opens the panel case itself. There is no second transaction between `openDispute` and the escrow link, so an arbitrator cannot vote in between and leave the escrow `Open`. GitHub issue #31 is closed.
3. **`release()` has a caller check.** An open escrow can be released only by the payer. After an upheld dispute, only the payer or the payee can release. A stranger reverts `ReleaseNotAuthorized`.

## Not claimed

TEE attestation against a real enclave, auditor slash on mainnet, and Certora proofs are not done. Scores, stamps, and denylists are point-in-time heuristics. The claims pool is not insurance. Read [DISCLAIMER.md](DISCLAIMER.md) before relying on a stamp.
