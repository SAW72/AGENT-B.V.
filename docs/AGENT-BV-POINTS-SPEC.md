# Agent-BV Points Spec

**Status:** Draft. Docs only. Not announced. No contract change is proposed here.

Points in this spec are off-chain and unpaid. They have no value, no token, and no promise about anything later. The only network is Base Sepolia (testnet). Chain id is `84532`. Mainnet chain ids `1` and `8453` are out of scope.

This file is the points spec for that testnet ledger. It does not announce the program, deploy anything, or change a contract, a config file, or application code. Counsel review called for in `docs/POINTS-PROGRAM.md` and `docs/POINTS-AND-ACCOUNTABILITY.md` still applies before any public announcement.

## Sources

Built only from:

- `docs/POINTS-PROGRAM.md`
- `docs/POINTS-AND-ACCOUNTABILITY.md`
- `docs/decision-chain-spec.md`
- `contracts/BotAttestationEscrow.sol` (event arguments and the functions that emit them)
- `deployments/base-sepolia.json`

Checklist #7, #9, and #12 use the definitions already written in `docs/reputation-ledger.md`, `docs/reputation/INDEXER_SPEC.md`, and `config/reputation/sepolia.json`. Where a fact is not in those files, this spec says **TBD**.

`contracts/BotAttestationEscrow.sol` at the commit named below is the same file as in the tree this spec was written from (`git diff` against `7fe4a863e9bce0b70b629dab76ddd2728c97b536` is empty). Event topic0 values below are keccak256 of the canonical Solidity signature. The `EscrowCreated`, `EscrowReleased`, and `EscrowRefunded` topic0 values published in `docs/reputation/EVENT_MAP.md` match this contract. That map publishes a two-argument `EscrowDisputed` topic0, which this contract does not emit. The three-argument topic0 is recorded below and does not appear in the event map.

## What points are

From `docs/POINTS-PROGRAM.md` and `docs/POINTS-AND-ACCOUNTABILITY.md`:

- Points record activity that already happened. They are post-facto only.
- There is no purchase, no referral bonus, and no holding requirement.
- No token is minted during the points phase. `deployments/base-sepolia.json` has `BVT.address` set to `null`. No dollar amount is attached to a point.
- The existing disclaimer line in `docs/reputation-ledger.md` is the posture of this ledger: "Testnet only. Not a token. Can't be transferred, sold, or redeemed. May be adjusted or cancelled, and may never convert to anything."
- This spec has no conversion rate, no allocation table, and no later redemption. The illustrative TGE tables in `docs/POINTS-PROGRAM.md` are outside this spec.

The read-only dashboard rule in `docs/POINTS-PROGRAM.md` still stands: enter a wallet address, see points by category and rank. No login, no sign-up, no connect-wallet button. This spec does not add a dashboard.

## Where the events come from

Count logs from one contract only:

| Field | Value |
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

Linked panel, named here only because the vote gap needs a candidate source: `DisputePanel` at `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb`. The deployment record says Gate B is seated and `arbitratorCount` is 3. Voting logs are not points sources until the gap in "Known gaps" is closed.

## Events that can count

Only these four events on the live escrow can become points. Anything else the contract emits is ignored for points, including `Credited`, `Withdrawn`, `DenylistUpdated`, `VaultUpdated`, and `DisputePanelUpdated`. `release` emits both `EscrowReleased` and `Credited`. `refund` emits both `EscrowRefunded` and `Credited`. Counting `Credited` as well as the release or refund event would record the same settlement twice. `Credited` is not a points event.

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

`docs/reputation/EVENT_MAP.md` still documents `EscrowDisputed(bytes32 indexed escrowId, bytes32 disputeId)`, topic0 `0xcd4243485a48c9b2bc0e6ac4133f40bcac2bc94a0807c72c2dc2d60e023d2995`, and says the flagger is not logged. That two-argument topic0 matches a signature this contract does not emit. Logs for the live escrow have to be filtered with the three-argument topic0 above. `party` is the flagger argument. No contract edit is requested to reconcile the event map. See "No contract change".

## Actions

Point weights are **TBD**. This spec does not copy the rubric in `docs/POINTS-PROGRAM.md` (verification run 10, attestation 50, integration 100, bug bounty 100–500, mirrored point). Those are different actions. It also does not copy the GUESS weights in `config/reputation/sepolia.json`.

The `action` value stored in the ledger is one of the strings in this table. That string is the `action` column of `UNIQUE(wallet, action, utc_day)`.

