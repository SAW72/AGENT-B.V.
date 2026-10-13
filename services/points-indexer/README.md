# Points indexer

Internal dev notes for the off-chain Base Sepolia ledger. Chain id `84532` only. Chain ids `1` and `8453` are refused. There is no token, no balance that can be transferred, and no UI in this package.

The rules implemented here are the ones in `docs/AGENT-BV-POINTS-SPEC.md` and `docs/reputation/EVENT_MAP.md`. This package does not change contracts.

```bash
cd services/points-indexer
npm test
```

Tests use `fixtures/base-sepolia-logs.json`, a read-only `eth_getLogs` capture. They do not dial a network and they sign only with keys generated inside the test process.

## What it stores

SQLite ledger. A chain-log row is inserted only when all of the following hold:

- The log is not `removed`, and its block number is at or below the finalized head. `safe` is not a commit path. There is no cancel or rewrite of a committed row.
- The wallet comes from the event (`payer`, `payee`, `party`, or `voter`). `transactionFrom` is stored and never credited.
- `VoteCast` counts only when its `disputeId` matches a 3-argument `EscrowDisputed` from escrow `0x3d660502d75f1e97b08c110255921b437a3c4c42` at or after block `47715415`. The panel address is not admitted by its own deploy block.
- `Credited`, `DisputeResolved`, `DisputeOpened`, and the retired 2-argument dispute topic are ignored.
- A server-issued nonce is bound to `(txHash, logIndex, wallet)`. It can be revoked and, after it is consumed, reissued inside the stored issue window. The window is `issue_time <= block_timestamp + 86400` of the bound log. Rebuilds read the stored issue time and the stored revoke. They do not ask the wall clock again.
- `PointsLink` is EIP-712, domain name `Agent-BV Points`, version `1`, chain id `84532`, verifying contract the escrow above. The signature is 65 bytes, low `s`, `r` and `s` non-zero, `r` below the curve order, `v` in `{0, 1, 27, 28}` with `0 → 27` and `1 → 28` before recovery. Anything else, including an ERC-1271 blob, is refused.
- The decision-chain terminal entry is a human with a server-side identity anchor and behavioral signals, and its timestamp is strictly before the log's block timestamp. `accountable_human_id` does not pass that check. An `ai` terminal entry stores the chain and commits no row.
- Checklist #7 is open, so every committed row has `points = 0`, `eligibility_status = unverified`, and `points_withheld = 1`. The row still occupies the unique keys.
- A repeated `escrowId` on `EscrowCreated`, or a repeated `disputeId` on `EscrowDisputed`, is ambiguous. Both copies and every release, refund, or vote that joins that id are skipped. Nothing is credited.
- `PointsLink.nonce` and `PointsLink.logIndex` must be canonical decimal strings (`/^(0|[1-9][0-9]*)$/`) before they are turned into `BigInt`. Hex, a leading minus, an empty string, whitespace, and non-numeric text return `bad_link` and do not throw.
- Live payer, payee, and voter accounts can be EIP-7702 delegated EOAs (`0xef0100` plus a delegate address). This indexer does not read account code. A 65-byte ECDSA signature that recovers to the EOA key is accepted. Contract-code signatures, including ERC-1271 blobs that are not 65 bytes, stay refused.

`config/arbitrator-register.json` is the off-chain human/AI register. It ships empty. A matched vote stays `pending` with points 0 until that voter is registered. An `ai` registration stores the row and does not count it toward `return_day`. A `human` registration still stores points 0 while the vote weight is unset. A configured vote weight above 0 is what makes a human vote count toward `return_day`. That check is separate from the #7 zero.

Numeric weights and the farming gates (`same_pair_per_day`, `same_pair_lifetime`, `min_escrow_amount_wei`, `min_escrow_duration_seconds`) stay null until set. A null gate is not applied.

## Keys

