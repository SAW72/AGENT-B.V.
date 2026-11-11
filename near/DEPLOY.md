# Deploy your own copy (NEAR testnet, free)

Testnet only. Uses free faucet accounts; no real funds. Nothing here talks to mainnet.

Needs: Rust/Node as in [README.md](README.md#toolchain), and [near-cli-rs](https://github.com/near/near-cli-rs) (`near`) on PATH.

```bash
cd near && ./scripts/deploy.sh      # creates faucet accounts, deploys contract/res/agent_bv_policy.wasm, sets up the policy
cd agent && npm run view            # check the new deployment (read-only)
npm run keys                        # agent holds only a function-call key for request_payment
npm run demo:attack                 # writes near/demo/out/attack.log; compare with near/demo/sample-attack.log
npm run demo:warn                   # writes near/demo/out/warn.log; compare with near/demo/sample-warn.log
```

`deploy.sh` creates three faucet accounts (policy/owner, agent, merchant), deploys the committed Wasm, records the demo attestations and blocklist entry, adds the agent's function-call key (receiver = your policy account, method = `request_payment`), deletes the agent's full-access key, and overwrites `deployments/testnet.json` with your account ids. Keys stay in `~/.near-credentials/testnet/` (the agent's function-call key in `agentbv-fc/`), outside the repo; never commit them.

When comparing your `demo/out/attack.log` with the sample, ignore timestamps, transaction hashes and account ids. Each attack run pays 0.001 testnet NEAR to the merchant, so the 0.05 demo limit allows about 50 runs.
