# Agent-B.V. Points Spec

**Status:** Will be a public testnet beta with open signup. Base Sepolia only. Docs only. No contract change is proposed here.

Points in this spec are an off-chain record of activity on Base Sepolia (testnet). Chain id is `84532`. Mainnet chain ids `1` and `8453` are out of scope. The disclaimer stays exactly: "Testnet only. Not a token. Can't be transferred, sold, or redeemed. May be adjusted or cancelled, and does not convert to anything."

This file is the points spec for that testnet ledger. It does not deploy anything, or change a contract, a config file, or application code. Lawyer reviews the first announcement text and a screenshot before any public post. Later posts reuse that approved text. See `docs/POINTS-ANNOUNCEMENT-DRAFT.md`.

## Sources

Built only from:

- `docs/POINTS-AND-ACCOUNTABILITY.md`
- `docs/decision-chain-spec.md`
- `contracts/BotAttestationEscrow.sol` (event arguments and the functions that emit them)
- `deployments/base-sepolia.json`

Checklist #7, #9, and #12 use the definitions already written in `docs/reputation-ledger.md`, `docs/reputation/INDEXER_SPEC.md`, and `config/reputation/sepolia.json`. Where a fact is not in those files, this spec says **TBD**.

`contracts/BotAttestationEscrow.sol` at the commit named below is the same file as in the tree this spec was written from (`git diff` against `7fe4a863e9bce0b70b629dab76ddd2728c97b536` is empty). Event topic0 strings below are keccak256 of the canonical Solidity signature. `docs/reputation/EVENT_MAP.md` records the same `EscrowCreated`, `EscrowReleased`, `EscrowRefunded`, and three-argument `EscrowDisputed` topic0 strings. Retired commits `78e3ba04` and `444c427` still emit the two-argument `EscrowDisputed`. This ledger does not count those retired logs.

## What points are

From `docs/POINTS-AND-ACCOUNTABILITY.md`:

- Points are recorded for activity that already happened. They are post-facto only.
- There is no purchase, no referral bonus, and no holding requirement.
- `deployments/base-sepolia.json` has `BVT.address` set to `null`. No dollar amount is attached to a point.
- The disclaimer stays exactly: "Testnet only. Not a token. Can't be transferred, sold, or redeemed. May be adjusted or cancelled, and does not convert to anything."
- The dashboard reads the connected wallet. Points are tied to that wallet. Signup will be open on this public testnet beta. This spec does not add a dashboard.

## Where the events come from

Count logs from one contract only:

| Field | Entry |
|---|---|
| Contract | `BotAttestationEscrow` |
| Address | `0x3d660502D75f1e97b08c110255921b437A3C4C42` |
| Network | `base-sepolia` |
| Chain id | `84532` |
| Start block | `47715415` (deploy block in `deployments/base-sepolia.json`) |
| Deploy tx | `0x0d39f2502956d1199bb9d264704aacab85ca7a5d54de3e1634b201c730b62b6c` |
| Source commit named by the deployment record | `7fe4a863e9bce0b70b629dab76ddd2728c97b536` |
| Owner | `0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33` (`governanceTimelock`) |
| `acceptOwnership` | complete |

The deployment record says this escrow is live. The comment at the top of `contracts/BotAttestationEscrow.sol` still says "Not deployed." The address, start block, and liveness in this spec come from `deployments/base-sepolia.json`, not from that comment.

Do not count the retired escrows in that same file:

- `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` (retired 2026-09-26)
- `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` (retired 2026-10-06)

`DisputePanel` at `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb` is the only other contract whose logs this ledger counts, and only `VoteCast`. The deployment record says Gate B is seated and `arbitratorCount` is 3. That seating list is not a human-versus-AI register. See "VoteCast".

## Events that can count

The live escrow events that can become points are the four below. `VoteCast` on the panel can also become a counted log, under the match rule in "VoteCast". Anything else those contracts emit is ignored for points, including `Credited`, `Withdrawn`, `DenylistUpdated`, `VaultUpdated`, `DisputePanelUpdated`, `DisputeOpened`, `DisputeResolved`, and `ArbitratorUpdated`. `release` emits both `EscrowReleased` and `Credited`. `refund` emits both `EscrowRefunded` and `Credited`. Counting `Credited` as well as the release or refund event would record the same settlement twice. `Credited` is not a points event. `DisputeResolved` is not a points event. The resolving vote is the `VoteCast` log, which is a different `log_index` in that transaction.

`utc_day` is never taken from `expiresAt`. `docs/reputation/INDEXER_SPEC.md` already forbids using `expiresAt` alone as a created-at time. Time rules are in "Ledger and daily cap".

### `EscrowCreated`

```solidity
event EscrowCreated(
    bytes32 indexed escrowId,
    address indexed payer,
    address indexed payee,
    bytes32 payerBotId,
    bytes32 payeeBotId,
    uint256 amount,
    uint256 expiresAt
);
```

Topic0 `0x9d605e83d5554e0f88f697fe6184e9d0616163c141daf3ba689299e334a285c1`.

Emitted by `createEscrow`. `payer` is `msg.sender`. `amount` is `msg.value`. `payee` is the address stored as the payee. The contract checks that `msg.sender` is `Vault.operator(payerBotId)` and that `payee` is `Vault.operator(payeeBotId)`.

| Argument | Indexed | Points use |
|---|---|---|
| `escrowId` | yes | Join key |
| `payer` | yes | Wallet for action `fund` |
| `payee` | yes | Credited address if this escrow later emits `EscrowReleased`. Not the `fund` wallet |
| `payerBotId` | no | Not a wallet. Whether the row stores it is **TBD** |
| `payeeBotId` | no | Not a wallet. Whether the row stores it is **TBD** |
| `amount` | no | ETH locked. Not a point weight |
| `expiresAt` | no | Not a time source |

### `EscrowReleased`

```solidity
event EscrowReleased(bytes32 indexed escrowId, uint256 amount);
```

Topic0 `0x9410e7c5b50451e4b5bd5ce113fd48abebd7070eb9d080df08b115b7cdc41650`.

Emitted by `release`. There is no wallet argument. The function credits `escrows[escrowId].payee`, which is the `payee` on the `EscrowCreated` log with the same `escrowId`. While the escrow is `Open`, only that row's `payer` may call `release`. While it is `Disputed`, the caller must be the payer or the payee, and only after the linked panel case is resolved and upheld. The caller is not an event argument.

