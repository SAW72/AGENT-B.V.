# Open PR review notes

Date: 2026-10-19, after PR #107 merged at 13:17:36 UTC (`0ebc4ec`, "claim-relayer: global rate limit and gas caps"). Nine pull requests were open on `SAW72/AGENT-B.V.` at review time. Tips below are the heads GitHub reported then.

`GET /health` on `bot-verifier-claim-relayer.onrender.com` at 17:41:18 UTC was serving that commit. `liveSubmit` was false. Blockers were `spencer_run_auth_required` and `live_submit_off`. `killSwitch` was false. Render env was not changed.

A merge to `main` auto-deploys that Render service. Docs-only merges restart it too. None of the nine PRs edit `claim-relayer/abuseLimits.mjs`, `claim-relayer/broadcast.mjs`, or the `CLAIM_RATE_*` / `CLAIM_MAX_*` settings. The claim gate from #107 stays: global default 60 requests per 60 seconds (`CLAIM_RATE_GLOBAL`), per-IP default 30 (`CLAIM_RATE_IP`), and per-transaction caps of 500000 gas, 5 gwei max fee, and 2 gwei priority fee. Over the rate cap or a gas cap, nothing is signed or broadcast.

The claim route limiter and the reputation route limiter are different objects in the same process. Reputation reads `config/reputation/sepolia.json` and limits at `read_api.rate_limit_per_minute` (60). Both can return `429` `rate_limited`. A change to the reputation JSON or `claim-relayer/reputation/*` ships on the next relayer deploy. A change that stays inside `services/points-indexer/` does not change claim signing. The indexer `render.yaml` files under `claim-relayer/` and `services/points-indexer/` are reference blueprints, not a repo-root Blueprint, so a merge does not register a new Render service by itself.

This review did not merge anything, did not push to PR #104's branch, and did not change `LIVE_SUBMIT`, `SPENCER_RUN_AUTH`, `KILL_SWITCH`, or `POINTS_ENABLED`.

## Points indexer, in priority order

### #102 read-only preview routes

