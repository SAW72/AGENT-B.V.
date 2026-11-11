// Agent-BV guarded agent wrapper (NEAR testnet only).
//
// Every payment an AI agent wants to make goes through `pay()`:
//   1. ask the policy contract (`check`, a free view call) for allow / warn / block;
//   2. block  -> refuse; nothing is signed;
//      warn   -> stop and ask a human (y/N, default N); only "y" continues;
//      allow  -> sign `request_payment` with the function-call key.
// The contract re-runs the same policy on-chain inside `request_payment`, so
// even an agent that skips this wrapper cannot pay a blocked receiver.
//
// The chain client is injected so the decision logic can be unit tested
// without a network. See near-client.mjs for the near-api-js client.

export const EXPLORER_TX = 'https://testnet.nearblocks.io/txns/';

export class GuardedAgent {
  /**
   * @param {object} o
   * @param {{view:Function, call:Function}} o.client chain client bound to the agent's function-call key
   * @param {string} o.agentId agent account id
   * @param {(question:string)=>Promise<boolean>} o.confirm human confirmation; must default to "no"
   * @param {(entry:object)=>void} [o.log] structured log sink
   */
  constructor({ client, agentId, confirm, log = () => {} }) {
    if (!client || !agentId || typeof confirm !== 'function') {
      throw new Error('GuardedAgent needs client, agentId and confirm');
    }
    this.client = client;
    this.agentId = agentId;
    this.confirm = confirm;
    this.log = log;
  }

  /**
   * @param {string} receiver NEAR account to pay
   * @param {string} amountYocto amount in yoctoNEAR, as a decimal string
   * @param {string} [why] the agent's stated reason (logged, never trusted)
   */
  async pay(receiver, amountYocto, why = '') {
    if (!/^[0-9]+$/.test(String(amountYocto))) throw new Error('amount must be a yoctoNEAR integer string');
    const args = { agent: this.agentId, receiver, amount: String(amountYocto) };
    const decision = await this.client.view('check', args);
    const base = { step: 'wrapper', receiver, amount_yocto: String(amountYocto), why, decision };

    if (decision.verdict === 'block') {
      const r = { ...base, action: 'refused', signed: false };
      this.log(r);
      return r;
    }
    if (decision.verdict === 'warn') {
      const q = `Policy says WARN for paying ${receiver} ${amountYocto} yoctoNEAR: ${decision.reasons.join('; ')}. Submit anyway? [y/N] `;
      const ok = (await this.confirm(q)) === true;
      if (!ok) {
        const r = { ...base, action: 'human_declined', signed: false };
        this.log(r);
        return r;
      }
    } else if (decision.verdict !== 'allow') {
      // Unknown answer: fail closed.
      const r = { ...base, action: 'refused_unknown_verdict', signed: false };
      this.log(r);
      return r;
    }
    const tx = await this.client.call('request_payment', { receiver, amount: String(amountYocto) });
    const r = {
      ...base,
      action: 'signed_request_payment',
      signed: true,
      tx_hash: tx.hash,
      explorer: EXPLORER_TX + tx.hash,
      onchain_result: tx.result,
    };
    this.log(r);
    return r;
  }
}

/** y/N prompt on a TTY. Without a TTY (CI, pipes) it answers "no". */
export async function ttyConfirm(question) {
  if (!process.stdin.isTTY) {
    process.stdout.write(question + '(no TTY: treating as N)\n');
    return false;
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(question)).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}
