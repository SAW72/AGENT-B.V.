// Unit tests for the wrapper's decision handling (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuardedAgent } from '../src/guarded-agent.mjs';
import { assertFunctionCallOnly } from '../src/key-guard.mjs';

function mockClient(verdict, reasons = ['r']) {
  const calls = [];
  return {
    calls,
    async view(method, args) {
      calls.push(['view', method, args]);
      return { verdict, reasons };
    },
    async call(method, args) {
      calls.push(['call', method, args]);
      return { hash: 'HASH1', result: { verdict, paid: verdict === 'allow' } };
    },
  };
}

const agentWith = (client, answer) =>
  new GuardedAgent({ client, agentId: 'agent.testnet', confirm: async () => answer });

test('block: refuses and never signs', async () => {
  const c = mockClient('block', ['receiver is on the blocklist: drainer']);
  const r = await agentWith(c, true).pay('drainer.testnet', '1000');
  assert.equal(r.signed, false);
  assert.equal(r.action, 'refused');
  assert.deepEqual(c.calls.map((x) => x[0]), ['view']);
});

test('block: refuses even if the human would say yes', async () => {
  let asked = false;
  const c = mockClient('block');
  const a = new GuardedAgent({ client: c, agentId: 'a.testnet', confirm: async () => ((asked = true), true) });
  const r = await a.pay('x.testnet', '1');
  assert.equal(asked, false);
  assert.equal(r.signed, false);
});

test('warn + human says no: does not sign', async () => {
  const c = mockClient('warn');
  const r = await agentWith(c, false).pay('new.testnet', '1');
  assert.equal(r.action, 'human_declined');
  assert.equal(c.calls.filter((x) => x[0] === 'call').length, 0);
});

test('warn + non-boolean answer: treated as no', async () => {
  const c = mockClient('warn');
  const r = await agentWith(c, 'y').pay('new.testnet', '1');
  assert.equal(r.signed, false);
});

test('warn + human says yes: signs request_payment', async () => {
  const c = mockClient('warn');
  const r = await agentWith(c, true).pay('new.testnet', '1');
  assert.equal(r.signed, true);
  assert.deepEqual(c.calls[1], ['call', 'request_payment', { receiver: 'new.testnet', amount: '1' }]);
});

test('allow: signs request_payment and links the explorer', async () => {
  const c = mockClient('allow');
  const r = await agentWith(c, false).pay('good.testnet', '10');
  assert.equal(r.signed, true);
  assert.equal(r.explorer, 'https://testnet.nearblocks.io/txns/HASH1');
});

test('unknown verdict: fails closed', async () => {
  const c = mockClient('maybe');
  const r = await agentWith(c, true).pay('good.testnet', '10');
  assert.equal(r.signed, false);
});

test('rejects non-integer amounts', async () => {
  await assert.rejects(agentWith(mockClient('allow'), true).pay('good.testnet', '1.5'));
});

test('key guard: accepts a function-call key scoped to the policy', () => {
  assert.doesNotThrow(() =>
    assertFunctionCallOnly(
      { permission: { FunctionCall: { receiver_id: 'policy.testnet', method_names: ['request_payment'], allowance: '1' } } },
      'policy.testnet',
    ),
  );
});

test('key guard: rejects a full-access key', () => {
  assert.throws(() => assertFunctionCallOnly({ permission: 'FullAccess' }, 'policy.testnet'), /full-access/i);
});

test('key guard: rejects a function-call key for another contract', () => {
  assert.throws(
    () =>
      assertFunctionCallOnly(
        { permission: { FunctionCall: { receiver_id: 'evil.testnet', method_names: [], allowance: null } } },
        'policy.testnet',
      ),
    /scoped to evil.testnet/,
  );
});

test('key guard: rejects a key allowed to call every method', () => {
  assert.throws(
    () =>
      assertFunctionCallOnly(
        { permission: { FunctionCall: { receiver_id: 'policy.testnet', method_names: [], allowance: '1' } } },
        'policy.testnet',
      ),
    /request_payment/,
  );
});