Draft. Head `c804aac`. Base `cursor/ledger-rebuild-when-needed-1181` (#105), not `main`. GitHub: MERGEABLE against that base. About +5726 / −28 across 16 files, 15 commits. The GitHub file list is the read API. The branch also contains the #103 and #105 commits underneath.

Adds an off-by-default read API for committed ledger rows: `GET /v1/points/config`, `GET /v1/points/:address`, and history. `POINTS_ENABLED` is on only for the exact string `true`. The read limiter defaults to 60 per minute (`POINTS_READ_RATE_PER_MINUTE`). `POINTS_TRUSTED_PROXY_HOPS` defaults to 0, so `X-Forwarded-For` is ignored unless an operator sets a hop count. A breaker opens after consecutive store failures. `render.yaml` in the package stays a reference file and says a live echo check is required before `POINTS_ENABLED` is set. Checklist #7 stays open: `points_total` is 0 and `points_withheld` is true.

Risk against #107: no claim-route or gas-cap edits. The read limiter is a second process with its own numbers. It does not replace `CLAIM_RATE_GLOBAL`. The PR does rename `bvt_securities_disclaimer` to `legal_notice_url` in `config/reputation/sepolia.json`. The live relayer loads that file and still reads the old key (`claim-relayer/reputation/reputationConfig.mjs`). The slot is an empty string today, so the served link stays blank under the old key. Landing #102 alone splits the file key from the relayer code key. #104 edits the same JSON and `.github/workflows/ci.yml`.

Recommendation: merge only after #103 and #105 are on `main`, and retarget this PR to `main` first. Leave `POINTS_ENABLED` unset. Keep the claim relayer's link key and this file key in one change, or leave the JSON key alone until that code change has a decision.

### #105 ledger rebuild only when a pass can change it

Draft. Head `e0d648a`. Base `cursor/getlogs-pace-backoff-fa8a` (#103), not `main`. GitHub: MERGEABLE against that base. About +944 / −20 across 4 files, 4 commits. Files: `services/points-indexer/src/main.mjs`, two tests, and the indexer README.

A pass sets `dirty` when it inserts a raw log, when the stored finalized head crosses a stored log, or when that crossing check throws. `indexer.rebuild()` runs only when `dirty` is set. A failed rebuild leaves `ledgerStale` and `lastError` `rebuild_error` so the next pass retries. A pass that inserts nothing and does not cross a stored log skips the replay. The code comment still says a partial replay is not wired. `setFinalizedBlock` is called with `rebuild: false` so the head move itself does not rebuild a second time.

Risk against #107: none of the claim-relayer files. A skipped rebuild cannot weaken the claim rate limit or the gas caps. The health flag `ledgerStale` is on the indexer process.

Recommendation: retarget onto `main` after #103 merges, then merge. The four commits are the whole PR once #103 is in `main`.

### #103 getLogs pacing

Draft. Head `c23b9cc`. Base `main`. GitHub: MERGEABLE. About +2855 / −74 across 7 files, 6 commits. New `services/points-indexer/src/pace.mjs`, plus indexer loop, README, tests, and a CI touch.

`eth_getLogs` is limited to five calls a second: 200 ms minimum gap (`POINTS_GETLOGS_MIN_GAP_MS`, allowed 100 to 60000, bad values fall back to 200). A retryable failure with no readable `Retry-After` waits 1 s, 2 s, then 4 s, up to 3 extra attempts (`MAX_SCAN_RETRIES`). One in-pass sleep is capped at 30 s. A longer `Retry-After` is carried to the next pass, capped at 15 minutes. HTTP 429 and 5xx end the pass. The cursor does not move past a failed window. Chain id, code reads, and the finalized head use the same gap. Windows stay at most `POINTS_LOG_RANGE` (default 200).

Risk against #107: this 429 is the RPC provider's 429, handled inside the indexer. It is a different limiter from `POST /v1/claims`. Pacing numbers are the ones in the branch. An operator who sets `POINTS_GETLOGS_MIN_GAP_MS` below 100 gets the 200 ms default again, because values outside 100 to 60000 fall back.

Recommendation: merge this first in the indexer stack. It is the only one of #102 / #105 / #103 whose base is already `main`.

### #104 SQLite Durable Object port

Draft. Head `dbe0420`. Base `main`. GitHub: MERGEABLE. About +7958 / −18 across 49 files, 7 commits.

One SQLite Durable Object (`idFromName("base-sepolia")`) plus a Worker for `/health` and `/v1/points/*`. It reimplements pacing, the read API, and the rebuild gate in TypeScript beside the Node modules in #103, #105, and #102. `POINTS_ENABLED` is the same exact-string gate. Per-address limits on the Worker are separate again: health 12 per 60 s, points 20 per 60 s, and a global cap of 50 Durable Object wakes per 60 s. The PR text says the free-plan versus paid choice is still open, and invocation logs stay off.

It also edits the live relayer: `claim-relayer/reputation/reputationConfig.mjs`, `claim-relayer/reputation/runtime.mjs`, the reputation balance fixture, and `config/reputation/sepolia.json`. Empty disclaimer slots become `null` after an https check, and the key `bvt_securities_disclaimer` becomes `legal_notice_url`. Wallet UX reputation types and the view change with that key. Those edits deploy with the claim relayer. They do not change `CLAIM_RATE_GLOBAL` or the gas caps. They do change the reputation JSON on the service #107 just shipped.

This review does not modify the branch. Recommendation: do not merge #104. Pick one indexer stack. If the host is the Worker, drop the claim-relayer and wallet-ux edits, and reconcile with #102, #103, and #105 instead of landing both. The shared files with #102 are `.github/workflows/ci.yml` and `config/reputation/sepolia.json`. Shared docs with #101 are `docs/POINTS-ANNOUNCEMENT-DRAFT.md` and `docs/POINTS-PROGRAM.md`.

### #101 soft-launch scope docs

Draft. Head `5f532d2`. Base `main`. GitHub: MERGEABLE. About +167 / −59 across 4 docs, 5 commits.

`docs/AGENT-BV-POINTS-SPEC.md` is the scope S spec for an off-chain Base Sepolia record, chain id 84532. The disclaimer sentence is present and matches the approved wording: "Testnet only. Not a token. Can't be transferred, sold, or redeemed. May be adjusted or cancelled, and does not convert to anything." Scoring stays 0 until OFAC screening is configured. The announcement draft lists public words to avoid, including airdrop, reward, and conversion. `docs/POINTS-PROGRAM.md` is marked superseded.

Wording still open, from the 2026-10-19 backlog, checked against this head: the spec still mentions `deployments/base-sepolia.json` `BVT.address` as null. The announcement says points are recorded for activity, and the spec says the ledger is shown for the connected wallet. The four docs do not say outreach is open for the beta. Those are doc fixes, not relayer fixes.

Risk against #107: no runtime files. A merge still redeploys the claim relayer. No overlap with the rate-limit code. Overlap with #104 is the two points docs above.

Recommendation: safe to merge once the wording gaps above are either accepted or edited. Merge it on its own, before or after the indexer code. It does not depend on #103.

## The other four

### #99 source-map-js bump

Open, not draft. Dependabot. Head `b1b3b22`. Base `main`. GitHub: MERGEABLE. `apps/wallet-ux/package-lock.json` only, +3 / −23. Bumps devDependency `source-map-js` from 1.2.1 to 1.2.2.

Risk against #107: no relayer files and no claim path. A merge restarts the relayer because `main` auto-deploys.

Recommendation: merge any time. No order dependency.

### #96 wallet-ux required build env follow-up

Draft. Head `56950d1`. Base `main`. GitHub: MERGEABLE. About +484 / −57 across 10 files, 8 commits. Extends `require-build-env.mjs` and its tests, the claim-secret guard, CI, and the Pages deploy workflow. The guard still fails a deploy if `dist` or `build-env.required.json` contains `x-claim-secret` or `VITE_CLAIM_API_SECRET`.

Risk against #107: no change to the new claim limiter or gas caps. The secret guard matches the relayer, which does not treat `x-claim-secret` as auth. Shared docs with #86: `apps/wallet-ux/CLOUDFLARE_PAGES.md`.

Recommendation: merge before #86, then rebase #86.

### #86 served-site checks

Draft. Head `866e1ac`. Base `main`. GitHub: CONFLICTING. About +170 / −39 across 7 files, 1 commit. Real site build checks, a 404 page, and an `/app/index.html` redirect. Conflicts with current `main` on `apps/wallet-ux/CLOUDFLARE_PAGES.md` and `apps/wallet-ux/scripts/served-site.test.mjs`.

Risk against #107: no relayer code. The conflict is with later wallet-ux docs and tests on `main`, including work after this branch was cut.

Recommendation: rebase onto current `main` after #96 if #96 merges. Do not merge while GitHub reports DIRTY.

### #83 retire the old Pages URL

Open, not draft. Head `97c2fb8`. Base `main`. GitHub: CONFLICTING. About +17 / −17 across 7 files, 2 commits. Replaces the old `agent-a-wallet-ux` Pages URL in docs, including `claim-relayer/README.md` and `claim-relayer/CUTOVER.md`. `CUTOVER.md` still tells an operator to delete `VITE_CLAIM_API_SECRET` in the Cloudflare dashboard. This review did not do that dashboard edit.

The file both this branch and `main` changed since the merge base is `claim-relayer/README.md`. #107 wrote the rate-limit and gas-cap documentation into that README. A careless conflict resolution can drop those sections. Runtime code is untouched if the resolution stays in the README.

Risk against #107: documentation conflict on the file that records the new limits. No conflict in `abuseLimits.mjs`.

Recommendation: rebase onto `0ebc4ec` and keep the #107 rate-limit and gas-cap sections. Then it can merge. It does not need to wait for the indexer stack.

## Merge order

1. Rebase #83 onto `main` and keep the PR #107 README sections. Merge #83.
2. Merge #101 when the wording gaps (BVT address mention, the connected-wallet sentence, outreach) are accepted or edited.
3. Merge #103 into `main`.
4. Retarget #105 to `main`. Merge #105.
5. Retarget #102 to `main`. Merge #102 only with `POINTS_ENABLED` left unset, and with a decision on the `legal_notice_url` key the relayer still does not read.
6. Merge #99 whenever. It has no stack dependency.
7. Merge #96, then rebase #86 onto that `main` and merge #86.
8. Do not merge #104.

Every step redeploys `bot-verifier-claim-relayer`. None of these steps should set `LIVE_SUBMIT`, `SPENCER_RUN_AUTH`, `KILL_SWITCH`, or `POINTS_ENABLED`.
