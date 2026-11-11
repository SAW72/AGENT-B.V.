# Agent-BV

**Agent-BV** — adversarial scenario library, scoring rubric, behavioral auditing pipeline, and on-chain attestation for detecting deceptive or harmful AI bots. Built for on-chain audit proofs.

## NEAR HACKATHON entry (NEAR testnet, AI Security & Defense)

> Testnet only. Nothing in this section runs on NEAR mainnet, uses NEAR Intents, or moves real funds.

### What is judged (Q-002 disclosure)

Agent-BV existed before NEAR HACKATHON as a testnet tester program on Base Sepolia (chain 84532), with BotAttestationEscrow `0x3d660502D75f1e97b08c110255921b437A3C4C42` and DisputePanel `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb`. That earlier work is the baseline and is **not** the entry. It has no users yet and is not audited, and its TEE attestation is not live.

The judged work is everything under `near/`, which was built during the hackathon window. Compare the baseline to the submission here:
https://github.com/SAW72/AGENT-B.V./compare/pre-hackathon...hackathon-submission

Until the `hackathon-submission` tag is set, compare against the working branch: https://github.com/SAW72/AGENT-B.V./compare/pre-hackathon...hackathon/near-2026

### What it does

- **Policy contract** (NEAR testnet, account [`agentbv-policy-11111545.testnet`](https://testnet.nearblocks.io/address/agentbv-policy-11111545.testnet)). It records a bot attestation outcome and keeps a small blocklist. Its `check` method returns `allow`, `warn`, or `block` with reasons before an agent spends. It can also enforce a per-agent spend limit.
- **Agent wrapper.** It signs only with a function-call access key scoped to the policy contract. On `block` it refuses to sign. On `warn` it stops and asks a human.
- **Attack demo.** A prompt-injected agent tries to pay a known-bad account and gets stopped. The run writes a log you can compare with the sample in `near/demo/sample-attack.log`.

### Key limits (why a function-call key)

The agent never holds a full-access key. Per the [NEAR access keys docs](https://docs.near.org/protocol/accounts-contracts/access-keys), a function-call key:
- can call only one contract (its `receiver_id`);
- cannot attach NEAR token transfers;
- cannot add or delete keys, or delete the account.

When its gas allowance runs out, the key stops working, and adding NEAR to the account does not refill it. So a hijacked agent can, at worst, call the policy contract until its allowance is spent.

### Judge steps (do X, see Y)

1. **Do:** `git clone https://github.com/SAW72/AGENT-B.V. && cd AGENT-B.V. && git checkout hackathon-submission && cd near`
   **See:** this README, the `contract/`, `agent/`, and `demo/` folders, and the compare link above.
2. **Do:** install the toolchain (Rust via rustup, which picks up the pinned 1.86.0 toolchain and `wasm32-unknown-unknown` target from `contract/rust-toolchain.toml`, and Node 22) and run `cd agent && npm ci` then `cd ../contract && cargo test && cd ../agent && npm test && npm run test:sandbox`.
   **See:** all tests pass, including the allow, warn, and block policy cases.
3. **Do:** `cd agent && npm run view` (read-only, no keys) against `agentbv-policy-11111545.testnet` (already deployed), or follow `near/DEPLOY.md` to deploy your own using a free testnet faucet account.
   **See:** the stored attestation outcome and blocklist entries.
4. **Do:** `cd agent && npm run demo:attack` (needs the agent's function-call key, so run it on your own copy from `near/DEPLOY.md`; without one, open the testnet transaction links in `near/demo/sample-attack.log`)
   **See:** the wrapper refuses to sign with reason `block`, and `near/demo/out/attack.log` matches `near/demo/sample-attack.log`, ignoring timestamps and transaction hashes.
5. **Do:** `cd agent && npm run demo:warn` (same key requirement as step 4; sample in `near/demo/sample-warn.log`)
   **See:** the wrapper does not sign on its own, and it prints a request for human approval.
6. **Do:** `cd agent && npm run keys` for the agent account
   **See:** the agent's key is a FunctionCall key whose `receiver_id` is `agentbv-policy-11111545.testnet`, and the agent uses no FullAccess key.

### Out of scope

The entry leaves out NEAR mainnet, NEAR Intents (they have no testnet), TEE attestation, porting the Base Sepolia escrow and dispute panel to NEAR, and any UI.

### License

Dual license: AGPL-3.0-only or a commercial license from Steward of the King LLC. See `LICENSE`.

## License

**Dual license:** [AGPL-3.0-only](LICENSE.AGPL-3.0) (public default) **or** a [paid commercial proprietary license](LICENSE.COMMERCIAL) from Steward of the King LLC.

- No commercial Order → AGPL-3.0-only applies (including network-use source obligations).
- Want closed / SaaS use without AGPL copyleft? → **contact Steward for a custom commercial quote** (negotiated per partner). No public price list.
- Older commits published under MIT stay MIT for those snapshots; see [NOTICE](NOTICE).

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE.AGPL-3.0)
[![Commercial available](https://img.shields.io/badge/License-Commercial-orange.svg)](LICENSE.COMMERCIAL)

## Disclaimer

**Experimental informational tool only.** Agent-BV is **not** a certification, safety guarantee, or insurance product. Scores, stamps, and denylists are point-in-time heuristics that may be wrong, gamed, or stale. TEE/attestation may be a stub. Contracts may be unaudited. Any fee-funded pool is an **experimental claims backstop — not insurance**.

Read before using or relying on any stamp:

- [Disclaimer](DISCLAIMER.md)
- [Terms of Use](TERMS.md)
- [Privacy](PRIVACY.md)
- [Security summary](SECURITY.md)

Related: [BVT securities disclaimer](docs/BVT_SECURITIES_DISCLAIMER.md) · [jurisdiction risk map](docs/LEGAL_JURISDICTION_MATRIX.md) (not a legal opinion).

## What this is
An experimental stack for testing whether an AI bot is safe, honest, and stable over time. Outputs are heuristics, not certifications.

- **Scenario library**: 125 adversarial prompts across 5 categories.
- **Scoring rubric**: Multi-axis fingerprint (honesty, transparency, manipulation, escalation, self-preservation).
- **Behavioral archaeology**: value-conflict scenarios, consistency stress tests, origin probes.
- **Sandbagging detection**: stealth scenarios and meta-probes.
- **Agentic layer**: tool-use simulation, long-horizon scoring.
- **On-chain attestation**: TEE-signed reports, portable fingerprints.
- **Vault + denylist**: trusted-bot registry, irreversible burn, hard-block denylist (exact, signature, and prompt) with reversible active listings and permanent history.
- **Governance**: multisig + timelock for safe rule changes.
- **Economic security**: auditor staking and slash.
- **Private scenarios**: encrypted vault with rotation.
- **Cross-chain**: hub-and-spoke with cached allowlist for trading bots.
- **Meta-audit**: independent re-audit of the auditors themselves.
- **Formal verification**: invariants for the critical contracts.
- **Key management**: ceremony, HSM, rotation, emergency freeze.
- **Liability**: experimental owner -> auditor -> claims-backstop waterfall (not insurance; not a lawsuit waiver — separate contracts required).
- **Claims backstop**: fee-funded experimental pool — **not insurance**.
- **Dispute panel**: 3-arbitrator on-chain resolution.
- **Bank adoption**: experimental optional institutional signal — not a certification any institution can require.

## Buildable code (runnable)
- `pipeline/end_to_end_runner.py` — full audit runner (stub bot included).
- `claim-relayer/` — Base Sepolia claim-flow relayer. Escrow address comes from `deployments/base-sepolia.json`. Fixture / dry-run unless `LIVE_SUBMIT=1` and `SPENCER_RUN_AUTH=1` on chain 84532. Live `POST /v1/claims` requires an EIP-712 `ClaimIntent` signed by the payer or payee. Mainnet is refused.
- `pipeline/run_audit.sh` — one-command runner.
- `meta_audit/meta_audit_runner.py` — re-audit the auditors.
- `contracts/Denylist.sol`, `Vault.sol`, `Liability.sol`, `InsuranceFund.sol`, `DisputePanel.sol` — real Solidity.
- `contracts/bvt/` — BVT ERC-20, auditor staking/slash, fee router, governor + 48h timelock (no sale premine). See `docs/BVT_TOKENOMICS.md`.
- `formal_verification/invariants.md` — properties to prove.
- `key_management/` — ceremony + HSM notes.

## Quick start
```bash
pip install -r requirements.txt
./pipeline/run_audit.sh
python meta_audit/meta_audit_runner.py --primary audit_report.json
```

### Live Grok
Key from env only. Never commit `XAI_API_KEY`.

```bash
XAI_API_KEY=… python pipeline/end_to_end_runner.py --target grok --scenarios-dir scenarios --limit 5 --out audit_report.json
```

Default model: `grok-4-1-fast` (override with `XAI_MODEL` or `--model`, e.g. `grok-4.6` or `grok-3-mini`). Alias: `GROK_API_KEY`. Stub still works with no key: `./pipeline/run_audit.sh`.

xAI base URL is env-only: `XAI_API_BASE` (default `https://api.x.ai/v1`). Do not pass a client/CLI base — that is rejected (SSRF). HTTPS only; no credentials in the URL.

The built-in **keyword scorer is demo-only** and not attestation-grade. `POST /v1/bots` and `--require-attestation` fail closed on keyword scores unless you set `ALLOW_KEYWORD_ATTESTATION=1`. Optional LLM-as-judge: `--scorer llm` (requires `XAI_API_KEY`).

### Stamp API auth
Privileged writes (`POST /v1/bots`, denylist writes, history append) require `STAMP_API_KEY`. Send `X-API-Key` or `Authorization: Bearer <key>`. Public reads (`GET` stamp/bot/denylist, `POST /v1/access/check`) stay open. Unset key → privileged writes return 503.

On register the server recomputes `sha256(canonical(fingerprint))` and rejects a mismatched `fingerprint_hash`. Conversation / rap-sheet history is capped and operator-isolated (`system` role is not accepted from untrusted clients).

### Contracts (Base Sepolia, chainid 84532)
Agents do **not** broadcast. Spencer deploys with his key:

```bash
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge build && forge test
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
# PRIVATE_KEY from env only — never commit
# CORE_TIMELOCK is an EOA (with EIP-7702 delegation), not a timelock; to be replaced by TimelockController (docs/runbooks/CORE_TIMELOCK_MIGRATION.md). Must not be the deployer.
# (1) forge script script/Deploy.s.sol:Deploy --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast
#     then CORE_TIMELOCK acceptOwnership() on Denylist and Vault, and setArbitrator x3
# Escrow is live and Gate B is seated. Record: script/DEPLOY_ESCROW_BASE_SEPOLIA.md
# SIMULATE is not live. Agents do not --broadcast. Do not replace the live escrow address.
# (2) escrow — env DENYLIST, VAULT, DISPUTE_PANEL, CORE_TIMELOCK (CORE_TIMELOCK must acceptOwnership):
# forge script script/DeployBotAttestationEscrow.s.sol:DeployBotAttestationEscrow --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast
# (3) optional BVT stack (hardened roles; sinks default to timelock). BVT_GUARDIAN required (≠ deployer):
# forge script script/DeployBVT.s.sol:DeployBVT --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast
# Denylist + Vault tip-bytecode redeploy (simulate only; Spencer broadcasts). See script/DEPLOY_DENYLIST.md
# forge script script/DeployDenylist.s.sol:DeployDenylist --rpc-url $BASE_SEPOLIA_RPC_URL -vvvv
```

`foundry.toml` pins solc `0.8.20`, the optimizer at 200 runs, and `evm_version = "shanghai"`. Moving `evm_version` from `cancun` to `shanghai` is output-neutral for these contracts: solc 0.8.20 does not implement Cancun, so the compiler was already emitting Shanghai bytecode.

Core `Deploy.s.sol`, `DeployDenylist.s.sol`, `DeployBotAttestationEscrow.s.sol`, and additive `DeployBVT.s.sol` all revert on Ethereum mainnet (`chainid == 1`) and on any chain other than Base Sepolia. ETH Sepolia (`11155111`) is a documented one-line switch. Paste addresses into `deployments/base-sepolia.json` and `contracts/README.md` after deploy. The Denylist redeploy does not invent those addresses; Spencer writes them after he broadcasts. Agents do not `--broadcast`.


### Wallet UI (Base Sepolia)

`apps/wallet-ux` connects an injected wallet and reads Gate A, the seated dispute panel, and live escrow. It refuses every chain except Base Sepolia (84532), including Ethereum mainnet and Base mainnet. Escrow and dispute calldata can be submitted from a wallet that is on Base Sepolia. The current Pages site is https://agent-bv.pages.dev. https://agent-a-wallet-ux.pages.dev stays live until a live refund passes on the new site.

```bash
cd apps/wallet-ux
npm install
npm run dev
```

See [`apps/wallet-ux/README.md`](apps/wallet-ux/README.md).

## Status
Architecture complete. Core runner (stub + live Grok client), denylist, vault, liability, insurance, dispute, meta-audit, key management, Base Sepolia Foundry deploy, and the BVT staking/fee/governance stack are real code. Core, Gate B, and BotAttestationEscrow are on Base Sepolia. BVT is not deployed. Agents do not `--broadcast`. Remaining: the first live attested audit.

Built by Spencer (SAW72) — trades mindset, crypto-native, early on purpose.