| Argument | Indexed | Points use |
|---|---|---|
| `escrowId` | yes | Join to `EscrowCreated` |
| `amount` | no | Amount the contract credits to the create-time payee. Not a point weight |

Wallet for a release credit: `EscrowCreated.payee` for that `escrowId`. The spec does not use `tx.from`. `docs/reputation/INDEXER_SPEC.md` already says parties come from `EscrowCreated`, never from `tx.from`.

### `EscrowRefunded`

```solidity
event EscrowRefunded(bytes32 indexed escrowId, uint256 amount);
```

Topic0 `0x21cabc2fff910e5afd1e2bcb22ff2b165a41ab0afbaf364f07aaf2f7787fb908`.

Emitted by `refund`. There is no wallet argument. The function credits `escrows[escrowId].payer`, which is the `payer` on the matching `EscrowCreated`. The event does not say which refund path ran. The caller is not an event argument. The function does not check `msg.sender`.

| Argument | Indexed | Points use |
|---|---|---|
| `escrowId` | yes | Join to `EscrowCreated` |
| `amount` | no | Amount the contract credits to the create-time payer. Not a point weight |

Wallet for a refund credit: `EscrowCreated.payer` for that `escrowId`. Same rule as release: not `tx.from`.

### `EscrowDisputed`

```solidity
event EscrowDisputed(bytes32 indexed escrowId, bytes32 disputeId, address party);
```

Topic0 `0xe1be5dd4565e4e23afb935a6c3bb69e2179bf9404c41df9c70b9b7c1743a6cfe` for the three-argument signature.

Emitted by `dispute` before `disputePanel.openDispute`. `party` is `msg.sender`. The contract requires that caller to be the payer or the payee. The comment on the event says `party` is not `tx.origin`. The panel challenger stored by `openDispute` is the escrow contract, because the escrow is `msg.sender` on that call. `party` is the payer or payee. `party` is not the arbitrator who later votes.

| Argument | Indexed | Points use |
|---|---|---|
| `escrowId` | yes | Join to `EscrowCreated` |
| `disputeId` | no | Panel case id. Not a vote. Not indexed |
| `party` | no | Wallet for a dispute-open credit. Not indexed |

`docs/reputation/EVENT_MAP.md` records this three-argument event, including `party`, and the topic0 above. Logs for the live escrow are filtered with that topic0. The two-argument topic0 `0xcd4243485a48c9b2bc0e6ac4133f40bcac2bc94a0807c72c2dc2d60e023d2995` is the retired shape only. `party` is not indexed.

### `VoteCast`

```solidity
event VoteCast(bytes32 indexed disputeId, address voter, bool support);
```

Topic0 `0x8b40665146691327ee30f5bf56e9b2d6f445d2830d3b09b56385cd30f630ecfb`, the hash in `docs/reputation/EVENT_MAP.md`. Contract `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb`. `disputeId` is indexed. `voter` and `support` are not. `vote` allows only a seated arbitrator, once per dispute, while the case is unresolved.

Count a `VoteCast` log only when its `disputeId` equals `EscrowDisputed.disputeId` on a log from escrow `0x3d660502D75f1e97b08c110255921b437A3C4C42` whose `block_number` is greater than or equal to `47715415`. The start block applies to those escrow logs. Panel logs are not admitted by the panel deploy block `47253020`. A panel log enters only through the `disputeId` match. A `VoteCast` whose `disputeId` matches no such escrow log is not counted. A `VoteCast` seen before that `EscrowDisputed` is stored is deferred, not dropped. It can commit only after the escrow log is stored, and only when the vote log's own block is `finalized` and the log is not `removed: true`.

| Argument | Indexed | Points use |
|---|---|---|
| `disputeId` | yes | Must equal `EscrowDisputed.disputeId` on a qualifying escrow log |
| `voter` | no | Wallet for the vote case of `dispute_open_or_vote` |
| `support` | no | Not a point weight. Whether it changes the credit is **TBD** |

The escrow id on that vote row is `EscrowDisputed.escrowId` from the matching log. `VoteCast` does not carry `escrowId`. `DisputeOpened.challenger` is not `voter` and is not `party`. On a case opened by `dispute`, the challenger is the escrow contract.

Vote credit stays **TBD** until a register exists of which arbitrators are human and which are AI. No such register is in the sources. The three seated addresses and `arbitratorCount` of 3 in `deployments/base-sepolia.json` are not that register. `docs/reputation/INDEXER_SPEC.md` says humans stay in Gate B. That sentence is not a per-arbitrator classification. Until the register exists, a matched vote that is not the payer or the payee is stored with points 0. That is not a numeric credit.

No vote credit when `VoteCast.voter` is that escrow's payer or payee. Those addresses are `EscrowCreated.payer` and `EscrowCreated.payee` for the `escrowId` on the matching `EscrowDisputed`. `docs/reputation/INDEXER_SPEC.md` already gives that arbitrator 0 on A1 and 0 on A2. This ledger writes no points row for that vote.

Negative test for retired escrows. The panel address is shared with the retired escrows `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` and `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c`. A `VoteCast` whose `disputeId` matches an `EscrowDisputed` only on one of those retired addresses is not counted. `DisputePanel.openDispute` reverts when `createdAt != 0` (`"exists"`), so a `disputeId` is unique on that panel. The points check does not rely on that revert. The check is the live-escrow log. A two-argument `EscrowDisputed` topic0 on the live address is ignored.

## Actions

Point weights are **TBD**. This spec does not copy a verification-run, attestation, integration, bug-bounty, or mirrored-point rubric. Those are different actions. It also does not copy the GUESS weights in `config/reputation/sepolia.json`.

The `action` name stored in the ledger is one of the strings in this table. That string is the `action` column of `UNIQUE(wallet, action, utc_day)`.

