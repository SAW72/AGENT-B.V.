// One-time NEAR testnet setup, run by scripts/deploy.sh after the faucet has
// created the accounts. Uses the owner's and agent's full-access keys that
// near-cli-rs saved in ~/.near-credentials (never in the repo), then:
//   1. deploys + initialises the policy contract on POLICY,
//   2. registers AGENT with a spend limit, attests MERCHANT `pass`,
//      attests BADBOT `fail`, blocklists DRAINER,
//   3. adds a function-call key to AGENT (receiver = POLICY, method =
//      request_payment, gas allowance 0.25 NEAR) and saves it outside the repo,
//   4. deletes AGENT's full-access key, so the agent account holds only that
//      function-call key,
//   5. writes near/deployments/testnet.json (public data only: ids, public keys, tx hashes).
// Testnet only. Prints no private key.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KeyPair, PublicKey, actions, parseNearAmount, teraToGas } from 'near-api-js';
import { NEAR_DIR, DEPLOYMENT_FILE, EXPLORER_TX, agentKeyFile, fullAccessKeyFile } from '../src/config.mjs';
import { accountFromKeyFile, readKeyFile, txHashOf, view } from '../src/near-client.mjs';

const [policyId, agentId, merchantId, drainerId, badbotId] = process.argv.slice(2);
if (!badbotId || ![policyId, agentId, merchantId, drainerId, badbotId].every((a) => a.endsWith('.testnet'))) {
  console.error('usage: node scripts/setup.mjs <policy>.testnet <agent>.testnet <merchant>.testnet <drainer>.testnet <badbot>.testnet');
  process.exit(2);
}
const wasmPath = process.env.POLICY_WASM || join(NEAR_DIR, 'contract', 'res', 'agent_bv_policy.wasm');
const LIMIT = parseNearAmount('0.05');
const WARN_ABOVE = parseNearAmount('0.02');
const ALLOWANCE = BigInt(parseNearAmount('0.25'));
const gas = teraToGas('30');
const txs = {};
const prev = existsSync(DEPLOYMENT_FILE + '.partial') ? JSON.parse(readFileSync(DEPLOYMENT_FILE + '.partial', 'utf8')) : {};
Object.assign(txs, prev);
const step = (name, res) => {
  txs[name] = txHashOf(res);
  console.log(`${name}: ${EXPLORER_TX}${txs[name]}`);
  writeFileSync(DEPLOYMENT_FILE + '.partial', JSON.stringify(txs));
};
// Re-runnable: skip steps that are already on chain.
const initialised = await view(policyId, 'get_owner', {}).then(() => true, () => false);
const registered = initialised && (await view(policyId, 'get_agent', { agent: agentId })) !== null;

const owner = accountFromKeyFile(fullAccessKeyFile(policyId));
const agentFull = accountFromKeyFile(fullAccessKeyFile(agentId));
const agentFullPub = readKeyFile(fullAccessKeyFile(agentId)).publicKey;

// 1. deploy + init in one transaction
if (!initialised) step(
  'deploy_and_init',
  await owner.signAndSendTransaction({
    receiverId: policyId,
    actions: [
      actions.deployContract(new Uint8Array(readFileSync(wasmPath))),
      actions.functionCall('new', { owner: policyId, warn_above: WARN_ABOVE }, teraToGas('100'), 0n),
    ],
  }),
);

// 2. policy state, owner-signed
if (!registered) step(
  'policy_setup',
  await owner.signAndSendTransaction({
    receiverId: policyId,
    actions: [
      actions.functionCall('set_agent_limit', { agent: agentId, limit: LIMIT }, gas, 0n),
      actions.functionCall(
        'record_attestation',
        { account: merchantId, outcome: 'pass', evidence: 'testnet demo attestation set by owner (not a live audit)' },
        gas,
        0n,
      ),
      actions.functionCall(
        'record_attestation',
        { account: badbotId, outcome: 'fail', evidence: 'testnet demo: bot failed prompt-injection exfiltration test' },
        gas,
        0n,
      ),
      actions.functionCall(
        'add_to_blocklist',
        { account: drainerId, reason: 'testnet demo known-bad account (prompt-injection payout target)' },
        gas,
        0n,
      ),
    ],
  }),
);

// 3. agent function-call key, saved outside the repo with mode 0600
const fcKey = KeyPair.fromRandom('ed25519');
const fcPub = fcKey.getPublicKey().toString();
const keyFile = agentKeyFile(agentId);
mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
writeFileSync(keyFile, JSON.stringify({ account_id: agentId, public_key: fcPub, private_key: fcKey.toString() }), { mode: 0o600 });
step(
  'agent_add_fc_key',
  await agentFull.signAndSendTransaction({
    receiverId: agentId,
    actions: [actions.addFunctionCallAccessKey(PublicKey.fromString(fcPub), policyId, ['request_payment'], ALLOWANCE)],
  }),
);

// 4. remove the agent's full-access key
step('agent_delete_full_access_key', await agentFull.signAndSendTransaction({ receiverId: agentId, actions: [actions.deleteKey(PublicKey.fromString(agentFullPub))] }));

// 5. public deployment record
const wasm = readFileSync(wasmPath);
const { createHash } = await import('node:crypto');
const out = {
  network: 'testnet',
  policy_contract: policyId,
  agent: agentId,
  merchant_attested_pass: merchantId,
  drainer_blocklisted: drainerId,
  badbot_attested_fail: badbotId,
  agent_function_call_public_key: fcPub,
  agent_key_scope: { receiver_id: policyId, method_names: ['request_payment'], allowance_yocto: ALLOWANCE.toString() },
  agent_limit_yocto: LIMIT,
  warn_above_yocto: WARN_ABOVE,
  wasm_sha256: createHash('sha256').update(wasm).digest('hex'),
  wasm_bytes: wasm.length,
  txs,
  explorer: Object.fromEntries(Object.entries(txs).map(([k, v]) => [k, EXPLORER_TX + v])),
  deployed_at: new Date().toISOString(),
};
mkdirSync(dirname(DEPLOYMENT_FILE), { recursive: true });
writeFileSync(DEPLOYMENT_FILE, JSON.stringify(out, null, 2) + '\n');
rmSync(DEPLOYMENT_FILE + '.partial', { force: true });
console.log(`wrote ${DEPLOYMENT_FILE}`);
console.log(`agent function-call key file (keep private, not in git): ${keyFile}`);
