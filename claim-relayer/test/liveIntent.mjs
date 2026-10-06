/**
 * Test-only intent signing. Keys come from the public Hardhat mnemonic.
 * Nothing here is a production key.
 */

import { mnemonicToAccount } from "viem/accounts";
import { actionIndex, claimIntentDomain, claimIntentTypes } from "../claimIntent.mjs";
import { encodeEscrowAction } from "../escrowCalldata.mjs";

export const TEST_MNEMONIC = "test test test test test test test test test test test junk";
export const NOW_MS = Date.parse("2026-09-25T19:00:00.000Z");
export const BOOKED_ESCROW = "0x3d660502D75f1e97b08c110255921b437A3C4C42";
export const ZERO = "0x0000000000000000000000000000000000000000";

export function testAccounts() {
  return {
    payer: mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 0 }),
    payee: mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 1 }),
    stranger: mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 2 }),
  };
}

export function deadlineAt(offsetSeconds, nowMs = NOW_MS) {
  return String(Math.floor(nowMs / 1000) + offsetSeconds);
}

/**
 * @param {object} opts
 * @param {import('viem/accounts').PrivateKeyAccount} opts.account
 */
export async function signedLiveBody(opts) {
  const action = opts.action || "refund";
  const index = actionIndex(action);
  if (index === null) throw new Error(`test cannot sign ${action}`);
  const escrowId = opts.escrowId;
  const chainId = opts.chainId ?? 84532;
  const verifyingContract = opts.verifyingContract || BOOKED_ESCROW;
  const encoded = encodeEscrowAction({ action, claimId: escrowId, escrowId, ...(opts.fields || {}) });
  const nonce = String(opts.nonce);
  const deadline = String(opts.deadline);
  const domain = claimIntentDomain(chainId, verifyingContract);
  const message = {
    action: index,
    escrowId,
    sender: opts.account.address,
    nonce: BigInt(nonce),
    deadline: BigInt(deadline),
  };
  const signature = await opts.account.signTypedData({
    domain,
    types: claimIntentTypes(),
    primaryType: "ClaimIntent",
    message,
  });
  const calldata = opts.calldata || encoded.calldata;
  return {
    live: opts.live !== false,
    calldata,
    signature,
    claimId: escrowId,
    ...(opts.fields?.amountWei ? { amountWei: String(opts.fields.amountWei) } : {}),
    intent: {
      action,
      escrowId,
      sender: opts.account.address,
      nonce,
      deadline,
      chainId,
      verifyingContract,
    },
  };
}

export function trackingChain(opts = {}) {
  const calls = { reads: [], simulations: [], erc1271: [] };
  const payer = opts.payer;
  const payee = opts.payee;
  return {
    calls,
    async readEscrow(id) {
      calls.reads.push(id);
      const missing = opts.missingIds || new Set();
      if (opts.exists === false || missing.has(String(id).toLowerCase())) {
        return { exists: false, payer: ZERO, payee: ZERO };
      }
      return { exists: true, payer, payee };
    },
    async simulate(tx) {
      calls.simulations.push(tx);
      if (opts.simulate) return opts.simulate(tx);
      return { ok: true, gasUsed: 50_000n, revertData: null };
    },
    async isValidSignature(account, typed, signature) {
      calls.erc1271.push({ account, typed, signature });
      if (typeof opts.isValidSignature === "function") return opts.isValidSignature(account, typed, signature);
      return false;
    },
  };
}
