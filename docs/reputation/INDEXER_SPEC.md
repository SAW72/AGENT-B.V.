# Base Sepolia reputation indexer spec

Status: DRAFT spec, docs only. Build and staging only. No indexer code, no deploy, no transactions.
Rules follow the Tokenomics design note v2.2 (2026-09-26). Where v2.2 section 12 conflicts with v2.1, v2.2 wins. Every point value, floor, and cap is a Tokenomics **GUESS** and is loaded from [config/reputation/sepolia.json](../../config/reputation/sepolia.json), never hard-coded. Event details: [EVENT_MAP.md](./EVENT_MAP.md).

Gate: do not merge or run against live data until Blockchain Verifier APPROVE and Spencer's GO via BOB.

## 1. Ledgers

| Ledger | Contents |
|---|---|
| `agent-bv-sepolia-reputation` | Usage outcomes O1 to O5 and ADJ |
| `agent-bv-sepolia-arbitrator-rep` | Arbitrator outcomes A1, A2 and ADJ |

The two ledgers are never summed, in storage, API, or UI. Points are off-chain, Steward-operated, non-transferable, and may be adjusted or cancelled.

## 2. Inputs

- chainId `84532` only. Refuse to start (and refuse any RPC whose `eth_chainId` is not `0x14a34`) on any other chain, explicitly including `1` and `8453`.
- Addresses and start blocks come from config (`contracts.*.address`, `contracts.*.start_block`). Usage and arbitrator points are earned only from Escrow, DisputePanel, and Vault logs on chainId `84532`. Denylist logs and the `Vault.bots()` view are allowed for enforcer signals only, at 0 points, and only from the pinned addresses in config. They are never an earning source.
- Register every topic0 listed in EVENT_MAP.md, including **both** shapes of Escrow `VaultUpdated` and `DisputePanelUpdated` (1-field on the retired escrow `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c`, 4-field on the live escrow `0x3d660502D75f1e97b08c110255921b437A3C4C42`, on the retired ESC-M-1 escrow `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d`, and on `main`). Decode by `(address, topic0)`. Unknown topic0 values are logged and skipped, never fatal. The live escrow indexer start block is `47715415`.
- Block header timestamps (`eth_getBlockByNumber`) are the only time source. Never use wall-clock time or `expiresAt` alone for "created at".

## 3. Log scanning

- `eth_getLogs` with `address = [Escrow, DisputePanel, Vault, Denylist]` and no topic filter, in ranges of **at most 625 blocks** (`scan.max_block_range`). `https://sepolia.base.org` returns HTTP 413 for ranges of 1250 blocks or more. On 413 or timeout, halve the range and retry; never skip a range.
- Start at the lowest configured start block (`47253020`) on first run; resume from the last fully processed block afterwards.
- Two cursors: `safe_cursor` (up to the `safe` tag) and `final_cursor` (up to the `finalized` tag). Nothing past `safe` is ingested.
- Persist every raw log with `(block_number, block_hash, tx_hash, tx_index, log_index, address, topics, data, block_timestamp)`.

## 4. Finality and reorgs

