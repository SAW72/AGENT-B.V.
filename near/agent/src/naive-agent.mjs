// A deliberately gullible "agent" planner used by the demos.
//
// It stands in for an LLM agent that has been prompt-injected: it turns the
// task AND any instructions found inside untrusted documents into payment
// actions. It is deterministic on purpose so judges get the same result on
// every replay. It is not a real LLM; it models the worst case, an agent that
// always obeys the injection.

const PAY_RE = /(?:pay|send|transfer)\s+([0-9.]+)\s*NEAR\s+to\s+([a-z0-9._-]+\.testnet)/gi;

/** @returns {{receiver:string, amountNear:string, source:'task'|'document', text:string}[]} */
export function planPayments(task, documents = []) {
  const plan = [];
  for (const m of task.matchAll(PAY_RE)) plan.push({ receiver: m[2], amountNear: m[1], source: 'task', text: m[0] });
  for (const doc of documents) {
    for (const m of doc.matchAll(PAY_RE)) plan.push({ receiver: m[2], amountNear: m[1], source: 'document', text: m[0] });
  }
  return plan;
}
