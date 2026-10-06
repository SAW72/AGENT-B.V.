import { randomBytes } from "node:crypto";
import { BASE_SEPOLIA_CHAIN_ID, ZERO_ADDRESS, httpError, isAddress, retiredEscrowError } from "./config.mjs";
import { encodeEscrowAction } from "./escrowCalldata.mjs";
import { isRulingPending, revertDataFrom } from "./revertData.mjs";

const CLAIM_ID_RE = /^(?:fixture-[0-9a-f]{8,32}|0x[0-9a-fA-F]{64}|[A-Za-z0-9:_-]{1,80})$/;

export function assertBaseSepolia(body) {
  if (!body || body.chainId === undefined || body.chainId === null || body.chainId === "") return;
  const chainId = Number(body.chainId);
  if (!Number.isInteger(chainId)) throw httpError(400, "wrong_chain");
  if (chainId === 1 || chainId === 8453) throw httpError(400, "mainnet_refused", { chainId });
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) throw httpError(400, "wrong_chain", { chainId });
}

export function requireAddress(value, field) {
  const address = String(value || "").trim();
  if (!isAddress(address) || address.toLowerCase() === ZERO_ADDRESS) {
    throw httpError(400, "invalid_address", { field });
  }
  return address;
}

export function parseAmountWei(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw httpError(400, "invalid_amount");
  } else if (typeof value !== "string" && typeof value !== "bigint") {
    throw httpError(400, "invalid_amount");
  }
  const text = typeof value === "bigint" ? value.toString() : String(value).trim();
  if (!/^[0-9]+$/.test(text) || text === "0") throw httpError(400, "invalid_amount");
  return text;
}

export function newFixtureClaimId() {
  return `fixture-${randomBytes(8).toString("hex")}`;
}

export function parseClaimId(value, { generate = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === "") {
    if (generate) return newFixtureClaimId();
    throw httpError(400, "invalid_claim_id");
  }
  const claimId = String(value).trim();
  if (!CLAIM_ID_RE.test(claimId)) throw httpError(400, "invalid_claim_id");
  return claimId;
}

/** Client asked for a real transaction (`live`, `liveSubmit`, or `mode` live/broadcast). */
export function wantsLiveSubmit(body) {
  if (!body || typeof body !== "object") return false;
  const mode = String(body.mode || "").trim().toLowerCase();
  return body.live === true || body.liveSubmit === true || mode === "live" || mode === "broadcast";
}

export function refusalReason(config) {
  const blockers = config?.liveSubmit?.blockers || [];
  if (config?.escrowRetired || blockers.includes("escrow_retired")) return "retired_or_superseded_address";
  if (blockers.includes("mainnet_refused")) return "mainnet_refused";
  if (blockers.includes("wrong_chain")) return "wrong_chain";
  if (!config?.escrowBooked || blockers.includes("escrow_not_booked")) return "escrow_not_booked";
  if (blockers.includes("escrow_not_booked_sepolia")) return "escrow_not_booked_sepolia";
  if (!config?.liveSubmit?.spencerAuth || blockers.includes("spencer_run_auth_required")) {
    return "escrow_booked_spencer_run_auth_required";
  }
  if (!config?.liveSubmit?.requested || blockers.includes("live_submit_off")) return "live_submit_off";
  if (config?.liveSubmit?.allowed) return null;
  return blockers[0] || "live_submit_blocked";
}

/** Permission note for the address that will sign. Never claims the funding wallet is a Vault operator. */
export function senderNoteFor(action) {
  if (action === "createEscrow") {
    return "createEscrow is signed by the relayer key. It succeeds only when that address is the payer Vault operator. This service does not treat the funding wallet as that operator.";
  }
  if (action === "dispute") {
    return "dispute is not relayed. The payer or the payee sends it from their own wallet.";
  }
  if (action === "release") {
    return "Only the payer can release an open escrow; after an upheld dispute, the payer or the payee. Release is not relayed. Send it from that wallet.";
  }
  return "refund is permissionless. The relayer signs the credit. The credited account withdraws its own balance.";
}

export function liveSubmitError(config) {
  if (config?.escrowRetired) return retiredEscrowError(config);
  return httpError(409, "live_submit_blocked", {
    reason: refusalReason(config),
    blockers: config.liveSubmit.blockers,
    mode: "fixture",
    txHash: null,
    dryRun: true,
    escrowBooked: config.escrowBooked,
    escrowAddress: config.escrowAddress,
  });
}

/** Encode claim calldata when `action` is set. Never signs or broadcasts. */
export function describeCalldata(body) {
  if (!body || body.action === undefined || body.action === null || String(body.action).trim() === "") {
    return { calldata: null, calldataStatus: "action_required" };
  }
  const encoded = encodeEscrowAction(body);
  return {
    action: encoded.action,
    signature: encoded.signature,
    selector: encoded.selector,
    calldata: encoded.calldata,
    valueWei: encoded.valueWei,
    senderConstraint: encoded.senderConstraint,
    calldataStatus: "encoded",
  };
}