| Action | What satisfies it | Wallet | Weight |
|---|---|---|---|
| `first_activity` | Derived one-per-wallet row. Links to the wallet's first stored escrow-log row | The wallet on the source row | **TBD** |
| `fund` | `EscrowCreated` | `payer` | **TBD** |
| `release_or_refund` | `EscrowReleased` or `EscrowRefunded` | Create-time `payee` on release. Create-time `payer` on refund | **TBD** |
| `dispute_open_or_vote` | `EscrowDisputed`, or a matched `VoteCast` that is not the payer or the payee | `party` for an open. `voter` for a matched vote | **TBD**. Vote credit stays **TBD** until the human/AI arbitrator register exists |
| `return_day` | Derived. One later UTC day of stored activity | The wallet whose activity was counted | **TBD** |

### Gates set before weights

These rules are named here. Their numbers are **TBD**. No point weight is assigned until the numbers are set. They are not the GUESS floors or pair caps in `config/reputation/sepolia.json`.

| Rule | What it compares | Setting |
|---|---|---|
| `same_pair` | How many credited escrow logs share the unordered pair of `EscrowCreated.payer` and `EscrowCreated.payee`. The two lowercase addresses are one pair in either order. One cap per UTC day and one cap for the life of the ledger, on the credited wallet's counter for that pair. A same-controller identity beyond that pair is not defined in the sources, so this is the named rule. | **TBD** |
| `min_escrow_amount` | `EscrowCreated.amount` for that `escrowId`. A log whose create amount is below the minimum is not credited. This is the gate against 1-wei farming. | **TBD** |
| `min_escrow_duration` | `EscrowCreated.expiresAt` minus the `EscrowCreated` block-header timestamp. The contract allows a duration from 1 second through 30 days. That 1 second is not this minimum. | **TBD** |

`same_pair` applies to `fund`, `release_or_refund`, and the dispute-open case. It does not apply to `VoteCast`. The counter is the credited wallet's. `fund` credits the payer, so it uses the payer's counter. A release credits the payee, so `EscrowReleased` uses the payee's counter. A refund credits the payer, so `EscrowRefunded` uses the payer's counter. Dispute open credits `party`, so it uses `party`'s counter. While a number is still **TBD**, that one comparison is not applied, and the weight stays unset. When the number is set, a log that fails it is not committed.

`release_or_refund` is one action. A release and a refund for the same wallet on the same UTC day share one slot. The row the server commits first keeps the slot. The other insert fails the unique constraint and credits nothing.

`dispute_open_or_vote` is one action, same daily slot. An `EscrowDisputed` and a matched `VoteCast` for the same wallet on the same UTC day share that slot. `party` and `voter` are different event arguments. Splitting open and vote into two action strings is **TBD**.

### First activity

`first_activity` replaces the name `first_connect`. Wallet connect is how the dashboard selects the address. The connect action itself is not a points row. Points for the connected wallet are the rows in this ledger.

`first_activity` is one row per wallet. Its own key is `UNIQUE (wallet) WHERE action = 'first_activity'`. The chain-log unique key does not include this action, so the row does not collide with its source and does not need a NULL column to slip past that key. Every key column on the row is NOT NULL. `chain_id`, `contract`, `tx_hash`, `log_index`, and `block_number` are copies of the source log, stored for the link. They are not a second insert of `UNIQUE (chain_id, contract, tx_hash, log_index)`.

The source is the earliest stored escrow-log row for that wallet in `(block_number, log_index)` order. Escrow-log rows are `fund`, `release_or_refund`, and the dispute-open case of `dispute_open_or_vote` from `0x3d660502D75f1e97b08c110255921b437A3C4C42` at or after block `47715415`. `VoteCast` is not an escrow log and does not start `first_activity`. A stored row whose points are 0 because checklist #7 is still open does count as a source. A log that was not stored (cap reject, farming-gate reject, removed log, block not finalized) does not.

Order is the log order in "Ingest", not the order rows arrived. The wallet is the wallet column of the source row. `utc_day` is that log's UTC day.

### Return days

Return days are derived from activity on distinct UTC days. They are not an event.

The wallet's first active UTC day is `first_activity`. It is not a `return_day`. Each later UTC day on which that wallet has a stored escrow-log row, or a stored vote row whose points are greater than 0, produces one `return_day`. A stored vote whose points are 0 because vote weight is still unset does not count. That rule is about vote weight. It is independent of checklist #7. An escrow-log row stored at points 0 because OFAC screening is unconfigured still counts. The source log for the link is the earliest row that does count that day, in `(block_number, log_index)` order. `chain_id`, `contract`, `tx_hash`, `log_index`, and `block_number` are copies of that source, all NOT NULL. The chain-log unique key does not include `return_day`, so the copy is not a second insert of the source key. The row's own key is `UNIQUE (wallet, utc_day) WHERE action = 'return_day'`. The point weight is **TBD**.

## Ledger and daily cap

The ledger is append-only. The server is the only writer.

Daily cap, per wallet: one committed row per action per UTC day. A release and a refund for the same wallet on the same UTC day share `release_or_refund`. The second insert fails and is not deferred to another day.

```text
UNIQUE (wallet, action, utc_day)
UNIQUE (chain_id, contract, tx_hash, log_index) WHERE action IN ('fund', 'release_or_refund', 'dispute_open_or_vote')
UNIQUE (wallet) WHERE action = 'first_activity'
UNIQUE (wallet, utc_day) WHERE action = 'return_day'
```

`wallet`, `contract`, and `tx_hash` are stored as lowercase hex with a `0x` prefix. The reputation read API already lowercases wallets. The RPC address is lowercase. Mixed case must not become two keys. `chain_id` is `84532`. `log_index` and `block_number` are integers and are NOT NULL on every committed row, including `first_activity` and `return_day`. No key column is NULL. A client cannot supply the key.

`contract` for an escrow log is `0x3d660502d75f1e97b08c110255921b437a3c4c42`. For a counted `VoteCast` it is `0x31a92f9a25396968e14d2b55b6b0bb1482ecf1bb`.

`utc_day = floor(block_timestamp / 86400)`, using the block-header timestamp in unix seconds. `docs/reputation/INDEXER_SPEC.md` already says block-header timestamps are the only time source for chain logs. `00:00:00Z` belongs to the new day. Ingest time and the server wall clock are not `utc_day`.

### Ingest

One block tag for backfill and for the live tail: `finalized`. That is `scan.final_tag` in `config/reputation/sepolia.json`. A log whose block is not yet `finalized` is not committed. `safe` (`scan.provisional_tag`) is display-only. It is not a points commit.

