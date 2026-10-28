# Integration API

Simple REST surface for banks and platforms.

## Endpoints

### GET /v1/bots/{botId}
Returns the bot's current status: tier, denylist status, latest fingerprint, insurance level, stamp.

### GET /v1/bots/{botId}/stamp
Returns the signed trust stamp (JWT or on-chain reference).

### GET /v1/bots/{botId}/history
Returns the background check rap sheet: version history, incidents, provenance.

### POST /v1/access/check
Body: `{ "botId": "...", "requestedPermissions": ["read_balance", "transfer"] }`
Returns: `{ "allowed": true/false, "reason": "...", "requiredTier": 3 }`

### GET /v1/denylist/{fingerprint}
Returns whether a fingerprint is denylisted and at what match level (exact / behavioral / prompt).

## Auth
Operator key (`STAMP_API_KEY`, sent as `X-API-Key` or `Authorization: Bearer`) is required for privileged writes:

- `POST /v1/bots` — register (server binds `fingerprint_hash` to `sha256(canonical(fingerprint))`)
- `POST /v1/denylist/{fingerprint}` — denylist writes
- `POST /v1/bots/{botId}/history` — rap-sheet append (capped, append-only)

Public / bank read surface (no operator key):

- `GET /health`, `GET /v1/bots/{botId}`, `GET /v1/bots/{botId}/stamp`, `GET /v1/bots/{botId}/history`, `GET /v1/denylist/{fingerprint}`
- `POST /v1/access/check`

Unauthenticated privileged calls are rejected (401). If `STAMP_API_KEY` is unset, privileged writes fail closed (503).

Software-scored registrations are the judgment (`scoring_mode=software`, `attestation_grade: true`). `keyword` is the same mode. `scoring_mode=llm_judge` is guidance only and `require_attestation` refuses it. The score can still be wrong or gamed.

## Rate Limits
High for verification endpoints. Low for history endpoints.

## SDKs
Provide thin SDKs for:
- Python
- JavaScript/TypeScript
- Solidity (for on-chain checks)