export async function buildFixtureQuote({ body, config, nonceStore, now }) {
  assertBaseSepolia(body);
  const payer = requireAddress(body.payer, "payer");
  const payee = requireAddress(body.payee, "payee");
  if (payer.toLowerCase() === payee.toLowerCase()) throw httpError(400, "invalid_parties");
  const claimId = parseClaimId(body.claimId, { generate: true });
  const amountWei = parseAmountWei(body.amountWei);
  const atMs = now();
  const reserved = await nonceStore.reserve({
    claimId,
    ttlMs: config.quoteTtlMs,
    atMs,
  });
  return {
    claimId,
    payer,
    payee,
    ...(amountWei !== undefined ? { amountWei } : {}),
    fixture: true,
    expiresAt: new Date(reserved.expiresAtMs).toISOString(),
    chainId: BASE_SEPOLIA_CHAIN_ID,
    mode: "fixture",
    dryRun: true,
    escrowBooked: config.escrowBooked,
    escrowAddress: config.escrowAddress,
    relayerAddress: config.relayerAddress,
    relayerNonce: reserved.nonce.toString(),
    ...describeCalldata(body),
  };
}

export function buildFixtureClaim(body, config) {
  assertBaseSepolia(body);
  const claimId = parseClaimId(body.claimId);
  const payer = body.payer !== undefined ? requireAddress(body.payer, "payer") : undefined;
  const payee = body.payee !== undefined ? requireAddress(body.payee, "payee") : undefined;
  if (payer && payee && payer.toLowerCase() === payee.toLowerCase()) {
    throw httpError(400, "invalid_parties");
  }
  if (body.amountWei !== undefined && body.amountWei !== null && body.amountWei !== "") {
    parseAmountWei(body.amountWei);
  }
  return {
    ok: true,
    mode: "fixture",
    claimId,
    txHash: null,
    reason: config.liveSubmit?.allowed ? "dry_run" : refusalReason(config),
    dryRun: true,
    escrowBooked: Boolean(config.escrowBooked),
    escrowAddress: config.escrowAddress,
    ...describeCalldata(body),
  };
}

/**
 * Sign and submit one encoded escrow action on Base Sepolia.
 * The caller must already have decided that live submit is allowed.
 * @param {object} args
 * @param {object} args.body
 * @param {ReturnType<import('./config.mjs').loadConfig>} args.config
 * @param {{ send: (tx: object) => Promise<{ txHash?: string }> } | null | undefined} args.broadcaster
 */
export async function submitLiveClaim({ body, config, broadcaster, prepared }) {
  assertBaseSepolia(body);
  if (config?.escrowRetired) throw retiredEscrowError(config);
  if (!config?.liveSubmit?.allowed) throw liveSubmitError(config);
  const encoded = prepared?.encoded || describeCalldata(body);
  if (encoded.calldataStatus !== "encoded" || !encoded.calldata) {
    throw httpError(400, "action_required", { txHash: null, dryRun: false });
  }
  const claimId = parseClaimId(prepared?.claimId || body.claimId);
  const payer =
    body.payer !== undefined && body.payer !== null && String(body.payer).trim() !== ""
      ? requireAddress(body.payer, "payer")
      : undefined;
  const payee =
    body.payee !== undefined && body.payee !== null && String(body.payee).trim() !== ""
      ? requireAddress(body.payee, "payee")
      : undefined;
  if (payer && payee && payer.toLowerCase() === payee.toLowerCase()) {
    throw httpError(400, "invalid_parties");
  }

  const tx = {
    chainId: BASE_SEPOLIA_CHAIN_ID,
    to: config.escrowAddress,
    data: encoded.calldata,
    valueWei: encoded.valueWei,
    action: encoded.action,
  };

  let sent;
  try {
    if (!broadcaster || typeof broadcaster.send !== "function") {
      throw httpError(503, "relayer_key_missing", { txHash: null, dryRun: false });
    }
    sent = await broadcaster.send(tx);
  } catch (err) {
    const revert_data = revertDataFrom(err);
    if (isRulingPending(revert_data)) {
      const pending = httpError(409, "ruling_pending", { txHash: null, dryRun: false, revert_data });
      pending.senderConstraint = encoded.senderConstraint;
      pending.senderNote = senderNoteFor(encoded.action);
      pending.action = encoded.action;
      throw pending;
    }
    const wrapped = err?.status
      ? err
      : httpError(502, "broadcast_failed", { txHash: null, dryRun: false, revert_data });
    wrapped.senderConstraint = encoded.senderConstraint;
    wrapped.senderNote = senderNoteFor(encoded.action);
    wrapped.action = encoded.action;
    wrapped.txHash = null;
    wrapped.dryRun = false;
    if (Number(wrapped.status) === 502 && wrapped.error === "broadcast_failed") {
      wrapped.revert_data = revertDataFrom(wrapped);
    }
    throw wrapped;
  }

  const txHash = sent?.txHash;
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw httpError(502, "broadcast_failed", {
      txHash: null,
      dryRun: false,
      revert_data: null,
      action: encoded.action,
      senderConstraint: encoded.senderConstraint,
      senderNote: senderNoteFor(encoded.action),
    });
  }

  return {
    ok: true,
    mode: "live",
    fixture: false,
    claimId,
    txHash,
    dryRun: false,
    escrowBooked: Boolean(config.escrowBooked),
    escrowAddress: config.escrowAddress,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    senderNote: senderNoteFor(encoded.action),
    ...encoded,
  };
}
