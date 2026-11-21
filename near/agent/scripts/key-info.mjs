// Lists every access key on the agent account (public data from RPC) and
// shows that the only key is a function-call key scoped to the policy contract.
import { loadDeployment } from '../src/config.mjs';
import { provider } from '../src/near-client.mjs';
import { assertFunctionCallOnly } from '../src/key-guard.mjs';

const d = loadDeployment();
const list = await provider().viewAccessKeyList({ accountId: d.agent });
const keys = list.keys.map((k) => ({ public_key: k.public_key, permission: k.access_key.permission }));
const fullAccess = keys.filter((k) => k.permission === 'FullAccess' || k.permission?.GasKeyFullAccess);
let ok = fullAccess.length === 0 && keys.length > 0;
for (const k of keys) {
  try {
    assertFunctionCallOnly({ permission: k.permission }, d.policy_contract);
  } catch {
    ok = false;
  }
}
console.log(
  JSON.stringify(
    { agent: d.agent, policy_contract: d.policy_contract, keys, full_access_keys: fullAccess.length, only_scoped_function_call_keys: ok },
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  ),
);
process.exit(ok ? 0 : 1);
