# Spencer setup for the Agent-B.V. relayer edge Worker

Agents ran none of these steps. No agent logged in, deployed, or set a secret. No Cloudflare resources were created from this branch. Do not run `wrangler --remote`.

`wrangler` is a devDependency at 4.124.0. It is not installed globally. `npm test` runs the proxy tests, then `npx wrangler deploy --dry-run`. That dry-run compiles the Worker and does not upload it. There is no D1 database on this Worker, so there is no migration to apply.

The Worker name is `agent-bv-relayer-edge`. It proxies to `https://bot-verifier-claim-relayer.onrender.com`. Wallet UX calls `https://agent-bv-relayer-edge.s-a-wight72.workers.dev`. The origin must be reachable only through this proxy. A direct caller can forge location headers and `CF-Connecting-IP`.

Do this on your Mac, from a checkout of this branch. The working directory is `services/relayer-edge`.

1. Use the Cloudflare account whose workers.dev subdomain is `s-a-wight72`, the account that owns `agent-bv.pages.dev`.
2. Run `npx wrangler login`.
3. Run `npx wrangler secret put RELAYER_EDGE_AUTH` and paste the value at the prompt. Use a high-entropy value. If it leaks, rotate it. Do not put the value in this repo, in `wrangler.toml`, in `.dev.vars`, or in the pull request.
4. Set that same value on the Render service `bot-verifier-claim-relayer` as `RELAYER_EDGE_AUTH`. `claim-relayer/render.yaml` already lists the key with `sync: false` and no value. The dashboard value is not overwritten from git.
5. Run `npx wrangler deploy`. The workers.dev route is `https://agent-bv-relayer-edge.s-a-wight72.workers.dev`. That route is the URL in `apps/wallet-ux/build-env.required.json`. If the account subdomain is different, stop. Do not publish wallet-ux until the pinned URL is the route you attached.
6. Close public access to the Render origin so it is reachable only through this Worker. Leave `LIVE_SUBMIT`, `KILL_SWITCH`, and `POINTS_ENABLED` as they are.

While `RELAYER_EDGE_AUTH` is unset, every path except `/internal/sanctions/*` returns 503 and the Worker does not call the origin. `/internal/sanctions` and `/internal/sanctions/*` return 404 and are never forwarded.
