// Thin near-api-js client. The agent client is built ONLY from the
// function-call key file and checks on-chain that the key really is a
// function-call key scoped to the policy contract before it will sign.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, getTransactionLastResult, teraToGas } from 'near-api-js';
import { RPC_URL } from './config.mjs';
import { assertFunctionCallOnly } from './key-guard.mjs';

export const provider = () => new JsonRpcProvider({ url: RPC_URL });

/** Reads a legacy-keychain JSON key file. The private key never leaves this function's scope as a string we print. */
export function readKeyFile(path, accountIdHint) {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const keyPair = KeyPair.fromString(j.private_key);
  // near-cli-rs legacy files have no account_id field; the file name is the account id.
  const accountId = j.account_id || accountIdHint || basename(path).replace(/\.json$/, '');
  return { accountId, keyPair, publicKey: keyPair.getPublicKey().toString() };
}

export async function view(contractId, method, args = {}) {
  return provider().callFunction({ contractId, method, args });
}

export function txHashOf(res) {
  return res?.transaction?.hash || res?.transaction_outcome?.id;
}

/** Collects EVENT_JSON logs from every receipt of a transaction. */
export function eventsOf(res) {
  const outs = [res?.transaction_outcome, ...(res?.receipts_outcome || [])];
  return outs
    .flatMap((o) => o?.outcome?.logs || [])
    .filter((l) => l.startsWith('EVENT_JSON:'))
    .map((l) => JSON.parse(l.slice('EVENT_JSON:'.length)));
}

/** Account bound to an arbitrary key (owner scripts). */
export function accountFromKeyFile(path) {
  const { accountId, keyPair } = readKeyFile(path);
  return new Account(accountId, provider(), new KeyPairSigner(keyPair));
}

/**
 * Agent client: `view` + `call` restricted to the policy contract, signed by
 * the function-call key in `keyFile`. Throws if the key is full-access or
 * scoped to anything else.
 */
export async function agentClient({ keyFile, policyId, agentId }) {
  const { accountId, keyPair, publicKey } = readKeyFile(keyFile);
  if (accountId !== agentId) throw new Error(`key file is for ${accountId}, expected ${agentId}`);
  const p = provider();
  const ak = await p.viewAccessKey({ accountId, publicKey });
  const fc = assertFunctionCallOnly(ak, policyId);
  const account = new Account(accountId, p, new KeyPairSigner(keyPair));
  return {
    publicKey,
    permission: fc,
    account,
    view: (method, args) => view(policyId, method, args),
    async call(method, args) {
      const res = await account.callFunctionRaw({
        contractId: policyId,
        methodName: method,
        args,
        gas: teraToGas('30'),
        deposit: 0n,
      });
      return { hash: txHashOf(res), result: getTransactionLastResult(res), events: eventsOf(res) };
    },
  };
}
