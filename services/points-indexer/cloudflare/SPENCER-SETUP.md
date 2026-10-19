# Spencer setup for the Agent-B.V. points Worker

Agents ran none of these steps. No agent logged in, deployed, or set a secret. No Cloudflare resources were created from this branch.

Do this on your Mac, from a checkout of this branch. The working directory is `services/points-indexer/cloudflare`.

1. Use the Cloudflare account that owns `agent-bv.pages.dev`, or create a free account and keep this Worker on that same account.
2. Run `npx wrangler login`.
3. Run `node check-chain.mjs`. It reads `CHAIN_ID` from `wrangler.toml` and exits if the value is not `84532`. The Worker reads the same variable on every alarm and refuses any other chain. Do not continue if this step fails.
4. Run `npx wrangler deploy`. The `v1` migration creates the Worker, the SQLite Durable Object class `PointsObject`, and the `POINTS_RATE_LIMITER` binding (`namespace_id` `1001`, 60 requests per 60 seconds). No D1 database is used. `/health` and `OPTIONS` are not counted by that limiter and do not need it. A `/v1/points` request is limited in the front Worker before the Durable Object.
5. Set the RPC endpoint only with `npx wrangler secret put BASE_SEPOLIA_RPC_URL`, then paste the value at the prompt. Use your keyed endpoint or the public Base Sepolia JSON-RPC endpoint. A plain var is wiped by the next `wrangler deploy`. A secret is kept. Do not put the URL in `wrangler.toml`, `.dev.vars`, or the repo. The first alarms report `config_error` and reschedule until this secret exists.
6. Leave `POINTS_ENABLED` unset until the Verifier gives GO. Only the exact string `true` turns the indexer on. `TRUE`, `1`, `yes`, `on`, and a padded value stay off. While it is off, `/health` returns 503 `{ "status": "disabled" }` and does not wake the Durable Object. `OPTIONS` is answered in the front Worker and does not wake it either. `/v1/points/*` returns 503 `points_disabled`. When it is on, `/health` reads the Durable Object because that is where behind/ok is stored.
7. The Free plan allows 100,000 rows written per day. Reads do not write `rate_hits` (the front Worker limiter does that job). A caught-up alarm every 15 seconds writes a handful of `meta` rows, on the order of a few tens of thousands of row writes per day. A full day stuck in the 1 second catch-up loop, with a window write on every tick, can pass 100,000. Watch the row counter if the cursor stays behind.
8. Later, when the lookup UI exists, put the Worker URL in `apps/wallet-ux` and rebuild that app. Do that only after the Verifier GO.
9. Confirm the Render dashboard has no `points-indexer` service. `services/points-indexer/render.yaml` says nothing there is deployed. There is nothing to retire.

Traces are off, and log sampling is 0, so a keyed URL in a trace is not recorded. `.dev.vars` and `.wrangler/` are gitignored.
