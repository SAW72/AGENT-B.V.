# Claim relayer (Base Sepolia)

Gas and ops service for the Agent-BV (Agent Auditor) claim flow. Default mode is **fixtures / dry-run**. Live claim submits are unlocked only on Base Sepolia when `LIVE_SUBMIT=1` and `SPENCER_RUN_AUTH=1`. `npm run readonly` is a separate read-only check (`eth_chainId`, `eth_getCode`, `eth_call` only).

Public funding wallet (address only): `0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861` (`…31861`). The same EOA is booked as `claimRelayerWallet` in `deployments/base-sepolia.json`. It is not a contract. The hosted service derives it from `RELAYER_PRIVATE_KEY`. Never commit the private key.

`BotAttestationEscrow` is booked in `deployments/base-sepolia.json` at `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d`. The indexer and relayer start block is the deploy block `47345163` (`BOOKED_SEPOLIA_ESCROW_START_BLOCK`, also `BotAttestationEscrow.startBlock` in the address book). When `ESCROW_ADDRESS` is unset, health reports `escrowBooked: true` and that address (`escrowSource: "address_book"`) with `escrowStartBlock: 47345163` and `escrowStartBlockSource: "address_book"`. BVT is still null. Set `ESCROW_ADDRESS` to the zero address to force `escrowBooked: false` (`escrowStartBlockSource: "unbooked"`).

The booked start block is used only when the configured escrow is that booked contract (address-book block, or the constant when the book omits one). An `ESCROW_ADDRESS` override that points at a different contract does not inherit `47345163`. Set `ESCROW_START_BLOCK` to a non-negative integer for that contract, or leave it unset. Unset means `escrowStartBlock: null` and `escrowStartBlockSource: "unset"` on `/health`, plus a startup log. It does not mean block 0. A JSON `null`, an empty string, or a missing book `deployBlock` / `startBlock` is missing, not block 0. A present non-integer or negative `ESCROW_START_BLOCK` refuses to boot (`invalid_escrow_start_block`).

Config load refuses any adopted address (escrow env or book, denylist, vault, dispute panel) that matches `retired.*`, `superseded.*`, or the wallet-ux superseded pins. Comparison ignores case and checksum. The previous escrow `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` is retired (ESC-M-1 redeploy, retired 2026-09-26). Setting it as `ESCROW_ADDRESS` fails at boot: `retired_or_superseded_address`, and the message names that address and the current booked address `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d`.

The booked escrow is source `444c427`. A dispute on that bytecode links only when the panel subject is the claim identifier. A redeploy that replaces `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` changes the wallet book, this relayer book, the wallet deploy-guard pin (`apps/wallet-ux/scripts/guard-escrow-addresses.mjs`), and the superseded entry for `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` together. Do not move one of those pins alone.

## HARD STOP

- **Base Sepolia only** (chain id **84532**). Ethereum mainnet (`1`), Base mainnet (`8453`), and every other chain are refused at boot and on every request. There is no mainnet send path.
- **Live submit is off unless every gate passes:** `CHAIN_ID=84532`, `LIVE_SUBMIT=1`, `SPENCER_RUN_AUTH=1`, and the escrow is the booked Sepolia contract `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d`. Health then reports `liveSubmit: true`, `mode: "live"`, and `liveSubmitBlockers: []`. Any missing gate keeps `liveSubmit: false`.
- **Agents do not `--broadcast`.** Do not add forge broadcast scripts. Do not deploy Escrow or BVT from here. Live submit sends one escrow transaction through the relayer key. It does not deploy contracts.
- **Never invent balances.** Quote amounts are echoed from the client. This service does not read wallet balances.
- **Never commit secrets or private keys.** `RELAYER_PRIVATE_KEY` is a runtime environment variable only. It is read only when live submit is allowed, it is not written to disk or to the JSONL log, and it is stripped from errors.

## Run locally

```bash
cd claim-relayer
cp .env.example .env
# edit .env if you want; empty defaults are enough for fixtures
set -a
source .env
set +a
npm start
```

Listens on `127.0.0.1:8790` unless `HOST` or Render's `PORT` is set. Render must bind `0.0.0.0`.

```bash
npm test
```

Tests use Node's built-in runner. They do not touch the network.

## Fixture mode

