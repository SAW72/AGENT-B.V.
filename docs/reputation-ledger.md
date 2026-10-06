# Reputation ledger (Base Sepolia)

Status: **draft for build and staging**. Spencer has not approved design note v2.2. This pull request stays a draft and must not be merged. Nothing here is a token, a claim, or a mainnet path.

The rules are design note **v2.2** (Tokenomics, 26 Sep 2026, 3:47 PM ET). v2.2 supersedes v2.1. Section 12 wins wherever it conflicts with sections 1 to 11. `rule_version` is `design-v2.2`. `config_version` is `sepolia-draft-1`. The ledger ids stay `agent-bv-sepolia-reputation` and `agent-bv-sepolia-arbitrator-rep`.

Event layouts, start blocks, and the draft numbers follow Blockchain Builder's draft [PR #28](https://github.com/SAW72/AGENT-B.V./pull/28) (`docs/reputation/EVENT_MAP.md`, `docs/reputation/INDEXER_SPEC.md`, `config/reputation/sepolia.json`). That PR is not modified by this change and is not on `main`. This service recomputes topic0 locally. Differences from that config are listed under "Differences from PR #28".

Contract names and addresses are unchanged. Stranded / GasRescue is not read and is not credited. The display name and the first-mention title are `product.name` and `product.title` in `config/reputation/sepolia.json`, the only authored copy. After the first mention, use `product.name`. Ledger ids are separate and do not change with the display name.

## Architecture

The ledger is a pure function of:

1. Logs from the three scoring contracts on chain id **84532** only, plus Denylist logs used as enforcer signals with zero points (see open question 1).
2. The versioned config in `config/reputation/timeline.json`.
3. The version-controlled adjustments file `config/reputation/adjustments.json`.

`replayLedger` in `claim-relayer/reputation/replay.mjs` folds those inputs into two ledgers:

| Ledger | Contents |
| --- | --- |
| `agent-bv-sepolia-reputation` | O1–O5 and usage ADJ |
| `agent-bv-sepolia-arbitrator-rep` | A1, A2, and arbitrator ADJ |

They are never added together, including in API objects. There is no `total`, `combined`, or `sum` field.

There is no durable store. Render's filesystem is ephemeral and a cold start drops process memory, so every read replays the log batch held in memory (empty unless a caller injects one). Replay starts at each contract's deploy block from the config (`start_block`). Logs before that block are dropped. Logs above the caller-supplied `safe` block are not ingested.

Chain id **1** and **8453** throw `mainnet_refused`. Every other chain id throws `wrong_chain`. A log that carries its own `chainId` is refused the same way. This check is in code, not only in config, so editing the JSON cannot open mainnet.

The read API does not call an RPC. PR #28's 625-block `eth_getLogs` plan is recorded on the config as `scan.max_block_range` for a later worker. There are no business events on chain yet, so this PR does not claim a live scan.

## Event map

