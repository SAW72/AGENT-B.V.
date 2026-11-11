# Agent-BV on NEAR testnet: policy contract, guarded agent, attack demo

Testnet only. Built for NEAR HACKATHON (track: AI Security & Defense). The
judge-facing summary, Q-002 disclosure and "do X, see Y" steps are in the
[root README](../README.md#near-hackathon-entry-near-testnet-ai-security--defense).
Everything in this folder was written during the hackathon window.

## Layout

| Path | What it is |
|---|---|
| `contract/` | Rust policy contract (near-sdk 5.27). `src/lib.rs` is the contract, `src/tests.rs` the unit tests. `res/agent_bv_policy.wasm` is the exact build deployed to testnet (sha256 in `deployments/testnet.json`). |
| `agent/src/guarded-agent.mjs` | The wrapper: `check` view, then refuse (block) / ask a human (warn) / sign `request_payment` (allow). |
| `agent/src/key-guard.mjs` | Refuses to run unless the agent key is a function-call key for the policy contract limited to `request_payment`. |
| `agent/src/near-client.mjs` | near-api-js 7 client. The agent client is built only from the function-call key file. |
| `agent/src/naive-agent.mjs` | A deterministic stand-in for a prompt-injected LLM agent: it obeys payment instructions found in untrusted documents. It is not an LLM; it models the worst case so replays are identical. |
| `agent/demo/attack.mjs`, `agent/demo/warn.mjs` | The demos. They write `near/demo/out/attack.log` and `near/demo/out/warn.log` (git-ignored). |
| `demo/sample-attack.log`, `demo/sample-warn.log` | Logs from the testnet runs, committed for comparison. |
| `agent/test/unit.test.mjs` | Wrapper + key-guard unit tests (no network). |
| `agent/test/sandbox.test.mjs` | End-to-end tests on a local nearcore sandbox (no testnet). |
| `agent/scripts/` | `view.mjs` (read-only state), `key-info.mjs` (agent keys), `setup.mjs` (one-time deploy/setup), `sandbox-test.sh`. |
| `scripts/deploy.sh` | Deploy your own copy on testnet with free faucet accounts. |
| `deployments/testnet.json` | Public record of the testnet deployment: account ids, public key, wasm hash, tx hashes. No secrets. |

## Policy

`check(agent, receiver, amount)` (free view) and `request_payment(receiver, amount)` (agent call) use the same rules:

| Verdict | When |
|---|---|
| `block` | receiver is on the owner's blocklist; receiver's attestation is `fail`; agent not registered; cumulative spend would exceed the agent's limit; amount is 0; receiver is the agent or the contract; pool too small; or (call only) 50 payments already wait for approval |
| `warn` | receiver has no attestation; receiver's attestation is `warn`; amount is above `warn_above` |
| `allow` | otherwise |

On `allow` the contract transfers from its own testnet balance and adds the amount to the agent's `spent`. On `warn` it parks the payment; only the owner can `approve_pending` (blocking rules are re-checked then) or `reject_pending`. On `block` it emits a `payment_blocked` event, increments `blocked_attempts`, and moves nothing. Owner-only methods: `add_to_blocklist`, `remove_from_blocklist`, `record_attestation`, `set_agent_limit`, `set_warn_above`, `approve_pending`, `reject_pending`.

## Testnet deployment (Nov 11, 2026)

| Item | Value |
|---|---|
| Policy contract / owner | `agentbv-policy-11111545.testnet` |
| Agent (function-call key only) | `agentbv-agent-11111545.testnet` |
| Merchant (attested `pass`) | `agentbv-merchant-11111545.testnet` |
| Known-bad, blocklisted (never created) | `agentbv-drainer-11111545.testnet` |
| Bad bot, attested `fail` (never created) | `agentbv-badbot-11111545.testnet` |
| Agent limit / warn above | 0.05 / 0.02 testnet NEAR |
| Deploy + init tx | https://testnet.nearblocks.io/txns/2he2GAkgqNEUZwfNtfRFgnxyvo33GokooJp1YTyseW6M |

All tx links are in `deployments/testnet.json` and the sample logs. Accounts came from the free testnet faucet; no real funds are involved.

## Toolchain

- Rust via rustup. `contract/rust-toolchain.toml` pins 1.86.0 with the `wasm32-unknown-unknown` target. Newer near-sdk releases need a newer rustc (5.30 needs 1.95), so `Cargo.lock` pins near-sdk 5.27.0, the newest the resolver accepts for 1.86.
- Node 22 (20+ works). near-api-js 7.5.3, near-workspaces 5.0.0 (dev).
- Sandbox: `agent/scripts/sandbox-test.sh` downloads nearcore 2.14.0 `near-sandbox` (Linux x86_64) into `near/.sandbox/`. near-workspaces' bundled nearcore 2.6.2 rejects Wasm from current rustc.
- Optional: [near-cli-rs](https://github.com/near/near-cli-rs) 0.31.1, used only by `scripts/deploy.sh` to create faucet accounts.

```bash
cd near/contract && cargo test                        # 23 contract unit tests
./build.sh                                            # rebuild res/agent_bv_policy.wasm
cd ../agent && npm ci && npm test                     # 12 wrapper unit tests
npm run test:sandbox                                  # 10 sandbox end-to-end tests
npm run view                                          # read the live testnet contract (no keys)
npm run keys                                          # show the agent account's keys (no keys needed)
```

The first `cargo test` compiles near-sdk's unit-testing runtime and is slow (minutes).

## Deploy your own (testnet, free)

Full steps: [DEPLOY.md](DEPLOY.md).

```bash
cd near && ./scripts/deploy.sh      # needs `near` (near-cli-rs) on PATH
cd agent && npm run demo:attack && npm run demo:warn
```

`deploy.sh` creates three faucet accounts, deploys `contract/res/agent_bv_policy.wasm`, sets up the policy, adds the agent's function-call key, deletes the agent's full-access key, and overwrites `deployments/testnet.json` with your ids. Keys stay in `~/.near-credentials/testnet/` (the agent's function-call key in `agentbv-fc/`), outside the repo. Each attack run pays 0.001 testnet NEAR to the merchant, so the 0.05 limit allows about 50 runs.

## Known limits (testnet demo)

- The demo agent is a deterministic script, not an LLM.
- Attestations are recorded by the owner; the contract does not verify an audit itself, and Agent-BV's TEE attestation is not live.
- A transfer is scheduled without a callback. If it failed (for example a receiver that does not exist), `spent` would still count it. Attested receivers in the demo exist.
- The owner is a single full-access key, not a multisig or timelock.
- Not audited.

## Libraries and AI use (Q-005)

near-sdk (Rust), near-api-js, near-workspaces, nearcore sandbox, near-cli-rs. Code was written with AI assistance during the hackathon window. No pre-hackathon Agent-BV code is reused here.
