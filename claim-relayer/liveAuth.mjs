/**
 * Live POST /v1/claims authorization.
 * `release` is refused before any of the steps below. A relayed release would
 * revert on chain: while the escrow is Open only the payer may call it, and
 * the relayer address is not the payer. That refusal does not simulate, sign,
 * broadcast, or consume an intent nonce.
 * Verification order for a relayable action is fixed:
 *   1. domain chainId + verifyingContract
 *   2. deadline window
 *   3. signer (ECDSA, then ERC-1271 only when enabled)
 *   4. server builds calldata from action + escrowId (client calldata is not relayed)
 *   5. sender is payer or payee of that same escrow id, which must exist at latest
 *   6. (sender, nonce) single-use store. A replay is rejected and is not broadcast.
 * Only then does the caller simulate and broadcast the server-built calldata.
 * Abuse limits run after the signature checks and before simulation.
 */

import { senderNoteFor } from "./claims.mjs";
import { DEADLINE_WINDOW_SECONDS, assertIntentDeadline, assertIntentDomain, assertIntentSigner, nonceKey, parseClaimIntent } from "./claimIntent.mjs";
import { httpError } from "./config.mjs";
import { encodeEscrowAction } from "./escrowCalldata.mjs";
import { isRulingPending } from "./revertData.mjs";

/**
 * Live allowlist is refund only.
 * release(bytes32) is payer-only while the escrow is Open, and payer or payee
 * only after the linked case is resolved and upheld. The transaction sender is
 * the relayer key, so a relayed release reverts ReleaseNotAuthorized. It is
 * refused here, before a nonce is claimed and before simulation or signing.
 * withdraw() and withdrawTo(address) spend pendingWithdrawals[msg.sender]
 * (BotAttestationEscrow.sol withdraw, withdrawTo, and _withdraw). The relayer
 * is that msg.sender, so a relayed withdraw pays the relayer and a relayed
 * withdrawTo can move the relayer's own credit to an address the caller picks.
 * Neither spends the signed user's credit. Both stay off.
 * dispute requires msg.sender to be the payer or the payee, so a relayed
 * dispute reverts. createEscrow is not relayed.
 */
const LIVE_ACTIONS = new Set(["refund"]);

/** Refuse release before calldata, escrow reads, nonce claim, simulation, or signing. */
export function assertReleaseRelayable(action) {
  if (action === "release") {
    throw httpError(400, "release_not_relayable", { txHash: null, dryRun: false });
  }
}

const ZERO = "0x0000000000000000000000000000000000000000";