`LIVE_SUBMIT` and `SPENCER_RUN_AUTH` default to `0`. Quote routes stay dry-run. Claim routes without `live: true` stay dry-run even after the gate opens.

`GET /health` and `GET /v1/health` (HTTP 200 even when the kill switch is on). Default blockers:

```json
{
  "ok": true,
  "chainId": 84532,
  "network": "base-sepolia",
  "killSwitch": false,
  "mode": "fixture",
  "stub": true,
  "fixture": true,
  "escrowBooked": true,
  "escrowAddress": "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d",
  "escrowSource": "address_book",
  "escrowStartBlock": 47345163,
  "escrowStartBlockSource": "address_book",
  "relayerAddress": "0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861",
  "liveSubmit": false,
  "liveSubmitRequested": false,
  "liveSubmitBlockers": ["spencer_run_auth_required", "live_submit_off"]
}
```

When `LIVE_SUBMIT=1` and `SPENCER_RUN_AUTH=1` on chain 84532 with that escrow, the same route reports `mode: "live"`, `liveSubmit: true`, `fixture: false`, `stub: false`, and `liveSubmitBlockers: []`. No private key is included.

## Wallet UX API (provisional)

Stable shapes for parallel Wallet UX work. Extra fields below are part of this scaffold's contract.

### `POST /v1/claims/quote`

Request:

```json
{ "payer": "0x1111111111111111111111111111111111111111", "payee": "0x2222222222222222222222222222222222222222", "amountWei": "1000", "claimId": "claim-1" }
```

`amountWei` and `claimId` are optional. `amountWei` is a base-10 integer string (echoed, not a balance). If `claimId` is omitted the service mints `fixture-` plus 16 hex chars. Optional `chainId` must be `84532`.

Response:

```json
{
  "claimId": "claim-1",
  "payer": "0x1111111111111111111111111111111111111111",
  "payee": "0x2222222222222222222222222222222222222222",
  "amountWei": "1000",
  "fixture": true,
  "expiresAt": "2026-09-25T20:00:00.000Z",
  "chainId": 84532,
  "mode": "fixture",
  "dryRun": true,
  "escrowBooked": true,
  "escrowAddress": "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d",
  "relayerAddress": "0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861",
  "relayerNonce": "0",
  "calldata": null,
  "calldataStatus": "action_required"
}
```

`expiresAt` is ISO-8601 UTC. `amountWei` is omitted when the request omitted it. `relayerNonce` is an in-memory reservation for that `claimId` (same id refreshes the same nonce until expiry).

### `POST /v1/claims`

Request `{ "claimId": "claim-1" }`. Optional `payer`, `payee`, `amountWei`, `chainId`.

Fixture response while Escrow is booked and Spencer has not authorized a run:

```json
{
  "ok": true,
  "mode": "fixture",
  "claimId": "claim-1",
  "txHash": null,
  "reason": "escrow_booked_spencer_run_auth_required",
  "dryRun": true,
  "escrowBooked": true,
  "escrowAddress": "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d",
  "calldata": null,
  "calldataStatus": "action_required"
}
```

Set `action` to `createEscrow`, `release`, `refund`, or `dispute` to get real calldata. `valueWei` is `msg.value` for `createEscrow` and `"0"` otherwise. It is not an ABI argument.

A claim that does not set `live: true`, `liveSubmit: true`, or `mode` to `"live"` or `"broadcast"` stays a dry run (`txHash: null`). With the gate closed, `reason` is `escrow_not_booked`, `escrow_not_booked_sepolia`, `escrow_booked_spencer_run_auth_required`, or `live_submit_off`. With the gate open, that dry run uses `reason: "dry_run"`.

A live claim while the gate is closed returns **409** `live_submit_blocked` and `txHash: null`. A live claim while the gate is open must carry a signed `ClaimIntent` (see Auth model). After that signature is accepted, the service signs the escrow transaction with `RELAYER_PRIVATE_KEY` and returns `mode: "live"` plus the transaction hash. Quotes never broadcast. A live flag on `POST /v1/claims/quote` is **409** `quote_does_not_broadcast` once the gate is open, and the closed-gate refusal before that. `KILL_SWITCH=1` still returns **503** `kill_switch` for quote and claim before the body is read.

