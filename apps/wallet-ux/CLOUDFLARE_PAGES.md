# Cloudflare Pages (wallet UX)

The current Pages project is `agent-bv` (https://agent-bv.pages.dev). It is a Direct Upload project. It has no git connection. Cloudflare does not build it, and environment variables set in the Cloudflare dashboard are not used at build time.

The previous project `agent-a-wallet-ux` (https://agent-a-wallet-ux.pages.dev) stays live. Retire it only after a live refund passes on https://agent-bv.pages.dev. Do not delete or disable `agent-a-wallet-ux` before that. Relayer defaults now allow only https://agent-bv.pages.dev.

Wallet UX is a static Vite app. The claim relayer stays on Render (`claim-relayer/`, service `bot-verifier-claim-relayer`). It is not a Pages or Workers app. The claim API secret is retired. The production deploy never embeds one. The page does not embed a claim secret. Escrow submits go out through the connected wallet unless `VITE_CLAIM_RELAYER_URL` is set, in which case a refund can also be posted live to that Base Sepolia relayer. Release stays on the payer's wallet. The connected wallet signs the claim. Live submit is authorized by the wallet signature, not a shared secret.

[`wrangler.toml`](wrangler.toml) records the project name and `pages_build_output_dir = "./dist"`. That file is not a git connection. Cloudflare does not read it to build the site.

## Production deploy

Gates and Grok Bot's per-SHA GO apply to the PR head SHA. The set, in order, is CI, Look, QA, Verifier, Security, and Lawyer when copy or legal text changes, then Grok Bot's per-SHA GO for that head. A GO for a different SHA does not cover this head. Nothing reaches `main` without every gate on that head.

A squash merge creates a new commit. That merge SHA is what gets deployed and recorded. It is not the head SHA the GO named.

Spencer is still required for mainnet, spending, outside messages, and deletes.

Build at the merge SHA on Node 22. That major is `.node-version` in this directory. There is no `.nvmrc`, and `package.json` has no `engines` field. It is the same major as the `wallet-ux` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).

From a checkout of that SHA:

```bash
cd apps/wallet-ux
npm ci
cd ../../claim-relayer
npm ci
cd ../apps/wallet-ux
npm test
npm run build
node scripts/guard-claim-secret.mjs dist
```

`npm ci` in `claim-relayer` is required because the wallet-ux tests load that package as Node modules. `npm run build` runs `scripts/sync-book.mjs`, then `node scripts/require-build-env.mjs`, then `tsc --noEmit`, then `vite build` (output `dist/app`), then `scripts/assemble-site.mjs`. That script copies `landing/` onto `dist/`, so the landing page is at `/` and the wallet app is at `/app/`. `dist/` is gitignored. A clean claim-secret scan logs `Claim leak scan passed`. Do not upload if that command fails.

`npm run build` reads [`build-env.required.json`](build-env.required.json). That file sets `VITE_CLAIM_RELAYER_URL` to `https://bot-verifier-claim-relayer.onrender.com` and `VITE_BASE_SEPOLIA_RPC_URL` to `https://sepolia.base.org`. The build fails if either resolved value is empty and names the variable. A non-empty shell value overrides the file. An empty shell value fails the build; it does not fall back to the file. Leave `VITE_CLAIM_API_SECRET` unset. That name is retired. `npm run dev` still uses `https://sepolia.base.org` when `VITE_BASE_SEPOLIA_RPC_URL` is unset. Any RPC URL must answer `eth_chainId` with `84532`.

Before the production upload, note the deployment ID of the live production deployment (the current `main` deployment). That ID is the rollback target. Preview deployment IDs are not rollback targets.

Direct Upload has no promote. Upload the same `dist` twice. Wrangler reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment. The token is **Pages:Edit** scope only. Do not store either value as a repository secret.

Preview, with `<PR#>` the pull request that produced the merge and `<sha>` the merge SHA:

```bash
npx wrangler pages deploy dist --project-name=agent-bv --branch=preview-<PR#> --commit-hash=<sha>
```

Live-check that preview deployment before uploading `main`. From `apps/wallet-ux`, run the served-bundle check against the deployment URL Wrangler prints. `DEPLOYMENT_URL` is required. `APP_PATH` defaults to `/`, which is the landing page and has no hashed bundle, so set it to `/app/`. `DIST_INDEX` defaults to `dist/index.html`; the built app index is `dist/app/index.html`.

```bash
DEPLOYMENT_URL="<deployment-url>" APP_PATH=/app/ DIST_INDEX=dist/app/index.html node scripts/verify-served-bundle.mjs
```

The script fetches `<deployment-url>/app/`, requires that HTML to reference the same `/app/assets/*` hashes as `dist/app/index.html`, downloads those `.js` files and any `./chunk.js` imports, and requires a JavaScript content type. An empty script, or a body that starts with `<` after a UTF-8 BOM and leading whitespace, fails the check. It then runs `scripts/guard-escrow-addresses.mjs` and `scripts/guard-claim-secret.mjs` on the served HTML plus JavaScript. A pass logs `Served bundle at <url> passed the escrow, phrase, and claim-secret checks.` A failure prints `Verify failed:` and exits non-zero.

The same preview URL also has to pass these checks. The script does not cover them:

- `GET /` returns 200.
- `GET /app/` returns 200.
- Asset content types are right. Wallet JavaScript (`/app/assets/*.js`) is `text/javascript`, `application/javascript`, or `application/x-javascript` (a `charset` parameter is fine). Landing CSS is `text/css`. Landing PNG assets are `image/png`.
- Redirects go to `/app/`. `/app` (no trailing slash), `/points`, `/claim`, and `/release` are 301 to `/app/`. The destination has no query string, so Pages keeps the incoming query string.
- The security headers are present: `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`.

A failed preview check stops the deploy. Do not upload `--branch=main`.

Then deploy production with the same `dist` and the same merge SHA:

```bash
npx wrangler pages deploy dist --project-name=agent-bv --branch=main --commit-hash=<sha>
```

Run `scripts/verify-served-bundle.mjs` again with `DEPLOYMENT_URL` set to the production deployment URL Wrangler prints, and the same `APP_PATH` and `DIST_INDEX`. Run the same `/`, `/app/`, content-type, redirect, and security-header checks against `https://agent-bv.pages.dev`. If any production check fails, roll back to the production deployment ID noted before this upload. Follow Rollback below.

### Deploy record

Write one record for the deploy. The head SHA is the PR head the gates and the GO covered. The merge SHA is the squash commit that was built, uploaded, and checked.

```
PR:
head SHA:
merge SHA:
preview deploy ID:
production deploy ID:
rollback target:
relayer deploy ID:
/health build.commit:
relayer rollback target:
VITE_CLAIM_RELAYER_URL:
check results:
```

`VITE_CLAIM_RELAYER_URL` is the public URL baked into that build. A build that passes has it set: the checked-in URL, or a non-empty shell override. It is not a secret. `/health build.commit` is the full 40-character SHA from `GET /health`. The relayer rollback target is the last good Render deploy ID.

| Name | Where | Role |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Environment of the deploy command. Never a repository secret. | API token with **Pages:Edit** scope only. Wrangler uses it to upload `dist`. |
| `CLOUDFLARE_ACCOUNT_ID` | Environment of the deploy command. Never a repository secret. | Cloudflare account that owns `agent-bv` and the still-live `agent-a-wallet-ux` project. |
| `VITE_CLAIM_RELAYER_URL` | [`build-env.required.json`](build-env.required.json). Not a GitHub variable. | Public `https://bot-verifier-claim-relayer.onrender.com`. `npm run build` fails if the resolved value is empty. A non-empty shell value overrides the file. The relayer button stays off until `GET /health` is up and not paused. The connected wallet signs the claim. Do not set a claim secret. |
| `VITE_BASE_SEPOLIA_RPC_URL` | [`build-env.required.json`](build-env.required.json). | Public `https://sepolia.base.org`. `npm run build` fails if the resolved value is empty. `npm run dev` uses that URL when the variable is unset. Any URL must answer `eth_chainId` with `84532`. |
| `VITE_CLAIM_API_SECRET` | Retired. Must not exist anywhere. | Do not set a claim secret on Pages. Not a repository secret, not an environment secret or variable, and not a Cloudflare Pages environment variable. |

### Relayer submit

The claim API secret is retired. Do not set a claim secret on Pages. Relayer authentication is EIP-712 signed intents (PR #46). The connected wallet signs the claim. Live submit is authorized by the wallet signature, not a shared secret. Wallet submit still works. This deploy does not pass a claim secret into the build.

Signed-intent auth is live in production only after cutover. The order is `claim-relayer/CUTOVER.md` in [PR #51](https://github.com/SAW72/AGENT-B.V./pull/51).

### Stale workflow

[`.github/workflows/deploy-wallet-ux.yml`](../../.github/workflows/deploy-wallet-ux.yml) is stale and unused. Its checks are outdated. A backlog fix is pending. Do not delete the file. `on` is `workflow_dispatch` only, so a push or a pull request does not publish. Do not run **Actions → Deploy wallet-ux**. Production is the merge-SHA build and `wrangler pages deploy` above. If that file is run anyway, its build reads [`build-env.required.json`](build-env.required.json) and does not pass `vars.VITE_CLAIM_RELAYER_URL`. An empty shell value fails the build; it does not fall back to the file.

## Claim relayer

Render auto-redeploys the claim relayer (`bot-verifier-claim-relayer`) on every merge to `main`. The required auto-deploy setting is **After CI Checks Pass** (`autoDeployTrigger`: `checksPass`), so the service deploys only after the merge-commit CI on `main` goes green.

As of 2026-10-13 the service is still on **On Commit** (`autoDeployTrigger`: `commit`). The switch is waiting on Spencer in the Render dashboard.

Until it is switched, the relayer goes live as soon as the merge lands, before merge-commit CI finishes. The post-merge `GET /health` check is mandatory after every merge. Require HTTP 200, `ok` true, `chainId` 84532, `killSwitch` false, and `build.commit` equal to the full 40-character merge SHA. Render sets that field from `RENDER_GIT_COMMIT`. If any of those fail, roll the relayer back as follows.

### Relayer rollback

1. Open the Render service `bot-verifier-claim-relayer`.
2. Open **Deploys**.
3. Pick the last good deploy ID recorded in the deploy record (the relayer rollback target).
4. Choose **Rollback**.

A dashboard rollback turns auto-deploy off. After the incident, turn auto-deploy back on with the trigger set to **After CI Checks Pass** (`checksPass`), not **On Commit**.

After the rollback, `GET /health` must return HTTP 200 with `build.commit` equal to the full 40-character SHA of the previous good merge, `chainId` 84532, and `killSwitch` false.

The bad commit is still on `main`. The next auto-deploy will ship it again unless that commit is reverted through a gated revert PR first. Turn auto-deploy back on only after that revert.

Once the setting is **After CI Checks Pass**, finding it back on **On Commit** is a gate gap. Report it.

The per-PR-head GO is still the gate before merge, so nothing reaches `main` without every gate.

## Warning

> **Warning:** Any `VITE_` variable is embedded in the public JavaScript bundle. `VITE_CLAIM_API_SECRET` is retired and must not be set. A value of that name in the bundle is not confidential and is not relayer authentication. Relayer authentication is EIP-712 signed intents (PR #46). Signed-intent auth is live in production only after cutover.

Do not put `PRIVATE_KEY`, `RELAYER_PRIVATE_KEY`, `SPENCER_RUN_AUTH`, `LIVE_SUBMIT`, or `ADMIN_SECRET` on this deploy or on the Pages project. Those belong to Foundry or the Render claim relayer, not this static app. Dashboard environment variables would not be applied at build time anyway.

`BASE_SEPOLIA_RPC_URL` at the repo root is for Foundry and the claim relayer. This app does not read it.

`x-claim-secret` is retired with the claim API secret. When `VITE_CLAIM_RELAYER_URL` is set, the Render service must allow https://agent-bv.pages.dev in `CORS_ORIGINS`. Relayer defaults now allow only that origin. `https://agent-a-wallet-ux.pages.dev` is refused unless the relayer env adds it. Live claims are Base Sepolia (chain id 84532) only. Ethereum mainnet and Base mainnet are refused before the request is sent. The page does not embed a claim secret.

## Bundle guard

`node scripts/guard-claim-secret.mjs dist` fails the deploy if `dist` contains the header `x-claim-secret` or the literal string `VITE_CLAIM_API_SECRET`. The header match is case-insensitive. Both markers are also rejected in these encodings: standard base64 with and without padding, URL-safe base64 with and without padding, URL-encoding, hex (lowercase and uppercase), and JSON escaping. The scan does not read a secret from the environment. There is no input that skips it. A directory target also fails when it is empty, has no files, or has no non-empty `.js` file. That failure says `no JavaScript scanned`.

The `wallet-ux` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs the same `node scripts/guard-claim-secret.mjs dist` from `apps/wallet-ux` after `npm run build`. A leak fails the pull request. A clean scan logs `Claim leak scan passed`.

[`scripts/guard-escrow-addresses.mjs`](scripts/guard-escrow-addresses.mjs) requires the built JavaScript to contain the live BotAttestationEscrow `0x3d660502D75f1e97b08c110255921b437A3C4C42` (case-insensitive) and both of these phrases from `src/`:

- `Submitting the refund request` (`src/relayer.ts`)
- `Submit the refund request through the refund service, or send it from your wallet.` (`src/relayer.ts`, shown in `src/FlowPreview.tsx`)

The script imports `ADDRESSES`, `FALLBACK_PIN`, and `SUPERSEDED`. `SUPERSEDED` in [`src/book.ts`](src/book.ts) is the blocked-address list. It requires `ADDRESSES.botAttestationEscrow` and `FALLBACK_PIN.botAttestationEscrow` to be the live escrow, `SUPERSEDED.botAttestationEscrow` to be the pre-ESC-M-1 retired escrow, and `SUPERSEDED.botAttestationEscrowEscM1` to be the retired ESC-M-1 escrow. It fails if any live `ADDRESSES` slot is either retired escrow.

Both retired addresses also appear in the top-level `notes` string of [`src/base-sepolia.json`](src/base-sepolia.json). Those sentences are not the `SUPERSEDED` literals. The script allowlists `SUPERSEDED`, `retired.*`, `superseded.*`, and the top-level notes. Any other client occurrence fails the check. The built `dist` must contain each retired address exactly as many times as those allowlisted sources. At this commit `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` is 3 (SUPERSEDED, `retired.BotAttestationEscrow.address`, and notes). `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` is 8 (SUPERSEDED plus seven allowlisted JSON fields, including `retired.BotAttestationEscrow.supersededBy`).

`npm test` runs these guards. Deploy the merge SHA only after every gate on the PR head is green and Grok Bot has given a GO for that head SHA.

## Rollback

Before `wrangler pages deploy ... --branch=main`, note the current production deployment ID. That ID is the rollback target. If any live check fails after the production upload, roll back to that ID, then investigate the failed check. A failed preview check never reaches this upload.

In the Cloudflare dashboard, open **Workers & Pages**, select the Pages project **agent-bv**, then open **Deployments**. Do not roll back or delete `agent-a-wallet-ux` from this step. That project stays live until a live refund passes on https://agent-bv.pages.dev. In **All deployments**, open the actions menu on the noted production deployment and choose **Rollback to this deployment**. Confirm the dialog. Production switches to that deployment immediately. Preview deployments are not valid rollback targets, including `preview-<PR#>`. Cloudflare documents that dashboard action at [Rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/).

The same rollback is the Pages API call documented at [Rollback deployment](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/rollback/). It accepts only a successful production deployment. `$DEPLOYMENT_ID` is the production deployment noted before the `main` upload, not a preview deployment:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/agent-bv/deployments/$DEPLOYMENT_ID/rollback" \
  -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

The [Wrangler Pages commands](https://developers.cloudflare.com/workers/wrangler/commands/pages/) reference has no rollback command. This runbook does not use Wrangler to roll back.

## Project settings

| Setting | Value |
| --- | --- |
| Project name | `agent-bv` |
| Production URL | `https://agent-bv.pages.dev` |
| Previous project | `agent-a-wallet-ux` at `https://agent-a-wallet-ux.pages.dev`, live until a live refund passes on the new site |
| Git connection | None. Direct Upload. |
| Who builds | The operator, at the merge SHA, on Node 22. Cloudflare does not build. |
| Dashboard env vars at build time | Unused. |
| Build output directory | `dist` (landing at the root, wallet app in `dist/app`) |
| Node.js | `22` |
| Deploy workflow | [`.github/workflows/deploy-wallet-ux.yml`](../../.github/workflows/deploy-wallet-ux.yml) is stale and unused. Its checks are outdated. A backlog fix is pending. Do not delete it. |

`pages_build_output_dir = "./dist"` is the assembled site. Vite writes the app to `dist/app`. `scripts/assemble-site.mjs` then copies `landing/` to `dist/`.

### SPA

The site root is the landing page. [`landing/_redirects`](landing/_redirects) is copied to `dist/_redirects` by `scripts/assemble-site.mjs`. The wallet app is built to `dist/app/` with Vite `base` `/app/`.

`/app/*` rewrites to `/app/` with status 200, so a refresh of a guided route still loads the app and leaves the browser URL unchanged. Those routes are `/app/fund`, `/app/release`, `/app/refund`, `/app/dispute`, `/app/vote`, and `/app/withdraw`. The client reads the path and does not prepare or submit from the address bar.

A root link with `?escrow=` or `?dispute=` is forwarded to `/app/` with the same search and hash. `/points`, `/claim`, and `/release` each 301 to `/app/`. The destination has no query string, so Pages keeps the incoming query string.

[`landing/_headers`](landing/_headers) is copied to `dist/_headers` the same way. It sets `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`. Those are the security headers both live Pages hosts already send. That file does not set `Content-Security-Policy`. The landing page pins its own script hash. `scripts/guard-pages-headers.mjs` fails when `landing/_headers` bytes change, and `npm test` runs the guard. A later upload of this `dist` applies the same headers on `agent-bv`. It does not delete `agent-a-wallet-ux`.

## Address book

The app imports [`src/base-sepolia.json`](src/base-sepolia.json). That file is a copy of [`deployments/base-sepolia.json`](../../deployments/base-sepolia.json) committed inside `apps/wallet-ux`. Vite does not import `../../../deployments/base-sepolia.json`, so a build rooted at `apps/wallet-ux` still works when the parent directory is not on the build path.

`npm run dev` and `npm run build` run `scripts/sync-book.mjs`. When the repo-root book is visible, the script refreshes `src/base-sepolia.json`. When it is not visible, the script keeps the committed copy. Either way the book must be Base Sepolia (`chainId` 84532, `network` `base-sepolia`). After a book change in the full repo, run `npm run sync-book` and commit `src/base-sepolia.json`. `npm test` fails if the two files differ.

`src/book.ts` `FALLBACK_PIN` matches the live book. The app uses the pin only when the copied JSON fails validation. Superseded Denylist and Vault addresses stay blocked. Both retired escrows stay blocked: `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` (ESC-M-1, retired 2026-10-06) and `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` (pre-ESC-M-1, retired 2026-09-26).

Live slots:

| Contract | Address |
| --- | --- |
| coreTimelock | `0x10CC9474b45625ADfd05C209f2518023484878D9` |
| Denylist | `0xeE76876bECcFc1B58fC06fF4E654a517d784B224` |
| Vault | `0x1463D664fA467FBCDA4B05443434494f05e565bc` |
| DisputePanel | `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb` |
| BotAttestationEscrow | `0x3d660502D75f1e97b08c110255921b437A3C4C42` |
