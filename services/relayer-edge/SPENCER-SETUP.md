# Spencer setup for the Agent-B.V. relayer edge Worker

The D1 database agent-bv-sanctions (id 027bb34d-bd12-4c43-acdf-294cf40a11a2) was created by Blockchain Builder through the wrangler CLI on 2026-10-30 at 11:25 EDT. The Worker agent-bv-relayer-edge deploy (version dd2e2efb, from 2f3a724) and remote migration 0001 ran on 2026-10-30. Do not run `wrangler --remote`.

`wrangler` is a devDependency at 4.124.0. It is not installed globally. `npm test` runs the proxy tests, the Miniflare D1 tests, then `npx wrangler deploy --dry-run`. That dry-run compiles the Worker and does not upload it. Agents do not run `wrangler deploy`, `--remote`, `secret put`, or `d1 create`.

A direct caller who has RELAYER_EDGE_AUTH could forge location headers and x-edge-client-ip. Without it, the origin treats the request as off-edge and denies.

The Worker name is `agent-bv-relayer-edge`. It proxies to `https://bot-verifier-claim-relayer.onrender.com`. Wallet UX calls `https://agent-bv-relayer-edge.s-a-wight72.workers.dev`. The origin must be reachable only through this proxy.

Do this on your Mac, from a checkout of this branch. The working directory is `services/relayer-edge`.

1. Use the Cloudflare account whose workers.dev subdomain is `s-a-wight72`, the account that owns `agent-bv.pages.dev`.
2. Run `npx wrangler login`.
3. Run `npx wrangler secret put RELAYER_EDGE_AUTH` and paste the value at the prompt. Use a high-entropy value. If it leaks, rotate it. Do not put the value in this repo, in `wrangler.toml`, in `.dev.vars`, or in the pull request.
4. Set that same value on the Render service `bot-verifier-claim-relayer` as `RELAYER_EDGE_AUTH`. `claim-relayer/render.yaml` already lists the key with `sync: false` and no value. The dashboard value is not overwritten from git.
5. Run `npx wrangler deploy`. The workers.dev route is `https://agent-bv-relayer-edge.s-a-wight72.workers.dev`. That route is the URL in `apps/wallet-ux/build-env.required.json`. If the account subdomain is different, stop. Do not publish wallet-ux until the pinned URL is the route you attached.
6. Close public access to the Render origin so it is reachable only through this Worker. Leave `LIVE_SUBMIT`, `KILL_SWITCH`, and `POINTS_ENABLED` as they are.
7. The D1 database `agent-bv-sanctions` is already created. Its id is in `wrangler.toml` under `[[d1_databases]]` binding `SANCTIONS_DB`. Agents do not create it. Remote migration 0001 ran on 2026-10-30. From `services/relayer-edge`, a later migration is `npx wrangler d1 migrations apply agent-bv-sanctions --remote`. Then confirm `UPDATE` and `DELETE` on `sanctions_release_audit`, `sanctions_session_audit`, and `sanctions_tie_audit` each fail with `append-only`.
8. Generate the data secret with `openssl rand -hex 32`. Run `npx wrangler secret put RELAYER_DATA_AUTH` and paste that value. Set the same value on the Render service `bot-verifier-claim-relayer` as `RELAYER_DATA_AUTH`. Set `SANCTIONS_DATA_URL` to `https://agent-bv-relayer-edge.s-a-wight72.workers.dev/internal/sanctions`. Set `SANCTIONS_DATA_TIMEOUT_MS` to `3000`. Delete `SANCTIONS_DB_PATH` on Render. Do not put the secret in git.
9. D1 free plan limits are 100k writes a day, 5M reads a day, and 500 MB. The counters reset at 00:00 UTC (8 PM ET). A query that hits a cap fails until the reset, and the relayer fails closed. A paid D1 plan is Spencer's call.

While `RELAYER_EDGE_AUTH` is unset, every public path returns 503 and the Worker does not call the origin. `/internal/sanctions` and `/internal/sanctions/*` are the sanctions data API. They are never forwarded. An unset `RELAYER_DATA_AUTH` returns 503 on those paths and does not call the origin.