| Action | What satisfies it | Wallet | Weight |
|---|---|---|---|
| `first_connect` | No event. See known gaps | **TBD** | **TBD** |
| `fund` | `EscrowCreated` | `payer` | **TBD** |
| `release_or_refund` | `EscrowReleased` or `EscrowRefunded` | Create-time `payee` on release. Create-time `payer` on refund | **TBD** |
| `dispute_open_or_vote` | `EscrowDisputed` today. A vote cannot satisfy it until the vote gap closes | `party` for an open. Vote wallet is **TBD** | **TBD** |
| `return_day` | Derived. Not an event | The wallet whose activity was counted | **TBD** |

`release_or_refund` is one action. A release and a refund for the same wallet on the same UTC day share one slot. The row the server commits first keeps the slot. The other insert fails the unique constraint and credits nothing.

`dispute_open_or_vote` is one action, same daily slot. Dispute open is defined. Vote is not, so a vote does not fill the slot. Splitting open and vote into two action strings is **TBD**. They are different addresses in the contracts that exist today: `EscrowDisputed.party` is the payer or payee, and `VoteCast.voter` on the panel is an allowlisted arbitrator.

## Known gaps

These are empty on purpose.

### Vote

`BotAttestationEscrow` has no vote event. `EscrowDisputed` carries `escrowId`, `disputeId`, and `party`. It does not carry a voter, a support bit, or a tally.

Candidate source, not adopted: `DisputePanel` `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb` already emits

```solidity
event VoteCast(bytes32 indexed disputeId, address voter, bool support);
```

Topic0 `0x8b40665146691327ee30f5bf56e9b2d6f445d2830d3b09b56385cd30f630ecfb`, which is the hash published in `docs/reputation/EVENT_MAP.md`. `voter` is not indexed. `vote` allows only a seated arbitrator, once per dispute, while the case is unresolved. The third vote also emits `DisputeResolved`. `docs/reputation/INDEXER_SPEC.md` already scores `VoteCast` on a separate arbitrator ledger and says humans stay in Gate B. That scoring is not this ledger. Whether `VoteCast` fills `dispute_open_or_vote` here is **TBD**.

`DisputeOpened.challenger` is not a substitute for `party` or for `voter`. On a case opened by `dispute`, the challenger is the escrow contract.

### First connect

No event is named `connect`. Two candidates, neither chosen:

1. An off-chain signal. The signal itself is **TBD**. The dashboard in `docs/POINTS-PROGRAM.md` has no connect-wallet button, so a dashboard connect is not that signal.
2. The wallet's first `EscrowCreated`. Which side counts (`payer`, `payee`, or either) is **TBD**.

If candidate 2 is chosen, that `EscrowCreated` already has a transaction hash. The rule that each `tx_hash` is credited once then collides with `fund` on the same transaction. How one transaction can be both `first_connect` and `fund` is **TBD**. Until that is decided, `first_connect` credits nothing.

### Return days

Return days are derived from activity on distinct UTC days. They are not an event.

A `return_day` row uses the server-assigned `utc_day` of qualifying activity for that wallet. Qualifying activity means a row this ledger has already committed for that wallet on that UTC day. Whether the wallet's first active UTC day is itself a return day is **TBD**. The point weight is **TBD**. `UNIQUE(wallet, action, utc_day)` already allows at most one `return_day` row per wallet per UTC day.

## Ledger and daily cap

The ledger is append-only. The server is the only writer.

Daily cap, per wallet: one committed row per action per UTC day.

```text
UNIQUE (wallet, action, utc_day)
```

Each `tx_hash` is credited once. A non-null `tx_hash` appears on at most one row. A row with no chain transaction (`first_connect` if the off-chain candidate is ever chosen, and `return_day`) stores a null `tx_hash` and is limited by the unique triple above. A client cannot supply a hash that occupies the non-null rule.

Columns this spec requires:

| Column | Who writes it |
|---|---|
| `wallet` | Server, from the event mapping above. Stored lowercase, the same address rule as the reputation read API in `docs/reputation-ledger.md`. **TBD** for `first_connect` |
| `action` | Server, one of the five action strings |
| `utc_day` | Server. UTC calendar day. Never a client field |
| `tx_hash` | Server, from a log it read, or null when the action has no transaction |
| `chain_id` | Server. `84532` only |
| `source_contract` | Server. The live escrow address, or null when the action has no escrow log |

Further columns (bot ids, `escrow_id`, `dispute_id`, `log_index`, `block_number`, point weight, decision-chain reference) are **TBD**.

Time is set by the server.

- A client-supplied `tx_hash`, timestamp, `utc_day`, or wallet is not a credit.
- For a row backed by an escrow log, the server reads the log from chain id `84532` on `0x3d660502D75f1e97b08c110255921b437A3C4C42` at or after block `47715415`, and sets `utc_day` from that log's block-header timestamp. `docs/reputation/INDEXER_SPEC.md` already says block-header timestamps are the only time source for chain logs, and `docs/reputation-ledger.md` defines a day as the UTC day of `block_timestamp`.
- For an off-chain `first_connect`, there is no block timestamp. If that candidate is chosen, the server's UTC clock at the time it accepts the signal is the time source. The signal is **TBD**, so this clock is unused until then.
- A removed log is not a credit. How a reorg that re-includes activity under a new transaction hash interacts with "each `tx_hash` is credited once" is **TBD**.

