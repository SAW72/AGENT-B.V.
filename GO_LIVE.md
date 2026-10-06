# Go live checklist

This is what "live" means at each stage. Do not skip stages.

## Stage 0 — local (ready now)
- [x] Clone the repo
- [x] `python pipeline/end_to_end_runner.py --target stub`
- [x] `python meta_audit/meta_audit_runner.py --primary audit_report.json`
- [x] `export STAMP_API_KEY=dev-only-local-key` then `uvicorn api.stamp_api:app --host 0.0.0.0 --port 8080`
- [x] `pytest tests/`

Privileged stamp writes (`POST /v1/bots`, denylist, history) are rejected without `STAMP_API_KEY` (401 if wrong/missing header; 503 if the env key is unset). Public GET/access-check stay readable.

## Stage 1 — live model audit (you can do this today)
- [ ] Set `XAI_API_KEY` (env only). Optional: `XAI_API_BASE=https://api.x.ai/v1` (HTTPS, env-only; no client-supplied base)
- [ ] Run `python pipeline/end_to_end_runner.py --target grok --bot-id grok-001`
- [ ] Keyword scores are demo-only. For an attestation-grade report use `--scorer llm --require-attestation` (or `ALLOW_KEYWORD_ATTESTATION=1` for an explicit demo exception)
- [ ] Register with `X-API-Key: $STAMP_API_KEY`. `fingerprint_hash` must equal `sha256(canonical(fingerprint))`
- [ ] Hit `GET /v1/bots/grok-001/stamp` (add `?attestation=true` only when the run is attestation-grade)

## Stage 2 — testnet contracts

Base Sepolia (**84532**) only. Mainnet always reverts. Agents do not `--broadcast`. Keys stay in the environment.

- [ ] `forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts`
- [ ] `forge build && forge test`
- [ ] **(1) Core** — `script/Deploy.s.sol`. Env: `PRIVATE_KEY`, `CORE_TIMELOCK` (required, ≠ deployer). Inside the script: Denylist → Vault(denylist) → Liability(`address(0)`) → InsuranceFund(liability) → `bindInsurance` → DisputePanel. Then `transferOwnership(CORE_TIMELOCK)` on Denylist and Vault (OZ **Ownable2Step** — ownership does not move until CORE_TIMELOCK calls `acceptOwnership`). CORE_TIMELOCK is an EOA (with EIP-7702 delegation), not a timelock; to be replaced by TimelockController ([runbook](docs/runbooks/CORE_TIMELOCK_MIGRATION.md)). `setOwner(CORE_TIMELOCK)` on InsuranceFund, Liability, and DisputePanel is immediate.
- [ ] **(1a) Denylist + Vault redeploy** — `script/DeployDenylist.s.sol` replaces the live pre–PR #10 Denylist with tip bytecode. Env: `PRIVATE_KEY`, `CORE_TIMELOCK` (≠ deployer). Simulate only until Spencer broadcasts: `forge script script/DeployDenylist.s.sol:DeployDenylist --rpc-url $BASE_SEPOLIA_RPC_URL -vvvv`. Then `acceptOwnership` on both new contracts and migrate active listings. See `script/DEPLOY_DENYLIST.md`. Do not re-run `Deploy.s.sol` for this cutover. Agents do not `--broadcast`. Spencer fills `deployments/base-sepolia.json` after a real broadcast.
- [x] **Panel seat (Gate B)** — seated on the live DisputePanel. `arbitratorCount` is 3: `0xD5ee9fA366C3698b34204722c635989E5197B018`, `0xF4253A3a3C102Ee59e38b2AA92989C3232eDcC30`, `0xB87Ed5F74276AC6172ef53fE866675093F75936E`. Seat txs are in block 47299643. `openDispute` reverts `panel not seated` if the count later drops below 3. Agents do not `--broadcast`. See `script/DEPLOY_ESCROW_BASE_SEPOLIA.md`.
- [x] **(2) Escrow** — live `BotAttestationEscrow` `0x3d660502D75f1e97b08c110255921b437A3C4C42` (pull-payment redeploy from commit `7fe4a863e9bce0b70b629dab76ddd2728c97b536`, deploy tx `0x0d39f2502956d1199bb9d264704aacab85ca7a5d54de3e1634b201c730b62b6c`, block 47715415, 2026-10-05 11:18:38 UTC). Linked DisputePanel `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb`. Constructor governance is governanceTimelock. `transferOwnership` is `0xe7f8fed585fd148c8ca34ae57b2cc92516cf4a48a0fbd992a34fa0b381aeb5fa`. `acceptOwnership` is complete (`0xb7e819961fbe644eef1122c7da4554090a4412083a87366b21c7da09124dd769`, block 47760929, 2026-10-06 12:35:46 UTC, status 1). `owner` is governanceTimelock `0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33` and `pendingOwner` is zero. The ESC-M-1 escrow `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` is retired (2026-10-06) under `retired.BotAttestationEscrowEscM1`. The previous escrow `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` is retired (ESC-M-1 redeploy, retired 2026-09-26). Its own `acceptOwnership` was already complete (`0xd2e982568811c3706eec074d296ef7fa4c54838de714e1a5bfc8afc9fbb73983`, block 47300275). Agents do not `--broadcast`.
- [ ] **(3) Optional BVT** — `script/DeployBVT.s.sol`. Env: `BVT_GUARDIAN` (required, non-zero, ≠ deployer). Optional `BVT_INSURANCE_SINK`, `BVT_TREASURY`.
- [x] Record addresses and deploy txs in `deployments/base-sepolia.json` and `contracts/README.md` (core and escrow are filled; BVT is still null)
- [ ] Point the stamp API at those addresses
- [ ] Bootstrap operators via `BVTStaking.bootstrapOperator` — not a public sale

## Stage 3 — first institution
- [ ] **Disclaimer / Terms / Privacy live on stamp surfaces** (`DISCLAIMER.md`, `TERMS.md`, `PRIVACY.md`, and `GET /v1/disclaimer`) before any first-institution reliance
- [ ] One crypto-native bank / neobank / payment processor as **optional experimental** anchor tenant (stamp is not a certification they can "require")
- [ ] They call `/v1/access/check` before granting a bot financial permissions
- [ ] One real incident drill: file a claim, run the waterfall on testnet (experimental settlement design — not insurance; not a lawsuit waiver)

## What is NOT live yet
- TEE attestation against a real enclave
- Auditor staking and slash on mainnet
- Private scenario vault encryption at rest
- Cross-chain light clients
- Formal proofs in Certora (invariants are written; proofs are not)

Those are Stage 4. Do not wait for Stage 4 to start Stage 1.