Fixture claims (no live flag) stay open, including when the gate is open. Quotes stay dry-run. `ADMIN_SECRET` still gates pause and unpause only. It does not authorize a live claim.

CORS preflight allows `content-type`, `x-admin-secret`, and `authorization`. When `CORS_ORIGINS` is unset, the allowlist is the Wallet UX production origin `https://agent-a-wallet-ux.pages.dev` plus `http://localhost:5173` and `http://127.0.0.1:5173`. Other `pages.dev` hosts are not allowed. Set `CORS_ORIGINS` to replace that list. CORS is not authentication.

## Auth model

Browser callers of live `POST /v1/claims` send `{ intent, signature, live: true }`. The wallet signs EIP-712 typed data (`eth_signTypedData_v4`) over `ClaimIntent`. The domain name is `AgentBV Claim Relayer`, version `1`, `chainId` is the configured chain, and `verifyingContract` is the configured escrow. The type string is pinned:

`ClaimIntent(uint8 action,bytes32 escrowId,address sender,uint256 nonce,uint256 deadline)`

The request schema lists `refund` only. Its signed uint8 stays `1`. `release` is not an allowlisted action: uint8 `0`, and case, whitespace, or numeric-string aliases such as `"0"`, `"00"`, `" 0"`, and `"Release"`, are **400** `release_not_relayable` before signature recovery, so they are not remapped onto refund. An array or object `action` is **400** `action_not_claim` before signature recovery. `deadline` is a unix second. The schema lives in `claimIntent.json`. Wallet UX keeps a copy of the same fields and a test fails if the two copies differ. Calldata is not part of the signed struct. The server builds `refund(bytes32)` from `action` and `escrowId` and broadcasts those bytes. A client `calldata` field, if present, must match that encoding exactly. A different encoding is **400** `calldata_mismatch`. Extra bytes after the encoding are **400** `trailing_bytes`. The client bytes are never sent.

There is no shared browser secret. `CLAIM_API_SECRET` and the `x-claim-secret` header are removed. Wallet UX is the only production caller of live claims. Tests and docs are not a second caller, so no server-to-server HMAC was added. A header that used to carry a secret is ignored.

The live allowlist is `refund` only. `release` is **400** `release_not_relayable` as soon as the action is read, before signature recovery, domain checks, nonce claim, simulation, signing, or broadcast. A refused release does not consume an intent nonce. `ReleaseNotAuthorized` means: "Only the payer can release an open escrow; after an upheld dispute, the payer or the payee." The relayer key is not that caller, so a relayed release would revert `ReleaseNotAuthorized` and burn gas. The payer sends an open release from their own wallet. `createEscrow`, `dispute`, `withdraw`, and `withdrawTo` are **400** `action_not_claim` before signature recovery. `createEscrow` stays on the connected wallet. `dispute` requires `msg.sender` to be a party, so a relayed dispute always reverts. `withdraw` and `withdrawTo` spend `pendingWithdrawals[msg.sender]`. The relayer key is that sender, so those calls would move the relayer's own credit, not the user's. They stay disabled.

A per-IP token bucket runs after the kill switch and before the body is parsed. It returns **429** `rate_limited`. Render's proxy appends the connecting client to `X-Forwarded-For`, so only the rightmost hop is trusted. A missing header uses the socket address. `X-Real-IP` and Cloudflare headers are not read. This service is not behind Cloudflare.

ECDSA signatures must be 65 bytes with `v` in `{0, 1, 27, 28}` and low `s` (`s` at most `secp256k1n / 2`). Anything else on a 65-byte signature is **400** `invalid_signature` or **400** `high_s`, before `ecrecover`. The transaction is signed once. A timeout rebroadcasts that same raw transaction. It does not sign again with a new nonce or gas price.

Verification order, and only then simulate and broadcast the server-built calldata:

