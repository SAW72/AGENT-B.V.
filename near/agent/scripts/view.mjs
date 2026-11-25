// Read-only views of the deployed testnet policy contract. No keys needed.
import { loadDeployment, EXPLORER_ADDR } from '../src/config.mjs';
import { view } from '../src/near-client.mjs';

const d = loadDeployment();
const c = d.policy_contract;
const out = {
  contract: c,
  explorer: EXPLORER_ADDR + c,
  owner: await view(c, 'get_owner'),
  blocklist: await view(c, 'get_blocklist', {}),
  attestation_merchant: { account: d.merchant_attested_pass, ...(await view(c, 'get_attestation', { account: d.merchant_attested_pass })) },
  attestation_badbot: { account: d.badbot_attested_fail, ...(await view(c, 'get_attestation', { account: d.badbot_attested_fail })) },
  agent: { account: d.agent, ...(await view(c, 'get_agent', { agent: d.agent })) },
  warn_above_yocto: await view(c, 'get_warn_above'),
  pending: await view(c, 'get_pending'),
  blocked_attempts: await view(c, 'get_blocked_attempts'),
  pool_yocto: await view(c, 'get_pool'),
  check_drainer: await view(c, 'check', { agent: d.agent, receiver: d.drainer_blocklisted, amount: '10000000000000000000000' }),
  check_merchant: await view(c, 'check', { agent: d.agent, receiver: d.merchant_attested_pass, amount: '10000000000000000000000' }),
};
console.log(JSON.stringify(out, null, 2));