- An entry is `provisional` when all of its source logs are at or below the `safe` block, and becomes `final` when all of its source logs are at or below the `finalized` block. (Design v2.2 cites Builder's measurement of about 21 minutes from latest to `finalized`; not independently verified.)
- On each pass, re-read the canonical block hash for every stored block between `final_cursor` and `safe_cursor`. If a stored `block_hash` is no longer canonical: drop that block's raw logs, set every `provisional` entry derived from them to `cancelled` with `cancel_reason = "reorg"`, rewind `safe_cursor` to the fork point, and rescan. Re-derived entries get the same semantic `entry_id` and are re-inserted as `provisional`.
- `final` entries are never rewritten by the indexer. Only an `ADJ` entry can change them.

## 5. Dedup

- Primary key is the **semantic key** (`entry_id`) plus `ledger`, not `(tx_hash, log_index)`. A reorg can re-include the same transaction at a different logIndex or block, so `(tx_hash, log_index)` alone can double-credit.
  - O1: `botId` + `O1`
  - O2, O3, O4: `escrowId` + outcome code
  - O5 (0 points, flag record only): `disputeId` + `O5`
  - A1, A2: `disputeId` + `voter` + outcome code
- On insert, if an entry with the same key exists: if its `block_hash` is still canonical, skip (idempotent); if not, replace it via the reorg path above.
- `escrowId` is single-use on-chain (`usedEscrowIds`), so each escrow counts once whether it came wallet-direct or through the claim relayer.

## 6. Derived state (rebuilt from events)

- **Escrow record** per `escrowId`: from `EscrowCreated` (payer, payee, payerBotId, payeeBotId, amount, expiresAt, create block number, create block timestamp), plus optional `EscrowDisputed(disputeId)` and a terminal `EscrowReleased` or `EscrowRefunded` with its block timestamp. Ordering is by `(block_number, log_index)`.
- **Dispute record** per `disputeId`: `DisputeOpened(subjectHash, challenger)` including its block number, up to 3 `VoteCast(voter, support)`, optional `DisputeResolved(upheld)`.
- **Operator at block**: for each botId, the ordered list of `OperatorSet(botId, account)` events. The operator of botId at block B is the `account` of the last `OperatorSet` at or before B (by block, then logIndex). Every operator write emits `OperatorSet`, so this is complete. An `eth_call Vault.operator(botId)` at block B is a cross-check only.
- **Fingerprint to botId map** (denylist signals): botIds are enumerable from `Registered`. For each new botId, call `Vault.bots(botId)` once (any block after registration; the hashes are fixed) and index `weightHash`, `behaviorSig`, `promptHash` -> botId. A `Listed(id, bucket, ...)` whose `id` matches maps to that botId, then to its operator via operator-at-block. This read, and Denylist logs, are enforcer signals at 0 points from pinned addresses on chainId `84532`. They are never an earning source.

## 7. Usage rules (ledger `agent-bv-sepolia-reputation`)

Parties for O2, O3, and O4 are always taken from `EscrowCreated.payer` / `.payee`, never from `tx.from` or `msg.sender`, because `release` and `refund` are permissionless. An address on `excluded_addresses` earns 0 usage points, including when it is the operator, the payer, or the payee.

### O1. Bot onboarded (+`points.O1` to the operator; GUESS 10)
- Trigger: the **first** `OperatorSet` ever seen for a botId (the 6-arg `register` emits it in the same tx after `Registered`; the 5-arg `register` sets no operator, so the credit waits for a later `setOperator`).
- Credit `wallet = OperatorSet.account`, `bot_id = botId`, unless that wallet is on `excluded_addresses` (then 0).
- Every later `OperatorSet` for the same botId (rotation) earns 0.
- **Active gate, evaluated when the O1 entry finalizes.** Credit only if there is no `Burned` event for that botId at or before the block of this first `OperatorSet`. A burn at or before that block earns 0. The check waits for finality so a reorg of `Burned` or `OperatorSet` cannot lock the answer early.
- **Tier gate** (`gates.o1_tier_gate`, on by default). When enabled, credit only if the bot's `Registered` tier is at least `min_tier` (GUESS: Financial = 3). Spencer can turn the flag off. The tier number is a GUESS.

### O2. Escrow completed without dispute (+`points.O2_payer` / +`points.O2_payee`; GUESS 5 / 5)
Join `EscrowCreated` -> `EscrowReleased` on `escrowId`. Credit only if all hold:
- no `EscrowDisputed` has **ever** been recorded for that escrowId (a released escrow can no longer be disputed, so this is final at release);
- `EscrowCreated.amount >= floors.min_amount_wei` (GUESS 0.0001 ETH);
- `release_block_timestamp - create_block_timestamp >= floors.o2_min_create_to_release_seconds` (GUESS 300).

### O3. Refund path exercised (+`points.O3_payer`, payee 0; GUESS 1 / 0)
Join `EscrowCreated` -> `EscrowRefunded` on `escrowId`. Credit only if all hold:
- the escrow was **never** disputed (no `EscrowDisputed` for that escrowId). `EscrowRefunded` does not say which path produced it, so any ever-disputed escrow is excluded;
- set duration `EscrowCreated.expiresAt - create_block_timestamp >= floors.o3_min_set_duration_seconds` (GUESS 3600). The contract allows 1 s;
- `amount >= floors.min_amount_wei`;
- at most `caps.o3_per_wallet_per_day` (GUESS 1) per payer wallet per day, and it counts toward `caps.escrows_per_wallet_per_day` (GUESS 5).

### O4. Dispute path completed (+`points.O4_payer` / +`points.O4_payee`; GUESS 2 / 2)
Credit when **all three** exist:
1. `EscrowDisputed(escrowId, disputeId)`;
2. `DisputeResolved(disputeId, ...)` for that same disputeId;
3. a terminal `EscrowReleased` or `EscrowRefunded` for that escrowId.

**Arrival order** applies only to `EscrowDisputed` versus `DisputeResolved`. Either may land first. `dispute()` only needs the panel dispute to exist, so `DisputeResolved` can precede `EscrowDisputed`. Evaluate O4 each time any of the three events for the pair is ingested, and emit the entry when the last one lands. The disputeId-to-escrowId join can also be cross-checked through `DisputeOpened.subjectHash == escrowId`.

**Block order is not free.** O4 counts only when the `EscrowCreated` block number is strictly less than the `DisputeOpened` block number for that disputeId. If `DisputeOpened` is missing, or the escrow was created in the same block or later, both parties get 0 and the enforcer hook receives `DISPUTE_PREDATES_ESCROW` (section 11). That signal does not auto-cancel other entries.

O4 pays both parties, including the side the panel ruled against. That is intended: the points reward finishing the dispute process, not winning it. Paying only the winner would give a counterparty a reason to avoid an honest dispute. The payout is symmetric, capped at `caps.o4_per_wallet_per_day` (GUESS 1) per wallet per day, and it counts toward the same-pair caps (`caps.pair_per_day` GUESS 2, `caps.pair_lifetime` GUESS 10).
- A disputed escrow refunded through the expiry backstop with no `DisputeResolved` earns 0.
- No flagger-specific credit. Parties come from `EscrowCreated`, never from `tx.from`. An excluded address still earns 0.

### O5. Standalone dispute (0 points; stays provisional)
- A `DisputeOpened` whose `subjectHash` is not an escrow, or whose subject escrow is no longer Open without ever having been linked through `EscrowDisputed`. Points stay 0.
- The classification stays provisional: escrowIds are caller-chosen, so a later escrow can still be created and linked. If `EscrowDisputed` later links that disputeId to an escrow, drop the O5 treatment and re-evaluate under O4, including the block-order rule above. A link that fails the block-order rule pays 0 and raises `DISPUTE_PREDATES_ESCROW`.
- Track `DisputeOpened.challenger`. If one challenger has `>= flags.o5_standalone_disputes_threshold` (GUESS 3) standalone disputes within `flags.o5_window_days` (GUESS 7), raise `O5_REPEAT` to the enforcer hook for review only. The flag never auto-cancels points.

## 8. Arbitrator rules (ledger `agent-bv-sepolia-arbitrator-rep`)

Only disputes tied to an escrow through `EscrowDisputed` count. `EscrowDisputed` and `DisputeResolved` may arrive in either order. Every resolved dispute has exactly 3 votes. A1 and A2 use the same block-order rule as O4: the `EscrowCreated` block number must be strictly less than the `DisputeOpened` block number for that disputeId. Otherwise every voter gets 0 and the enforcer hook receives `DISPUTE_PREDATES_ESCROW`.

- **A1** (+`points.A1_per_vote`; GUESS 3): a `VoteCast` on an escrow-linked dispute that resolved and passes the block-order rule.
- **A2** (+`points.A2_match_bonus`; GUESS 0): additionally when `VoteCast.support == DisputeResolved.upheld`. The default is 0 because votes are public as they land, so a match bonus rewards copying earlier voters. Revisit A2 only if commit-reveal voting is added on-chain.
- An arbitrator who is `EscrowCreated.payer` or `EscrowCreated.payee` of the linked escrow gets 0 A1 and 0 A2 on that dispute.
- **Per-transaction scoring.** Score after processing all logs of a transaction, not at the moment `DisputeResolved` is seen: the resolving vote's tx emits `DisputeResolved` at logIndex n and its own `VoteCast` at n+1. When the dispute becomes resolved, score all 3 votes (earlier txs plus the resolving tx). If the `EscrowDisputed` link arrives in a later tx, score then. Arrival order does not relax the block-order rule.
- Cap: `caps.arbitrator_points_per_day` (GUESS 30) per arbitrator per day. Manual enforcer cancel (ADJ) for collusion or missed duties.
- This track pays no BVT, no USD, and nothing from the InsuranceFund. AI can assist or co-seat, but humans stay in Gate B.

## 9. Caps and anti-gaming (checklist #12, all GUESS, config defaults)

Applied in `(block_number, log_index)` order at credit time. The day is the UTC day of `block_timestamp` (`caps.day_boundary`). Spec proposal (not stated in design v2.2): an entry over a cap is stored with `points = 0` and a `capped` note so the history stays explainable.
- Usage points: 20 per wallet per day, 20 per botId per day (GUESS).
- At most 5 counted escrows per wallet per day (O2 plus O3) (GUESS).
- Same payer/payee pair: at most 2 per day and 10 lifetime (GUESS). These pair caps apply to O4 as well as O2 and O3.
- 500 usage points per wallet per season (GUESS). The season is `caps.season_length_days` (GUESS 90). Season 1 starts at `caps.season_start_block`, which stays null until go-live after Spencer's GO.
- No decay in v1.
- Arbitrator ledger: 30 per arbitrator per day (GUESS).
- Slashing: the enforcer cancels points with manual ADJ entries until #9 names an owner and a written abuse policy. O5 repeat flags and `DISPUTE_PREDATES_ESCROW` go to review only and never auto-cancel.

## 10. Ledger entry schema (matches design v2.2 section 6)

| Field | Type | Notes |
|---|---|---|
| `entry_id` | string | Semantic key: O1 = botId; O2/O3/O4 = escrowId + outcome code; A1/A2 = disputeId + voter (+ code) |
| `ledger` | enum | `agent-bv-sepolia-reputation` or `agent-bv-sepolia-arbitrator-rep` |
| `chain_id` | int | Always `84532` |
| `wallet` | address | Credited wallet |
| `bot_id` | bytes32, nullable | Where one applies |
| `outcome_code` | enum | `O1`..`O5`, `A1`, `A2`, `ADJ` |
| `points` | signed int | Negative only for `ADJ` |
| `status` | enum | `provisional`, `final`, `cancelled` |
| `source_contract` | address | |
| `event_names` | string[] | All events joined for this entry |
| `tx_hash`, `log_index`, `block_number`, `block_hash`, `block_timestamp` | | Of the log that completed the entry |
| `escrow_id`, `dispute_id` | bytes32, nullable | Where they apply |
| `rule_version`, `config_version` | string | So caps and weights can change without rewriting history |
| `cancel_reason`, `cancelled_by` | string, nullable | For `ADJ` and cancelled entries |

## 11. Hook interfaces (spec-level stubs only; no implementation in this PR)

All hooks are pure interfaces. Until their checklist item closes, each returns its "pending" default and the entry stays eligible for staging only.

```
// #7 OFAC / sanctions eligibility (OPEN: Lawyer + ops)
interface EligibilityScreen {
  screen(wallet: Address, atBlock: number): { eligible: boolean; reason?: string; provider?: string }
}
// default: { eligible: true, reason: "pending-#7" } in staging; public launch blocked until #7 closes

// #9 Sybil / abuse enforcer (OPEN: Spencer names owner, Lawyer reviews policy)
interface AbuseEnforcer {
  flag(signal: { kind: "O5_REPEAT" | "DISPUTE_PREDATES_ESCROW" | "DENYLIST_LISTED" | "BOT_BURNED" | "PAIR_CAP" | "OTHER"; wallet?: Address; botId?: Bytes32; refs: string[] }): void
  cancel(entryId: string, reason: string, by: string): AdjEntry   // writes an ADJ entry
}

// #11 Disclaimer and AS IS links (OPEN: wired at UI time, Lawyer confirms surfaces)
interface DisclaimerLinks {
  links(): { masterDisclaimer?: Url; bvtSecuritiesDisclaimer?: Url; asIs?: Url; notInvestment?: Url }
}
// the read API returns these slots, empty until #11 closes

// #12 Caps (OPEN: Spencer locks section 9 values)
interface CapPolicy {
  configVersion(): string
  apply(candidate: LedgerEntry, history: LedgerView): { points: number; capped: boolean; capName?: string }
}
```

## 12. Non-goals

- Points are off-chain and non-transferable. No token conversion, no redemption, no claim, no sale, no staking, and no fee payment in points.
- No link to BVT (supply, fee router, staking, or any BVT contract).
- $0 protocol fees; no list, unban, register, or check fees in points or BVT.
- No mainnet. Base Sepolia (84532) only.
- No AI-vs-AI arbitration; humans stay in Gate B.
- No new on-chain ledger contract, no contract change, no redeploy.
- No Stranded / GasRescue data in either direction; no combined dashboards.

## 13. Known limits

- **Flagger identity is not derivable.** `EscrowDisputed` does not log `msg.sender`, and `tx.from` is wrong for smart accounts, EIP-7702 accounts, batched calls, and the claim relayer. Not needed, because flagging is not penalized or credited in design v2.2. Penalizing it later would need `address indexed flaggedBy` on `EscrowDisputed`, which means an Escrow redeploy.
- **No attestation / challenge-window primitive exists on-chain.** "Undisputed completion" is detected positively as `EscrowReleased` with no `EscrowDisputed`, never inferred from elapsed time or silence. An attestation with a challenge window would need a new contract.
- **Immediate release after a pre-resolved upheld dispute** is a contract-level fund-flow question raised with the Smart Contract Auditor. An upheld dispute can let a party move Open to Disputed to Released without waiting for expiry. The indexer does not treat that as a points question: O4, A1, and A2 still require `EscrowCreated` block < `DisputeOpened` block, and a failure there pays 0. The fund flow itself is not solved here.
- No business events exist live yet, so event ordering is verified from source and bytecode only.

## 14. Resolved in design v2.2

Design note v2.2 section 12 closes the questions that were open here. The rules in sections 2 and 6 through 9 are the normative text. Spencer has not given GO. Every number below stays a GUESS until checklist #12 locks.

| # | Ruling |
|---|---|
| 1 | Denylist logs and `Vault.bots()` are allowed for enforcer signals only, at 0 points, from pinned addresses on chainId `84532`. They are never an earning source. |
| 2 | O5 stays provisional at 0 points. A later escrow link is re-evaluated under O4 and the block-order rule. The 3-in-7-days flag is review only and never auto-cancels. |
| 3 | O4, A1, and A2 require `EscrowCreated` block strictly before `DisputeOpened` block. Otherwise both parties and all voters get 0 and the enforcer receives `DISPUTE_PREDATES_ESCROW`. "Any order" covers only `EscrowDisputed` versus `DisputeResolved` arrival. Same-pair caps (GUESS 2/day, 10 lifetime) apply to O4. Immediate release after a pre-resolved upheld dispute is a fund-flow question for the Smart Contract Auditor, not an indexer rule. |
| 4 | O1 credits only if the bot is active: no `Burned` for that botId at or before the first `OperatorSet` block, checked when the entry finalizes. The tier gate is on by default at Financial (3), GUESS, and can be turned off. |
| 5 | `excluded_addresses` earn 0 usage points. The claim relayer address is null until pinned. `CORE_TIMELOCK` `0x10CC9474b45625ADfd05C209f2518023484878D9` is an EOA (with EIP-7702 delegation), not a timelock; to be replaced by TimelockController ([runbook](../runbooks/CORE_TIMELOCK_MIGRATION.md)). The four contract addresses are excluded too. Parties come from `EscrowCreated`, never `tx.from`. An arbitrator who is payer or payee of the linked escrow gets 0 A1 and 0 A2 on that dispute. |
| 6 | The day is the UTC day of `block_timestamp`. Caps apply in `(block_number, log_index)` order. The season is 90 days (GUESS), starting at a config block that stays null until go-live after Spencer's GO. The season cap stays 500 (GUESS). |
| 7 | O4 paying both parties, including the side ruled against, is intended: it rewards finishing the process, and it is symmetric and capped. A2 defaults to 0 (GUESS). A1 stays +3 (GUESS). Revisit A2 only if commit-reveal voting is added on-chain. |

### Still open

- Spencer's GO before merge or any live use. Checklist #7, #9, #11, and #12 are still open. Numeric caps, floors, and points stay GUESS until #12 locks. #9 has no named owner yet, so enforcer flags do not auto-cancel.
- The claim relayer entry on `excluded_addresses` is null until that address is pinned.
- Whether the EIP-7702 delegation on `CORE_TIMELOCK` is the intended governance setup is a question for Spencer and BOB. The indexer only excludes the address.