1. Domain `chainId` and `verifyingContract` must equal configured `CHAIN_ID` and `ESCROW_ADDRESS`. The retired escrow `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` is rejected. Chain ids `1` and `8453` are rejected.
2. `deadline` is in the future and at most 300 seconds ahead.
3. `ecrecover` of the low-`s` signature equals `intent.sender`. ERC-1271 `isValidSignature` runs only when `ERC1271_ENABLED=1`, and only for a signature that is not a 65-byte ECDSA signature. The default is off.
4. The server builds calldata from the signed `action` and `escrowId`. A supplied value is refused. Client calldata is checked and then discarded.
5. `sender` is the payer or the payee of that same `escrowId`, read on chain at `latest`. A missing id is **404** `escrow_not_found`.
6. `(sender, nonce)` is claimed once. A replay is **409** `nonce_replay` and is not broadcast. A second request while the first is still in flight is **409** `nonce_in_flight`. A **409** `ruling_pending` consumes that signed intent's nonce, so the same body retried returns `nonce_replay`. The user signs again after the 7-day grace ends.

The on-chain `msg.sender` is still the relayer key. The signature says who may ask the relayer to spend gas. A relayed `refund` only credits `pendingWithdrawals`. The credited account withdraws its own balance. `release` is not relayed.

### Threat table

| Check | What it stops |
| --- | --- |
| Domain chain id and verifying contract | A signature made for another chain, another escrow, or the retired escrow. |
| Deadline window of at most 300 seconds | A signature that stays valid long enough to submit later. |
| Recovered signer equals `sender` | Someone submitting a signature they did not make. |
| ERC-1271, off unless `ERC1271_ENABLED=1` | Contract wallets that cannot `ecrecover`. Left off until that path is reviewed. |
| Sender is payer or payee of the signed escrow id | A stranger asking the relayer to spend gas on someone else's claim. |
| Server-built calldata for that same escrow id | Relaying client bytes, a mismatched escrow id, or trailing bytes. |
| Live allowlist of `refund` only, and `release_not_relayable` before a nonce is claimed | Relaying `release` (the relayer is not the payer), `createEscrow`, `dispute`, `withdraw`, or `withdrawTo`. |
| Single-use `(sender, nonce)` | A second broadcast of the same approval. A replay is rejected. |
| Per-IP token bucket before the body is read | A burst that would otherwise reach signature recovery. The rightmost `X-Forwarded-For` hop is the client. |
| Low `s` and `v` in `{0, 1, 27, 28}` | A malleable signature. |
| Sign once, rebroadcast the same raw transaction | A timeout that would otherwise sign a second nonce. |
| Per-escrow cap | Repeated submits against one claim. |
| Daily gas budget | The relayer spending more than the configured gas for the day. |
| Kill switch | Quote and claim traffic while the service is paused. |

Rate limits, the escrow cap, and the gas budget are abuse controls. They are not authentication. They live in memory for one process. Defaults: 5 claims per sender per 60 seconds, 30 claims per IP per 60 seconds, 8 claims per escrow per 86400 seconds, and `10000000000000000` wei of gas per day priced at `1000000000` wei per gas. Override with `CLAIM_RATE_SENDER`, `CLAIM_RATE_IP`, `CLAIM_RATE_WINDOW_SEC`, `CLAIM_ESCROW_CAP`, `CLAIM_ESCROW_WINDOW_SEC`, `DAILY_GAS_BUDGET_WEI`, and `CLAIM_GAS_PRICE_WEI`.

### Intent nonce store

Production uses the file-backed store (`createFileIntentNonceStore`) at `INTENT_NONCE_PATH`. The default is `./data/intent-nonces.jsonl`. On Render the Blueprint sets `/tmp/claim-relayer/intent-nonces.jsonl`. That disk is ephemeral, same as the claim log, and a restart forgets used nonces. That is accepted for Base Sepolia. Run one web instance. Tests use the in-memory store. The quote reservation in `nonceStore.mjs` is a different store and is unchanged. Signatures are not written to the claim log.

### Deferred to mainnet

- A Render Key Value nonce store (`SET NX PX`) so a restart cannot forget a used nonce. `/tmp` is enough for this testnet.
- Persistent abuse limits and a live gas price. The current windows and `CLAIM_GAS_PRICE_WEI` live in one process.
- ERC-1271 smart-wallet signers. The flag stays off.
- A note for a future Cloudflare proxy. This service trusts Render's rightmost `X-Forwarded-For` hop only.

## Error codes