Addresses and start blocks (PR #28; Vault and Escrow blocks also appear in `contracts/README.md` and `deployments/base-sepolia.json`):

| Contract | Address | Start block | Role |
| --- | --- | --- | --- |
| Vault | `0x1463D664fA467FBCDA4B05443434494f05e565bc` | 47294164 | O1 |
| BotAttestationEscrow | `0x3d660502D75f1e97b08c110255921b437A3C4C42` | 47715415 | O2, O3, O4 link |
| DisputePanel | `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb` | 47253020 | O4 resolution, O5, A1, A2 |
| Denylist | `0xeE76876bECcFc1B58fC06fF4E654a517d784B224` | 47294163 | Signal only. Zero points. |

Scored signatures and topic0 (keccak256 of the canonical signature, recomputed in `claim-relayer/reputation/codec.mjs` and checked against PR #28):

| Event | Canonical signature | topic0 | Indexed | Not indexed |
| --- | --- | --- | --- | --- |
| `OperatorSet` | `OperatorSet(bytes32,address)` | `0x9efccfdeeb35d36624f8546b14ab72aa768151985ee15f2f7dfce288348baaa3` | botId, account | — |
| `EscrowCreated` | `EscrowCreated(bytes32,address,address,bytes32,bytes32,uint256,uint256)` | `0x9d605e83d5554e0f88f697fe6184e9d0616163c141daf3ba689299e334a285c1` | escrowId, payer, payee | payerBotId, payeeBotId, amount, expiresAt |
| `EscrowReleased` | `EscrowReleased(bytes32,uint256)` | `0x9410e7c5b50451e4b5bd5ce113fd48abebd7070eb9d080df08b115b7cdc41650` | escrowId | amount |
| `EscrowRefunded` | `EscrowRefunded(bytes32,uint256)` | `0x21cabc2fff910e5afd1e2bcb22ff2b165a41ab0afbaf364f07aaf2f7787fb908` | escrowId | amount |
| `EscrowDisputed` | `EscrowDisputed(bytes32,bytes32)` | `0xcd4243485a48c9b2bc0e6ac4133f40bcac2bc94a0807c72c2dc2d60e023d2995` | escrowId | disputeId |
| `DisputeOpened` | `DisputeOpened(bytes32,bytes32,address)` | `0xff7eb321cb9f047b29ab55a1eaab2dbd40f73e1ec2b34cf847246a5ea1b0b535` | disputeId, subjectHash | challenger |
| `VoteCast` | `VoteCast(bytes32,address,bool)` | `0x8b40665146691327ee30f5bf56e9b2d6f445d2830d3b09b56385cd30f630ecfb` | disputeId | voter, support |
| `DisputeResolved` | `DisputeResolved(bytes32,bool)` | `0x6309d9f2499864a4f9d4ddb22f2b493afde8c215a1cd2e178647596cffe2efa4` | disputeId | upheld |

`EscrowDisputed.disputeId`, `VoteCast.voter`, `VoteCast.support`, and `DisputeOpened.challenger` are not indexed. The decoder reads them from log data.

Also decoded, never turned into points:

- `Burned(bytes32,uint256)` on Vault. Enforcer signal `BOT_BURNED`. Used by the O1 active check. It does not create points.
- `Registered(bytes32,uint8,uint256)` on Vault. It does not create a row by itself. O1 reads the `uint8` tier from the latest `Registered` at or before the first `OperatorSet`. `Vault.Tier` is None 0, Chat 1, DataTools 2, Financial 3, Critical 4.
- `Listed` / `Unlisted` on Denylist. Enforcer signals. `Listed.id` is a fingerprint, not a bot id. This replay does not call `Vault.bots()`, so it does not join a listing to a bot. The indexed `bucket` is validated by `claim-relayer/denylistBucket.mjs`: only Exact `0`, Signature `1`, and Prompt `2` are valid. Until L-4 ships, the live Sepolia Denylist maps any other value onto Prompt. This service does not. `encodeEventData` rejects an out-of-range bucket before it writes topics. A decoded out-of-range bucket is the review-only signal `DENYLIST_INVALID_BUCKET` and is not a Prompt listing. Claim calldata does not call `remove`, `listing`, or `everListed`.

Ignored on purpose (unknown topic0 is skipped, not fatal):

- `AccessGranted` (a view, absent from live bytecode, per PR #28).
- Ownership events.
- Retired escrow `VaultUpdated(address)` topic `0x161584aed96e7f34998117c9ad67e2d21ff46d2a42775c22b11ed282f3c7b2cd` and `DisputePanelUpdated(address)` topic `0x9d75f31e9d9860ecb2dbb146498bd73b67bd0a905f7670417df7b935a6ce3998` (contract `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c`, start block 47299930). The live escrow `0x3d660502D75f1e97b08c110255921b437A3C4C42` (start block 47715415, commit `7fe4a863e9bce0b70b629dab76ddd2728c97b536`), the retired ESC-M-1 escrow `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` (start block 47345163, commit `444c427`), and `main` emit the 4-field shapes `VaultUpdated(address,address,address,uint256)` topic `0x98bd850118a3b2adf2899b547ed110d0a68397fc64ca0b49a55802aeb08a385d` and `DisputePanelUpdated(address,address,address,uint256)` topic `0xf784fa686c25e5a523a9c6576fc20a1e0a5fc05d3f15b235d9d6d78ef8609758`. Neither shape is a reputation rule. A fixture with either topic does not throw.
- `Denylist.check` is a view and has no log. It credits nothing.

`EscrowCreated` has no `createdAt`. The create-block timestamp is the block timestamp on that log. `expiresAt` is the event field. Set duration is `expiresAt` minus that timestamp.

The resolving vote's transaction emits `DisputeResolved` and then `VoteCast` (log index n, then n+1). Scoring walks the whole log set, so that vote is not missed.

### Uncertainties

- PR #28 measured the DisputePanel deploy block as **47253020**. It is not in `deployments/base-sepolia.json`. This service uses 47253020 because that map is the indexer spec we were asked to follow. If Builder revises it, change `contracts.dispute_panel.start_block` only.
- Finality lag of about 21 minutes is Builder's measurement, quoted by Tokenomics as unverified. This code does not assume a duration. The caller passes `safeBlock` and `finalizedBlock`.
- PR #28's scan through block 47341332 found only deploy, ownership, wiring, and seat logs on DisputePanel, Vault, Denylist, and the pre-ESC-M-1 escrow. That scan is before the retired ESC-M-1 deploy block 47345163 and before the live escrow deploy block 47715415, so this service does not claim a scan of the live escrow. Ordering is from source, not from live transactions.
- `CORE_TIMELOCK` `0x10CC9474b45625ADfd05C209f2518023484878D9` is on the usage exclusion list. Whether the EIP-7702 delegation is intended governance is still for Spencer and BOB. This replay only excludes the address.

## Scoring

Parties for O2, O3, and O4 come from `EscrowCreated`, never from `tx.from`. A missing `EscrowCreated` produces no usage credit for that escrow.

Weights, floors, and caps are read from the config version active at the **completing** log: the latest of the logs that made the outcome true, ordered by `(block_number, log_index)`. A later config version does not rescore an outcome whose completing block is still on the old version.

| Code | Ledger | Nominal points (GUESS) | When |
| --- | --- | --- | --- |
| O1 | usage | 10 to the operator | First `OperatorSet` for a botId. Later sets for that botId credit 0 and write no row. The 5-argument `register` emits `Registered` only, so the credit waits for `OperatorSet`. The tier gate is on by default: the `Registered` tier must be at least Financial (3). A missing registration scores 0. Turning `gates.o1_tier_gate.enabled` off skips that check. A `Burned` log at or before that `OperatorSet` block scores 0 once the O1 row is final. While the row is still provisional the burn does not zero it. A burn in a later block does not claw a final O1 back. |
| O2 | usage | 5 payer and 5 payee | `EscrowReleased`, no `EscrowDisputed` anywhere in the log set for that escrowId, amount at least the floor, release timestamp at least 300 seconds after create. |
| O3 | usage | 1 payer, 0 payee | `EscrowRefunded`, never disputed, set duration at least 3600 seconds, same amount floor. The 0 payee weight writes no row. |
| O4 | usage | 2 payer and 2 payee | `EscrowDisputed`, `DisputeResolved`, and `EscrowReleased` or `EscrowRefunded` all exist. Those three may arrive in any order. `EscrowCreated` must be in a strictly earlier block than `DisputeOpened`. The same block, a later create, or a missing `DisputeOpened` scores 0 for both parties and flags `DISPUTE_PREDATES_ESCROW`. The amount floor and the 300 second gap do not apply. Both parties are credited, including the side the panel ruled against. |
| O5 | usage | 0 | `DisputeOpened` whose subject is not an escrow in this log set, or whose subject escrow is terminal and was never linked by `EscrowDisputed`. Status stays `provisional`, because a later escrow can still be created. If a later `EscrowDisputed` links it, the O5 row drops and the escrow is scored under O4, including the block-order rule. |
| A1 | arbitrator | 3 per vote | `VoteCast` on a dispute that is both resolved and linked through `EscrowDisputed`. The same block-order rule as O4 applies. A voter who is that escrow's payer or payee scores 0. |
| A2 | arbitrator | 0 by default | Same vote when `support == upheld` and the config weight is above 0. The checked-in weight is 0, so no A2 row is written until the weight is raised. The block-order rule and the party rule apply when the weight is above 0. |
| ADJ | either | negative or zero | Manual file only. |

An escrow that is both released and refunded in a fixture keeps the earlier terminal log. One escrow id produces one outcome. O2 and O3 are impossible once `EscrowDisputed` is present, even if that log is ordered after release. On the real contract a release leaves the escrow unable to be disputed; the stricter "ever" check is what the tests lock.

Parties for O2, O3, and O4 are the `EscrowCreated` payer and payee. Replay never reads `tx.from`. Addresses on `excluded_addresses` score 0 on the usage ledger, including when one of them is the operator, payer, or payee. The arbitrator ledger is not zeroed by that list, except that a voter who is a party to the escrow scores 0 A1 and 0 A2 on that dispute.

`DISPUTE_PREDATES_ESCROW` and `O5_REPEAT` are review flags. They do not cancel other rows and they do not withhold later points.

### Entry fields

Section 6 fields are on every row: `entry_id`, `ledger`, `chain_id` (always 84532), `wallet`, `bot_id`, `outcome_code`, `points`, `status`, `source_contract`, `event_names`, `tx_hash`, `log_index`, `block_number`, `block_hash`, `block_timestamp`, `escrow_id`, `dispute_id`, `rule_version`, `config_version`, `cancel_reason`, `cancelled_by`.

`points` is the amount that counts. It is 0 when a cap, the eligibility mask, or the enforcer mask applies. `nominal_points` keeps the config weight so a zero row is explainable. `capped` and `cap_name` record the cap. Extra fields `semantic_key`, `eligible`, `eligibility_reason`, `enforcer_withheld`, and `role` are documented extensions.

`entry_id` vs `semantic_key` (flagged for Tokenomics and Builder): section 6 and PR #28 key O2/O3/O4 as escrowId plus outcome code, and the row has a single `wallet`. O2 and O4 credit two wallets, so those rows cannot share one id. `semantic_key` is the spec key (`O2:<escrowId>`). `entry_id` appends the lowercase wallet (`O2:<escrowId>:<wallet>`). Dedup and the once-per-escrow rule use the semantic key. O1 is `O1:<botId>`. O5 is `O5:<disputeId>`. A1/A2 are `<code>:<disputeId>:<voter>`. ADJ is `ADJ:<adjustment_id>`.

`status` is `provisional` when every source log is at or below `safe` and at least one is above `finalized`. It is `final` when every source log is at or below `finalized`. O5 stays `provisional` even after its open log is finalized. It is `cancelled` only when an ADJ names that `entry_id`. A `final` row is not rewritten except by that ADJ.

Off-chain ADJ rows use the zero address and the zero hash, `log_index: null`, and `event_names: ["ADJ"]`. They are not chain logs.

## Caps and the day

All of these live in `config/reputation/sepolia.json` under `points`, `floors`, `caps`, and `flags`. Each value is marked GUESS. `caps._label` is `DRAFT/GUESS`. The scorer has no copy of the numbers.

| Cap | Default | Applies to |
| --- | --- | --- |
| Usage points per wallet per day | 20 | O1–O4 |
| Usage points per botId per day | 20 | O1 uses the bot. O2/O4 payer uses `payerBotId`, payee uses `payeeBotId`. O3 uses `payerBotId`. |
| Counted escrows per wallet per day | 5 | O2 and O3 only. O4 is outside this cap. |
| O3 per wallet per day | 1 | O3 |
| O4 per wallet per day | 1 | O4, per wallet |
| Pair per day / lifetime | 2 / 10 | O2, O3, and O4. Ordered pair `payer\|payee` (A pays B is not B pays A). Counted once per escrow, only if at least one wallet actually receives points. |
| Usage points per wallet per season | 500 | O1–O4 |
| Arbitrator points per day | 30 | A1 and A2 together |
| O5 window | 3 standalone disputes in 7 UTC days | Flag only |

**Day** (decided by Tokenomics): a day is the UTC day of `block_timestamp`, index `floor(block_timestamp / 86400)`, resetting at 00:00:00 UTC. The timestamp is the completing log's `block_timestamp`, including when a later log is what makes the outcome true. Wall-clock time is not used.

**Season** (v2.2 Q6, still a GUESS): 90 UTC days (`caps.season_length_days`). Season 1 starts at `caps.season_start_block` and `caps.season_start_timestamp`, both null until go-live after Spencer's GO. If either is null, or the completing block is before the start block, or the timestamp is before the start timestamp, the 500 point season cap does not apply. When both are set, `season_index = floor((block_timestamp - start_timestamp) / (length_days * 86400))` and the cap key is `season-${index + 1}`. A new season gets a fresh 500. Cancelling a row does not refund cap headroom.

An over-cap candidate is stored with `points: 0`, `capped: true`, and `cap_name` set to the config key that bound (PR #28 section 9). The full nominal amount must fit. Remainders are not clipped. Caps are applied in canonical `(block_number, log_index)` order (decided by Tokenomics), then outcome (A1 before A2 on the same vote), then role (payer before payee).

## Dedup and reorgs

Raw delivery dedup is `(block_hash, log_index, address)`.

Semantic dedup is the entry id plus a block-hash check, not `(tx_hash, log_index)` alone:

- The same transaction hash seen again under a new block hash replaces the previous locator (a reorg re-inclusion, including a new log index).
- A different transaction for an escrow id that already has that event keeps a single outcome (escrow ids are single-use on chain; a fixture must not double-credit).
- Logs with `removed: true` are dropped before scoring, so an orphan plus a canonical re-inclusion produces one row on the canonical block hash.

Each escrow id is counted once whether the submit was wallet-direct or through the claim relayer. The relayer is not a special case: the escrow id is the key.

## Decided by Tokenomics

These five are decided. They are not open questions. Checklist items 7, 9, 11, and 12 stay open: fail-closed hooks are the behavior until those items close, not a substitute for OFAC screening or a named enforcer.

**(a) Adjustments file.** Manual ADJ and cancel rows are not chain logs, so replay cannot invent them. They live in `config/reputation/adjustments.json`, changed only by pull request, and are applied during replay. There is no admin write endpoint. A cancel names `cancels_entry_id`, has `points: 0`, and sets that row to `cancelled`. A slash has negative `points` and no cancel target, and those points count in the balance. Positive ADJ points are rejected. A negative amount combined with a cancel target is rejected as ambiguous. An unknown target fails closed.

**(b) Config timeline.** `config/reputation/timeline.json` lists versions with `effective_from_block`. Replay stamps the version active at the completing block. A later edit does not rescore earlier blocks. The checked-in timeline has one version, `sepolia-draft-1` / `design-v2.2`, from block 0.

**(f) Section 12 scoring.** A2 defaults to 0 and stays configurable. O4, A1, and A2 require `EscrowCreated` in an earlier block than `DisputeOpened`. Pair caps include O4. Protocol addresses on the exclusion list score 0 usage points. An arbitrator who is a party scores 0 A1 and 0 A2 on that dispute. O1 requires the bot still active at finality and, by default, tier at least Financial. Seasons are 90 days from the go-live block, and the 500 cap is per season. O5 stays provisional. The 3-in-7-days flag is review only.

**(c) Day.** A day is the UTC day of `block_timestamp`, as in the caps section above.

**(d) Cap order.** Caps run in canonical `(block_number, log_index)` order, as in the caps section above.

**(e) Hooks fail closed.** Checklist #7 and #9 are still open, and the default hooks do not silently credit. See the next section.

## Hooks (fail closed)

Tokenomics confirmed that the #7 and #9 hooks fail closed. PR #28's stub returns `eligible: true` with reason `pending-#7` for staging. **This service does not.** The default eligibility hook returns `{ eligible: false, status: "unverified", reason: "ofac_unconfigured" }`. The row is still stored, `nominal_points` keeps the weight, and `points` is 0 so a raw sum does not credit it. Tests inject `allowAllEligibility` when they need to see weights land.

The enforcer hook receives:

- `O5_REPEAT` when one challenger has at least 3 O5 rows whose UTC days fall in `[D - 6, D]` (7 days inclusive). v2.2 Q2: the default returns `withhold_wallet: false` with reason `review_only`. It does not zero later rows.
- `DISPUTE_PREDATES_ESCROW` when O4, A1, or A2 fail the block-order rule. One flag per dispute. `withhold_wallet` is forced false. Other rows are left alone.
- `BOT_BURNED`, `DENYLIST_LISTED`, `DENYLIST_UNLISTED`, and `PAIR_CAP`. The default records them and does not withhold. Listings are not joined to bots. This replay does not call `Vault.bots()`.

ADJ rows bypass both masks so a cancel still applies while #7 and #9 are open.

Disclaimer links (#11) are `disclaimer_links` in the config. Empty slots are returned as `null` until Lawyer fills them. The read API always returns the slots inside `disclaimer.links` and this line as `disclaimer.text`:

> Testnet only. Not a token. Can't be transferred, sold, or redeemed. May be adjusted or cancelled, and may never convert to anything.

The default eligibility hook reports API `eligibility.status` `"unverified"` and `points_withheld: true`. That is the same fail-closed mask (`eligible: false`, reason `ofac_unconfigured`): rows are stored and `points` is 0. `allowAllEligibility` is a test hook that reports `status: "eligible"` and `points_withheld: false`. If the enforcer has withheld that wallet, `points_withheld` is true even when the eligibility hook would otherwise allow the row.

## Read API

Mounted on the existing claim relayer. `POST /v1/claims` auth is unchanged (`CLAIM_API_SECRET`, `x-claim-secret` or Bearer, fail-closed 503 when unset in live mode). Reputation GET routes use their own CORS policy (`REPUTATION_CORS_PAGES_ORIGIN`, `REPUTATION_CORS_PREVIEW_HOST`, `REPUTATION_CORS_LOCAL_HOSTS`). The default allows `https://agent-a-wallet-ux.pages.dev`, one-label preview hosts under `*.agent-a-wallet-ux.pages.dev`, and `http://localhost` / `http://127.0.0.1` on any port. It does not allow `*.pages.dev` and it does not set credentials. `CORS_ORIGINS` for claim routes is not widened.

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/v1/reputation/config` | None. Registered before `/{address}` so `config` is never parsed as an address. |
| GET | `/v1/reputation/{address}` | None. Rate limited (60/minute/IP, in memory, reset on cold start). |
| GET | `/v1/reputation/{address}/history` | Same. |

`chainId` defaults to 84532 when omitted. Any other value is 400 and the body has no ledger data. `1` and `8453` are `mainnet_refused`. The address must match `^0x[0-9a-fA-F]{40}$` and is lowercased for the lookup and the `address` field. An unknown address is 200 with zeros, not 404.

Balance `ledgers.usage` and `ledgers.arbitrator` each carry `ledger`, `final`, and `provisional`. There is no combined total and no USD, ETH, or token field. `eligibility` is `{ status, points_withheld }`. `indexed_to_block` is the safe head supplied to replay (null before any head is loaded). `indexed_to_block_timestamp` is the timestamp of the newest ingested log at or below that head, or null. `finalized_block` is the finalized head. `disclaimer` is `{ text, links }`.

History requires `ledger=usage` or `ledger=arbitrator`. `limit` defaults to 25 and caps at 100. `cursor` is opaque. Items are section 6 fields only, sorted by `block_number` descending, then `log_index` descending. An unknown address returns `items: []`.

`GET /v1/reputation/config` returns the active caps and thresholds, including `season_length_days`, `season_start_block`, and `season_start_timestamp`. While checklist #12 is open each value has `status: "draft"`, and the body has `status: "draft"`, `config_version`, and `rule_version`. `day_boundary` is the machine value `utc_day_by_block_timestamp`.

Example responses, labeled as example data and not a live scan, are in `claim-relayer/fixtures/reputation/`.

Copy does not use "reward" or "earn". Any method other than GET or OPTIONS on these paths is 405. There is no write or admin route.

## Checklist (Lawyer's dozen)

| # | Item | How this code treats it |
| --- | --- | --- |
| 1 | No public BVT supply promise. Points never convert. | No supply field, no conversion route. Disclaimer says points may never convert. Locked for this sprint. |
| 2 | QA / testing / reputation framing. No "reward" in headlines or buttons. | API labels and the disclaimer use that framing. A test rejects `reward`, `earn`, `earnings`, `apy`, `yield`, and `allocation` in the JSON. Live UI still needs Lawyer's pass. |
| 3 | No purchase. Points are not bought or sold. | Read-only API. No fee, list, or register route priced in points. |
| 4 | Stranded fee credits are N/A. | No Stranded or GasRescue reads or writes. |
| 5 | No public TGE or airdrop calendar. | No such fields. |
| 6 | Non-transferable and cancellable. No property right. | No transfer surface. ADJ file can cancel. Disclaimer states it. |
| 7 | OFAC / sanctions before soft launch. **Open.** | `eligibility` hook. Fail closed, as Tokenomics decided: every row is not eligible and `points` is 0 until a real screen is plugged in. |
| 8 | A later claim needs its own terms. Points are not a claim. | No reputation claim or redeem route. The existing `POST /v1/claims` path is the escrow relayer and is unchanged. |
| 9 | Name the sybil / abuse enforcer and write the policy. **Open.** | `enforcer` hook. Owner is not named, so flags do not auto-cancel. `O5_REPEAT` and `DISPUTE_PREDATES_ESCROW` are review only. Burns and listings are signals. Cancels are ADJ. Checklist #7 stays fail closed. |
| 10 | No cross-product dashboard and no summed ledgers. | Two objects. Tests reject a combined key. |
| 11 | Securities, master, AS IS, and not-investment links. **Open.** | `disclaimer.links` from config. Empty slots are `null` until the links exist. |
| 12 | Lock caps before soft launch. **Open.** | Section 7 numbers in `config/reputation/sepolia.json`, labeled `DRAFT/GUESS`. `GET /v1/reputation/config` returns `status: "draft"` on the body and on each cap and threshold. |

## Differences from PR #28

PR #28 was read and not modified. Keys and defaults match that file except:

| Topic | PR #28 | This service |
| --- | --- | --- |
| `excluded_addresses.entries` role `claim_relayer` | `address: null` until pinned | `0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861` from `deployments/base-sepolia.json` `claimRelayerWallet`, so that wallet scores 0 usage points now |
| Season start | `caps.season_start_block` only, null until go-live | Also `caps.season_start_timestamp`, null until go-live. A 90-day season needs a timestamp. If either is null the season cap does not apply |
| `caps._label`, `display`, `disclaimer_links`, `read_api`, `day_implementation`, `effective_from_block`, `adjustments_file` | Absent | Kept. The read API and the timeline depend on them |
| `product` | `"the product"` | Object with `name` and `title`. `name` is the display name. `title` is the first-mention form. Both live only in this object. |
| `Vault.bots()` | INDEXER_SPEC allows the call as a 0-point fingerprint signal | Not called. Replay stays a pure function of logs. Denylist listings are not joined to bots |
| Cap overflow | Section 9 stores `points: 0` and a capped note as a spec proposal | All-or-nothing, already implemented: `points: 0`, `capped: true`, `cap_name` set |
| Day string | `caps.day_boundary.value` is `UTC day by block_timestamp` | The file matches that string. `GET /v1/reputation/config` still returns the machine value `utc_day_by_block_timestamp` |
| O1 burn | INDEXER_SPEC: no `Burned` at or before the first `OperatorSet` block, checked once final | Same. A later burn does not claw back. The ~21 minute lag is not assumed; the caller passes `finalizedBlock` |

## Open questions

Decided, and not listed here: the adjustments file, the config timeline, UTC day by `block_timestamp`, canonical cap order, fail-closed checklist #7, and design note v2.2 section 12 (A2 default, block order, pair caps on O4, the exclusion list, the party-arbitrator rule, the O1 tier and active checks, 90-day seasons, O5 staying provisional, and review-only flags).

1. Cap overflow stays all-or-nothing. PR #28 section 9 calls `points: 0` plus a capped note a spec proposal. Confirm Spencer wants no clipped remainder.
2. O2/O4 `entry_id` appends the wallet; `semantic_key` is the spec key. Confirm.
3. The claim-relayer exclusion address is filled from the address book. PR #28 and INDEXER_SPEC still say null until pinned. Confirm that wallet is the one to exclude.
4. `season_start_timestamp` is extra. Go-live still needs Spencer to set both the block and the timestamp.
5. No `Vault.bots()` call, so a Denylist fingerprint is not joined to a bot.

## Verification

Offline fixtures only. `claim-relayer` tests encode logs with the same ABI the decoder uses. They do not call a network. Do not treat a green test run as evidence that any contract has emitted a business event.

```bash
cd claim-relayer && npm test
```