Walk blocks from `47715415` through the finalized head, and within a block by `log_index` ascending. Backfill and live use that same order. Cap checks and `first_activity` see logs in that order, not in arrival order.

The only reorg rule is to skip a log marked `removed: true`. There is no cancel path and no rewrite of a committed row.

The cap insert is one database transaction. On conflict it rolls back. No second row and no partial amount.

The same closed failure applies when the server cannot verify the log, when `chain_id` is not `84532`, when the contract is a retired escrow, when a `VoteCast` has no matching live-escrow `disputeId`, when `VoteCast.voter` is that escrow's payer or payee, when the block is not `finalized`, when the log is marked removed, or when the client is the only source of the hash, the log index, or the time.

Further columns (bot ids, `dispute_id`, `support`, point weight) are **TBD**. `escrow_id` on an escrow log is the event's `escrowId`. On a matched `VoteCast` it is the matching `EscrowDisputed.escrowId`. Checklist #12 stays open. The unique keys above are the caps this spec defines. They are not a locked numeric weight.

## Decision chain: proved on Agent-B.V. first

The accountability layer is the decision chain in `docs/decision-chain-spec.md` and section 6 of `docs/POINTS-AND-ACCOUNTABILITY.md`. A badge is a label on that chain. The chain is the record.

Agent-B.V. is where that layer is proved first. `docs/POINTS-AND-ACCOUNTABILITY.md` section 5 says STRANDED, RAT Score, and any other partner count AI-assisted activity only after Agent-B.V. has issued a human-verified attestation with the decision chain attached. Those programs do not decide human versus AI. Agent-B.V. does, and this ledger is the first points record that withholds credit when the chain fails.

### Chain the server already has to store

Each entry, from the decision-chain spec:

- `actor_id`
- `actor_type`: `human` or `ai`
- `model_version`: required when `actor_type` is `ai`
- `timestamp`
- `signature`
- `scope`
- `authority`: `propose`, `review`, or `approve`
- `accountable_human_id`: optional. The human responsible for an AI actor. Responsibility is not authority. This field is not a points wallet and does not satisfy the terminal-approver rule.

Order is fixed: proposer, then each reviewer, then the terminal approver. A missing, reordered, or unsigned chain is rejected. Every chain, approved or blocked, is stored in full. The points row does not replace the chain log.

The decision-chain link is required on every chain-log credit, including a matched vote. `first_activity` and `return_day` do not take a second link. They are confirmed by the source row's link. The chain belongs to the points wallet, the address in the wallet column. It does not belong to `tx.from`. A refund submitted by the claim relayer `0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861` (`claimRelayerWallet` in `deployments/base-sepolia.json`) still requires the chain of `EscrowCreated.payer`, who is the credited wallet. The relayer is not the terminal approver. A release credits `EscrowCreated.payee`, including when only the payer may call `release` while the escrow is `Open`. The required chain is the payee's. The payer's transaction is not a substitute for that chain.

Two signatures, in this order. The decision-chain entry, including the terminal approval, is signed before the transaction. `PointsLink` is signed after the transaction, because `txHash` and `logIndex` exist only once the log is mined. The rule that a signature after the action is not prior authority applies to the decision-chain entry only. It does not apply to `PointsLink`.

The payee's signing load on a release is intended. The payee signs the decision-chain approval before the transaction, and signs one `PointsLink` after it for `release_or_refund`. Derived rows add no signature.

### EIP-712 link

Issuer: the points server. It is the only writer of this ledger. It issues the nonce and stores it. A client-supplied nonce is not accepted. `docs/reputation/INDEXER_SPEC.md` calls this class of points Steward-operated. That is the operator, not a second issuer. `createEscrow`'s intent-hash comment and the claim-relayer `ClaimIntent` nonce are not this nonce.

Encoding: EIP-712. Domain and struct:

```text
EIP712Domain(string name, string version, uint256 chainId, address verifyingContract)
name = "Agent-BV Points"
version = "1"
chainId = 84532
verifyingContract = 0x3d660502D75f1e97b08c110255921b437A3C4C42

PointsLink(bytes32 escrowId, string action, bytes32 txHash, uint256 logIndex, uint256 nonce, uint64 expiry, address wallet)
```

`action` is the EIP-712 dynamic `string`. `txHash` is the log's transaction hash. `logIndex` is the log's `log_index`. `wallet` is the points wallet. It must equal the ledger row's wallet and the address recovered from the signature. If either check fails, the link does not credit. There is no salt field.

Scope: one signature covers one log. The signed `escrowId`, `action`, `txHash`, `logIndex`, and `wallet` must be that log and that row, on chain id `84532`, with `verifyingContract` the live escrow. A different chain id, contract, escrow, action, hash, log index, or wallet does not confirm. `BotAttestationEscrow` does not verify `PointsLink`. This spec does not add that check.

Recovery is ECDSA only (`ecrecover`). The signature is 65 bytes. `r` and `s` are both greater than zero, and `s` is at most `secp256k1n / 2`. `v` is in `{0, 1, 27, 28}`. Before the signer is recovered, a `v` of `0` is rewritten to `27` and a `v` of `1` is rewritten to `28`. Recovery uses that normalized `v`. A signature outside those bounds does not credit. The low-`s` bound matches `assertLowS` in `claim-relayer/claimIntent.mjs`, which rejects a larger `s` against `SECP256K1_HALF_N`. ERC-1271 contract-wallet signatures are refused. That matches the claim relayer's testnet default, where ERC-1271 stays off unless `ERC1271_ENABLED=1` (`claim-relayer/README.md`). An EIP-7702 account whose ECDSA signature recovers to `wallet` is accepted. A contract wallet that does not recover that way is refused.

Nonce: `uint256`, unique, single-use, server-issued, and server-stored. At issue time the server binds the nonce to `(txHash, logIndex, wallet)` for one log, and it checks the issue time against that log's `block_timestamp`. The signer is the terminal human approver, and that address is `wallet`. A missing nonce, a reused nonce, or a nonce whose stored binding differs from the signed transaction hash, log index, or wallet does not credit. Nonces do not have to be confirmed in order. A later nonce for a different log may be confirmed while an earlier nonce is still open. A log has at most one open nonce. Open means issued and not yet consumed by confirmation or revoke. A second issue while that nonce is open is refused and stores nothing. Once the open nonce is consumed, a new nonce may be issued for the same log. The server stores the issue time with the nonce. It refuses to issue a nonce when that issue time is after the bound log's `block_timestamp + 86400`. A refused issue stores no nonce. Rebuilds read the stored issue time and the stored binding. They do not ask again whether the wall clock is still inside the window. Before confirmation, the points server may revoke the nonce by consuming it. A consumed nonce does not confirm. The revoke is an append-only stored record. Rebuilds read that record. They do not infer it from the clock.