| HTTP | `error` | When |
| --- | --- | --- |
| 503 | `kill_switch` | Kill switch is on. Quote and claim are refused before the body is read. Health stays 200. |
| 503 | `relayer_key_missing` | The signed intent was accepted and `RELAYER_PRIVATE_KEY` is unset. Nothing is signed. |
| 502 | `broadcast_failed` | The Sepolia RPC rejected the send, or gas estimation reverted, and the revert is not `RulingPending`. `txHash` is null. `senderConstraint` says who the contract requires. `revert_data` is the raw revert bytes as a `0x` lowercase hex string, or `null` when the RPC error has no revert bytes. |
| 409 | `ruling_pending` | A relayed refund's simulation or broadcast reverted with `RulingPending` (`0x3a0621bd`). Nothing is broadcast when simulation reverts. `txHash` is null. |
| 409 | `live_submit_blocked` | Client asked for a live transaction and the gate is closed, or asked a quote to broadcast. `reason` is `escrow_not_booked`, `escrow_not_booked_sepolia`, `escrow_booked_spencer_run_auth_required`, `live_submit_off`, or `quote_does_not_broadcast`. |
| 400 | `release_not_relayable` | Live `action` is `release`, uint8 `0`, or a case, whitespace, or numeric-string alias of release (`"0"`, `"00"`, `" 0"`, `"Release"`). Refused before signature recovery, simulation, signing, broadcast, and before an intent nonce is claimed. Only the payer can release an open escrow; after an upheld dispute, the payer or the payee. The payer sends an open release from their own wallet. |
| 400 | `invalid_bytes32` | `escrowId` / bot id / `disputeId` is not a non-zero bytes32. |
| 400 | `invalid_duration` | `durationSeconds` is outside `1..2592000` (`30 days` on the contract). |
| 400 | `action_not_claim` | Live `action` is not `refund`. An array or object is refused before signature recovery. `createEscrow`, `dispute`, `withdraw`, `withdrawTo`, and governance setters are refused. `release` uses `release_not_relayable` instead. |
| 400 | `value_not_allowed` | A live refund included `amountWei`, `valueWei`, or `value`. The broadcast value is `0`. |
| 400 | `mainnet_refused` | Domain or body `chainId` is `1` or `8453`. |
| 400 | `wrong_chain` | Any chain other than `84532`. |
| 400 | `retired_or_superseded_address` | The signed verifying contract is the retired escrow. |
| 409 | `domain_mismatch` | The signed verifying contract is not the configured escrow. |
| 400 | `intent_required` | A live claim did not include an intent object. |
| 401 | `invalid_signature` | The signature does not recover to `intent.sender`, or `ERC1271_ENABLED` is off. |
| 400 | `deadline_expired` | `deadline` is not in the future. |
| 400 | `deadline_too_far` | `deadline` is more than 300 seconds ahead. |
| 403 | `not_a_party` | The signer is not the payer or the payee. |
| 404 | `escrow_not_found` | That escrow id is not on the contract at `latest`. |
| 400 | `high_s` | A 65-byte signature has `s` above `secp256k1n / 2`. |
| 400 | `calldata_mismatch` | Client calldata is not the server encoding of the signed action and escrow id. |
| 400 | `trailing_bytes` | Client calldata starts with the server encoding and then continues. |
| 409 | `nonce_replay` | This `(sender, nonce)` was already used. Nothing is broadcast again. |
| 409 | `nonce_in_flight` | This `(sender, nonce)` is already being submitted. |
| 429 | `rate_limited` | The sender or IP window is full. |
| 429 | `escrow_cap` | This escrow has hit its window cap. |
| 429 | `gas_budget_exhausted` | The daily gas budget is spent. |
| 400 | `invalid_address` | `payer`, `payee`, or `sender` is missing or not a 20-byte hex address. |
| 400 | `invalid_parties` | Payer and payee are the same address. |
| 400 | `invalid_amount` | `amountWei` is not a positive integer. |
| 400 | `invalid_claim_id` | Claim id missing on submit, or an unexpected shape. |
| 400 | `invalid_json` | Body is not a JSON object. |
| 401 | `unauthorized` | Admin route called with the wrong `ADMIN_SECRET`. |
| 404 | `not_found` | Unknown path. |

A **409** `ruling_pending` consumes that signed intent's nonce. The same body retried returns `nonce_replay`. The user signs again after the 7-day grace ends.

