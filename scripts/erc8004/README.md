# TCS Grokbot registration helper (unsigned)

Base Sepolia only. Chain id 84532.

This helper writes the agent registration file and the unsigned `register(string)` call for the existing ERC-8004 Identity Registry `0x8004A818BFB912233c491871b3d84c89A494BD9e`. It does not deploy a contract. It does not hold a key. This branch never runs the send. Spencer runs the send himself from his own wallet.

The agent id is assigned by the mint. This file does not call the Vault, the timelock, or the Safe. Those steps wait until the id exists, and Spencer schedules them himself.

`scripts/erc8004/tcs-grokbot-registration.json` is the registration file (`type` `https://eips.ethereum.org/EIPS/eip-8004#registration-v1`, name `TCS Grokbot`, `active` true). The `registrations` list is omitted until the agent id exists. A later `setAgentURI` can add it. That second call is also Spencer's to sign.

Run the dry run from the repo root. `<his-address>` is the address that will send the mint. `<his-keystore>` is the account in his own cast keystore. `<base-sepolia-rpc>` is a Base Sepolia URL with no key in it. No ETH value is attached. Gas is testnet gas only.

`cast` 1.8.3 accepts `--chain` on `cast call` and `cast send`. It does not accept `--chain` on `cast calldata`, `cast estimate`, or `cast chain-id`. Those lines stay without that flag. The send block below exits unless `cast chain-id` is 84532.

```bash
REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e
AGENT_URI="data:application/json;base64,$(base64 < scripts/erc8004/tcs-grokbot-registration.json | tr -d '\n')"

# Exact unsigned calldata for register(string agentURI). No RPC.
cast calldata "register(string)" "$AGENT_URI"

# Read-only dry run from his address. eth_call and eth_estimateGas. No broadcast.
# Stop unless this RPC is Base Sepolia 84532.
[ "$(cast chain-id --rpc-url <base-sepolia-rpc>)" = 84532 ] || exit 1
cast call "$REGISTRY" "register(string)(uint256)" "$AGENT_URI" --from <his-address> --rpc-url <base-sepolia-rpc> --chain 84532
cast estimate "$REGISTRY" "register(string)" "$AGENT_URI" --from <his-address> --rpc-url <base-sepolia-rpc>
```

Stop. The next block is the send. This branch never runs it. Spencer runs it himself, from his own machine, after the dry run. A wrong chain, or any answer other than `YES`, exits before `cast send`.

```bash
REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e
AGENT_URI="data:application/json;base64,$(base64 < scripts/erc8004/tcs-grokbot-registration.json | tr -d '\n')"

# Exits unless the RPC reports chain id 84532, then waits for a typed YES.
[ "$(cast chain-id --rpc-url <base-sepolia-rpc>)" = 84532 ] || exit 1
printf 'type YES: '
read -r ok
[ "$ok" = YES ] || exit 1
cast send "$REGISTRY" "register(string)" "$AGENT_URI" --account <his-keystore> --rpc-url <base-sepolia-rpc> --chain 84532
```

After the mint, the gateway is `https://agent-bv.pages.dev/app/identity`. The check is signed by the agent wallet in the browser. The page label is "Checks run in your browser".
