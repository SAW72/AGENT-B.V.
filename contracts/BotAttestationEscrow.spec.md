# BotAttestationEscrow release and dispute

Spec for who may call `release`, and how `dispute` opens a `DisputePanel` case in the same transaction. The panel contract is unchanged. `release` does not transfer ETH. It credits `pendingWithdrawals`.

## State machine

`EscrowState` is `Open`, `Disputed`, `Released`, or `Refunded`. `createEscrow` starts at `Open`. `Released` and `Refunded` are terminal.

| State | `release` | `refund` | `dispute` |
| --- | --- | --- | --- |
| `Open`, inside the window, attestation still passes | Payer only. Credits the create-time payee. The payee and a stranger revert `ReleaseNotAuthorized`. | Reverts `not expired`. | Payer or payee. `dispute(escrowId, disputeId, reason)` calls `openDispute` in the same transaction and moves the row to `Disputed`. |
| `Open`, past `expiresAt` | The payer reverts `EscrowExpired`. The payee and a stranger revert `ReleaseNotAuthorized`. | Anyone. Credits the payer. | A party reverts `DisputeAfterExpiry`. |
| `Disputed`, panel case not a completed uphold | A party reverts `DisputePending`. A stranger reverts `ReleaseNotAuthorized`. | Anyone after a resolved unwind, at any time including during grace. An unresolved case reverts `DisputePending` while `block.timestamp <= expiresAt`, reverts `RulingPending` while `expiresAt < block.timestamp < expiresAt + RULING_GRACE`, and refunds the payer once `block.timestamp >= expiresAt + RULING_GRACE`. An uphold reverts `DisputePending` even after expiry and during grace. | Reverts `EscrowNotOpen`. |
| `Disputed`, panel case resolved and upheld | Payer or payee. Credits the create-time payee. Skips expiry, re-attestation, and operator rebinding. A stranger reverts `ReleaseNotAuthorized`. | Reverts `DisputePending`. | Reverts `EscrowNotOpen`. |
| `Released` or `Refunded` | `EscrowNotOpen`. | `EscrowNotOpen`. | `EscrowNotOpen`. |

A missing id reverts `EscrowNotFound` before any caller check.

**Who may release.** While `Open`, only the payer stored at `createEscrow`. The payee and every other caller revert `ReleaseNotAuthorized`, before expiry and before the Vault or denylist are read. While `Disputed`, the payer or the payee, and only when the linked ruling is resolved and upheld. Governance is not a release caller. There is no relayer role on the contract. `refund` stays permissionless because it only credits the payer, and only on the expiry, grace, or unwind paths above.

The payee does not `release` an `Open` escrow. That call credits the payee, so it can land before the payer's `dispute` and settle the deal the payer was about to open. The payer releases when the delivery stands. After an upheld ruling, either party can release, and the credit is still the create-time payee.

**Payer free option.** Taking `release` away from the payee while `Open` would otherwise let the payer accept delivery, never release, and refund after `expiresAt`. The payee cannot collect by calling `release`. A dispute opened after `expiresAt` reverts `DisputeAfterExpiry`. The payee's path is to `dispute` before or at `expiresAt`. That moves the row to `Disputed` and closes the expiry refund until the panel rules, or until `RULING_GRACE` elapses with the case still unresolved. If the payee never opens a case, expiry still refunds the payer. That remains the backstop for a silent counterparty.

**Ruling grace.** `RULING_GRACE` is 7 days, a public constant, not a storage variable. A linked case that is still unresolved does not refund at `expiresAt`. `refund` reverts `RulingPending` while `expiresAt < block.timestamp < expiresAt + RULING_GRACE`. At `block.timestamp >= expiresAt + RULING_GRACE`, an unresolved case refunds the payer. The grace is the time the panel has to vote after a dispute filed at the deadline. Without it, the payer refunds in the next block, the row becomes `Refunded`, and a later uphold cannot pay the payee (`EscrowNotOpen`).

Once the case is resolved, the ruling decides and the grace clock does not delay it. Upheld means the deal stands: `refund` reverts `DisputePending`, and the payer or the payee can `release`, including after `expiresAt` and during the grace. Not upheld means unwind: `refund` is allowed immediately, including inside the window and inside the grace. That outcome does not depend on who opened the case.

### Error order in `refund` after `expiresAt`

`_requireEscrow` still runs first. A missing id reverts `EscrowNotFound` before any of the branches below. The branches then run in this order:

1. `Open`. The `"not expired"` check passes, because `block.timestamp > expiresAt`. Anyone refunds the payer. No custom error.
2. `Disputed`, in this order:
   1. The linked case exists, the subject matches, and the case is resolved and upheld → `DisputePending`.
   2. The linked case exists, the subject matches, the case is not resolved, and `block.timestamp < expiresAt + RULING_GRACE` → `RulingPending`.
   3. Otherwise the refund credits the payer. That is a resolved unwind, an unresolved case with `block.timestamp >= expiresAt + RULING_GRACE`, or a linked id that no longer exists or no longer matches this row. A mismatch after expiry is still the old expiry backstop. It does not become `InvalidDispute` and it does not wait on the grace.
