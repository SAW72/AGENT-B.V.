# Open pull request review

Reviewed 2026-10-19 against `main` at `0ebc4ece4af11da6fe775b8f2ab9e74c529a5806` (PR #107, merged 13:17 UTC). That commit is what `bot-verifier-claim-relayer` was serving: global claim cap 60 per 60 seconds, per-transaction gas caps, `liveSubmit: false`.

Nine pull requests were open. CI on each head was green. This note does not merge any of them. A merge to `main` deploys the claim relayer, the same way #107 deployed. None of the nine change `abuseLimits.mjs`, `broadcast.mjs` gas caps, `LIVE_SUBMIT`, `SPENCER_RUN_AUTH`, or `KILL_SWITCH`.

`#102` and `#105` are mergeable into their parent branches. They are not standalone merges onto `main`.

## Merge order

1. **#101** docs for soft-launch scope S. Clean against `main`. Docs only. Does not set `POINTS_ENABLED`.
2. **#103** getLogs pacing. Clean against `main`. Base of the points-indexer stack.
3. **#105** ledger rebuild. Rebase onto `main` after #103 is squash-merged, then merge. The branch contains #103's commits. Squashing #103 and then merging #105 without a rebase replays those commits.
4. **#102** read-only preview routes. Rebase onto the updated `main` after #105, then merge. `POINTS_ENABLED` stays off unless the env is the exact string `true`. This blueprint does not set it.
5. **#96** wallet-ux build env. Independent of the stack. Clean against `main`.
6. **#99** `source-map-js` 1.2.1 to 1.2.2, lockfile only. Clean against `main`.
7. **#86** then **#83**, after a rebase. Both conflict with `main` today.
8. **#104** stays closed. Do not merge it.

Hold #104 even though GitHub reports it mergeable and CI is green. It is a second points indexer (Cloudflare SQLite Durable Object) beside the Node stack in #103, #105, and #102. It also changes the claim relayer's reputation payload, so a merge would deploy that change. `POINTS_ENABLED` is intentionally absent from its `wrangler.toml`.

## Points-indexer stack

### #103 — pace getLogs and end a pass on 429 or 5xx

Branch `cursor/getlogs-pace-backoff-fa8a`, base `main`, +2855/−74, mergeable.

Adds `services/points-indexer/src/pace.mjs`. getLogs calls keep a 200 ms gap (five per second). A retryable failure waits 1 s, 2 s, then 4 s, with at most three extra attempts. `Retry-After` sleeps at most 30 seconds inside the pass and can carry the rest, up to 15 minutes, into the next pass. HTTP 429 is not treated as a block-range error. A 429, 5xx, or network failure on getLogs ends the pass instead of walking the rest of the range. CI includes a large pace test file.

No claim-relayer files. No overlap with the global claim bucket or the gas caps. The indexer's 429 is an RPC response from the chain provider. The relayer's 429 is `rate_limited` or `gas_cap` on `POST /v1/claims`.

Merge this before #105 and #102.

### #105 — rebuild the ledger only when a pass can change it

Branch `cursor/ledger-rebuild-when-needed-1181`, base `cursor/getlogs-pace-backoff-fa8a` (#103), +944/−20, mergeable into that base. The branch contains #103 (`c23b9cc` is an ancestor).

`indexer.rebuild()` runs when the pass inserted a raw log, or when the new finalized head moves over a stored log. A pass that inserts nothing and does not cross a stored log skips the replay. A failed rebuild sets `ledgerStale` and `lastError: rebuild_error` and stays due on the next pass. The stored head is updated with `{ rebuild: false }` before that decision, and a throw while deciding the crossing leaves the stored head where it was. The comment in `main.mjs` still says a partial replay is not wired.

Depends on #103's early exit: a 429 that ends the pass must not look like a clean pass that skips a needed rebuild. Landing #105 without #103's pass result would drop that coupling.

No claim-relayer files. No change to #107's caps. After a squash of #103, rebase this branch onto `main` before merging.

### #102 — read-only Base Sepolia preview routes

Branch `cursor/points-read-api-5ba0`, base `cursor/ledger-rebuild-when-needed-1181` (#105), +5726/−28, mergeable into that base. The branch contains #105 and therefore #103.

Adds `readApi.mjs`, a SQLite read store, and `readEdge.mjs`. Routes are `GET /v1/points/config`, `GET /v1/points/:address`, and `GET /v1/points/:address/history`. Other methods on those paths are 405. `POINTS_ENABLED` is on only for the exact string `"true"`. Anything else, including unset, returns 503 `points_disabled` before the handler reads the store. The reference `services/points-indexer/render.yaml` does not set `POINTS_ENABLED`. It sets `POINTS_TRUSTED_PROXY_HOPS` to `"0"` and says a live echo check is required before that flag is turned on and before the hop count is raised. `POINTS_CLOUDFLARE_INGRESS` is not set. The file lives under `services/points-indexer/`, not at the repo root, so merging it does not register a new Render blueprint.

The read limiter is separate from the claim relayer's IP and global buckets. A 429 here is `rate_limited` on the points preview, with `Retry-After`. It does not share memory with `claim-relayer/abuseLimits.mjs`.

`dockerfilePath` moves to `./services/points-indexer/Dockerfile` with context at the repo root, so the image can copy `config/reputation/sepolia.json`. That file is reference-only until a points service is created. It does not change the claim relayer's Docker or start command.

Leave `POINTS_ENABLED` unset when this merges. Rebase onto `main` after #103 and #105.

### #101 — Base Sepolia points soft-launch scope S

Branch `cursor/points-soft-launch-docs-2254`, base `main`, +167/−59, mergeable. Files: `docs/AGENT-BV-POINTS-SPEC.md`, `docs/POINTS-AND-ACCOUNTABILITY.md`, `docs/POINTS-ANNOUNCEMENT-DRAFT.md`, `docs/POINTS-PROGRAM.md`.

Scope S is documentation. The spec status becomes a public testnet beta with open signup, Base Sepolia only, chain id 84532. Weights, same-pair caps, and the minimum escrow amount stay **TBD**. Checklist #12 stays open. The disclaimer sentence is fixed: "Testnet only. Not a token. Can't be transferred, sold, or redeemed. May be adjusted or cancelled, and does not convert to anything." The announcement file says not to publish it, and that a lawyer reviews the first public post and a screenshot. No contract diff. No `POINTS_ENABLED`. No claim-relayer code.

Merging the doc does not launch points. It overlaps the announcement docs that #104 also edits, so merge #101 before any later rebase of #104.

### #104 — SQLite Durable Object port

Branch `cursor/points-worker-cloudflare-5bfd`, base `main`, +7958/−18, mergeable, CI green. **Do not merge.**

The Worker under `services/points-indexer/cloudflare/` reimplements pacing, scanning, and read routes on a SQLite Durable Object (`PointsObject`). `wrangler.toml` leaves `POINTS_ENABLED` and `BASE_SEPOLIA_RPC_URL` unset. Unset points routes return 503, and `/health` does not wake the Durable Object. Rate-limit namespaces are 20, 12, and 50 per 60 seconds. Those counters are not the claim relayer's.

The three-dot diff also edits the claim relayer:

- `claim-relayer/reputation/reputationConfig.mjs` keeps only https links and renames `bvt_securities_disclaimer` to `legal_notice_url`.
- `claim-relayer/reputation/runtime.mjs` returns that new key.
- A fixture balance JSON line and `claim-relayer/test/legalNoticeUrl.test.mjs`.

Git merge-tree against `main` is clean, including against the #107 rate-limit files. The reputation change is still a behavior change on the running service: `GET` reputation payloads would drop `bvt_securities_disclaimer` and add `legal_notice_url`. A merge to `main` deploys the claim relayer, so this would ship. It does not change quote or claim submit, the global cap, or the gas caps.

#104's `pace.ts` and `read-api.ts` duplicate #103 and #102. Landing both indexers leaves two writers for one ledger. Wallet UX reputation types move with this PR as well.

Hold the pull request. If it is rebased later, rebase it after #101 so the points docs resolve in one place, and split the claim-relayer reputation edit out of the Worker port.

## The other four

### #96 — wallet-ux required build env

Branch `cursor/wallet-ux-build-env-followup-8253`, base `main`, +484/−57, mergeable, CI green.

`require-build-env.mjs` pins `VITE_CLAIM_RELAYER_URL` to `https://bot-verifier-claim-relayer.onrender.com` (and that origin with `/` or `/v1/claims`). The build inlines the allowlist entry. An RPC host must be `https://sepolia.base.org` with no port, or must answer `eth_chainId` 84532. The script rejects userinfo and strings that look like keys. No claim-relayer source change. No live-submit flag.

Safe to merge on its own, before or after the points stack. The merge redeploys the relayer process and does not change relayer source.

### #99 — source-map-js 1.2.1 to 1.2.2

Branch `dependabot/npm_and_yarn/apps/wallet-ux/source-map-js-1.2.2`, base `main`, lockfile only, mergeable, CI green.

The resolved tarball becomes `source-map-js-1.2.2.tgz`. The same diff drops `"dev": true` on a few optional platform packages in `apps/wallet-ux/package-lock.json`. No application source. No claim-relayer files. Low risk. Merge after #96 if both touch the wallet lockfile; this PR does not touch `package.json`, and #96 does not touch the lockfile, so they are unlikely to conflict.

### #86 — served-site checks

Branch `cursor/served-site-low-fixes-21d3`, base `main`, +170/−39. CI on the head is green. GitHub reports **CONFLICTING**. `git merge-tree` conflicts on `apps/wallet-ux/CLOUDFLARE_PAGES.md`.

The branch checks the assembled site, adds a 404 page, and redirects `/app/index.html`. Wallet UX only. No claim-relayer files, so no interaction with the rate limit or gas caps. Later wallet docs on `main` are what conflict. Rebase onto `main` and re-run CI before merge. Parts of this may already be covered by wallet PRs merged after 13 Oct.

### #83 — retire the old Pages URL

Branch `cursor/retire-old-pages-docs-9b91`, base `main`, +17/−17. CI on the head is green. GitHub reports **CONFLICTING**. `git merge-tree` conflicts on `apps/wallet-ux/CLOUDFLARE_PAGES.md` and `apps/wallet-ux/README.md`.

The three-dot diff also edits `claim-relayer/README.md` and `claim-relayer/CUTOVER.md`. Those hunks do not change cap numbers. They say `agent-a-wallet-ux` is retired, name a Base Sepolia refund tx `0x794a3b2258a3a0ff044bfaf2373d8ec8ed24408f7edfcdd5d861dc1368bd5e7d` (block 48034931), and say not to add that origin to `CORS_ORIGINS`. merge-tree did not report a conflict in those two relayer files against #107. This review did not re-check that transaction on chain.

Rebase before merge so the wallet doc conflict is resolved without dropping the #107 rate-limit section of `claim-relayer/README.md`. Do this after #86 if both are rebased, because they share `CLOUDFLARE_PAGES.md`.

## What #107 does not collide with

| PR | Touches claim-relayer? | Against the new caps |
| --- | --- | --- |
| #103 | no | none |
| #105 | no | none. Rebase after #103 |
| #102 | no | none. Read-route 429 is a different process. Leave `POINTS_ENABLED` unset |
| #101 | no | none. Docs do not enable points |
| #104 | yes, reputation links | git-clean, and it would deploy a reputation JSON change. Do not merge |
| #96 | no | none. Pins the existing relayer origin |
| #99 | no | none |
| #86 | no | none. Rebase the wallet doc conflict first |
| #83 | yes, README and CUTOVER wording | no cap change. Rebase the wallet doc conflict and keep the #107 README section |