The cap is enforced atomically. The unique check and the insert are one database transaction. On conflict the transaction rolls back. No second row is written, and no partial point amount is written. The failure mode is closed: the extra activity does not become points.

The same closed failure applies when the server cannot verify the log on the pinned contract and chain, when `chain_id` is not `84532`, when the contract address is a retired escrow, or when the client is the only source of the hash or the time.

Checklist #12, below, is still open. The unique triple is the daily cap this spec defines. It is not a locked numeric weight.

## Decision chain: proved on Agent-BV first

The accountability layer is the decision chain in `docs/decision-chain-spec.md` and section 6 of `docs/POINTS-AND-ACCOUNTABILITY.md`. A badge is a label on that chain. The chain is the record.

Agent-BV is where that layer is proved first. `docs/POINTS-AND-ACCOUNTABILITY.md` section 5 says STRANDED, RAT Score, and any other partner count AI-assisted activity only after Agent-BV has issued a human-verified attestation with the decision chain attached. Those programs do not decide human versus AI. Agent-BV does, and this ledger is the first points record that withholds credit when the chain fails.

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

Order is fixed: proposer, then each reviewer, then the terminal approver. A missing, reordered, or unsigned chain is rejected. Every chain, approved or blocked, is stored in full. The foreign key from a points row to that stored chain is **TBD**. The points row does not replace the chain log.

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

If the terminal approver is `ai`, Agent-BV already blocks the action and logs the full chain. The points consequence, which is the proof on this ledger, is that no points row is committed. A signature added after the escrow transaction is a confirmation, not prior authority, so a chain attached after the log does not make the log eligible. If the escrow was called outside the block and the log exists anyway, the points writer still commits nothing.

The badge when the check passes is `Human-instructed`: a verified human approved before execution. `Bot-instructed` means every actor is `ai`. That badge is allowed only inside a non-financial scope, so it does not authorize a credit for these four events. `Human` by itself does not authorize fund movement. `Trusted` and `Not trusted` are labels on a scenario-library result. None of the badges is an action in the table above, and none of them has a point weight.

`accountable_human_id` does not pass step 3. The person who is notified is not, by that field, the person who was allowed to approve.

Whether `first_connect`, `return_day`, or a future vote credit needs the same chain is **TBD**. `VoteCast` does not carry decision-chain fields. `docs/reputation/INDEXER_SPEC.md` says AI can assist or co-seat and that humans stay in Gate B. That sentence is the existing human rule for the panel. It is not a chain entry.

Whether large transfers need more than one human signature is undecided in both source specs. This spec sets no dollar threshold and no signature count above one.

The escrow contract does not read the chain. The check lives in the points writer. That split is intentional and is restated for Blockchain Builder under "No contract change".

## Checklist #7 — OFAC screening

**Open.** Definition from `docs/reputation-ledger.md`: OFAC / sanctions before soft launch. The `eligibility` hook fails closed, as Tokenomics decided. Every row is not eligible and `points` is 0 until a real screen is plugged in.

The running definition in that same doc, which this spec uses:

- Default eligibility result: `{ eligible: false, status: "unverified", reason: "ofac_unconfigured" }`.
- The API reports `eligibility.status` `"unverified"` and `points_withheld: true`.
- The row is still stored. `points` is 0 so a raw sum does not credit it.
- `docs/reputation/INDEXER_SPEC.md` shows a staging stub `{ eligible: true, reason: "pending-#7" }` and says public launch is blocked until #7 closes. `docs/reputation-ledger.md` says this service does not use that stub. This spec follows the ledger doc: eligible is false until a real screen exists.

`docs/TERMS.md` section 4 already bars comprehensively sanctioned jurisdictions, OFAC SDN and similar denied-party listings, and persons owned or controlled by them. There is no screen implementation named in the sources. Provider, list set, and refresh interval are **TBD**.

Interaction with the append-only daily cap: a #7 zero row still occupies `UNIQUE(wallet, action, utc_day)` and, when it has one, the `tx_hash`. A later screen does not rewrite the row. Backfill of points onto a zero row is **TBD** and is not assumed.

`allowAllEligibility` is a test hook in the reputation doc. It is not a production path for this ledger.

## Checklist #9 — Enforcer