`dispute` is not relayed. When a wallet-sent link reverts `DisputeVotesCast` (`0x8aab0a8f`), two votes on one side already decide that 3-member case, so it can't be linked or linked again. One vote, or one vote on each side, still links. The party opens a new case and links that one. `revertCopy.json` is that mapping. The sentence is: "Two votes on one side already decide this case, so it can't be linked or linked again. Open a new case and link that one."

A live claim that fails while sending returns this body. `revert_data` is always present: a `0x` lowercase hex string of the raw revert bytes, or `null`. Empty `0x`, odd length, non-hex, and payloads larger than 4096 bytes are `null` (they are not truncated). The body does not include the RPC URL, the provider error text, the request body, or the signer key.

```json
{
  "ok": false,
  "error": "broadcast_failed",
  "txHash": null,
  "dryRun": false,
  "action": "refund",
  "senderConstraint": "permissionless",
  "senderNote": "refund is permissionless. The relayer signs the credit. The credited account withdraws its own balance.",
  "revert_data": null
}
```

Startup with `CHAIN_ID` other than `84532` refuses to boot (`mainnet_refused` or `wrong_chain`). `RELAYER_KEY_FILE` / `RELAYER_PRIVATE_KEY_FILE` refuse to boot. A retired or superseded escrow, denylist, vault, or dispute panel refuses to boot (`retired_or_superseded_address`). A non-integer or negative `ESCROW_START_BLOCK` on a non-booked escrow refuses to boot (`invalid_escrow_start_block`). Keys stay in the environment.

## Kill switch

`KILL_SWITCH=1` starts paused. `POST /v1/admin/pause` and `POST /v1/admin/unpause` require header `x-admin-secret` or `Authorization: Bearer` matching `ADMIN_SECRET`.

If `ADMIN_SECRET` is unset, those routes return HTTP 200 and do **not** change the switch:

```json
{ "ok": true, "noop": true, "killSwitch": false, "docs": "ADMIN_SECRET is unset. ..." }
```

## Nonce store and logs

Quote reservations live in memory for one process. Intent nonces for live claims are the file store described under Auth model. Render must run **one web instance**. Do not turn on horizontal scaling. A restart clears in-memory reservations and, on the free plan, the ephemeral intent-nonce file.

`CLAIM_LOG_PATH` is append-only JSONL (default `./data/claims.jsonl`). Records are allowlisted. Private keys, secrets, and nested objects are dropped. The wallet signature sits on the nested intent, so it is not copied into the log. The log field named signature is the escrow function signature string. On Render the disk is ephemeral, so use `/tmp/...` and expect the file to vanish on restart.

## Claim calldata

Calldata is encoded in `escrowCalldata.mjs` from the signatures in `contracts/BotAttestationEscrow.sol`:

| Action | Signature | Value | Who may send it later |
| --- | --- | --- | --- |
| `createEscrow` | `createEscrow(bytes32,address,bytes32,bytes32,uint256)` | `amountWei` as `msg.value` | Payer bot's Vault operator (`vault_operator_must_send`) |
| `release` | `release(bytes32)` | 0 | Payer while Open (`payer_while_open`). Payer or payee after an upheld dispute. Not relayed (`release_not_relayable`). |
| `refund` | `refund(bytes32)` | 0 | Anyone (`permissionless`) |
| `dispute` | `dispute(bytes32,bytes32,string)` | 0 | Payer or payee (`party_must_send`). Encoded for description only. Not relayed. |

Selectors are `keccak256` of those strings. `setDenylist`, `setVault`, and `setDisputePanel` are not claim actions.

The public funding wallet is not assumed to be a Vault operator. Live submit does not broadcast `createEscrow`, `release`, `dispute`, `withdraw`, or `withdrawTo`. `refund` is permissionless on chain and only credits a balance. The EIP-712 signer must still be the payer or the payee before the relayer will send a refund. `release` is sent by the payer's own wallet while the escrow is open, and by the payer or the payee after an upheld dispute. The credited account calls `withdraw` or `withdrawTo` from its own wallet.

`npm run readonly` performs `eth_chainId`, `eth_getCode`, and `eth_call` only (`owner`, `governance`, `disputePanel`, `arbitratorCount`). It is not part of `npm test`. It refuses every chain other than 84532.

## Reputation read API (draft)

