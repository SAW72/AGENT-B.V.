#!/usr/bin/env bash
# Deploy your own copy of the Agent-BV policy contract to NEAR TESTNET.
# Needs: near-cli-rs (`near`), Node >= 20, and a built wasm (see near/README.md).
# Accounts are created free by the testnet faucet. Keys are saved by near-cli-rs
# in ~/.near-credentials (outside this repo). Nothing here touches mainnet.
set -euo pipefail
cd "$(dirname "$0")/.."
SUF="${SUFFIX:-$(date +%m%d%H%M)}"
P="agentbv-policy-$SUF.testnet"; A="agentbv-agent-$SUF.testnet"; M="agentbv-merchant-$SUF.testnet"
D="agentbv-drainer-$SUF.testnet"; B="agentbv-badbot-$SUF.testnet"   # never created; only referenced
for acct in "$P" "$A" "$M"; do
  if [ -f "$HOME/.near-credentials/testnet/$acct.json" ]; then echo "exists: $acct"; continue; fi
  near account create-account sponsor-by-faucet-service "$acct" autogenerate-new-keypair \
    save-to-legacy-keychain network-config testnet create | grep -E "created successfully|Transaction ID"
done
chmod -R go-rwx "$HOME/.near-credentials"
node agent/scripts/setup.mjs "$P" "$A" "$M" "$D" "$B"