**Open.** Definition from `docs/reputation-ledger.md`: name the sybil / abuse enforcer and write the policy. The `enforcer` hook has no named owner, so flags do not auto-cancel. `O5_REPEAT` and `DISPUTE_PREDATES_ESCROW` are review only. Burns and listings are signals. Cancels are ADJ. Checklist #7 stays fail closed.

Hook shape from `docs/reputation/INDEXER_SPEC.md`, still open (Spencer names the owner, Lawyer reviews the policy):

- `flag` accepts `O5_REPEAT`, `DISPUTE_PREDATES_ESCROW`, `DENYLIST_LISTED`, `BOT_BURNED`, `PAIR_CAP`, and `OTHER`.
- `cancel` writes an ADJ entry. It is not an automatic zero of later rows.

`docs/reputation-ledger.md` records the default enforcer behavior this spec keeps until #9 closes:

- `O5_REPEAT`: `withhold_wallet: false`, reason `review_only`. It does not zero later rows. The threshold cited there is at least 3 O5 rows whose UTC days fall in `[D - 6, D]`.
- `DISPUTE_PREDATES_ESCROW`: one flag per dispute, `withhold_wallet` forced false, other rows left alone.
- `BOT_BURNED`, `DENYLIST_LISTED`, `DENYLIST_UNLISTED`, and `PAIR_CAP`: recorded, not withheld. Denylist listings are not an earning source.

No owner is named, so this spec does not auto-cancel. ADJ lives on the reputation ledger (`config/reputation/adjustments.json`, pull request only, no admin write endpoint). Whether an ADJ row can target an action in this spec is **TBD**. Until that exists, abuse handling on this ledger is the closed cap: the extra row is not committed. Flags do not mint a negative point.

## Checklist #12 — Caps

**Open.** Definition from `docs/reputation-ledger.md`: lock caps before soft launch. The numbers in `config/reputation/sepolia.json` are labeled `DRAFT/GUESS`. `GET /v1/reputation/config` returns `status: "draft"` on the body and on each cap and threshold. `config/reputation/sepolia.json` says every value under `points`, `floors`, `caps`, and `flags` is a Tokenomics GUESS until Spencer locks checklist #12, and it must not be used against live data until Blockchain Verifier APPROVE and Spencer's GO via BOB.

This spec does not lock those numbers and does not reuse them as weights for `first_connect`, `fund`, `release_or_refund`, `dispute_open_or_vote`, or `return_day`. The GUESS figures (including 20 usage points per wallet per day, 500 per season, and 30 arbitrator points per day) stay in that config. They are not the daily cap for this ledger.

The daily cap this spec does define is the atomic unique constraint in "Ledger and daily cap": one row per wallet per action per server-assigned UTC day, and one credit per `tx_hash`. Overflow is all-or-nothing. The insert fails closed. No clipped remainder is credited.

`caps._label` remains `DRAFT/GUESS`. A numeric point cap, a per-bot cap, a pair cap, and a season cap for these actions are **TBD** until #12 locks.

## No contract change

No contract change is expected. Blockchain Builder confirms that.

This spec reads events the deployed escrow already emits. It does not add a function, an event, a storage field, or a check inside `BotAttestationEscrow`. The decision-chain check is off-chain, in the points writer. The escrow does not take a chain, an `actor_type`, or a point balance.

Vote-event gap, for that confirmation: the escrow has no vote event. Closing the gap by reading the existing `DisputePanel.VoteCast` log does not require an escrow change. Adding a vote event, or a voter argument, on `BotAttestationEscrow` would be a contract change. This spec does not ask for that change. If Builder rejects `VoteCast` as the source, vote credit stays **TBD** and the escrow stays as deployed.

Also for Builder, without asking for an edit: `docs/reputation/EVENT_MAP.md` still publishes the two-argument `EscrowDisputed` topic0. The deployed source emits three arguments, including `party`. Indexers that filter on the two-argument topic0 will not see dispute-open logs from `0x3d660502D75f1e97b08c110255921b437A3C4C42`. The points writer uses the three-argument topic0 in this spec. Fixing the event map would be a docs change in another file. It is not part of this draft, and it is not a contract change.

The header comment "Not deployed" in `contracts/BotAttestationEscrow.sol` disagrees with `deployments/base-sepolia.json`. This spec follows the deployment record. No source edit is requested.

## Out of scope

- Code, config, migrations, and deploys.
- A new on-chain ledger, a token, a claim, a sale, or a mainnet deployment.
- Scoring `Credited`, `Withdrawn`, governance swap events, Denylist logs, or Vault logs as points. Denylist logs stay enforcer signals at 0 points where the indexer spec already says so.
- The O1–O5 and A1–A2 reputation ledgers. They keep their own spec. This file does not sum with them.
- Choosing the multi-human threshold. That question stays open in `docs/decision-chain-spec.md`.
