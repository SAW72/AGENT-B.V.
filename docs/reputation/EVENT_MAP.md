# Base Sepolia reputation event map

Status: DRAFT, docs only. Build and staging only. Nothing here is deployed, merged, or live.
Companion docs: [INDEXER_SPEC.md](./INDEXER_SPEC.md) and [config/reputation/sepolia.json](../../config/reputation/sepolia.json).

- Chain: Base Sepolia, chainId `84532`. Any other chainId (including `1` and `8453`) is refused.
- Source of truth for addresses: [deployments/base-sepolia.json](../../deployments/base-sepolia.json).
- Source code read: `contracts/BotAttestationEscrow.sol`, `contracts/DisputePanel.sol`, `contracts/Vault.sol`, `contracts/Denylist.sol` on `main` @ `3f47066`. The live escrow bytecode is commit `7fe4a863e9bce0b70b629dab76ddd2728c97b536` (recorded in `deployments/base-sepolia.json`). The retired ESC-M-1 escrow `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` is commit `444c427`.
- topic0 = keccak256 of the canonical signature (enums encode as `uint8`). Every topic0 below was recomputed locally. The live escrow emits the 4-field governance topics. The 1-field topics belong to the retired escrow.

## Contracts and start blocks

| Contract | Address | Deploy block (indexer start block) | Deploy time (ET) | Live code vs `main` |
|---|---|---|---|---|
| BotAttestationEscrow ("Escrow") | `0x3d660502D75f1e97b08c110255921b437A3C4C42` | `47715415` | 2026-10-05 11:18 UTC | Pull-payment redeploy from `7fe4a863e9bce0b70b629dab76ddd2728c97b536`. Governance events match `main` (4-field `VaultUpdated` / `DisputePanelUpdated`). The retired ESC-M-1 escrow `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` (block `47345163`, commit `444c427`) emitted the same 4-field shapes. The retired escrow `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` (block `47299930`, commit `78e3ba04`) emitted the 1-field shapes. |
| DisputePanel | `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb` | `47253020` | 2026-09-24 2:25 PM | Same as `main` |
| Vault | `0x1463D664fA467FBCDA4B05443434494f05e565bc` | `47294164` | 2026-09-25 1:16 PM | Same as `main` |
| Denylist | `0xeE76876bECcFc1B58fC06fF4E654a517d784B224` | `47294163` | 2026-09-25 1:16 PM | Same events as `main` (PR #23 changed internals only) |

## Live state at time of writing

A full `eth_getLogs` scan from block `47253020` to `47341332` (2026-09-26 3:29 PM ET), in 625-block chunks, covered DisputePanel, Vault, Denylist, and the retired escrow `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c`. It found 16 logs, all deploy, ownership, wiring, or arbitrator-seat logs: 0 `Registered`, 0 `OperatorSet`, 0 `EscrowCreated/Released/Refunded/Disputed`, 0 `DisputeOpened/VoteCast/DisputeResolved`, and 0 `Listed/Unlisted`. The escrow that was live at that writing, now retired, was deployed later at block `47345163` (`0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d`, 2026-09-26 5:36 PM ET). The current live escrow was deployed at block `47715415` (`0x3d660502D75f1e97b08c110255921b437A3C4C42`). That scan does not cover either later deploy, and this map does not claim a new scan of them. Counts below that say "retired-contract scan" are from the earlier scan. Business-event layouts are from source, not from live business transactions.

## BotAttestationEscrow `0x3d660502D75f1e97b08c110255921b437A3C4C42` (start block 47715415)

| Event (full signature, indexed marked) | Canonical signature | topic0 | Indexed fields (topics 1..3) | Data fields | Emitting function / transition | Reputation use |
|---|---|---|---|---|---|---|
| `EscrowCreated(bytes32 indexed escrowId, address indexed payer, address indexed payee, bytes32 payerBotId, bytes32 payeeBotId, uint256 amount, uint256 expiresAt)` | `EscrowCreated(bytes32,address,address,bytes32,bytes32,uint256,uint256)` | `0x9d605e83d5554e0f88f697fe6184e9d0616163c141daf3ba689299e334a285c1` | escrowId, payer, payee | payerBotId, payeeBotId, amount, expiresAt | `createEscrow`: none -> Open. `payer` = msg.sender = `Vault.operator(payerBotId)`; `payee` = `Vault.operator(payeeBotId)`. `expiresAt` = create block timestamp + `durationSeconds` (1 s .. 30 days) | O2, O3, O4 parties, amount, set duration |
| `EscrowReleased(bytes32 indexed escrowId, uint256 amount)` | `EscrowReleased(bytes32,uint256)` | `0x9410e7c5b50451e4b5bd5ce113fd48abebd7070eb9d080df08b115b7cdc41650` | escrowId | amount | `release` (permissionless): Open -> Released (only at or before `expiresAt`, operators re-bound, bots re-verified) or Disputed -> Released (panel resolved and upheld; no expiry, no re-verification). Pays create-time `payee` | O2, O4 |
| `EscrowRefunded(bytes32 indexed escrowId, uint256 amount)` | `EscrowRefunded(bytes32,uint256)` | `0x21cabc2fff910e5afd1e2bcb22ff2b165a41ab0afbaf364f07aaf2f7787fb908` | escrowId | amount | `refund` (permissionless): Open -> Refunded only after `expiresAt`; Disputed -> Refunded before expiry only if panel resolved and not upheld, or after expiry whenever the panel has not upheld (pending or unwind). Pays create-time `payer`. The event does not say which path | O3, O4 |
| `EscrowDisputed(bytes32 indexed escrowId, bytes32 disputeId)` | `EscrowDisputed(bytes32,bytes32)` | `0xcd4243485a48c9b2bc0e6ac4133f40bcac2bc94a0807c72c2dc2d60e023d2995` | escrowId | disputeId | `dispute` (payer or payee only): Open -> Disputed. The panel case must exist, be unresolved, have zero votes, `subjectHash == escrowId`, `createdAt` not before this escrow, and a challenger who is the payer or the payee. Reverts after `expiresAt` (`DisputeAfterExpiry`). Flagger (`msg.sender`) is not logged. The retired escrow did not apply these ESC-M-1 checks. | O2/O3 exclusion, O4 link, A1 link |
| `DenylistUpdated(address indexed previousDenylist, address indexed newDenylist, address indexed actor, uint256 timestamp)` | `DenylistUpdated(address,address,address,uint256)` | `0x1c1cf22427d30e6d6cec33e1375a00936ed2c93d037712b5cfa14221b035d92a` | previousDenylist, newDenylist, actor | timestamp | constructor, `setDenylist` | Governance audit only. Retired-contract scan count 1. The live constructor emits the same event. |
| **Retired shape** `VaultUpdated(address indexed vault)` | `VaultUpdated(address)` | `0x161584aed96e7f34998117c9ad67e2d21ff46d2a42775c22b11ed282f3c7b2cd` | vault | none | constructor, `setVault` on `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` only | Governance audit only. Retired-contract scan count 1. Not in the live bytecode. |
| **Retired shape** `DisputePanelUpdated(address indexed panel)` | `DisputePanelUpdated(address)` | `0x9d75f31e9d9860ecb2dbb146498bd73b67bd0a905f7670417df7b935a6ce3998` | panel | none | constructor, `setDisputePanel` on the retired escrow only | Governance audit only. Retired-contract scan count 1. Not in the live bytecode. |
| **Live shape** (commits `444c427` and `7fe4a863e9bce0b70b629dab76ddd2728c97b536`, same as `main`) `VaultUpdated(address indexed previousVault, address indexed newVault, address indexed actor, uint256 timestamp)` | `VaultUpdated(address,address,address,uint256)` | `0x98bd850118a3b2adf2899b547ed110d0a68397fc64ca0b49a55802aeb08a385d` | previousVault, newVault, actor | timestamp | constructor, `setVault` | Governance audit only. In the live bytecode. Retired-contract scan count 0. |
| **Live shape** (commits `444c427` and `7fe4a863e9bce0b70b629dab76ddd2728c97b536`, same as `main`) `DisputePanelUpdated(address indexed previousPanel, address indexed newPanel, address indexed actor, uint256 timestamp)` | `DisputePanelUpdated(address,address,address,uint256)` | `0xf784fa686c25e5a523a9c6576fc20a1e0a5fc05d3f15b235d9d6d78ef8609758` | previousPanel, newPanel, actor | timestamp | constructor, `setDisputePanel` | Governance audit only. In the live bytecode. Retired-contract scan count 0. |
| `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)` (OpenZeppelin) | `OwnershipTransferred(address,address)` | `0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0` | previousOwner, newOwner | none | constructor, `acceptOwnership` | Governance audit only. Retired-contract scan count 2. The live contract emits this too. |
| `OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)` (OpenZeppelin 2-step) | `OwnershipTransferStarted(address,address)` | `0x38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e22700` | previousOwner, newOwner | none | `transferOwnership` | Governance audit only. Retired-contract scan count 1. The live contract emits this too. |

### Old vs new `VaultUpdated` / `DisputePanelUpdated` (indexer must accept both)

The live Escrow is `0x3d660502D75f1e97b08c110255921b437A3C4C42`, deployed at block `47715415` from commit `7fe4a863e9bce0b70b629dab76ddd2728c97b536`. It emits the **4-field** shapes `VaultUpdated(address,address,address,uint256)` and `DisputePanelUpdated(address,address,address,uint256)`, the same shapes as `main` and `apps/wallet-ux/src/abi/BotAttestationEscrow.json`. The retired ESC-M-1 escrow `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` (block `47345163`, commit `444c427`) emitted those same 4-field shapes. The retired escrow `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` was deployed at block `47299930` from commit `78e3ba04`, before PR #23, and emits the **1-field** shapes. Register **both** topic0 values per event name and decode by topic0. An indexer that only knows the 4-field ABI will fail if it is ever pointed at the pre-ESC-M-1 contract. This is governance audit data only; no reputation rule depends on it.

## DisputePanel `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb` (start block 47253020)

| Event (full signature, indexed marked) | Canonical signature | topic0 | Indexed fields | Data fields | Emitting function | Reputation use |
|---|---|---|---|---|---|---|
| `DisputeOpened(bytes32 indexed disputeId, bytes32 indexed subjectHash, address challenger)` | `DisputeOpened(bytes32,bytes32,address)` | `0xff7eb321cb9f047b29ab55a1eaab2dbd40f73e1ec2b34cf847246a5ea1b0b535` | disputeId, subjectHash | challenger | `openDispute`: permissionless and free once 3 arbitrators are seated. `subjectHash` is free-form (an escrowId, botId, or audit hash) | O4 join, O5 classification and repeat-use flag |
| `VoteCast(bytes32 indexed disputeId, address voter, bool support)` | `VoteCast(bytes32,address,bool)` | `0x8b40665146691327ee30f5bf56e9b2d6f445d2830d3b09b56385cd30f630ecfb` | disputeId | voter, support | `vote`: allowlisted arbitrator, once per dispute, only while unresolved. `support = true` means the original decision stands | A1, A2 |
| `DisputeResolved(bytes32 indexed disputeId, bool upheld)` | `DisputeResolved(bytes32,bool)` | `0x6309d9f2499864a4f9d4ddb22f2b493afde8c215a1cd2e178647596cffe2efa4` | disputeId | upheld | Inside `vote` when the 3rd vote lands; `upheld = votesFor >= votesAgainst`. **Emitted before that same vote's `VoteCast`** (logIndex n, then VoteCast at n+1) | O4, A1, A2 |
| `ArbitratorUpdated(address indexed account, bool allowed)` | `ArbitratorUpdated(address,bool)` | `0x90337bcf2f2ffbb618856a0655c6fa90dc53576d7e86a32bd7d0a279583a0886` | account | allowed | `setArbitrator` (owner) | Seat history cross-check. Live count 3 (block 47299643) |
| `OwnerUpdated(address indexed previous, address indexed next)` | `OwnerUpdated(address,address)` | `0x8292fce18fa69edf4db7b94ea2e58241df0ae57f97e0a6c9b29067028bf92d76` | previous, next | none | `setOwner` | Governance audit only. Live count 1 |

The constructor emits nothing. `outcome(disputeId)` is a view returning `(exists, resolved, upheld, subjectHash)`. `PANEL_SIZE = 3`, so every resolved dispute has exactly 3 `VoteCast` logs.

## Vault `0x1463D664fA467FBCDA4B05443434494f05e565bc` (start block 47294164)

| Event (full signature, indexed marked) | Canonical signature | topic0 | Indexed fields | Data fields | Emitting function | Reputation use |
|---|---|---|---|---|---|---|
| `Registered(bytes32 indexed botId, Tier tier, uint256 ts)` | `Registered(bytes32,uint8,uint256)` | `0x2578fc74812af5cd47b15f759eb9c5fc42c617d359b4974992d25e50fba91add` | botId | tier (uint8: None=0, Chat=1, DataTools=2, Financial=3, Critical=4), ts | Both `register` overloads (onlyOwner). Succeeds only if `Denylist.check == None` at that block. No operator and no fingerprint hashes in the event | botId enumeration; O1 precondition |
| `OperatorSet(bytes32 indexed botId, address indexed account)` | `OperatorSet(bytes32,address)` | `0x9efccfdeeb35d36624f8546b14ab72aa768151985ee15f2f7dfce288348baaa3` | botId, account | none | 6-arg `register` (same tx, after `Registered`) and `setOperator` (bind or rotate; requires the bot to be registered; does not check `active`). `account` is never zero | O1 (first per botId only); operator-at-block history |
| `Burned(bytes32 indexed botId, uint256 ts)` | `Burned(bytes32,uint256)` | `0x332f25d7d767b49a1126573abecdd03ab5293993961c8c46f81e74c188aba555` | botId | ts | `burn` (onlyOwner, irreversible) | Enforcer signal only; no points in design v2.2 |
| `AccessGranted(bytes32 indexed botId, Tier tier, uint256 ts)` | `AccessGranted(bytes32,uint8,uint256)` | `0xf3c3dd4f535e08ca012ad6de26fb12509f2c9111049045d33e3d27adc62c0978` | botId | tier, ts | **Never emitted** (`grantAccess` is a view). Absent from live bytecode | None |
| `OwnershipTransferred` / `OwnershipTransferStarted` (OpenZeppelin) | as in Escrow | as in Escrow | previousOwner, newOwner | none | constructor / `acceptOwnership` / `transferOwnership` | Governance audit only. Live counts 2 / 1 |

View used by the indexer: `bots(bytes32 botId) -> (bytes32 weightHash, bytes32 behaviorSig, bytes32 promptHash, uint8 tier, bool active, uint256 registeredAt)`. The three hashes are fixed at register time.

## Denylist `0xeE76876bECcFc1B58fC06fF4E654a517d784B224` (start block 47294163)

| Event (full signature, indexed marked) | Canonical signature | topic0 | Indexed fields | Data fields | Emitting function | Reputation use |
|---|---|---|---|---|---|---|
| `Listed(bytes32 indexed id, Bucket indexed bucket, address indexed actor, uint256 timestamp, uint64 timesListed)` | `Listed(bytes32,uint8,address,uint256,uint64)` | `0x9e202313ab265067bd141ce7ac995ac72378854bf1309fd27ff1ed7884d1ee0a` | id, bucket (Exact=0, Signature=1, Prompt=2), actor | timestamp, timesListed | `addExact`, `addSignature`, `addPrompt` (onlyOwner) | Enforcer signal only (0 points). `id` is a fingerprint hash, not a botId |
| `Unlisted(bytes32 indexed id, Bucket indexed bucket, address indexed actor, uint256 timestamp, uint64 timesListed)` | `Unlisted(bytes32,uint8,address,uint256,uint64)` | `0x2d23df7334e8c5a0e332bab82c73ba47a6a0c6762ce1588267f09c18159bec39` | id, bucket, actor | timestamp, timesListed | `remove(bytes32,uint8)` (onlyOwner) | Enforcer signal only |
| `OwnershipTransferred` / `OwnershipTransferStarted` (OpenZeppelin) | as in Escrow | as in Escrow | previousOwner, newOwner | none | constructor / 2-step | Governance audit only. Live counts 2 / 1 |

`check()` is a view and emits nothing, so a denylist check earns 0 (design v2.2, section 3). Mapping a `Listed.id` fingerprint to a botId needs the `Vault.bots(botId)` view (see [INDEXER_SPEC.md](./INDEXER_SPEC.md)).

## Notes

- `EscrowDisputed.disputeId`, `VoteCast.voter`, and `DisputeOpened.challenger` are not indexed. Filter them client-side.
- `EscrowCreated` has no `createdAt` field. Use the block header timestamp of the `EscrowCreated` log.
- Out of scope for this map: Liability and InsuranceFund (no claims exist; the `claim-relayer` "claim" is a relayed escrow call, not a Liability claim).