3. `Released` or `Refunded`. `EscrowNotOpen`. The panel is not read.

Inside the window (`block.timestamp <= expiresAt`) the `Disputed` order is unchanged. Upheld reverts `DisputePending` first. Otherwise `_requirePanelUnwind` reverts `InvalidDispute` when the case is missing or the subject does not match, then `DisputePending` when the case is not a completed unwind. At the exact `expiresAt` timestamp an unresolved case is still that in-window path (`DisputePending`), not `RulingPending`. `RulingPending` starts at `expiresAt + 1` and stops being the revert at `expiresAt + RULING_GRACE`, where the refund succeeds.

## Opening a panel case

`dispute(escrowId, disputeId, reason)` calls `openDispute` in the same transaction. There is no path that only links an existing case. The caller uses a fresh random id. The reason cap is 256 bytes.

Checks, in order, after `EscrowNotFound`:

1. The caller is the payer or the payee (`NotParty`).
2. The escrow is `Open` (`EscrowNotOpen`).
3. `disputeId` is not zero (`InvalidDispute`).
4. `disputeId` is not `escrowId`, `panelSubject(escrowId, createdAt)`, or `keccak256(abi.encode(escrowId, createdAt))` (`InvalidDispute`).
5. `bytes(reason).length` is not zero (`DisputeReasonEmpty`). A zero-length reason reverts before the panel call. Above 256 bytes reverts `DisputeReasonTooLong`.
6. `block.timestamp` is at or before `expiresAt` (`DisputeAfterExpiry`).

State is set before the external call. The row stores `Disputed`, `disputeId`, and `party = msg.sender` (not `tx.origin`). `EscrowDisputed` emits that party. Then the escrow calls `openDispute(disputeId, panelSubject(escrowId, createdAt), reason)`. A revert from the panel reverts this transaction and leaves the escrow `Open`. The panel challenger is this escrow, and only for the case this call just opened. Arbitrators read `party`.

The dispute id is in the calldata, so a front-run can squat it (`exists`) before the escrow's call.

Selectors `DisputeAlreadyResolved`, `DisputeVotesCast`, `DisputePredatesEscrow`, and `DisputeChallengerNotParty` stay in the ABI. `dispute` opens the case. It does not attach an existing ruling, read a pre-existing tally, or attach a case opened earlier.

## Panel subject

`panelSubject` is `keccak256(abi.encode(block.chainid, address(this), escrowId, createdAt))`. `createdAt` is the timestamp stored by `createEscrow`. `dispute` passes that hash to `openDispute`. The uphold and unwind reads require the same hash.

The bare `escrowId` is not enough. Two escrow deployments can share one `DisputePanel` and can each create the same `escrowId` in the same block, so `createdAt` matches. The escrow address is inside the preimage, so the hashes differ. Chain id is in the preimage so the same addresses on another chain do not match either.

The hash is public once the escrow exists. A stranger calling `dispute` reverts `NotParty`. Squatting one dispute id only burns that id. The party opens another. They cannot build the other deployment's subject without that deployment's address.

## Arbitrator rule

`DisputePanel` is unchanged. This rule is not enforced on chain. It is the operating rule for arbitrators, recorded here because the deploy doc is frozen.

Arbitrators vote on a case only after `EscrowDisputed` is emitted for that escrow and `escrows(id).disputeId` equals that case id.

`dispute` opens that case in the same transaction. State is set, `party` is stored, and `EscrowDisputed` is emitted before `openDispute` returns. Voting the stored id keeps the tally on the case `dispute` opened.

`vote(id, true)` means the deal stands and the payee is paid (`release` credits the create-time payee). `vote(id, false)` means unwind and refund the payer. The meaning is the same whoever challenged. A payer's `true` and a payee's `true` are both votes that the original deal stands. The panel resolves when three votes are in: `upheld` is `votesFor >= votesAgainst`. This escrow treats `upheld` as pay the payee and not `upheld` as refund the payer.

The panel must finish that vote inside `RULING_GRACE` after `expiresAt`. That SLA is a mainnet blocker below. The contract does not extend the grace if the panel is late.

## Mainnet blockers

Not enforced in this contract. Testnet end-to-end still uses short escrows.

- Minimum `durationSeconds` of at least 3 days. `createEscrow` still accepts any duration from 1 second through 30 days. A minimum here would change the `createEscrow` arguments #47 already passes, including the short durations testnet end-to-end uses. A window shorter than the time a payee needs to notice a missing release and open a dispute leaves the payer free option open.
- Arbitrator ruling SLA: the panel must rule within `RULING_GRACE` (7 days) of `expiresAt`. After `expiresAt + RULING_GRACE`, an unresolved linked case refunds the payer.

## What did not change

`refund` is still permissionless. Payer-only `release` while `Open` is unchanged. `createEscrow` still has no minimum `durationSeconds`. `RULING_GRACE` is still a public constant.

`dispute(escrowId, disputeId, reason)` opens the panel case in the same transaction. `party` is stored on the escrow and emitted on `EscrowDisputed`. The reason cap is 256 bytes. A zero-length reason reverts before the panel call. The caller uses a fresh random id.