Expiry is checked only against the log's block timestamp: `block_timestamp <= expiry <= block_timestamp + 86400`. The `86400` is the same one-day length used in `utc_day = floor(block_timestamp / 86400)`. Confirmation time is not compared to `expiry`. A rebuild the next day accepts the same link when the block timestamp still falls in that window.

The decision-chain approval is signed before the transaction. Its timestamp is strictly before the log's block timestamp. A chain entry at or after that timestamp does not credit. `PointsLink` is signed after the transaction. That later signature is the link.

Confirmation also checks that the block is `finalized`, the log is not `removed: true`, and `escrowId` is the escrow id on the row (`EscrowDisputed.escrowId` for a matched `VoteCast`). `first_activity` and `return_day` use the source row's confirmed `PointsLink`. They do not require `action` to be `first_activity` or `return_day` inside a second struct.

The origin tag is written server-side. A client cannot hide it or flip it. A `human` entry needs an identity anchor (government ID check, passkey, or a wallet signature tied to a prior human verification) plus behavioral signals. A checkbox is not that anchor. An `ai` entry names the agent and the model version. No AI actor may present itself as human.

### How a fund action gets a point

`fund`, `release_or_refund`, and the dispute-open case of `dispute_open_or_vote` move, lock, or irreversibly commit funds:

- `createEscrow` locks ETH (`lockedValue` increases by `msg.value`).
- `release` credits the payee's pull balance.
- `refund` credits the payer's pull balance.
- `dispute` moves an open escrow that still holds funds to `Disputed`.

The terminal-approver rule already applies to that class of action. The last approver must be a verified human. An AI may propose, sequence, and recommend. It may approve ordinary work inside an explicit scope that does not touch funds. It may not be the last signature on these actions.

A credit for one of those actions is committed only when all of the following are true:

1. The server has the full chain for the action, written before the action, with server-side origin tags.
2. The chain is ordered and every entry is signed.
3. The terminal approver's `actor_type` is `human`, and that human entry has the identity anchor and behavioral signals the decision-chain spec requires.
4. The event mapping in this spec names the wallet, and the ledger constraints accept the row.
5. The `PointsLink` for that log is signed after the transaction, its `wallet` matches the row, and it confirms under the rules above. The decision-chain approval for that same action was signed before the transaction.

A matched `VoteCast` can pass these checks and still receive no numeric credit. Vote credit stays **TBD** until the human/AI arbitrator register exists. A stored vote whose points are 0 because that weight is unset does not produce a `return_day`. That exclusion is the vote-weight rule. It is independent of checklist #7. OFAC screening can zero a different row for `ofac_unconfigured`. It is not what keeps a vote at 0 here.

If the terminal approver is `ai`, Agent-B.V. already blocks the action and logs the full chain. The points consequence, which is the proof on this ledger, is that no points row is committed. A decision-chain signature added after the escrow transaction is a confirmation, not prior authority, so a chain attached after the log does not make the log count. That rule does not apply to `PointsLink`, which is signed after the log. Both signatures, in that order, are necessary. They are not sufficient. The log still has to pass the rest of this spec, including a finalized block, a log that is not removed, a matching wallet, a low-`s` signature with nonzero `r` and `s` and a normalized `v`, an expiry inside the block-timestamp window, and the ledger gates. If the escrow was called outside that path and the log exists anyway, a missing or out-of-order signature means no credit, and so does a signature pair that fails any of those other gates.

The badge when the check passes is `Human-instructed`: a verified human approved before execution. `Bot-instructed` means every actor is `ai`. That badge is allowed only inside a non-financial scope, so it does not authorize a credit for these four events. `Human` by itself does not authorize fund movement. `Trusted` and `Not trusted` are labels on a scenario-library result. None of the badges is an action in the table above, and none of them has a point weight.

`accountable_human_id` does not pass step 3. The person who is notified is not, by that field, the person who was allowed to approve.

`VoteCast` does not carry decision-chain fields. The link above is still required, and it is confirmed against the `VoteCast` log and the matching `EscrowDisputed`. That confirmation does not classify the arbitrator. Vote credit stays **TBD** until the human/AI register exists. `docs/reputation/INDEXER_SPEC.md` says AI can assist or co-seat and that humans stay in Gate B. That sentence is not a chain entry and it is not the register.

Whether large transfers need more than one human signature is undecided in both source specs. This spec sets no dollar threshold and no signature count above one.

The escrow contract does not read the chain. The check lives in the points writer. That split is intentional and is restated for Blockchain Builder under "No contract change".

## Checklist #7: OFAC screening

**Open.** Scoring stays 0 until OFAC screening is configured. That is fail-closed. Definition from `docs/reputation-ledger.md`: OFAC / sanctions before soft launch. The screen hook fails closed, as that ledger doc decided. Every row keeps `points` at 0 until a real screen is plugged in.

The running definition in that same doc, which this spec uses:

- Default screen result: `{ eligible: false, status: "unverified", reason: "ofac_unconfigured" }`.
- The API reports `eligibility.status` `"unverified"` and `points_withheld: true`.
- The row is still stored. `points` is 0 so a raw sum does not credit it.
- `docs/reputation/INDEXER_SPEC.md` shows a staging stub `{ eligible: true, reason: "pending-#7" }` and says public launch is blocked until #7 closes. `docs/reputation-ledger.md` says this service does not use that stub. This spec follows the ledger doc: the screen stays closed until a real screen exists.

`TERMS.md` at the repository root, section 4, already bars comprehensively sanctioned jurisdictions, OFAC SDN and similar denied-party listings, and persons owned or controlled by them. There is no screen implementation named in the sources. Provider, list set, and refresh interval are **TBD**.

