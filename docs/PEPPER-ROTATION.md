# Pepper rotation

`WALLET_HASH_PEPPER` is not set yet. Do this before the first value is stored.

The pepper is the input keying material for two keys. HKDF-SHA256 derives an HMAC key and a separate AES-GCM key. The HMAC key produces `wallet_hash`. The AES key seals the wallet address. The seal's additional data is the account id and the wallet hash. A seal opened with a different account id or a different hash fails.

## Before the first value

1. Generate a high-entropy pepper outside this repo. Do not commit it. Do not put it in an example file.
2. Create the database directory and set `SANCTIONS_DB_PATH` to a file path. An empty value, or `:memory:`, refuses to start the relayer. In-memory databases stay in tests.
3. Set the same pepper as `WALLET_HASH_PEPPER` on the claim relayer and on the points Worker. Leave it empty in git.
4. Start the relayer. It refreshes the SDN publication at boot and every 12 hours.
5. Confirm `/health` does not echo the pepper.

## Rotation after seals exist

A new pepper does not open old seals and does not reproduce old wallet hashes. Points stay withheld during the window.

Pause screening writes (KILL_SWITCH) during the rewrite.

1. Keep the current pepper in the process.
2. For each account wallet row, open the seal with the current pepper, the account id, and the wallet hash.
3. Derive the next wallet hash and the next seal from the next pepper.
4. Write the next hash and the next seal, then commit.
5. Swap `WALLET_HASH_PEPPER` to the next pepper on the relayer and the Worker together.
6. Restart both. Remove the previous pepper from the secret store after the rewrite is committed.
7. Do not log a raw wallet address. The claim log stores a pseudonymized sha256 of a payer or payee, or drops the value when it is not an EVM address. Calldata in that log keeps only the 4-byte selector.

Spencer sets the pepper. This file does not contain a pepper value.
