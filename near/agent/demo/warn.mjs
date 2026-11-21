// Warn-path demo (NEAR testnet). The agent wants to pay an account that has no
// bot attestation on record. The policy answers `warn`, so the wrapper stops
// and asks a human "[y/N]". Default is N; without a TTY it is always N.
// Writes near/demo/out/warn.log.
//
//   node demo/warn.mjs            interactive y/N on a TTY
//   echo n | node demo/warn.mjs   non-interactive: treated as N, nothing signed
// If a human answers y, the agent signs request_payment and the contract parks
// the payment as pending until the owner approves it on-chain (approve_pending).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNearAmount } from 'near-api-js';
import { NEAR_DIR, loadDeployment, agentKeyFile } from '../src/config.mjs';
import { agentClient } from '../src/near-client.mjs';
import { GuardedAgent, ttyConfirm } from '../src/guarded-agent.mjs';

const d = loadDeployment();
const client = await agentClient({ keyFile: agentKeyFile(d.agent), policyId: d.policy_contract, agentId: d.agent });
const asked = [];
const agent = new GuardedAgent({
  client,
  agentId: d.agent,
  confirm: async (q) => {
    const answer = await ttyConfirm(q);
    asked.push({ question: q, answer: answer ? 'y' : 'N' });
    return answer;
  },
});
// Unattested receiver (never created on chain; only referenced).
const receiver = process.env.WARN_RECEIVER || d.agent.replace('agentbv-agent-', 'agentbv-newvendor-');
const r = await agent.pay(receiver, parseNearAmount('0.001'), 'task: pay a new vendor for a sample order');
const out = { demo: 'agent-bv near warn demo', network: 'testnet', run_at: new Date().toISOString(), policy_contract: d.policy_contract, agent: d.agent, receiver, human_prompt: asked, result: r };
const dir = join(NEAR_DIR, 'demo', 'out');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'warn.log'), JSON.stringify(out, null, 2) + '\n');
console.log(`verdict=${r.decision.verdict} action=${r.action} signed=${r.signed}`);
console.log(`log: ${join(dir, 'warn.log')}`);
