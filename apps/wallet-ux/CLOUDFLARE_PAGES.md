# Cloudflare Pages (wallet UX)

The current Pages project is `agent-bv` (https://agent-bv.pages.dev). It is a Direct Upload project. It has no git connection. Cloudflare does not build it, and environment variables set in the Cloudflare dashboard are not used at build time.

The previous project `agent-a-wallet-ux` (https://agent-a-wallet-ux.pages.dev) has been deleted. That URL no longer serves the wallet. Do not recreate it. Relayer defaults allow only https://agent-bv.pages.dev.

Wallet UX is a static Vite app. The browser calls the claim relayer through the Cloudflare Worker `agent-bv-relayer-edge` at `https://agent-bv-relayer-edge.s-a-wight72.workers.dev`. That Worker proxies to the Render origin `bot-verifier-claim-relayer`. The origin must be reachable only through the proxy. The claim API secret is retired. The production deploy never embeds one. The page does not embed a claim secret. Escrow submits go out through the connected wallet. A successful build includes `VITE_CLAIM_RELAYER_URL`, so a refund can also be posted live to that Worker. Release stays on the payer's wallet. The connected wallet signs the claim. Live submit is authorized by the wallet signature, not a shared secret.

[`wrangler.toml`](wrangler.toml) records the project name and `pages_build_output_dir = "./dist"`. That file is not a git connection. Cloudflare does not read it to build the site.

## Production deploy

Gates and Steward's per-SHA GO, with the D2 cross-check (rule 1g), apply to the PR head SHA. The set, in order, is CI, Look, QA, Verifier, Security, and Lawyer when copy or legal text changes, then Steward's per-SHA GO and the D2 cross-check for that head. A GO for a different SHA does not cover this head. Nothing reaches `main` without every gate on that head.

A squash merge creates a new commit. That merge SHA is what gets deployed and recorded. It is not the head SHA the GO named.

A Base Sepolia (testnet) production deploy needs a Steward GO. Spencer is still required for spending real money, deleting a GitHub repo or project, and blockchain mainnet.

Build at the merge SHA on Node 22. That major is `.node-version` in this directory. There is no `.nvmrc`, and `package.json` has no `engines` field. It is the same major as the `wallet-ux` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).

From a checkout of that SHA:

```bash
cd apps/wallet-ux
npm ci
cd ../../claim-relayer
npm ci
cd ../apps/wallet-ux
npm test
unset WALLET_UX_OUT_DIR
WALLET_UX_DEPLOY=1 npm run build
node scripts/guard-claim-secret.mjs dist
```

Unset `WALLET_UX_OUT_DIR` before this production build and again before each manual Direct Upload below. `WALLET_UX_DEPLOY=1` makes a set `WALLET_UX_OUT_DIR` fail the build. `scripts/assemble-site.mjs` prints the resolved output directory and the source commit from `git rev-parse HEAD`. It exits non-zero if that directory is not the expected one. The same `git rev-parse HEAD` is written into `dist/app/index.html` as `<meta name="agent-bv-build-commit" content="<40-hex sha>">` (see Build commit stamp below). Before each upload, confirm the build printed both `wallet-ux output dir: <checkout>/apps/wallet-ux/dist` and `assembled <checkout>/apps/wallet-ux/dist: landing at /, wallet app at /app/`. `<checkout>` is the absolute path of this checkout. Do not upload if either line is missing or names another directory.

`npm ci` in `claim-relayer` is required because the wallet-ux tests load that package as Node modules. `npm run build` runs `scripts/sync-book.mjs`, then `node scripts/require-build-env.mjs`, then `tsc --noEmit`, then `vite build` (output `dist/app`), then `scripts/assemble-site.mjs`. That script copies `landing/` onto `dist/`, so the landing page is at `/` and the wallet app is at `/app/`. `dist/` is gitignored. A clean claim-secret scan logs `Claim leak scan passed`. Do not upload if that command fails.

`npm run build` reads [`build-env.required.json`](build-env.required.json). That file sets `VITE_CLAIM_RELAYER_URL` to `https://agent-bv-relayer-edge.s-a-wight72.workers.dev` and `VITE_BASE_SEPOLIA_RPC_URL` to `https://sepolia.base.org`. The build fails if either resolved value is empty and names the variable. A non-empty shell value overrides the file. An empty shell value fails the build; it does not fall back to the file. The relayer URL must be exactly `https://agent-bv-relayer-edge.s-a-wight72.workers.dev`, `https://agent-bv-relayer-edge.s-a-wight72.workers.dev/`, or `https://agent-bv-relayer-edge.s-a-wight72.workers.dev/v1/claims`. The Render origin is not an allowlist entry. The build inlines that allowlist entry. An https RPC host on the allowlist (`sepolia.base.org`) is accepted. Any other public https RPC host must answer `eth_chainId` with `84532`. Anything else fails the build. Leave `VITE_CLAIM_API_SECRET` unset. That name is retired. `npm run dev` still uses `https://sepolia.base.org` when `VITE_BASE_SEPOLIA_RPC_URL` is unset.

Before the production upload, note the deployment ID of the live production deployment (the current `main` deployment). That ID is the rollback target. Preview deployment IDs are not rollback targets.

Direct Upload has no promote. Wrangler reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment. The token is **Pages:Edit** scope only. Do not store either value as a repository secret.

Deploy production with the built `dist` and the merge SHA:

```bash
unset WALLET_UX_OUT_DIR
npx wrangler pages deploy dist --project-name=agent-bv --branch=main --commit-hash=<sha>
```

**Exposure window.** A preview upload is not required, so the production upload publishes the bundle on the alias `https://agent-bv.pages.dev` immediately. If that bundle is bad, it stays live on the alias until the live checks below finish and, when one fails, the rollback below also finishes. Plan for that window. Keep the checks and the rollback ready before uploading, and run them straight after the upload without a pause.

**Preview is an optional canary.** An upload with `--branch=<name>` other than `main` creates a preview deployment on its own URL and does not touch the alias. An operator may use one to try a risky change first. It is never required, and a preview ID is never a rollback target. A preview upload is an extra upload, so check that Steward's GO covers it before doing one.

Right after the production upload, live-check the new deployment URL Wrangler prints, then the production alias `https://agent-bv.pages.dev`. From `apps/wallet-ux`, run the served-bundle check against the new deployment URL. `DEPLOYMENT_URL` is required. `APP_PATH` defaults to `/`, which is the landing page and has no hashed bundle, so set it to `/app/`. `DIST_INDEX` defaults to `dist/index.html`; the built app index is `dist/app/index.html`.

```bash
DEPLOYMENT_URL="<deployment-url>" APP_PATH=/app/ DIST_INDEX=dist/app/index.html EXPECT_COMMIT="<merge-sha>" node scripts/verify-served-bundle.mjs
```

`EXPECT_COMMIT` is the full 40-character merge SHA that was built. For a new stamped deploy, always set it. The script fails if a served or built page has a stamp and `EXPECT_COMMIT` is unset, unless the operator also sets `ALLOW_UNPINNED_ROLLBACK=1` (exact `1` only; surrounding whitespace is not accepted).

Operator notes:

- First stamped deploy, and every stamped deploy after: set `EXPECT_COMMIT` to the merge SHA. Do not set `ALLOW_UNPINNED_ROLLBACK`.
- Rollback to the unstamped deploy `2c57aa1d-4d9c-4e78-9d5d-12a6439150b8` (main `cdb3232`): leave `EXPECT_COMMIT` unset, and do not set the flag. An unstamped page passes only when `EXPECT_COMMIT` is unset. The flag does not override that.
- Rollback or check of a *stamped* deployment without pinning a SHA: set `ALLOW_UNPINNED_ROLLBACK=1` and leave `EXPECT_COMMIT` unset. This is a deliberate exception so an operator can verify a known stamped rollback target without typing the SHA. It does not waive a built-vs-served stamp mismatch, a wrong `EXPECT_COMMIT`, or a missing stamp when `EXPECT_COMMIT` is set. Do not use it on a new production deploy.

A page with more than one real `agent-bv-build-commit` tag always fails. The stamp reader accepts any attribute order, single or double quotes, and extra attributes, and it ignores tags inside HTML comments or `<script>` / `<template>` bodies.

The script fetches `<deployment-url>/app/`, requires that HTML to reference the same `/app/assets/*` hashes as `dist/app/index.html`, downloads those `.js` files and any `./chunk.js` imports, and requires a JavaScript content type. An empty script, or a body that starts with `<` after a UTF-8 BOM and leading whitespace, fails the check. It then runs `scripts/guard-escrow-addresses.mjs` and `scripts/guard-claim-secret.mjs` on the served HTML plus JavaScript. It also reads the build commit stamp from the served HTML (`Served build commit: <sha>.`). When the local `DIST_INDEX` has a stamp, the served page must carry the same one, so equal asset hashes from a different commit still fail. When `EXPECT_COMMIT` is set, the served stamp must equal it. A stamped page (served or built) with `EXPECT_COMMIT` unset fails unless `ALLOW_UNPINNED_ROLLBACK=1`. A local build from before the stamp existed has none, and a served page without one then passes with `Served index.html has no build commit stamp.`, but only when `EXPECT_COMMIT` is unset. A pass logs `Served bundle at <url> passed the escrow, phrase, and claim-secret checks.` A failure prints `Verify failed:` and exits non-zero.

The same new deployment URL also has to pass these checks. The script does not cover them:

- `GET /` returns 200.
- `GET /app/` returns 200.
- Asset content types are right. Wallet JavaScript (`/app/assets/*.js`) is `text/javascript`, `application/javascript`, or `application/x-javascript` (a `charset` parameter is fine). Landing CSS is `text/css`. Landing PNG assets are `image/png`.
- Redirects go to `/app/`. `/app` (no trailing slash), `/points`, `/claim`, and `/release` are 301 to `/app/`. The destination has no query string, so Pages keeps the incoming query string.
- The security headers are present on `/app/` and `/app/identity`: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, and a `Content-Security-Policy` that ends in `frame-ancestors 'none'`. `/` has `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` as headers.
- Cache headers: a hashed `/app/assets/*.js` file returns `Cache-Control: public, max-age=31536000, immutable`. `/` and `/app/` do not return `immutable`.

Then run `scripts/verify-served-bundle.mjs` again with `DEPLOYMENT_URL` set to `https://agent-bv.pages.dev`, and the same `APP_PATH` and `DIST_INDEX`. Run the same `/`, `/app/`, content-type, redirect, and security-header checks against `https://agent-bv.pages.dev`. If any check fails, roll back to the production deployment ID noted before this upload. Follow Rollback below.

### Deploy record

Write one record for the deploy. The head SHA is the PR head the gates and the GO covered. The merge SHA is the squash commit that was built, uploaded, and checked.

```
PR:
head SHA:
merge SHA:
production deploy ID:
rollback target:
relayer deploy ID:
/health build.commit:
relayer rollback target:
VITE_CLAIM_RELAYER_URL:
check results:
served build commit (from /app/):
```

`VITE_CLAIM_RELAYER_URL` is the public URL baked into that build. A build that passes has it set to exactly `https://agent-bv-relayer-edge.s-a-wight72.workers.dev`, `https://agent-bv-relayer-edge.s-a-wight72.workers.dev/`, or `https://agent-bv-relayer-edge.s-a-wight72.workers.dev/v1/claims`. It is not a secret. `/health build.commit` is the full 40-character SHA from `GET /health` on the origin, through the Worker. The relayer rollback target is the last good Render deploy ID.

| Name | Where | Role |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Environment of the deploy command. Never a repository secret. | API token with **Pages:Edit** scope only. Wrangler uses it to upload `dist`. |
| `CLOUDFLARE_ACCOUNT_ID` | Environment of the deploy command. Never a repository secret. | Cloudflare account that owns `agent-bv`. |
| `VITE_CLAIM_RELAYER_URL` | [`build-env.required.json`](build-env.required.json). Not a GitHub variable. | Public `https://agent-bv-relayer-edge.s-a-wight72.workers.dev`. `npm run build` fails if the resolved value is empty. A non-empty shell value overrides the file only when it is exactly one of those three URLs. The Render origin is not an allowlist entry. Any other value fails the build. The build inlines the allowlist entry. The relayer button stays off until `GET /health` is up and not paused. The connected wallet signs the claim. Do not set a claim secret. |
| `VITE_BASE_SEPOLIA_RPC_URL` | [`build-env.required.json`](build-env.required.json). | Public `https://sepolia.base.org`, which is the RPC host allowlist. `npm run build` fails if the resolved value is empty. A public https host that is not on that allowlist must answer `eth_chainId` with `84532`. Anything else fails the build. `npm run dev` uses `https://sepolia.base.org` when the variable is unset. |
| `VITE_CLAIM_API_SECRET` | Retired. Must not exist anywhere. | Do not set a claim secret on Pages. Not a repository secret, not an environment secret or variable, and not a Cloudflare Pages environment variable. |

### Relayer submit

The claim API secret is retired. Do not set a claim secret on Pages. Relayer authentication is EIP-712 signed intents (PR #46). The connected wallet signs the claim. Live submit is authorized by the wallet signature, not a shared secret. Wallet submit still works. This deploy does not pass a claim secret into the build.

Signed-intent auth is live in production only after cutover. The order is `claim-relayer/CUTOVER.md` in [PR #51](https://github.com/SAW72/AGENT-B.V./pull/51).

### Stale unused deploy-wallet-ux

[`.github/workflows/deploy-wallet-ux.yml`](../../.github/workflows/deploy-wallet-ux.yml) is stale and unused. Its checks are outdated. A backlog fix is pending. Do not delete the file. `on` is `workflow_dispatch` only, so a push or a pull request does not publish. Do not run **Actions → Stale unused deploy-wallet-ux**. Production is the merge-SHA build and `wrangler pages deploy` above. If that file is run anyway, its build reads [`build-env.required.json`](build-env.required.json) and does not pass `vars.VITE_CLAIM_RELAYER_URL`. An empty shell value fails the build; it does not fall back to the file.

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

`x-claim-secret` is retired with the claim API secret. A successful build includes `VITE_CLAIM_RELAYER_URL`, so the browser calls the Worker and the Worker forwards `Origin`. The Render origin must allow https://agent-bv.pages.dev in `CORS_ORIGINS`. Relayer defaults now allow only that origin. `https://agent-a-wallet-ux.pages.dev` is refused. That Pages project has been deleted. Do not add the origin. Live claims are Base Sepolia (chain id 84532) only. Ethereum mainnet and Base mainnet are refused before the request is sent. The page does not embed a claim secret.

## Bundle guard

`node scripts/guard-claim-secret.mjs dist` fails the deploy if `dist` or `build-env.required.json` contains the header `x-claim-secret` or the literal string `VITE_CLAIM_API_SECRET`. The scan always includes that JSON file. The header match is case-insensitive. Both markers are also rejected in these encodings: standard base64 with and without padding, URL-safe base64 with and without padding, URL-encoding, hex (lowercase and uppercase), and JSON escaping. The scan does not read a secret from the environment. There is no input that skips it. A directory target also fails when it is empty, has no files, or has no non-empty `.js` file. That failure says `no JavaScript scanned`.

The `wallet-ux` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs the same `node scripts/guard-claim-secret.mjs dist` from `apps/wallet-ux` after `npm run build`. A leak fails the pull request. A clean scan logs `Claim leak scan passed`.

[`scripts/guard-escrow-addresses.mjs`](scripts/guard-escrow-addresses.mjs) requires the built JavaScript to contain the live BotAttestationEscrow `0x3d660502D75f1e97b08c110255921b437A3C4C42` (case-insensitive) and both of these phrases from `src/`:

- `Submitting the refund request` (`src/relayer.ts`)
- `Submit the refund request through the refund service, or send it from your wallet.` (`src/relayer.ts`, shown in `src/FlowPreview.tsx`)

The script imports `ADDRESSES`, `FALLBACK_PIN`, and `SUPERSEDED`. `SUPERSEDED` in [`src/book.ts`](src/book.ts) is the blocked-address list. It requires `ADDRESSES.botAttestationEscrow` and `FALLBACK_PIN.botAttestationEscrow` to be the live escrow, `SUPERSEDED.botAttestationEscrow` to be the pre-ESC-M-1 retired escrow, and `SUPERSEDED.botAttestationEscrowEscM1` to be the retired ESC-M-1 escrow. It fails if any live `ADDRESSES` slot is either retired escrow.

Both retired addresses also appear in the top-level `notes` string of [`src/base-sepolia.json`](src/base-sepolia.json). Those sentences are not the `SUPERSEDED` literals. The script allowlists `SUPERSEDED`, `retired.*`, `superseded.*`, and the top-level notes. Any other client occurrence fails the check. The built `dist` must contain each retired address exactly as many times as those allowlisted sources. At this commit `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` is 3 (SUPERSEDED, `retired.BotAttestationEscrow.address`, and notes). `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` is 8 (SUPERSEDED plus seven allowlisted JSON fields, including `retired.BotAttestationEscrow.supersededBy`).

`npm test` runs these guards. Deploy the merge SHA only after every gate on the PR head is green and Steward has given a per-SHA GO, with the D2 cross-check (rule 1g), for that head SHA.

## Rollback

Before `wrangler pages deploy ... --branch=main`, note the current production deployment ID. That ID is the rollback target. If any live check fails after the production upload, roll back to that ID, then investigate the failed check.

In the Cloudflare dashboard, open **Workers & Pages**, select the Pages project **agent-bv**, then open **Deployments**. This rollback is only for `agent-bv`. The deleted project `agent-a-wallet-ux` is not a rollback target, and this step does not recreate it. In **All deployments**, open the actions menu on the noted production deployment and choose **Rollback to this deployment**. Confirm the dialog. Production switches to that deployment immediately. Preview deployments are not valid rollback targets, including `preview-<PR#>`. Cloudflare documents that dashboard action at [Rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/).

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
| Previous project | `agent-a-wallet-ux` at `https://agent-a-wallet-ux.pages.dev`, deleted. Do not recreate it. |
| Git connection | None. Direct Upload. |
| Who builds | The operator, at the merge SHA, on Node 22. Cloudflare does not build. |
| Dashboard env vars at build time | Unused. |
| Build output directory | `dist` (landing at the root, wallet app in `dist/app`) |
| Node.js | `22` |
| Deploy workflow | [`.github/workflows/deploy-wallet-ux.yml`](../../.github/workflows/deploy-wallet-ux.yml) is stale and unused. Its checks are outdated. A backlog fix is pending. Do not delete it. |

`pages_build_output_dir = "./dist"` is the assembled site. Vite writes the app to `dist/app`. `scripts/assemble-site.mjs` then copies `landing/` to `dist/`.

### Routing

`npm run build` writes the wallet app to `dist/app` (`base` is `/app/`), then [`scripts/assemble-site.mjs`](scripts/assemble-site.mjs) copies [`landing/`](landing/) onto `dist/`. The site root is the landing page. The wallet app stays at `/app/`.

[`landing/_redirects`](landing/_redirects) is copied to `dist/_redirects`. Pages does not support a 404 status in `_redirects` (only 301, 302, 303, 307, 308, and a 200 proxy). The rules are:

- `/app` and `/app/index.html` are **301** to `/app/`. A request for `/app/` serves `dist/app/index.html` with status 200 and does not redirect again, so the `/app/index.html` rule does not loop.
- `/index.html` is **301** to `/`.
- `/points`, `/claim`, and `/release` are **301** to `/app/`. The destination has no query string, so Pages keeps the incoming query string.
- A root link with `?escrow=` or `?dispute=` is forwarded to `/app/` with the same search and hash.
- `/app/assets/*`, `/app/manifest.webmanifest`, and the two icons are listed before `/app/*`. A matching 200 rewrite replaces a real file, so those paths are named first. `/app/* /app/ 200` is the app fallback. Pages ignores a rewrite whose destination is `/app/index.html`. A refresh of a guided route still loads the app and leaves the browser URL unchanged. Those routes are `/app/fund`, `/app/release`, `/app/refund`, `/app/dispute`, `/app/vote`, and `/app/withdraw`. The client reads the path and does not prepare or submit from the address bar.

There is no top-level `404.html`. Without one, Pages serves the landing page with status 200 for an unknown path outside `/app/` (for example `/foo/bar`). `/app/nope` still matches `/app/*` and serves the app.

Missing files under `/assets/` and `/app/assets/` return **404**. [`landing/assets/404.html`](landing/assets/404.html) is copied to `dist/assets/404.html` and to `dist/app/assets/404.html`. Pages serves the nearest `404.html` for a path that is not a real file and is not rewritten to a page. `wrangler pages dev` returns 404 for `/assets/nope.png` and `/app/assets/nope.js`, and still returns the real image and the built JavaScript with status 200.

[`landing/_headers`](landing/_headers) is copied to `dist/_headers` the same way. `scripts/guard-pages-headers.mjs` pins its exact bytes, and `npm test` runs the guard, so a header change is a reviewed change to both files. Pages merges every matching rule and joins a repeated header name into one value, so the rules do not overlap on a header name:

- `/*` sets `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`. The live Pages host already sent those two.
- `/` sets `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`. The landing page keeps its own `<meta>` CSP with the inline-script hash. A meta CSP cannot send `frame-ancestors`, so only that directive is a header. Both policies apply.
- `/app/*` (the app, and every SPA route such as `/app/identity`) sets `X-Frame-Options: DENY` and this CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src https://sepolia.base.org https://agent-bv-relayer-edge.s-a-wight72.workers.dev; manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'`. There is no `unsafe-inline` and no `unsafe-eval`. The built app has no inline script or style attribute and never evaluates a string. `connect-src` is the Base Sepolia RPC and the relayer edge Worker. The wallet connector is `injected()` only (EIP-6963), so no WalletConnect or wallet-provider host is needed. If `VITE_BASE_SEPOLIA_RPC_URL` or the relayer URL changes, change this CSP in the same commit. The test in `scripts/guards.test.mjs` ties `connect-src` to those constants.
- `/app/assets/*` sets `Cache-Control: public, max-age=31536000, immutable`. Vite names those files by content hash. It is the only rule that sets `Cache-Control`, so HTML keeps the Pages default (`public, max-age=0, must-revalidate`) and never gets `immutable`. `/app/assets/404.html` and `/app/assets/404` detach it with `! Cache-Control` because the shared not-found page is not content-hashed.
- Landing assets under `/assets/*` are not content-hashed (`Poppins-*.ttf`, `mascot-*.png`, `og-image.png`, icons), so they get no `immutable` rule. Do not add one unless those files get hashed names.

`scripts/served-site.test.mjs` serves the real build with `wrangler pages dev`, asserts these headers on the served responses, and loads `/`, `/app/`, and `/app/identity` in headless Chrome with zero CSP violations. A later upload of this `dist` applies the same headers on `agent-bv`. It does not recreate `agent-a-wallet-ux`.

### Build commit stamp

`dist/app/index.html` carries `<meta name="agent-bv-build-commit" content="<40-hex sha>">`. `scripts/build-stamp.mjs` writes it during `vite build` from `git rev-parse HEAD` in `apps/wallet-ux`, the same commit `assemble-site.mjs` logs as `wallet-ux source commit`. There is no timestamp, host name, or random value in it. Rules:

- The same commit rebuilds byte-identical, on Node 22 and Node 24. A different commit changes only that one meta tag in `dist/app/index.html` when the app sources are unchanged. A commit that changes app sources also changes the hashed JS or CSS. The hashed JS and CSS do not carry the stamp, so their file names and bytes do not depend on the commit.
- `curl -s https://agent-bv.pages.dev/app/ | grep agent-bv-build-commit` shows which commit is live. The served page must have exactly one real stamp tag. `scripts/verify-served-bundle.mjs` fails on more than one real tag. Tags inside comments or `<script>` / `<template>` are ignored. Zero tags pass only when `EXPECT_COMMIT` is unset (a rollback to a pre-stamp build such as `2c57aa1d`). A stamped page requires `EXPECT_COMMIT`, or `ALLOW_UNPINNED_ROLLBACK=1` as the documented exception.
- A `WALLET_UX_DEPLOY=1` production build refuses to stamp a dirty git tree and exits with a message that names the dirty files (`git status --porcelain`, including untracked files). The git calls drop every inherited `GIT_*` variable and pass `git -C <app root>`, so a dummy `GIT_DIR` / `GIT_WORK_TREE` cannot hide dirt or retarget the stamp SHA. A missing git or a non-git directory fails closed. Other builds, including the test suite, may still stamp `HEAD` in a dirty tree. Build a deploy from a clean checkout of the merge SHA, as above.
- A rebuild comparison at the merge SHA still works: build that SHA, and compare `dist/` file hashes with the served files. The stamp is part of the comparison. A rebuild at another commit differs in `app/index.html` only when the app sources are unchanged.
- A rollback to a deployment from before this stamp has no stamp. Verify it against a local build of that older commit, which has none either, and leave `EXPECT_COMMIT` unset. For the current production deployment, that unstamped rollback target is `2c57aa1d-4d9c-4e78-9d5d-12a6439150b8`.

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
