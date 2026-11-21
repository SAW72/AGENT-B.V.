// Integration tests on a local NEAR sandbox (near-workspaces). No testnet, no
// network keys: every account and key lives only inside the throwaway sandbox.
// Runs the same wrapper + near-api-js client the testnet demos use.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'near-workspaces';

const WASM = process.env.POLICY_WASM || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contract', 'res', 'agent_bv_policy.wasm');
const MILLI = 10n ** 21n; // 0.001 NEAR in yocto
let worker, root, policy, merchant, agentAcc, keysDir, nearApi, client, mod, guard, fullKeyFile;

const writeKey = (name, accountId, kp) => {
  const p = join(keysDir, `${name}.json`);
  writeFileSync(p, JSON.stringify({ account_id: accountId, private_key: kp.toString() }), { mode: 0o600 });
  return p;
};

before(async () => {
  worker = await Worker.init();
  root = worker.rootAccount;
  process.env.NEAR_RPC_URL = worker.provider.connection?.url ?? worker.rpcAddr;
  nearApi = await import('near-api-js');
  mod = await import('../src/near-client.mjs');
  guard = await import('../src/guarded-agent.mjs');

  policy = await root.createSubAccount('policy', { initialBalance: 20n * 10n ** 24n });
  await policy.deploy(WASM);
  await policy.call(policy, 'new', { owner: root.accountId, warn_above: (20n * MILLI).toString() });
  merchant = await root.createSubAccount('merchant');
  agentAcc = await root.createSubAccount('agent');
  await root.call(policy, 'set_agent_limit', { agent: agentAcc.accountId, limit: (50n * MILLI).toString() });
  await root.call(policy, 'record_attestation', { account: merchant.accountId, outcome: 'pass', evidence: 'sandbox' });
  await root.call(policy, 'record_attestation', { account: 'badbot.test.near', outcome: 'fail', evidence: 'sandbox fail' });
  await root.call(policy, 'add_to_blocklist', { account: 'drainer.test.near', reason: 'sandbox known-bad' });

  // Give the agent a function-call key only, then delete its full-access key.
  keysDir = mkdtempSync(join(tmpdir(), 'agentbv-sbx-'));
  const { KeyPair, PublicKey, Account, JsonRpcProvider, KeyPairSigner, actions } = nearApi;
  const fullKp = KeyPair.fromString((await agentAcc.getKey()).toString());
  fullKeyFile = writeKey('agent-full', agentAcc.accountId, fullKp);
  const full = new Account(agentAcc.accountId, new JsonRpcProvider({ url: process.env.NEAR_RPC_URL }), new KeyPairSigner(fullKp));
  const fcKp = KeyPair.fromRandom('ed25519');
  await full.signAndSendTransaction({
    receiverId: agentAcc.accountId,
    actions: [actions.addFunctionCallAccessKey(fcKp.getPublicKey(), policy.accountId, ['request_payment'], 10n ** 24n / 4n)],
  });
  await full.signAndSendTransaction({ receiverId: agentAcc.accountId, actions: [actions.deleteKey(PublicKey.fromString(fullKp.getPublicKey().toString()))] });
  client = await mod.agentClient({ keyFile: writeKey('agent-fc', agentAcc.accountId, fcKp), policyId: policy.accountId, agentId: agentAcc.accountId });
});

after(async () => {
  if (keysDir) rmSync(keysDir, { recursive: true, force: true });
  if (worker) await worker.tearDown().catch(() => {});
});

const agentWith = (answer) => new guard.GuardedAgent({ client, agentId: agentAcc.accountId, confirm: async () => answer });

test('key guard refuses the (deleted) full-access key path', async () => {
  await assert.rejects(mod.agentClient({ keyFile: fullKeyFile, policyId: policy.accountId, agentId: agentAcc.accountId }));
});

test('allow: attested merchant is paid through the policy', async () => {
  const before = await merchant.availableBalance();
  const r = await agentWith(false).pay(merchant.accountId, MILLI.toString());
  assert.equal(r.decision.verdict, 'allow');
  assert.equal(r.signed, true);
  assert.equal(r.onchain_result.paid, true);
  assert.equal((await merchant.availableBalance()) - before, MILLI);
});

test('block: wrapper refuses blocklisted drainer, nothing signed', async () => {
  const r = await agentWith(true).pay('drainer.test.near', MILLI.toString());
  assert.equal(r.decision.verdict, 'block');
  assert.equal(r.signed, false);
});

test('block: wrapper refuses a receiver that failed attestation', async () => {
  const r = await agentWith(true).pay('badbot.test.near', MILLI.toString());
  assert.equal(r.decision.verdict, 'block');
  assert.equal(r.signed, false);
});

test('bypass: direct request_payment to drainer is blocked on-chain', async () => {
  const spentBefore = (await policy.view('get_agent', { agent: agentAcc.accountId })).spent;
  const r = await client.call('request_payment', { receiver: 'drainer.test.near', amount: (40n * MILLI).toString() });
  assert.equal(r.result.verdict, 'block');
  assert.equal(r.result.paid, false);
  assert.ok(r.events.some((e) => e.event === 'payment_blocked'));
  assert.equal((await policy.view('get_agent', { agent: agentAcc.accountId })).spent, spentBefore);
});

test('function-call key cannot transfer NEAR', async () => {
  await assert.rejects(
    client.account.signAndSendTransaction({ receiverId: merchant.accountId, actions: [nearApi.actions.transfer(MILLI)] }),
    /full access|FullAccess/i,
  );
});

test('function-call key cannot call owner methods', async () => {
  await assert.rejects(
    client.account.signAndSendTransaction({
      receiverId: policy.accountId,
      actions: [nearApi.actions.functionCall('remove_from_blocklist', { account: 'drainer.test.near' }, 30n * 10n ** 12n, 0n)],
    }),
    /does not allow method|MethodName/i,
  );
});

test('warn: human says no, nothing is signed', async () => {
  const r = await agentWith(false).pay('newvendor.test.near', MILLI.toString());
  assert.equal(r.decision.verdict, 'warn');
  assert.equal(r.signed, false);
});

test('warn: human says yes, payment parks until the owner approves', async () => {
  const r = await agentWith(true).pay(merchant.accountId, (30n * MILLI).toString()); // above warn threshold
  assert.equal(r.decision.verdict, 'warn');
  assert.equal(r.onchain_result.verdict, 'warn');
  assert.equal(r.onchain_result.paid, false);
  const id = r.onchain_result.pending_id;
  assert.equal((await policy.view('get_pending')).length, 1);
  const before = await merchant.availableBalance();
  await root.call(policy, 'approve_pending', { id });
  assert.equal((await merchant.availableBalance()) - before, 30n * MILLI);
  assert.equal((await policy.view('get_pending')).length, 0);
});

test('spend limit: cumulative cap blocks the next payment', async () => {
  // spent so far: 1 + 30 = 31 milliNEAR of a 50 milliNEAR limit
  const r = await client.call('request_payment', { receiver: merchant.accountId, amount: (20n * MILLI).toString() });
  assert.equal(r.result.verdict, 'block');
  assert.ok(r.result.reasons.some((x) => x.includes('spend limit')));
});
