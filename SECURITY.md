# Security summary

**Status:** testnet only. This is an operator snapshot of the code on `main`, not a third-party audit and not a mainnet go.

**Reviewed:** 2026-09-27. **HEAD:** `a66ef64`.

## Where it runs

Base Sepolia (84532) only. Mainnet execution is refused. The live escrow is `0x3d660502D75f1e97b08c110255921b437A3C4C42`, owned by governanceTimelock `0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33`. The ESC-M-1 escrow `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` is retired (2026-10-06). The previous escrow `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` is retired (2026-09-26). Addresses and the stage checklist are in [GO_LIVE.md](GO_LIVE.md) and `deployments/base-sepolia.json`.

## What holds

- `release` and `refund` credit `pendingWithdrawals`. They do not push ETH to the payee or payer inside that call. The party pulls with `withdraw` or `withdrawTo`.
- An open release re-checks the Vault (bots still active, not denylisted, Financial+ tier) and the operators stored on the escrow. An upheld dispute skips that re-check on purpose, so a later denylist hit or operator rotation cannot strand the locked ETH. Refund stays closed after an uphold.
- `dispute()` rejects a missing panel case, a resolved case, a case that already has votes, a case older than the escrow, a challenger who is not the payer or payee, and a link after `expiresAt`.
- Live `POST /v1/claims` requires an EIP-712 `ClaimIntent` signed by the payer or payee. The relayer refuses mainnet.

## Open before mainnet

1. **One ruling can settle two deployments** ([#32](https://github.com/SAW72/AGENT-B.V./issues/32)). `BotAttestationEscrow.dispute()` requires the panel `subjectHash` to equal the bare `escrowId`. Two deployments that share the live panel, the same `escrowId`, and the same `createdAt` can both link one fresh, unvoted dispute. Bind the subject to chain id, this contract, `escrowId`, and `createdAt`, or have the escrow open the panel case itself. That changes the flow. It needs a redeploy plus an Auditor and Verifier pass. Wallet UX and the relayer must hash the same subject.
2. **An early vote blocks the link** ([#31](https://github.com/SAW72/AGENT-B.V./issues/31)). `openDispute` and `dispute()` are two transactions. `dispute()` reverts `DisputeVotesCast` if any arbitrator has already voted. The escrow stays `Open`.
3. **`release()` has no caller check.** That is the intended trigger for a deal that already passed the open-path checks. Combined with #31, anyone can release an escrow that a party was trying to dispute, until a fresh unvoted case is linked. Prefer the contract change in #31 (the escrow opens the panel case inside `dispute()`) before mainnet.

## Not claimed

TEE attestation against a real enclave, auditor slash on mainnet, and Certora proofs are not done. Scores, stamps, and denylists are point-in-time heuristics. The claims pool is not insurance. Read [DISCLAIMER.md](DISCLAIMER.md) before relying on a stamp.