Interaction with the append-only ledger: a #7 zero row still occupies `UNIQUE(wallet, action, utc_day)` and, when it is a chain log, the partial unique key on `(chain_id, contract, tx_hash, log_index)`. A later screen does not rewrite the row. Backfill of points onto a zero row is **TBD** and is not assumed. A #7 zero row still counts as the `first_activity` source when it is that wallet's earliest stored escrow log.

The reputation doc's test hook that bypasses the screen is not a production path for this ledger.

## Checklist #9: Enforcer

**Open.** Definition from `docs/reputation-ledger.md`: name the sybil / abuse enforcer and write the policy. The `enforcer` hook has no named owner, so flags do not auto-cancel. `O5_REPEAT` and `DISPUTE_PREDATES_ESCROW` are review only. Burns and listings are signals. Cancels are ADJ. Checklist #7 stays fail closed.

Hook shape from `docs/reputation/INDEXER_SPEC.md`, still open (Spencer names the owner, Lawyer reviews the policy):

- `flag` accepts `O5_REPEAT`, `DISPUTE_PREDATES_ESCROW`, `DENYLIST_LISTED`, `BOT_BURNED`, `PAIR_CAP`, and `OTHER`.
- `cancel` writes an ADJ entry. It is not an automatic zero of later rows.

`docs/reputation-ledger.md` records the default enforcer behavior this spec keeps until #9 closes:

- `O5_REPEAT`: `withhold_wallet: false`, reason `review_only`. It does not zero later rows. The threshold cited there is at least 3 O5 rows whose UTC days fall in `[D - 6, D]`.
- `DISPUTE_PREDATES_ESCROW`: one flag per dispute, `withhold_wallet` forced false, other rows left alone.
- `BOT_BURNED`, `DENYLIST_LISTED`, `DENYLIST_UNLISTED`, and `PAIR_CAP`: recorded, not withheld. Denylist listings are not a points source.

No owner is named, so this spec does not auto-cancel. ADJ lives on the reputation ledger (`config/reputation/adjustments.json`, pull request only, no admin write endpoint). Whether an ADJ row can target an action in this spec is **TBD**. Until that exists, abuse handling on this ledger is the closed cap: the extra row is not committed. Flags do not mint a negative point.

## Checklist #12: Caps

**Open.** Definition from `docs/reputation-ledger.md`: lock caps before soft launch. The numbers in `config/reputation/sepolia.json` are labeled `DRAFT/GUESS`. `GET /v1/reputation/config` returns `status: "draft"` on the body and on each cap and threshold. `config/reputation/sepolia.json` says every figure under `points`, `floors`, `caps`, and `flags` is a GUESS until Spencer locks checklist #12, and it must not be used against live data until Blockchain Verifier APPROVE and Spencer's GO via BOB.

This spec does not lock those numbers and does not reuse them as weights for `first_activity`, `fund`, `release_or_refund`, `dispute_open_or_vote`, or `return_day`. The GUESS figures (including 20 usage points per wallet per day, 500 per season, and 30 arbitrator points per day) stay in that config. They are not the daily cap for this ledger.

`caps._label` remains `DRAFT/GUESS`. A numeric point cap, a per-bot cap, and a season cap for these actions are **TBD** until #12 locks. `same_pair`, `min_escrow_amount`, and `min_escrow_duration` are named in "Gates set before weights". Their numbers are **TBD** and are set before any weight.

## No contract change

No contract change is expected. An earlier look for Blockchain Builder confirmation, as his review of commit `6bf8488ce6c983e2f008a84020f55fff34fd693f`, found that pull request #85 has no review, no issue comment, no review comment, and no commit comment on that SHA.

The confirmation below is a build record for Blockchain Builder. It is not announcement text. Blockchain Builder confirms that no contract change is needed for soft-launch scopes S, M, or L as those scopes are written in "Soft launch scope S". Checked on `main` at `6b67ad26aa35a3c87e980acfce12aab89ab21d76`:

- The events this ledger counts are already in the source. `EscrowCreated` is `contracts/BotAttestationEscrow.sol:149-157`. `EscrowReleased` is `contracts/BotAttestationEscrow.sol:158`. `EscrowRefunded` is `contracts/BotAttestationEscrow.sol:159`. `EscrowDisputed` is `contracts/BotAttestationEscrow.sol:169` and is emitted at `contracts/BotAttestationEscrow.sol:578`. `VoteCast` is `contracts/DisputePanel.sol:28` and is emitted at `contracts/DisputePanel.sol:108`.
- `git diff --quiet 7fe4a863e9bce0b70b629dab76ddd2728c97b536 HEAD -- contracts/BotAttestationEscrow.sol contracts/DisputePanel.sol` exited 0. Both files are byte-identical to that deployed commit.
- Topic hashes were not recomputed. `cast` was not on the machine that checked this draft. The topic0 strings already in this spec match `services/points-indexer/src/constants.mjs:20-26` by text comparison only.
- Chain, nonce, `PointsLink`, and the human/AI register stay off-chain, as this spec already says. Scope M is that off-chain write path. Scope L is the off-chain screen, the enforcer, the links, the caps, and the register. Neither scope asks the escrow or the panel to read them.

Do not edit the header comment "Not deployed" at `contracts/BotAttestationEscrow.sol:4` to chase the deployment record. A source edit changes the verified-source hash. That is general compiler behavior. It was not tested here.

This spec reads events the deployed escrow and the deployed panel already emit. It does not add a function, an event, a storage field, a salt, or a check inside `BotAttestationEscrow` or `DisputePanel`. The escrow does not verify `PointsLink`. The decision-chain check is off-chain, in the points writer. The approval is signed before the transaction. The link is signed after it. The escrow does not take a chain, an `actor_type`, a nonce, or a point balance.

Vote-event gap, for that confirmation: the escrow has no vote event. This spec counts the existing `DisputePanel.VoteCast` log only when `disputeId` matches an `EscrowDisputed` from `0x3d660502D75f1e97b08c110255921b437A3C4C42` at or after block `47715415`. That match does not require an escrow change. Adding a vote event, or a voter argument, on `BotAttestationEscrow` would be a contract change. This spec does not ask for that change. Vote credit stays **TBD** until a register exists of which arbitrators are human and which are AI. That register is not a contract field today.

`docs/reputation/EVENT_MAP.md` now records `EscrowDisputed(bytes32 indexed escrowId, bytes32 disputeId, address party)` for the live escrow. Argument names match `contracts/BotAttestationEscrow.sol`. The two-argument topic0 remains the retired shape only. No contract edit is requested.

