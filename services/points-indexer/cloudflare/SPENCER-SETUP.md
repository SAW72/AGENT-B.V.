# Spencer setup for the Agent-B.V. points Worker

Agents ran none of these steps. No agent logged in, deployed, or set a secret. No Cloudflare resources were created from this branch.

Do this on your Mac, from a checkout of this branch. The working directory is `services/points-indexer/cloudflare`.

1. Use the Cloudflare account that owns `agent-bv.pages.dev`, or create a free account and keep this Worker on that same account.
2. Run `npx wrangler login`.
3. Run `npx wrangler deploy`. The `v1` migration creates the Worker and the SQLite Durable Object class `PointsObject`. No D1 database is used.
4. Set `BASE_SEPOLIA_RPC_URL` yourself. If the endpoint is keyed, run `npx wrangler secret put BASE_SEPOLIA_RPC_URL` and paste the value at the prompt. Otherwise set it as a plain var to the public Base Sepolia JSON-RPC endpoint. Do not commit the value. This repo does not contain it.
5. Leave `POINTS_ENABLED` unset until the Verifier gives GO. While it is unset, `/v1/points/*` returns 503 `points_disabled`. `/health` stays available.
6. Later, when the lookup UI exists, put the Worker URL in `apps/wallet-ux` and rebuild that app. Do that only after the Verifier GO.
7. Confirm the Render dashboard has no `points-indexer` service. `services/points-indexer/render.yaml` says nothing there is deployed. There is nothing to retire.