Off-chain Base Sepolia reputation per design note v2.2 (section 12 scoring). Design: [`docs/reputation-ledger.md`](../docs/reputation-ledger.md). This does not change `POST /v1/claims` auth or the claim-route CORS list. The display name and the first-mention title are `product.name` and `product.title` in [`config/reputation/sepolia.json`](../config/reputation/sepolia.json). `GET /v1/reputation/config` returns them as `product` and `product_title`. After the first mention, use `product`. The ledger ids stay `agent-bv-sepolia-reputation` and `agent-bv-sepolia-arbitrator-rep`.

- `GET /v1/reputation/config?chainId=84532` returns caps and thresholds with `status: "draft"` while checklist #12 is open. This path is matched before `/{address}`.
- `GET /v1/reputation/{address}?chainId=84532` returns `ledgers.usage` and `ledgers.arbitrator` as separate objects (`final` and `provisional`). There is no combined total. Omitted `chainId` defaults to 84532. Any other chain is 400, including 1 and 8453, and the body has no ledger data. An unknown address is 200 with zeros.
- `GET /v1/reputation/{address}/history?ledger=usage|arbitrator` pages section 6 fields. `limit` defaults to 25 and caps at 100.
- Reads are unauthenticated and rate limited. There is no write or admin route.
- Reputation GET CORS is separate. Defaults allow `https://agent-a-wallet-ux.pages.dev`, one-label `*.agent-a-wallet-ux.pages.dev` previews, and `http://localhost:*` / `http://127.0.0.1:*`. No credentials. It does not allow `*.pages.dev`. Override with `REPUTATION_CORS_PAGES_ORIGIN`, `REPUTATION_CORS_PREVIEW_HOST`, and `REPUTATION_CORS_LOCAL_HOSTS`. `CORS_ORIGINS` still applies only to the other routes.
- Caps are loaded from [`config/reputation/sepolia.json`](../config/reputation/sepolia.json). Example responses for Wallet UX (not a live scan) are in [`fixtures/reputation/`](fixtures/reputation/).

The in-memory ledger is rebuilt by replaying logs. A cold start on Render wipes it. Nothing here is live chain data.

## Cutover

Spencer runs the cutover himself. [CUTOVER.md](CUTOVER.md) starts with an interim stop against the relayer that is deployed now. The later steps publish the EIP-712 relayer and the Pages bundle, and they name the behavior that code does not have yet.

## Render

See `render.yaml` in this directory. It is a reference Blueprint, not registered at the repo root, so merging it does not create a Render service. Do not apply it until Spencer says GO.

**Apply path (either one, later):**

1. Move or copy this file to the repo root as `render.yaml` and set `rootDir: claim-relayer` on the service.
2. Create the service from this Blueprint in the Render dashboard.

This copy stays under `claim-relayer/` until Spencer asks to move it. The display name is `product.name` in `config/reputation/sepolia.json`. The Render service slug stays `bot-verifier-claim-relayer` unless Spencer renames it in the dashboard.

Free plan, one web instance (`numInstances: 1`), no disk, no autoscaling. Render Free spins down after about 15 minutes idle, which is fine for Base Sepolia. Before mainnet, upgrade the plan to Starter (about $7/month) so the relayer stays warm. The app still refuses mainnet; do not set a mainnet chain id in the Blueprint.

`HOST=0.0.0.0`. `LIVE_SUBMIT` and `SPENCER_RUN_AUTH` stay `0` in the Blueprint. To unlock Sepolia submits later in the Render dashboard, set:

```
LIVE_SUBMIT=1
SPENCER_RUN_AUTH=1
CHAIN_ID=84532
```

Put `RELAYER_PRIVATE_KEY` in the dashboard as a secret. Do not bake it into the Blueprint. `BASE_SEPOLIA_RPC_URL` must be a Base Sepolia endpoint. The process checks `eth_chainId` and refuses `1` and `8453` before `eth_sendRawTransaction`.

`CORS_ORIGINS` in the Blueprint includes `https://agent-a-wallet-ux.pages.dev` plus local Vite origins. Wallet UX signs a `ClaimIntent` with the connected wallet. It does not send a shared secret. `INTENT_NONCE_PATH` is `/tmp/claim-relayer/intent-nonces.jsonl` (ephemeral). `ERC1271_ENABLED` stays `0`. Abuse-limit variables keep the code defaults unless the dashboard overrides them.