The header comment "Not deployed" in `contracts/BotAttestationEscrow.sol` disagrees with `deployments/base-sepolia.json`. This spec follows the deployment record. No source edit is requested.

## Soft launch scope S

Scope S will be a public testnet beta with open signup. The only network is Base Sepolia. Chain id is `84532`. Wallet connect is in. Points are tied to the connected wallet. Scoring stays 0 until OFAC screening is configured, fail-closed: the points total is 0, `points_withheld` is true, and the reason is `ofac_unconfigured`. That is the same triple `rowFrom` stores on a committed row (`services/points-indexer/src/indexer.mjs:984-987`). Scope S adds no write route.

`claim-relayer/reputation/runtime.mjs:6` rejects the copy patterns named in that file. Public wording for what points are not is the disclaimer in "What points are".

Scope M is the write path: nonce issue, chain submit, link submit, wallet signing, and an identity anchor. It needs its own design plan. It is later. It is not part of the soft launch.

Scope L is a total above 0. It needs checklist #7 (OFAC), checklist #9 (the enforcer), checklist #11 (links), checklist #12 (locked caps), the vote register, and Lawyer. It is later. It is not part of the soft launch. This file does not lock a weight, a cap, or a gate. The checklist sections above stay open. Checklist #11 stays open.

The public testnet beta is this ledger, shown for the connected wallet. The older reputation read API remains a separate system. Its fate is not decided here.

No contract change is needed for scopes S, M, or L as written here. The confirmation and the file check are in "No contract change".

### Two systems on main

Two separate systems exist on `main` at `6b67ad26aa35a3c87e980acfce12aab89ab21d76`. They are not one ledger.

(a) The older reputation read API and the new ledger are both in the tree.

The older one is the O1–O5 and A1–A2 reputation read API in the claim-relayer. The routes are `GET /v1/reputation/config`, `GET /v1/reputation/:address`, and `GET /v1/reputation/:address/history` (`claim-relayer/app.mjs:219-240`, `claim-relayer/reputation/runtime.mjs:63-64`). `config/reputation/sepolia.json:3-4` names `config_version` `sepolia-draft-1` and `rule_version` `design-v2.2`. On 2026-10-17 a read-only GET of the claim-relayer `/health` route returned HTTP 200, `chainId` 84532, `mode` `live`, `liveSubmit` true, and `build.commit` `6b67ad26aa35a3c87e980acfce12aab89ab21d76`. `GET /v1/reputation/config?chainId=84532` on that host returned `status` `draft`. `GET /v1/reputation/0x0000000000000000000000000000000000000001?chainId=84532` returned `final` 0 and `provisional` 0 on both ledgers, `eligibility.status` `unverified`, `points_withheld` true, and `indexed_to_block` null. That address is the only live balance read recorded here. `docs/reputation-ledger.md:28` says there is no durable store and the in-memory batch is empty unless a caller injects one. The wallet UI is under `apps/wallet-ux/src/reputation/`. `ReputationView` appears only inside the collapsed "System status" details (`apps/wallet-ux/src/App.tsx:325-330` and `apps/wallet-ux/src/App.tsx:422-428`) and only when that wallet is connected on chain 84532 (`apps/wallet-ux/src/reputation/ReputationView.tsx:364`). The address it sends is `account.address` (`apps/wallet-ux/src/App.tsx:426`). "What points are" uses that same rule: wallet connect is in, and points are tied to the connected wallet. There is no typed-address lookup.

The new ledger is this spec plus `services/points-indexer`. `GET /health` and `GET /health/` stay on that process (`services/points-indexer/src/main.mjs:480`). The read routes below are on the same Node process and on the Worker. They answer only when `POINTS_ENABLED` is the exact string `true`.

(b) There is no write path, so as specced no real user can get even a zero-point row.

`setOrigin`, `submitChain`, `issueNonce`, and `submitLink` are methods on the in-process indexer (`services/points-indexer/src/indexer.mjs:318`, `services/points-indexer/src/indexer.mjs:447`, `services/points-indexer/src/indexer.mjs:468`, and `services/points-indexer/src/indexer.mjs:550`). A search of `services/points-indexer/src/main.mjs` finds none of those four names. A search of `apps/` and `claim-relayer/` for `PointsLink`, `DecisionEntry`, `submitChain`, `issueNonce`, and `submitLink` found no match, so nothing in the wallet signs them. `rebuild` skips a candidate unless the chain is accepted and the link is accepted (`services/points-indexer/src/indexer.mjs:745-753`). A human entry is accepted only when the server origin has an identity anchor and behavioral signals (`services/points-indexer/src/signature.mjs:203-206`). Without those stored rows, `rebuild` commits nothing.

### Storage (plan pending)

The indexer host is Cloudflare: D1 plus a Worker or a Durable Object. That choice replaces the earlier host list. The storage design is plan pending. This document does not design it. One alarm on the Worker does at most 45 subrequests.

### Read API contract

The Node process and the Worker both implement this contract. Public reads stay off unless `POINTS_ENABLED` is the exact string `true`. `TRUE`, a space-padded `true`, `1`, `yes`, and `on` leave the reads off.

The routes are on the points-indexer process, not on the claim-relayer. The claim-relayer is the submit process: the health read in "Two systems on main" returned `mode` `live`. `claim-relayer/README.md:21` says `RELAYER_PRIVATE_KEY` is a runtime environment variable only. The indexer process does not read a signing key.

- `GET /v1/points/config`
- `GET /v1/points/:address`
- `GET /v1/points/:address/history`

Chain id `84532` only. Any other chain id is rejected, including `1` and `8453`. An address that is not `0x` plus 40 hexadecimal digits is rejected, and a stored address is lowercase. The reputation route already uses that shape (`claim-relayer/reputation/runtime.mjs:64-71`).

There is no authentication. The body is public data derived from chain logs plus the connected wallet. The limit below is not an auth control, which is also what `claim-relayer/reputation/rateLimit.mjs:1-3` says about its own limiter. The limit is 60 requests per minute per IP, in memory (`claim-relayer/reputation/rateLimit.mjs:5`), and it is empty again after a restart. On the Node process the client IP is the socket address. `X-Forwarded-For` is used only when `POINTS_TRUSTED_PROXY_HOPS` is a positive hop count, counted from the right. Hop 0, the default, ignores that header. `CF-Connecting-IP` is used only when `POINTS_CLOUDFLARE_INGRESS` is the exact string `true`. The Worker uses `CF-Connecting-IP` only and does not read `X-Forwarded-For`.