```text
UNIQUE (wallet, action, utc_day)
UNIQUE (chain_id, contract, tx_hash, log_index)
  WHERE action IN ('fund', 'release_or_refund', 'dispute_open_or_vote')
UNIQUE (wallet) WHERE action = 'first_activity'
UNIQUE (wallet, utc_day) WHERE action = 'return_day'
```

`log_index` and `block_number` are `NOT NULL` on every row, including derived rows. `wallet`, `contract`, and `tx_hash` are lowercase `0x` hex. `utc_day = floor(block_timestamp / 86400)`. `00:00:00Z` is the new day. Ingest time is not the day.

`first_activity` is the derived one-per-wallet row. The spec renamed the earlier name. Its chain-log columns are copies of the source row, and `source_action` names that row. `return_day` uses the same copy rule. Neither derived action is inside the chain-log unique index, so the copy does not collide with the source.

A full rebuild deletes `ledger_rows` and replays raw logs, chains, nonce records, links, origins, the register, and the gates. Replay of the same log does not insert a second raw row or a second credit.

## QA notes

- M-1. Finalized-only. A log above the finalized head is withheld. A `removed` log is skipped. There is no safe-row cancel path, because a safe log is never committed.
- M-2. The derived-row indexes are the ones in the spec, under the name `first_activity`. A partial index of `action <> first_activity` would also cover `return_day` and would reject the return-day copy of the source key. The spec's `IN (...)` list is the one created here.
- M-3. The EIP-712 domain, the struct, and the nonce binding are implemented as above, including revoke and reissue. Tests sign with process-generated keys only.
- M-4. `docs/reputation/EVENT_MAP.md` already says release is payer-only while Open and payer or payee while Disputed, and that refund is the permissionless path. This package follows that wording. It does not edit that file.
- L-1. The chain belongs to the credited wallet. A refund whose `transactionFrom` is the claim relayer still requires the payer's chain.
- L-2. `wallet`, `contract`, and `tx_hash` are lowercased before the key is written.
- L-3. UTC day is `floor(block_timestamp / 86400)`. A second `release_or_refund` for the same wallet on that day is not deferred.
- L-4. Walk order is `(block_number, log_index)`, including when the raw logs arrive shuffled. A zero-point escrow row still counts as a `first_activity` source. A log that was not stored does not.
- L-5. The derived action is `first_activity`.
- L-7. A `VoteCast` whose `disputeId` matches only a retired escrow is not counted.
- N-1 through N-9. Expiry and the issue window are compared to the bound log's block timestamp. Confirmation time is not. Rebuilds read stored nonce records. A vote with unset weight does not produce `return_day`. An escrow row at points 0 does.
- P-2. `dispute_open_or_vote` stays one action. Splitting it is still open in the spec.
- Checklist #9, the O1–O5 reputation ledger, and any dashboard are out of scope. Flags do not write a negative point. No contract, key, or deploy is part of this package.

## Ambiguities resolved

- The idempotency key `(chain_id, contract, tx_hash, log_index)` applies to chain-log actions. Derived rows copy those columns and are excluded by the partial index, with their own unique keys, and they point at the source through `source_action` plus the copied key.
- `return_day` for a vote follows the configured vote weight and a `human` register entry, not the stored points column. Stored points stay 0 while checklist #7 is open, including when the weight is set. `VoteCast` does not start `first_activity`, so that later day still requires an earlier stored escrow-log row for the same wallet.
- A nonce is consumed only when a chain-log row is inserted or when it is revoked. A cap or gate miss leaves the nonce open. A second open issue for the same key is refused by a partial unique index. After a confirmed row exists, a later nonce can be issued and its link does not add a second row. Rebuild writes the final nonce status and does not reopen a confirmed nonce in the database while another nonce for that key is open. If a replay would leave two open nonces, the latest issue stays open and the earlier one is revoked.
- The latest stored chain for `(wallet, action, escrow id)` is the one rebuild evaluates. A blocked chain is still stored.
