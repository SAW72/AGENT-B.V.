// Shared config for the NEAR testnet scripts. Testnet only: any other network
// id is refused so nothing here can be pointed at mainnet by accident.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NEAR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const NETWORK = process.env.NEAR_NETWORK || 'testnet';
if (NETWORK !== 'testnet') {
  throw new Error(`testnet only: refusing NEAR_NETWORK=${NETWORK}`);
}
export const RPC_URL = process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com';
if (/mainnet|rpc\.near\.org|\/\/rpc\.fastnear/i.test(RPC_URL)) {
  throw new Error(`testnet only: refusing RPC ${RPC_URL}`);
}
export const EXPLORER_TX = 'https://testnet.nearblocks.io/txns/';
export const EXPLORER_ADDR = 'https://testnet.nearblocks.io/address/';
export const DEPLOYMENT_FILE = process.env.NEAR_DEPLOYMENT_FILE || join(NEAR_DIR, 'deployments', 'testnet.json');
export const CREDS_DIR = process.env.NEAR_CREDENTIALS_DIR || join(homedir(), '.near-credentials', 'testnet');

export function loadDeployment() {
  if (!existsSync(DEPLOYMENT_FILE)) {
    throw new Error(`no deployment file at ${DEPLOYMENT_FILE}; run scripts/deploy.sh first`);
  }
  const d = JSON.parse(readFileSync(DEPLOYMENT_FILE, 'utf8'));
  if (d.network !== 'testnet') throw new Error('deployment file is not testnet');
  return d;
}

/** Path of the agent's function-call key file (outside the repo by default). */
export function agentKeyFile(agentId) {
  return process.env.AGENT_KEY_FILE || join(CREDS_DIR, 'agentbv-fc', `${agentId}.json`);
}

/** Path of a full-access key saved by near-cli-rs (legacy keychain). Owner use only. */
export function fullAccessKeyFile(accountId) {
  return join(CREDS_DIR, `${accountId}.json`);
}