CORS is an exact-origin allowlist on both runtimes. Unset `POINTS_CORS_ORIGINS` is an empty allowlist, so no origin is allowed. That is separate from the claim-relayer default. Methods are GET, HEAD, and OPTIONS. There is no wildcard. Responses send `Cache-Control: no-store`. There is no write route and no admin route. `GET /health` stays as it is. `setOrigin`, `submitChain`, `issueNonce`, and `submitLink` stay off HTTP. A repeated query parameter is HTTP 400 `duplicate_query` on every runtime.

`GET /v1/points/config` returns chain id `84532`, `status` `draft`, `rule_version`, and the weights and gates in `services/points-indexer/config/points.json`. Every weight and every gate in that file is null. This draft does not set them. The response also carries `disclaimer`, with `text` and `links`.

`GET /v1/points/:address` is the scope S read for the connected wallet. `points_total` is 0. `points_withheld` is true. `eligibility.status` is `unverified`. `eligibility.reason` is `ofac_unconfigured`. Scoring stays 0 until OFAC screening is configured. `indexed_to_block` is the cursor `last_scanned_block` (`services/points-indexer/src/indexer.mjs:274`, written inside `commitScanWindow` at `services/points-indexer/src/indexer.mjs:386`). It is not `finalized_block`. `setFinalizedBlock` stores the finalized head and only moves that head forward (`services/points-indexer/src/indexer.mjs:263-269`). The pass computes that head at `services/points-indexer/src/main.mjs:742`, reads the cursor at `services/points-indexer/src/main.mjs:743`, and stores the head at `services/points-indexer/src/main.mjs:815` even when the cursor is still behind. The address and history responses also include `finalized_block`, `stale`, and `disclaimer`. `GET /v1/points/:address/history` returns committed `ledger_rows` only. A page is 25 rows by default and 100 at most (`config/reputation/sepolia.json:160-161`).

Open decision, not made here. This spec defines committed rows. `attributeLogs` (`services/points-indexer/src/attribute.mjs:30`) can name candidates in `raw_logs` that were not committed. Whether the address route may also return a count of activity seen on chain, with no points attached, is open. Until that is decided, the contract is committed rows only.

Disclaimer link slots stay empty while checklist #11 is open (`config/reputation/sepolia.json:145-152`). The display sentence is `config/reputation/sepolia.json:155`. This draft does not fill the slots. `disclaimer.links` includes `legal_notice_url`, and each slot is empty until Lawyer confirms the surface.

### Pacing before the first deploy

This is a requirement before the first deploy. The work is PR-3. Pacing of `getLogs`, and stopping a pass when the RPC returns HTTP 429, uses the numbers proposed in PR #103. Those numbers are still Spencer's decision.

The values proposed in PR #103 wait 200 ms between `getLogs` calls. A failed call is retried 3 times, at 1 s, then 2 s, then 4 s. The `Retry-After` cap is 30 s. A value at or under that cap stays inside the pass. A longer value ends the pass and the next pass carries the remaining wait. Windows are 200 blocks. One pass scans at most 500 windows. The final pacing numbers are Spencer's decision and are still pending.

The only measured evidence recorded here is the figure from the soft-launch plan, which attributes it to the PR #100 Verifier verdict: 50 HTTP 429 responses in 1,055 requests, at 25 to 35 requests per second, on the public RPC. That count is not in the git tree. Pull request #100 on GitHub had no reviews and no comments when those lists were read for this draft. The count was not measured again here.

Two other items stay parked. They are not planned. Grok Bot's ruling still covers both.

- Storing `finalized_block` as the minimum of the reported head and the cursor. Today the stored head can move while `last_scanned_block` is behind, as cited in the read API section.
- Removing the `DATABASE_URL` fallback at `services/points-indexer/src/main.mjs:150-152`.

### Open items and owners

| Owner | Open items |
|---|---|
| Spencer | The RPC secret. The Pages upload (`apps/wallet-ux/CLOUDFLARE_PAGES.md:3` is Direct Upload). Checklist #12 caps. Checklist #9 enforcer owner. The human/AI arbitrator register. |
| Spencer | Pacing numbers for PR-3: Spencer's call, pending. |
| Lawyer | Checklist #11 links. Checklist #7 OFAC provider. The first announcement text and a screenshot, before any public post. |
| Grok Bot | The two parked items in the pacing section. |

Checklists #7, #9, and #12 stay **Open** in the sections above. Checklist #11 stays open. No weight in this file is locked.

### Later pull requests

PR-1 is this docs amendment. Each item below waits until PR-1 is merged and until Grok Bot has ruled. This file does not authorize any of them.

- PR-2. The indexer read API in the contract above. It waits for PR-1 merged plus Grok Bot's ruling.
- PR-3. `getLogs` pacing, and stopping a pass on HTTP 429. Required before the first deploy. It waits for PR-1 merged plus Spencer's ruling on the pacing numbers. The parked `finalized_block` change and the parked `DATABASE_URL` removal are not PR-3.
- PR-4. Storage on Cloudflare (D1 plus a Worker or a Durable Object) is plan pending. A later pull request may add that design. This file does not design it and it does not hold a secret.
- PR-5. A wallet surface for the connected wallet on chain `84532`. Points are tied to that wallet. Signup will be open. It waits for PR-1 merged plus Grok Bot's ruling. The Pages upload stays with Spencer.

Scope M and scope L are not in that list. Each needs its own plan. They are not the soft launch.

## Out of scope

- Code, config, migrations, and deploys.
- A new on-chain ledger, a sale, or a mainnet deployment.
- Scoring `Credited`, `Withdrawn`, governance swap events, Denylist logs, or Vault logs as points. Denylist logs stay enforcer signals at 0 points where the indexer spec already says so.
- The O1–O5 and A1–A2 reputation ledgers. They keep their own spec. This file does not sum with them.
- Choosing the multi-human threshold. That question stays open in `docs/decision-chain-spec.md`.
