# Register two Financial-tier test bots on the live Base Sepolia Vault

This runbook registers two test bots on the live Vault so `createEscrow` on the live escrow can get past `InvalidParties`. Spencer signs both registrations from `CORE_TIMELOCK`. An agent session stops at the read-only dry-run.

The live Vault has no bots. `BotAttestationEscrow.createEscrow` reads `Vault.operator(botId)` and reverts `InvalidParties` when that address is the zero address. Binding a payer operator and a payee operator, both at Financial tier, is the fix.

The first smoke sets the payer operator to Spencer's own wallet. He calls `createEscrow` from that wallet, because `createEscrow` requires `msg.sender == operator(payerBotId)`. The relayer is not the payer operator for this smoke. That mode is optional and later, and only after the two gates in [Optional later mode](#optional-later-mode-relayer-as-payer-operator).

Reads below were taken against `https://sepolia.base.org` (chain id `84532`). Owner, tier, and empty-bot reads ran while the head moved through `47391918`–`47392049`. The payer-wallet simulations in [Simulation-only record](#simulation-only-record) ran at block `47392348`. The `Registered` / `OperatorSet` log scan covers the Vault from its deploy block `47294164` through block `47392049`. Nothing in this file was broadcast.

## Hard stops

1. Spencer sends the two `cast send` registration transactions himself, from `0x10CC9474b45625ADfd05C209f2518023484878D9`.
2. Agent sessions stop after `cast call`, `cast estimate`, `cast code`, `cast storage`, `cast logs`, and `cast calldata`. They do not run `cast send`, `--broadcast`, or any command with a private key.
3. Every send template uses `--account <his-keystore>`. None of them contain `--private-key`.
4. The chain is Base Sepolia only. The RPC is `https://sepolia.base.org`.
5. The first smoke does not register `0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861` as a Vault operator.

## Prerequisites

Spencer ticks both boxes before any `register` command (steps 3, 4, and 7). Steps 1 and 2 are reads.

- [ ] wallet-ux Pages redeployed without the embedded secret
- [ ] Retired by #46 (code path removed), not rotated. Tick only after CUTOVER.md (#51) step 1 has deleted the old values on Render, GitHub, and Cloudflare.

Retired by #46 (code path removed), not rotated. Tick only after CUTOVER.md (#51) step 1 has deleted the old values on Render, GitHub, and Cloudflare. Do that before the first `register`, including the Spencer-wallet smoke.

## What the source and the chain agree on

`contracts/Vault.sol` at main `34c9d71` is the registration contract. The owner-only write that fixes the escrow check is the six-argument overload:

```solidity
function register(
    bytes32 botId,
    bytes32 weightHash,
    bytes32 behaviorSig,
    bytes32 promptHash,
    Tier tier,
    address operator_
) external onlyOwner
```

Selector `0xb4560e96`. `Tier.Financial` is enum value `3` (`None = 0`, `Chat = 1`, `DataTools = 2`, `Financial = 3`, `Critical = 4`). The five-argument `register` (`0xeea95429`) stores the bot and leaves `operator` at the zero address, so `createEscrow` still reverts `InvalidParties`. Use the six-argument form.

There is no stake, bond, or fee on this call. The argument list has no token and no amount. The function is not payable: a call with `msg.value` of 1 wei reverts with empty revert data. `deployments/base-sepolia.json` leaves `BVT.address` null, and `Vault.register` does not call `BVTFeeRouter`. Spencer does not approve a token and does not attach ETH to the registration.

`onlyOwner` checks `msg.sender == owner()`. On chain that owner is `0x10CC9474b45625ADfd05C209f2518023484878D9`. `pendingOwner()` is the zero address. The same account owns the live Denylist and the live escrow, and it is the escrow's immutable `governance`.

That account is an EIP-7702-delegated EOA. Its code is 23 bytes:

```text
0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b
```

The address after `0xef0100` is `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` (the delegate recorded in `test/LiveDenylistVault.t.sol`). `getMinDelay()` reverts. `schedule(address,uint256,bytes,bytes32,bytes32,uint256)` reverts. There is no `TimelockController` delay. A transaction from this account runs immediately.

`register` also calls `denylist.check(weightHash, behaviorSig, promptHash)` and requires `MatchLevel.None` (`0`). Any other level reverts with the string `bot is denylisted`. The live Denylist is `0xeE76876bECcFc1B58fC06fF4E654a517d784B224`, which is what `Vault.denylist()` returns. Both test fingerprints below return `0`.

The Vault's executable runtime bytecode matches `forge build` of `contracts/Vault.sol` (solc `0.8.20`, optimizer on, 200 runs). Codesize is `2799`. The trailing CBOR records solc `0.8.20`. The 32-byte IPFS metadata hash differs from a fresh compile on this machine; the opcodes before that CBOR match. The deployed bytecode contains selectors for both `register` overloads, `setOperator`, `bots`, `operator`, `tierMaxPermissions`, `grantAccess`, `burn`, `owner`, and `denylist`.

The live Denylist executable bytecode matches `contracts/Denylist.sol` as of `78e3ba0` (the source that was current when this pair was deployed). Current `main` adds `InvalidBucket` on `remove` / `everListed` / `listing`. `check()` itself is unchanged. Registration only calls `check()`.

`tierMaxPermissions` on the live Vault:

| Tier | uint8 | max permissions |
| --- | --- | --- |
| None | 0 | 0 |
| Chat | 1 | 1 |
| DataTools | 2 | 2 |
| Financial | 3 | 3 |
| Critical | 4 | 4 |

No bot is registered. `Registered(bytes32,uint8,uint256)` topic `0x2578fc74812af5cd47b15f759eb9c5fc42c617d359b4974992d25e50fba91add` and `OperatorSet(bytes32,address)` topic `0x9efccfdeeb35d36624f8546b14ab72aa768151985ee15f2f7dfce288348baaa3` have zero logs from block `47294164` through block `47392049`. The public RPC allows 1,000 blocks per `eth_getLogs`, so the scan was one window at a time. `bots` for the two ids below is empty (`registeredAt = 0`, `active = false`, tier `0`) and `operator` is the zero address.

## What createEscrow actually checks

`createEscrow(bytes32 escrowId, address payee, bytes32 payerBotId, bytes32 payeeBotId, uint256 durationSeconds)` on `0x3d660502D75f1e97b08c110255921b437A3C4C42` reverts `InvalidParties` (`0xb6e500fe`) unless all of these hold:

1. `payee` is not the zero address, and `payee` is not `msg.sender`.
2. Both bot ids are non-zero, and they are different from each other.
3. `vault.operator(payerBotId) == msg.sender`. The payer is whoever sends `createEscrow`.
4. `vault.operator(payeeBotId) == payee`. The payee argument is the payee bot's operator.

After that, `_verifyBot` requires each bot to be active, tier `>= Financial` (`3`), `grantAccess(botId, 3) == true`, and `denylist.check` of the stored fingerprint equal to `None`. A Financial bot with max permissions `3` passes `grantAccess(botId, 3)`.

Bot A is the payer bot. Its operator is Spencer's wallet, and that same wallet sends `createEscrow`. Bot B is the payee bot. Its operator is the `payee` argument.

## Addresses

| Role | Address |
| --- | --- |
| Vault | `0x1463D664fA467FBCDA4B05443434494f05e565bc` |
| Denylist | `0xeE76876bECcFc1B58fC06fF4E654a517d784B224` |
| BotAttestationEscrow | `0x3d660502D75f1e97b08c110255921b437A3C4C42` |
| CORE_TIMELOCK (registration sender) | `0x10CC9474b45625ADfd05C209f2518023484878D9` |
| Payer operator, first smoke | `<SPENCER_PAYER_WALLET>` |
| Payee operator | `<REAL_PAYEE_WALLET>` |
| Relayer, optional later mode only | `0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861` |

The relayer address is the public hot wallet in `deployments/base-sepolia.json` (`claimRelayerWallet`), `claim-relayer/.env.example` (`RELAYER_ADDRESS`), and `claim-relayer/README.md`. No private key is stored there. It is not `PAYER_OPERATOR` for the first smoke.

## Bot id rule

The Vault does not derive `botId`. The owner passes a `bytes32`, and that id is permanent. A second `register` for the same id reverts `already registered`, including after `burn`.

These two smoke ids are `cast keccak` of a fixed ASCII string (raw bytes, not ABI-encoded):

```bash
cast keccak "agent-bv:base-sepolia:p1d:bot-a:payer"
# 0xa450ef44f1712ad6894a0dabb8a29774918db7452510d9b422e553bdded40532

cast keccak "agent-bv:base-sepolia:p1d:bot-b:payee"
# 0xc84705852089ffaea2c5bda0b1dbcba6aae7f3d876cc4e49dcdf2ea2ff780e94
```

Fingerprints use the same rule. They are the values `denylist.check` and, later, `_verifyBot` read. They are not the bot id.

```bash
# Bot A
cast keccak "agent-bv:base-sepolia:p1d:bot-a:weight"     # 0xf9cc540627d352529a2568a8400427dcce9b68d2c479a1078148868047218a9f
cast keccak "agent-bv:base-sepolia:p1d:bot-a:behavior"   # 0xe863e38846ffd3f86bda77edd9e0d95097057a57d1b6732047546183048f6edd
cast keccak "agent-bv:base-sepolia:p1d:bot-a:prompt"     # 0xcee6783c2b68ccd68b77fea3b3084b6937c8e881d563a5d72a8c0809b6c49dbb

# Bot B
cast keccak "agent-bv:base-sepolia:p1d:bot-b:weight"     # 0xa7b6c55a356a156e98ecf59c2c84c909ff97c5482028fbd8b419d04630409aea
cast keccak "agent-bv:base-sepolia:p1d:bot-b:behavior"   # 0xa068a50733d40b7c745e9bb98931dffe295f917d9ae98ee78f8abf3c76aaa7da
cast keccak "agent-bv:base-sepolia:p1d:bot-b:prompt"     # 0x3f6dbab9b8cf39f0a13b6e8348f3100e05af1d7d53e95f7fd7e52ac629fcdd6d
```

## Clear leftover operators

Paste this block by itself and let it finish before the export block. It is a separate paste on purpose. zsh, the default on a Mac, rejects an unedited export paste as one unit, so an `unset` written inside that export paste never runs and a previous payer and payee stay set. This step clears them even when the next paste is rejected.

```bash
unset PAYER_OPERATOR PAYEE_OPERATOR
```

## Checklist

Replace both angle-bracket tokens with checksummed addresses, then follow the numbers in order. Left as written, the two operator exports fail to parse (`<` is a redirection).

Bash reads a paste one line at a time, so it reports a syntax error on the angle brackets and does not set the placeholders. zsh rejects that whole paste, so a previous valid address can remain if the clear step above was skipped. `ops_guard` does not rely on that `unset`. After checksum, and ignoring hex case, it rejects a payer or a payee that is blocklisted. That list is the `bEEF` placeholder, the zero address, the simulation stand-ins `0x1111111111111111111111111111111111111111` and `0x2222222222222222222222222222222222222222`, the live escrow `0x3d660502D75f1e97b08c110255921b437A3C4C42`, the retired ESC-M-1 escrow `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d`, the retired escrow `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c`, the sample senders in `script/` (`0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001`, `0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38`, `0x0000000000000000000000000000000000000A11`, `0x0000000000000000000000000000000000000A22`, `0x0000000000000000000000000000000000000A33`, and `0x0000000000000000000000000000000000000001`), and these book addresses from `deployments/base-sepolia.json`: Vault `Vault.address` `0x1463D664fA467FBCDA4B05443434494f05e565bc`, Denylist `Denylist.address` `0xeE76876bECcFc1B58fC06fF4E654a517d784B224`, DisputePanel `DisputePanel.address` `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb`, the old Vault `superseded.Vault.address` `0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7`, Liability `Liability.address` `0x554Caf5a214B8d70D675C09186C5EAE24FEB7307`, InsuranceFund `InsuranceFund.address` `0x19fc26B36Cb2031062eD90C19db64b3b09753ab8`, and the old Denylist `superseded.Denylist.address` `0xF0f260967D377E07Bdd7840862508ddB23C012b8`. `coreTimelock` and the escrow deployer stay allowed. They are EOAs. It also rejects either operator equal to the relayer, the two operators equal to each other, and a shell with no `cast`. Step 7 still prints both values and waits for `YES` before either registration `cast send`. That prompt is what stops a stale address that is not on the list. Both send pastes check `cast chain-id` and skip the send unless it is `84532`. A missing `cast` prints `cast is not installed` and does not report a wrong chain. The shell stays open.

```bash
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
export VAULT=0x1463D664fA467FBCDA4B05443434494f05e565bc
export DENYLIST=0xeE76876bECcFc1B58fC06fF4E654a517d784B224
export ESCROW=0x3d660502D75f1e97b08c110255921b437A3C4C42
export CORE_TIMELOCK=0x10CC9474b45625ADfd05C209f2518023484878D9
export PAYER_OPERATOR=<SPENCER_PAYER_WALLET>
export PAYEE_OPERATOR=<REAL_PAYEE_WALLET>

export BOT_A=0xa450ef44f1712ad6894a0dabb8a29774918db7452510d9b422e553bdded40532
export WEIGHT_A=0xf9cc540627d352529a2568a8400427dcce9b68d2c479a1078148868047218a9f
export SIG_A=0xe863e38846ffd3f86bda77edd9e0d95097057a57d1b6732047546183048f6edd
export PROMPT_A=0xcee6783c2b68ccd68b77fea3b3084b6937c8e881d563a5d72a8c0809b6c49dbb

export BOT_B=0xc84705852089ffaea2c5bda0b1dbcba6aae7f3d876cc4e49dcdf2ea2ff780e94
export WEIGHT_B=0xa7b6c55a356a156e98ecf59c2c84c909ff97c5482028fbd8b419d04630409aea
export SIG_B=0xa068a50733d40b7c745e9bb98931dffe295f917d9ae98ee78f8abf3c76aaa7da
export PROMPT_B=0x3f6dbab9b8cf39f0a13b6e8348f3100e05af1d7d53e95f7fd7e52ac629fcdd6d

export ESCROW_ID=0xcf49428f2c5d229ad09cd8c4c343539fa4c80199aa43d6d9c900bfff4102686b
```

`ESCROW_ID` is `cast keccak "agent-bv:base-sepolia:p1d:create-escrow-dry-run"`. It is only for the simulation. `usedEscrowIds` for it was `false` at block `47392038`.

`PAYER_OPERATOR` is the wallet Spencer will use as `msg.sender` on `createEscrow`. `PAYEE_OPERATOR` is the payee test wallet. They are different addresses. The registration transaction is still sent by `CORE_TIMELOCK`, which can be a different account from `PAYER_OPERATOR`.

1. Confirm the chain, the owner, the tier cap, and that these ids are empty.

```bash
cast chain-id --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "owner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "pendingOwner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "denylist()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "tierMaxPermissions(uint8)(uint8)" 3 --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast code "$CORE_TIMELOCK" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "bots(bytes32)(bytes32,bytes32,bytes32,uint8,bool,uint256)" "$BOT_A" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "operator(bytes32)(address)" "$BOT_A" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "bots(bytes32)(bytes32,bytes32,bytes32,uint8,bool,uint256)" "$BOT_B" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "operator(bytes32)(address)" "$BOT_B" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Observed in this session:

```text
84532
0x10CC9474b45625ADfd05C209f2518023484878D9
0x0000000000000000000000000000000000000000
0xeE76876bECcFc1B58fC06fF4E654a517d784B224
3
0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b
```

Both `bots` rows were `(0x0, 0x0, 0x0, 0, false, 0)`. Both `operator` reads were `0x0000000000000000000000000000000000000000`.

2. Confirm the fingerprints are clean on the live Denylist. `0` means `MatchLevel.None`.

```bash
cast call "$DENYLIST" "check(bytes32,bytes32,bytes32)(uint8)" \
  "$WEIGHT_A" "$SIG_A" "$PROMPT_A" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$DENYLIST" "check(bytes32,bytes32,bytes32)(uint8)" \
  "$WEIGHT_B" "$SIG_B" "$PROMPT_B" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Observed output, each call:

```text
0
```

3. Dry-run Bot A from `CORE_TIMELOCK`. `PAYER_OPERATOR` is Spencer's wallet. `cast call` returns `0x` when the state change succeeds and the function returns nothing. `cast estimate` returns gas. Neither command sends a transaction. Both prerequisite boxes are ticked before this step.

```bash
cast call "$VAULT" "register(bytes32,bytes32,bytes32,bytes32,uint8,address)" \
  "$BOT_A" "$WEIGHT_A" "$SIG_A" "$PROMPT_A" 3 "$PAYER_OPERATOR" \
  --from "$CORE_TIMELOCK" --rpc-url "$BASE_SEPOLIA_RPC_URL"

cast estimate "$VAULT" "register(bytes32,bytes32,bytes32,bytes32,uint8,address)" \
  "$BOT_A" "$WEIGHT_A" "$SIG_A" "$PROMPT_A" 3 "$PAYER_OPERATOR" \
  --from "$CORE_TIMELOCK" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

A `cast call` of the same register with `--value 1` from `CORE_TIMELOCK` reverts with no revert data. Leave the value off.

The same register with `--from` set to any account other than `CORE_TIMELOCK` reverts `OwnableUnauthorizedAccount` (`0x118cdaa7`). The registration has to come from `CORE_TIMELOCK`.

4. Define `ops_guard`, then dry-run Bot B only if it returns 0. Paste this block as one unit. The function checks that `cast` is installed, that each operator is a valid checksummed address (`cast to-check-sum-address`, then compare the shell value to that result), and that the two operators differ. After checksum, and ignoring hex case, it rejects either operator when it is the relayer `0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861` or when it is blocklisted: the `bEEF` placeholder, the zero address, a simulation stand-in, the live escrow, the retired escrow, a sample sender from `script/`, the live Vault, the live Denylist, DisputePanel, the old Vault, Liability, InsuranceFund, or the old Denylist. Those book addresses in `deployments/base-sepolia.json` are `Vault.address`, `Denylist.address`, `DisputePanel.address`, `superseded.Vault.address`, `Liability.address` `0x554Caf5a214B8d70D675C09186C5EAE24FEB7307`, `InsuranceFund.address` `0x19fc26B36Cb2031062eD90C19db64b3b09753ab8`, and `superseded.Denylist.address` `0xF0f260967D377E07Bdd7840862508ddB23C012b8`. `coreTimelock` and the deployer stay allowed. That check does not depend on the earlier `unset`. A failure prints why and `return`s 1. It does not `exit`, so the interactive shell stays open. The dry-run is on the same `&&` chain, so a failure skips both `cast` commands. The chain-id check is on the two send pastes, not on this dry-run. A wrong chain skips the send and leaves the shell open.

```bash
ops_guard() {
  local payer payee relayer payer_lc payee_lc relayer_lc banned banned_lc
  if ! command -v cast >/dev/null 2>&1; then
    echo "cast is not installed"
    return 1
  fi
  payer=$(cast to-check-sum-address "${PAYER_OPERATOR-}") || {
    echo "PAYER_OPERATOR invalid/placeholder"
    return 1
  }
  payee=$(cast to-check-sum-address "${PAYEE_OPERATOR-}") || {
    echo "PAYEE_OPERATOR invalid/placeholder"
    return 1
  }
  relayer=$(cast to-check-sum-address 0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861) || {
    echo "cast to-check-sum-address failed"
    return 1
  }
  payer_lc=$(printf '%s' "$payer" | tr '[:upper:]' '[:lower:]')
  payee_lc=$(printf '%s' "$payee" | tr '[:upper:]' '[:lower:]')
  relayer_lc=$(printf '%s' "$relayer" | tr '[:upper:]' '[:lower:]')
  if [ "$payer_lc" = "$relayer_lc" ]; then
    echo "PAYER_OPERATOR is the relayer"
    return 1
  fi
  if [ "$payee_lc" = "$relayer_lc" ]; then
    echo "PAYEE_OPERATOR is the relayer"
    return 1
  fi
  while IFS= read -r banned; do
    [ -n "$banned" ] || continue
    banned=$(cast to-check-sum-address "$banned") || {
      echo "cast to-check-sum-address failed"
      return 1
    }
    banned_lc=$(printf '%s' "$banned" | tr '[:upper:]' '[:lower:]')
    if [ "$payer_lc" = "$banned_lc" ]; then
      echo "PAYER_OPERATOR is blocklisted"
      return 1
    fi
    if [ "$payee_lc" = "$banned_lc" ]; then
      echo "PAYEE_OPERATOR is blocklisted"
      return 1
    fi
  done <<'END_KNOWN'
0x000000000000000000000000000000000000bEEF
0x0000000000000000000000000000000000000000
0x1111111111111111111111111111111111111111
0x2222222222222222222222222222222222222222
0x3d660502D75f1e97b08c110255921b437A3C4C42
0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d
0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c
0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001
0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38
0x0000000000000000000000000000000000000A11
0x0000000000000000000000000000000000000A22
0x0000000000000000000000000000000000000A33
0x0000000000000000000000000000000000000001
0x1463D664fA467FBCDA4B05443434494f05e565bc
0xeE76876bECcFc1B58fC06fF4E654a517d784B224
0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb
0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7
0x19fc26B36Cb2031062eD90C19db64b3b09753ab8
0x554Caf5a214B8d70D675C09186C5EAE24FEB7307
0xF0f260967D377E07Bdd7840862508ddB23C012b8
END_KNOWN
  if [ "$PAYER_OPERATOR" != "$payer" ]; then
    echo "PAYER_OPERATOR is not checksummed (expected $payer)"
    return 1
  fi
  if [ "$PAYEE_OPERATOR" != "$payee" ]; then
    echo "PAYEE_OPERATOR is not checksummed (expected $payee)"
    return 1
  fi
  if [ "$payee" = "$payer" ]; then
    echo "PAYER_OPERATOR and PAYEE_OPERATOR are the same address"
    return 1
  fi
  return 0
}

ops_guard && cast call "$VAULT" "register(bytes32,bytes32,bytes32,bytes32,uint8,address)" \
  "$BOT_B" "$WEIGHT_B" "$SIG_B" "$PROMPT_B" 3 "$PAYEE_OPERATOR" \
  --from "$CORE_TIMELOCK" --rpc-url "$BASE_SEPOLIA_RPC_URL" && \
cast estimate "$VAULT" "register(bytes32,bytes32,bytes32,bytes32,uint8,address)" \
  "$BOT_B" "$WEIGHT_B" "$SIG_B" "$PROMPT_B" 3 "$PAYEE_OPERATOR" \
  --from "$CORE_TIMELOCK" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

The zero address reverts `zero operator` and stores nothing.

5. Build calldata. Tier stays `3`. Regenerate both payloads after the guard passes. The last 32-byte word of each payload is that bot's operator.

```bash
cast calldata "register(bytes32,bytes32,bytes32,bytes32,uint8,address)" \
  "$BOT_A" "$WEIGHT_A" "$SIG_A" "$PROMPT_A" 3 "$PAYER_OPERATOR"

cast calldata "register(bytes32,bytes32,bytes32,bytes32,uint8,address)" \
  "$BOT_B" "$WEIGHT_B" "$SIG_B" "$PROMPT_B" 3 "$PAYEE_OPERATOR"
```

The selector on both payloads is `0xb4560e96`.

6. Show that `createEscrow` reverts `InvalidParties` on the live state, before either registration is sent. `--from` is `$PAYER_OPERATOR`, Spencer's wallet, because that address will be `msg.sender`. `--value 1000` is 1000 wei. This is a simulation.

```bash
cast call "$ESCROW" "createEscrow(bytes32,address,bytes32,bytes32,uint256)" \
  "$ESCROW_ID" "$PAYEE_OPERATOR" "$BOT_A" "$BOT_B" 3600 \
  --value 1000 --from "$PAYER_OPERATOR" --rpc-url "$BASE_SEPOLIA_RPC_URL"

cast estimate "$ESCROW" "createEscrow(bytes32,address,bytes32,bytes32,uint256)" \
  "$ESCROW_ID" "$PAYEE_OPERATOR" "$BOT_A" "$BOT_B" 3600 \
  --value 1000 --from "$PAYER_OPERATOR" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

On the empty Vault this reverts `InvalidParties` (`0xb6e500fe`). The [simulation-only record](#simulation-only-record) has the exact text.

7. **Stop. Do not send until both prerequisite boxes are ticked, the echoed addresses are the wallets you mean, and you type `YES`. `PAYER_OPERATOR` and `PAYEE_OPERATOR` have to be real checksummed wallets. An unedited export of `<SPENCER_PAYER_WALLET>` or `<REAL_PAYEE_WALLET>` fails in the shell. The guard rejects the `bEEF` placeholder, the zero address, the simulation stand-ins, the live escrow, the retired escrow, the sample senders from `script/`, the live Vault, the live Denylist, DisputePanel, the old Vault, Liability `0x554Caf5a214B8d70D675C09186C5EAE24FEB7307`, InsuranceFund `0x19fc26B36Cb2031062eD90C19db64b3b09753ab8`, the old Denylist `0xF0f260967D377E07Bdd7840862508ddB23C012b8`, the relayer as either operator, and using one address for both operators. A blocklisted address fails here even when the clear step was skipped. Sending a stand-in binds that address as a party.**

Paste this block as one unit. It defines `ops_guard` again so a fresh shell cannot send without it. The two `echo` lines show the addresses that will be bound. Before the chain check, a missing `cast` prints `cast is not installed` and skips both sends. It does not print `wrong chain`. The chain check reads `cast chain-id` and skips both sends unless the RPC is Base Sepolia `84532`. The prompt uses `printf` and `read -r`, which behave the same in bash and in zsh. Do not switch it to `read -p`: zsh treats `-p` as a coprocess flag. Type `YES` only after the echoed addresses are right. Any other answer, or a failing guard, skips both `cast send` commands and leaves the shell open. A wrong chain, an empty chain id, or a `cast chain-id` error skips both sends, calls the wallet 0 times, and leaves the shell open. Replace `<his-keystore>` with the `CORE_TIMELOCK` account name before pasting. `cast wallet address` for that account must be `0x10CC9474b45625ADfd05C209f2518023484878D9`. That keystore is the 7702 EOA. There is no schedule step.

```bash
ops_guard() {
  local payer payee relayer payer_lc payee_lc relayer_lc banned banned_lc
  if ! command -v cast >/dev/null 2>&1; then
    echo "cast is not installed"
    return 1
  fi
  payer=$(cast to-check-sum-address "${PAYER_OPERATOR-}") || {
    echo "PAYER_OPERATOR invalid/placeholder"
    return 1
  }
  payee=$(cast to-check-sum-address "${PAYEE_OPERATOR-}") || {
    echo "PAYEE_OPERATOR invalid/placeholder"
    return 1
  }
  relayer=$(cast to-check-sum-address 0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861) || {
    echo "cast to-check-sum-address failed"
    return 1
  }
  payer_lc=$(printf '%s' "$payer" | tr '[:upper:]' '[:lower:]')
  payee_lc=$(printf '%s' "$payee" | tr '[:upper:]' '[:lower:]')
  relayer_lc=$(printf '%s' "$relayer" | tr '[:upper:]' '[:lower:]')
  if [ "$payer_lc" = "$relayer_lc" ]; then
    echo "PAYER_OPERATOR is the relayer"
    return 1
  fi
  if [ "$payee_lc" = "$relayer_lc" ]; then
    echo "PAYEE_OPERATOR is the relayer"
    return 1
  fi
  while IFS= read -r banned; do
    [ -n "$banned" ] || continue
    banned=$(cast to-check-sum-address "$banned") || {
      echo "cast to-check-sum-address failed"
      return 1
    }
    banned_lc=$(printf '%s' "$banned" | tr '[:upper:]' '[:lower:]')
    if [ "$payer_lc" = "$banned_lc" ]; then
      echo "PAYER_OPERATOR is blocklisted"
      return 1
    fi
    if [ "$payee_lc" = "$banned_lc" ]; then
      echo "PAYEE_OPERATOR is blocklisted"
      return 1
    fi
  done <<'END_KNOWN'
0x000000000000000000000000000000000000bEEF
0x0000000000000000000000000000000000000000
0x1111111111111111111111111111111111111111
0x2222222222222222222222222222222222222222
0x3d660502D75f1e97b08c110255921b437A3C4C42
0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d
0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c
0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001
0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38
0x0000000000000000000000000000000000000A11
0x0000000000000000000000000000000000000A22
0x0000000000000000000000000000000000000A33
0x0000000000000000000000000000000000000001
0x1463D664fA467FBCDA4B05443434494f05e565bc
0xeE76876bECcFc1B58fC06fF4E654a517d784B224
0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb
0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7
0x19fc26B36Cb2031062eD90C19db64b3b09753ab8
0x554Caf5a214B8d70D675C09186C5EAE24FEB7307
0xF0f260967D377E07Bdd7840862508ddB23C012b8
END_KNOWN
  if [ "$PAYER_OPERATOR" != "$payer" ]; then
    echo "PAYER_OPERATOR is not checksummed (expected $payer)"
    return 1
  fi
  if [ "$PAYEE_OPERATOR" != "$payee" ]; then
    echo "PAYEE_OPERATOR is not checksummed (expected $payee)"
    return 1
  fi
  if [ "$payee" = "$payer" ]; then
    echo "PAYER_OPERATOR and PAYEE_OPERATOR are the same address"
    return 1
  fi
  return 0
}

echo "PAYER_OPERATOR=${PAYER_OPERATOR-UNSET}"
echo "PAYEE_OPERATOR=${PAYEE_OPERATOR-UNSET}"
skip_send=0
command -v cast >/dev/null || { echo 'cast is not installed'; skip_send=1; }
if [ "$skip_send" = 0 ]; then
  chain_id=$(cast chain-id --rpc-url "$BASE_SEPOLIA_RPC_URL") || chain_id=
  if [ "$chain_id" = 84532 ]; then
    ops_guard && printf 'Send with PAYER=%s PAYEE=%s? type YES: ' "$PAYER_OPERATOR" "$PAYEE_OPERATOR" && read -r ok && [ "$ok" = "YES" ] && \
    cast send "$VAULT" "register(bytes32,bytes32,bytes32,bytes32,uint8,address)" \
      "$BOT_A" "$WEIGHT_A" "$SIG_A" "$PROMPT_A" 3 "$PAYER_OPERATOR" \
      --rpc-url "$BASE_SEPOLIA_RPC_URL" \
      --account <his-keystore> && \
    cast send "$VAULT" "register(bytes32,bytes32,bytes32,bytes32,uint8,address)" \
      "$BOT_B" "$WEIGHT_B" "$SIG_B" "$PROMPT_B" 3 "$PAYEE_OPERATOR" \
      --rpc-url "$BASE_SEPOLIA_RPC_URL" \
      --account <his-keystore>
  else
    echo 'wrong chain: expected Base Sepolia 84532' >&2
  fi
fi
```

Send Bot A first, wait for the receipt, then send Bot B. Each registration comes from `0x10CC9474b45625ADfd05C209f2518023484878D9`. Re-estimate after the real wallets are filled in. A simulation-only stand-in at block `47392348` used about `177900` gas for each register. That figure is not a substitute for the estimate with Spencer's addresses.

8. Read the bots back. Tier `3` is Financial. `active` is true. `registeredAt` is the block timestamp, non-zero. Operators match the addresses Spencer passed.

```bash
cast call "$VAULT" "bots(bytes32)(bytes32,bytes32,bytes32,uint8,bool,uint256)" \
  "$BOT_A" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "operator(bytes32)(address)" "$BOT_A" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "grantAccess(bytes32,uint8)(bool)" "$BOT_A" 3 --rpc-url "$BASE_SEPOLIA_RPC_URL"

cast call "$VAULT" "bots(bytes32)(bytes32,bytes32,bytes32,uint8,bool,uint256)" \
  "$BOT_B" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "operator(bytes32)(address)" "$BOT_B" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "grantAccess(bytes32,uint8)(bool)" "$BOT_B" 3 --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Expected shape for Bot A: the three fingerprints above, then `3`, `true`, a non-zero `registeredAt`, operator equal to `$PAYER_OPERATOR`, and `grantAccess` `true`. Bot B is the same shape with its fingerprints and `$PAYEE_OPERATOR`.

9. Prove `InvalidParties` is gone.

After both receipts, repeat the step 6 `cast call` and `cast estimate` with no state override. `--from` stays `$PAYER_OPERATOR`. `cast estimate` then returns a gas number. `cast call` returns the escrow id (`bytes32`). That pair is still a simulation.

Before those transactions exist, the same proof needs a state override. `cast` 1.8.3 has no `--state-override` flag. `cast call` has `--override-state-diff` (change listed slots, keep the rest) and `--override-state` (replace the account's storage entirely). Use the diff form. Replacing the whole Vault storage would wipe `owner`, `denylist`, and the tier caps. `cast estimate` rejects `--override-state-diff` (`error: unexpected argument '--override-state-diff' found`). The pre-send proof is `cast call`.

The override writes each `BotRecord` and each `operator`. Mapping base slot for `bots` is `3`. Mapping base slot for `operator` is `4`. Slot numbers come from the bot id. The operator words come from the shell variables. There is no address literal in this override.

```bash
cast index bytes32 "$BOT_A" 3   # record base
cast index bytes32 "$BOT_A" 4   # operator slot
cast index bytes32 "$BOT_B" 3
cast index bytes32 "$BOT_B" 4

PAYER_WORD=$(cast abi-encode "f(address)" "$PAYER_OPERATOR")
PAYEE_WORD=$(cast abi-encode "f(address)" "$PAYEE_OPERATOR")
```

`BotRecord` layout from that base: `+0` weight, `+1` behavior, `+2` prompt, `+3` packed `tier` in the low byte and `active` in the next byte, `+4` `registeredAt`. Financial and active pack as `0x0103`. The simulation uses `registeredAt = 1`. The real transaction stores `block.timestamp`. `createEscrow` does not read `registeredAt`.

| Bot | Slot | Value |
| --- | --- | --- |
| A weight | `0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6ce6` | `$WEIGHT_A` |
| A behavior | `0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6ce7` | `$SIG_A` |
| A prompt | `0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6ce8` | `$PROMPT_A` |
| A tier+active | `0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6ce9` | `0x0103` |
| A registeredAt | `0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6cea` | `1` |
| A operator | `0x316b25c1a55daae1c3e5c1a467c07723b410db69e64fcca70fd9345218789f42` | `$PAYER_WORD` |
| B weight | `0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2ca` | `$WEIGHT_B` |
| B behavior | `0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2cb` | `$SIG_B` |
| B prompt | `0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2cc` | `$PROMPT_B` |
| B tier+active | `0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2cd` | `0x0103` |
| B registeredAt | `0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2ce` | `1` |
| B operator | `0x7e668be1fdcdb22f1b5523923112ad8ada1b6bf71090e5dde6b1e6d1a7b1c3b5` | `$PAYEE_WORD` |

`ops_guard` is the function from step 4. A failure skips this call and leaves the shell open.

```bash
ops_guard && cast call "$ESCROW" "createEscrow(bytes32,address,bytes32,bytes32,uint256)(bytes32)" \
  "$ESCROW_ID" "$PAYEE_OPERATOR" "$BOT_A" "$BOT_B" 3600 \
  --value 1000 --from "$PAYER_OPERATOR" --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --override-state-diff "${VAULT}:0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6ce6:${WEIGHT_A}" \
  --override-state-diff "${VAULT}:0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6ce7:${SIG_A}" \
  --override-state-diff "${VAULT}:0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6ce8:${PROMPT_A}" \
  --override-state-diff "${VAULT}:0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6ce9:0x0000000000000000000000000000000000000000000000000000000000000103" \
  --override-state-diff "${VAULT}:0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6cea:0x0000000000000000000000000000000000000000000000000000000000000001" \
  --override-state-diff "${VAULT}:0x316b25c1a55daae1c3e5c1a467c07723b410db69e64fcca70fd9345218789f42:${PAYER_WORD}" \
  --override-state-diff "${VAULT}:0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2ca:${WEIGHT_B}" \
  --override-state-diff "${VAULT}:0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2cb:${SIG_B}" \
  --override-state-diff "${VAULT}:0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2cc:${PROMPT_B}" \
  --override-state-diff "${VAULT}:0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2cd:0x0000000000000000000000000000000000000000000000000000000000000103" \
  --override-state-diff "${VAULT}:0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2ce:0x0000000000000000000000000000000000000000000000000000000000000001" \
  --override-state-diff "${VAULT}:0x7e668be1fdcdb22f1b5523923112ad8ada1b6bf71090e5dde6b1e6d1a7b1c3b5:${PAYEE_WORD}"
```

A successful simulation returns `ESCROW_ID`. `$PAYER_WORD` and `$PAYEE_WORD` are the real wallets only when `ops_guard` returns 0.

When Spencer later sends `createEscrow`, paste this block as one unit. It defines `ops_guard` again. A missing `cast` prints `cast is not installed` and skips the send. The chain check skips the send unless `cast chain-id` is Base Sepolia `84532`. A wrong chain, an empty chain id, or a `cast chain-id` error does not send and does not call `cast wallet`. The shell stays open. The send runs only when the guard returns 0 and `cast wallet address --account <his-keystore>` equals `$PAYER_OPERATOR`. That keystore is the payer wallet. If that wallet is also `CORE_TIMELOCK`, it is the same account as step 7. If it is a different wallet, it is a different keystore, still passed only as `--account <his-keystore>`. Replace `<his-keystore>` before pasting.

```bash
ops_guard() {
  local payer payee relayer payer_lc payee_lc relayer_lc banned banned_lc
  if ! command -v cast >/dev/null 2>&1; then
    echo "cast is not installed"
    return 1
  fi
  payer=$(cast to-check-sum-address "${PAYER_OPERATOR-}") || {
    echo "PAYER_OPERATOR invalid/placeholder"
    return 1
  }
  payee=$(cast to-check-sum-address "${PAYEE_OPERATOR-}") || {
    echo "PAYEE_OPERATOR invalid/placeholder"
    return 1
  }
  relayer=$(cast to-check-sum-address 0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861) || {
    echo "cast to-check-sum-address failed"
    return 1
  }
  payer_lc=$(printf '%s' "$payer" | tr '[:upper:]' '[:lower:]')
  payee_lc=$(printf '%s' "$payee" | tr '[:upper:]' '[:lower:]')
  relayer_lc=$(printf '%s' "$relayer" | tr '[:upper:]' '[:lower:]')
  if [ "$payer_lc" = "$relayer_lc" ]; then
    echo "PAYER_OPERATOR is the relayer"
    return 1
  fi
  if [ "$payee_lc" = "$relayer_lc" ]; then
    echo "PAYEE_OPERATOR is the relayer"
    return 1
  fi
  while IFS= read -r banned; do
    [ -n "$banned" ] || continue
    banned=$(cast to-check-sum-address "$banned") || {
      echo "cast to-check-sum-address failed"
      return 1
    }
    banned_lc=$(printf '%s' "$banned" | tr '[:upper:]' '[:lower:]')
    if [ "$payer_lc" = "$banned_lc" ]; then
      echo "PAYER_OPERATOR is blocklisted"
      return 1
    fi
    if [ "$payee_lc" = "$banned_lc" ]; then
      echo "PAYEE_OPERATOR is blocklisted"
      return 1
    fi
  done <<'END_KNOWN'
0x000000000000000000000000000000000000bEEF
0x0000000000000000000000000000000000000000
0x1111111111111111111111111111111111111111
0x2222222222222222222222222222222222222222
0x3d660502D75f1e97b08c110255921b437A3C4C42
0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d
0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c
0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001
0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38
0x0000000000000000000000000000000000000A11
0x0000000000000000000000000000000000000A22
0x0000000000000000000000000000000000000A33
0x0000000000000000000000000000000000000001
0x1463D664fA467FBCDA4B05443434494f05e565bc
0xeE76876bECcFc1B58fC06fF4E654a517d784B224
0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb
0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7
0x19fc26B36Cb2031062eD90C19db64b3b09753ab8
0x554Caf5a214B8d70D675C09186C5EAE24FEB7307
0xF0f260967D377E07Bdd7840862508ddB23C012b8
END_KNOWN
  if [ "$PAYER_OPERATOR" != "$payer" ]; then
    echo "PAYER_OPERATOR is not checksummed (expected $payer)"
    return 1
  fi
  if [ "$PAYEE_OPERATOR" != "$payee" ]; then
    echo "PAYEE_OPERATOR is not checksummed (expected $payee)"
    return 1
  fi
  if [ "$payee" = "$payer" ]; then
    echo "PAYER_OPERATOR and PAYEE_OPERATOR are the same address"
    return 1
  fi
  return 0
}

skip_send=0
command -v cast >/dev/null || { echo 'cast is not installed'; skip_send=1; }
if [ "$skip_send" = 0 ]; then
  chain_id=$(cast chain-id --rpc-url "$BASE_SEPOLIA_RPC_URL") || chain_id=
  if [ "$chain_id" = 84532 ]; then
    ops_guard && [ "$(cast wallet address --account <his-keystore>)" = "$PAYER_OPERATOR" ] && \
    cast send "$ESCROW" "createEscrow(bytes32,address,bytes32,bytes32,uint256)" \
      "$ESCROW_ID" "$PAYEE_OPERATOR" "$BOT_A" "$BOT_B" 3600 \
      --value 1000 \
      --rpc-url "$BASE_SEPOLIA_RPC_URL" \
      --account <his-keystore>
  else
    echo 'wrong chain: expected Base Sepolia 84532' >&2
  fi
fi
```

That send is Spencer's, after step 8. Agents do not run it. `1000` wei is the simulated smoke value. He can change the value. He cannot change `--from`: the account has to be `$PAYER_OPERATOR`.

## Optional later mode: relayer as payer operator

This mode is not the first smoke. It stays off the send path until both of these are true:

1. Retired by #46 (code path removed), not rotated. Tick only after CUTOVER.md (#51) step 1 has deleted the old values on Render, GitHub, and Cloudflare.
2. EIP-712 relayer auth or a relayer amount cap has shipped.

Until then, `PAYER_OPERATOR` stays Spencer's wallet. `ops_guard` rejects the relayer as the payer, including a lowercase copy of that address. A payee equal to the relayer is always rejected. The function CI checks is the one in the pastes.

The current relayer accepts a positive `amountWei` and does not cap it. `release` is permissionless and pays the payee. Registering the relayer as Bot A's operator is not part of these pastes.

## Simulation-only record

These calls used throwaway checksummed addresses inside `cast call` and `cast estimate` only. They are not the exports, they are not on the send path, and they were not broadcast. After the calls, `operator(BOT_A)` was still `0x0000000000000000000000000000000000000000`.

```text
PAYER_OPERATOR stand-in (simulation only) = 0x1111111111111111111111111111111111111111
PAYEE_OPERATOR stand-in (simulation only) = 0x2222222222222222222222222222222222222222
block = 47392348
```

`cast abi-encode "f(address)"` for those two values:

```text
0x0000000000000000000000001111111111111111111111111111111111111111
0x0000000000000000000000002222222222222222222222222222222222222222
```

Register Bot A from `CORE_TIMELOCK` (`cast call`, then `cast estimate`):

```text
0x
177900
```

Register Bot B from `CORE_TIMELOCK`:

```text
0x
177900
```

`createEscrow` on live state, `--from` the throwaway payer, `--value 1000`, no override. `cast call`:

```text
Error: execution reverted: InvalidParties

Context:
- server returned an error response: error code 3: execution reverted, data: "0xb6e500fe"
```

`cast estimate` returned the same revert data: `0xb6e500fe`.

`createEscrow` with `--override-state-diff`, operator words taken from those throwaways, `--from` the throwaway payer:

```text
0xcf49428f2c5d229ad09cd8c4c343539fa4c80199aa43d6d9c900bfff4102686b
```

That is `ESCROW_ID`. Under the same override, `bots(BOT_A)` returned the three Bot A fingerprints, then:

```text
3
true
1
```

`operator(BOT_A)` returned `0x1111111111111111111111111111111111111111`. `operator(BOT_B)` returned `0x2222222222222222222222222222222222222222`. `grantAccess(BOT_A, 3)` returned `true`.

`cast rpc eth_estimateGas` with the same `stateDiff` returned:

```text
"0x4967d"
```

`0x4967d` is `300669` gas. This node call does not publish a transaction.

## Risks

Retired by #46 (code path removed), not rotated. Tick only after CUTOVER.md (#51) step 1 has deleted the old values on Render, GitHub, and Cloudflare. The relayer still has no amount cap. At block `47392348` that balance was `413437500000000000` wei (about 0.413 ETH). `release` is permissionless and pays the payee. A payee address nobody controls burns those funds. A stale Pages deploy would send that path at a retired escrow. The live escrow is `0x3d660502D75f1e97b08c110255921b437A3C4C42`. The ESC-M-1 escrow `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` is retired (2026-10-06). The stale UI still shows the retired escrow `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c`.

The first smoke therefore sets `PAYER_OPERATOR` to Spencer's own wallet (`<SPENCER_PAYER_WALLET>`). He calls `createEscrow` from that wallet. `msg.sender` has to equal `operator(payerBotId)`. The pasted guard rejects the relayer as either operator. Retired by #46 (code path removed), not rotated. Tick only after CUTOVER.md (#51) step 1 has deleted the old values on Render, GitHub, and Cloudflare.

`CORE_TIMELOCK` has no delay. The 7702 delegation executes the owner call in the same transaction Spencer signs. The same key can `register`, `setOperator`, and `burn` on this Vault, and it owns the Denylist and the escrow. A bad signature is immediate.

`register` is permanent for a `botId`. `burn` clears `active` and does not free the id. A wrong id cannot be registered again. `setOperator` can point a stored bot at a new non-zero account, and that call is also `onlyOwner` from `0x10CC9474b45625ADfd05C209f2518023484878D9`.

The payer operator and the payee operator have to be different addresses. `createEscrow` reverts `InvalidParties` when `msg.sender == payee`. `ops_guard` returns 1 when they match, when either one is the relayer, when either one is blocklisted, and when `cast` is missing. Those failures leave the shell open. A missing `cast` on either send paste prints `cast is not installed` and does not say `wrong chain`. A chain id other than `84532`, an empty chain id, or a `cast chain-id` error skips the send, calls the wallet 0 times, and leaves the shell open.

These ids and fingerprints are the smoke pair. Listing any of the three hashes on the Denylist later makes `_verifyBot` revert `AttestationFailed` even when the operators still match.

The superseded Vault `0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7` is a different contract. These registrations go to `0x1463D664fA467FBCDA4B05443434494f05e565bc` only.