function sameAddress(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

/**
 * Build refund calldata from the signed action and escrow id.
 * A client-supplied calldata field is checked and then discarded.
 * The transaction uses the bytes this function returns.
 * release is refused before that encoding.
 */
export function bindLiveCall(intent, body) {
  assertReleaseRelayable(intent.action);
  if (!LIVE_ACTIONS.has(intent.action)) throw httpError(400, "action_not_claim", { field: "action" });
  const built = encodeEscrowAction({ action: intent.action, escrowId: intent.escrowId });
  const suppliedValue = body?.amountWei ?? body?.valueWei ?? body?.value;
  if (suppliedValue !== undefined && suppliedValue !== null && String(suppliedValue).trim() !== "") {
    throw httpError(400, "value_not_allowed");
  }
  if (built.valueWei !== "0") throw httpError(400, "value_not_allowed");
  const client = body?.calldata;
  if (client !== undefined && client !== null && String(client).trim() !== "") {
    const hex = String(client).trim().toLowerCase();
    if (!/^0x[0-9a-f]*$/.test(hex)) throw httpError(400, "invalid_calldata");
    const canonical = built.calldata.toLowerCase();
    if (hex.startsWith(canonical) && hex.length > canonical.length) throw httpError(400, "trailing_bytes");
    if (hex !== canonical) throw httpError(400, "calldata_mismatch");
  }
  return built;
}

/**
 * viem's default baseFeeMultiplier is 1.2. prepareTransactionRequest sets
 * maxFeePerGas to that scaled base fee plus the priority fee.
 * @param {bigint | string | number} baseFeePerGas
 * @param {bigint | string | number} maxPriorityFeePerGas
 */
export function eip1559MaxFeePerGas(baseFeePerGas, maxPriorityFeePerGas) {
  return (BigInt(baseFeePerGas) * 12n) / 10n + BigInt(maxPriorityFeePerGas);
}

/**
 * Price one gas unit for the daily budget.
 * A quoted max fee is the signer's rate for this claim.
 * With no quote, CLAIM_GAS_PRICE_WEI is multiplied by CLAIM_GAS_PRICE_MULTIPLIER
 * (default 5). The result is clamped to maxFeePerGasWei.
 * @param {object} [abuse]
 * @param {bigint | string | number | null} [quotedMaxFeePerGasWei]
 */
export function budgetGasPriceWei(abuse = {}, quotedMaxFeePerGasWei) {
  const capText = abuse.maxFeePerGasWei;
  const cap = capText == null || String(capText).trim() === "" ? null : BigInt(capText);
  const base = BigInt(abuse.gasPriceWei ?? "1000000000");
  const multiplier = BigInt(abuse.gasPriceMultiplier ?? 5);
  let quoted = null;
  if (quotedMaxFeePerGasWei != null && String(quotedMaxFeePerGasWei).trim() !== "") {
    quoted = BigInt(quotedMaxFeePerGasWei);
  }
  let price = quoted != null && quoted > 0n ? quoted : base * multiplier;
  if (cap != null && cap > 0n && price > cap) price = cap;
  if (price < 1n) price = 1n;
  return price;
}

function gasWeiFor(gasUsed, valueWei, gasPriceWei) {
  const gas = gasUsed > 0n ? gasUsed : 120_000n;
  const price = gasPriceWei > 0n ? gasPriceWei : 0n;
  const value = BigInt(valueWei || "0");
  return gas * price + value;
}

/**
 * @param {object} args
 * @param {object} args.body
 * @param {ReturnType<import('./config.mjs').loadConfig>} args.config
 * @param {{ readEscrow: Function, isValidSignature: Function, simulate: Function }} args.chain
 * @param {{ claim: Function }} args.intentNonces
 * @param {{ check: Function, consume: Function }} args.abuse
 * @param {number} args.nowMs
 * @param {string} args.ip
 */
export async function prepareLiveClaim(args) {
  const { body, config, chain, intentNonces, abuse, nowMs, ip } = args;
  const intent = parseClaimIntent(body);
  assertReleaseRelayable(intent.action);
  assertIntentDomain(intent, config);
  assertIntentDeadline(intent, nowMs);
  const signer = await assertIntentSigner(intent, config, chain);
  const described = bindLiveCall(intent, body);
  const valueWei = "0";
  const boundEscrowId = intent.escrowId;

  if (!chain || typeof chain.readEscrow !== "function") {
    throw httpError(503, "escrow_reader_missing", { txHash: null, dryRun: false });
  }
  const record = await chain.readEscrow(boundEscrowId);
  if (!record?.exists || sameAddress(record.payer, ZERO)) {
    throw httpError(404, "escrow_not_found", { txHash: null, dryRun: false });
  }
  const senderIsParty =
    sameAddress(intent.sender, record.payer) || sameAddress(intent.sender, record.payee);
  if (!senderIsParty) throw httpError(403, "not_a_party", { txHash: null, dryRun: false });

  const key = nonceKey(intent.sender, intent.nonce);
  const ttlMs = Math.max(DEADLINE_WINDOW_SECONDS * 1000, Number(intent.deadline) * 1000 - nowMs);

  const claimed = await intentNonces.claim({ key, ttlMs, atMs: nowMs });
  if (claimed.kind === "replay") {
    throw httpError(409, "nonce_replay", { txHash: null, dryRun: false });
  }
  if (claimed.kind === "pending") {
    throw httpError(409, "nonce_in_flight", { txHash: null, dryRun: false });
  }

  const encoded = {
    action: intent.action,
    signature: described.signature,
    selector: described.selector,
    calldata: described.calldata,
    valueWei,
    calldataStatus: "encoded",
    senderConstraint: described.senderConstraint,
  };

  try {
    await abuse.check({
      sender: intent.sender,
      ip,
      escrowId: boundEscrowId,
      gasWei: 0n,
      atMs: nowMs,
    });
  } catch (err) {
    err.nonceClaimed = true;
    err.nonceKey = key;
    throw err;
  }

  let simulation;
  try {
    simulation = await chain.simulate({
      to: config.escrowAddress,
      data: described.calldata,
      valueWei,
    });
  } catch (err) {
    err.nonceClaimed = true;
    err.nonceKey = key;
    throw err;
  }
  if (!simulation?.ok) {
    const revert_data = simulation?.revertData ?? null;
    if (isRulingPending(revert_data)) {
      throw Object.assign(httpError(409, "ruling_pending", {
        txHash: null,
        dryRun: false,
        revert_data,
        action: intent.action,
        senderConstraint: described.senderConstraint,
        senderNote: senderNoteFor(intent.action),
      }), { nonceClaimed: true, nonceKey: key });
    }
    throw Object.assign(httpError(502, "broadcast_failed", {
      txHash: null,
      dryRun: false,
      revert_data,
      action: intent.action,
      senderConstraint: described.senderConstraint,
    }), { nonceClaimed: true, nonceKey: key });
  }

  const estimatedGas = BigInt(simulation.gasUsed ?? 0);
  const maxGas = BigInt(config.abuse?.maxGas ?? 500_000);
  if (estimatedGas > maxGas) {
    throw Object.assign(
      httpError(429, "gas_cap", { field: "gas", txHash: null, dryRun: false, retryAfter: 1 }),
      { nonceClaimed: true, nonceKey: key },
    );
  }

  const gasWei = gasWeiFor(
    estimatedGas,
    valueWei,
    budgetGasPriceWei(config.abuse, simulation.maxFeePerGasWei),
  );
  try {
    await abuse.consume({
      sender: intent.sender,
      ip,
      escrowId: boundEscrowId,
      gasWei,
      atMs: nowMs,
    });
  } catch (err) {
    err.nonceClaimed = true;
    err.nonceKey = key;
    throw err;
  }

  return {
    kind: "ready",
    nonceKey: key,
    encoded,
    claimId: boundEscrowId,
    sender: intent.sender,
    payer: record.payer,
    payee: record.payee,
    domainMatched: signer.domainMatched,
  };
}
