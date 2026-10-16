import { secp256k1 } from "@noble/curves/secp256k1";
import { getAddress, hashTypedData, hexToBytes, keccak256 } from "viem";
import {
  CHAIN_ID,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  ESCROW,
  SECP256K1_HALF_N,
  SECP256K1_N,
  ZERO_ADDRESS,
} from "./constants.mjs";

export const POINTS_DOMAIN = Object.freeze({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  chainId: CHAIN_ID,
  verifyingContract: getAddress(ESCROW),
});

export const POINTS_LINK_TYPES = Object.freeze({
  PointsLink: Object.freeze([
    Object.freeze({ name: "escrowId", type: "bytes32" }),
    Object.freeze({ name: "action", type: "string" }),
    Object.freeze({ name: "txHash", type: "bytes32" }),
    Object.freeze({ name: "logIndex", type: "uint256" }),
    Object.freeze({ name: "nonce", type: "uint256" }),
    Object.freeze({ name: "expiry", type: "uint64" }),
    Object.freeze({ name: "wallet", type: "address" }),
  ]),
});

export const DECISION_ENTRY_TYPES = Object.freeze({
  DecisionEntry: Object.freeze([
    Object.freeze({ name: "actorId", type: "address" }),
    Object.freeze({ name: "actorType", type: "string" }),
    Object.freeze({ name: "modelVersion", type: "string" }),
    Object.freeze({ name: "timestamp", type: "uint64" }),
    Object.freeze({ name: "scope", type: "string" }),
    Object.freeze({ name: "authority", type: "string" }),
    Object.freeze({ name: "accountableHumanId", type: "address" }),
  ]),
});

export const POINTS_LINK_TYPE_STRING =
  "PointsLink(bytes32 escrowId,string action,bytes32 txHash,uint256 logIndex,uint256 nonce,uint64 expiry,address wallet)";

export const DECISION_ENTRY_TYPE_STRING =
  "DecisionEntry(address actorId,string actorType,string modelVersion,uint64 timestamp,string scope,string authority,address accountableHumanId)";

/**
 * ECDSA only. Anything that is not a 65-byte signature is refused (ERC-1271).
 * r and s must be non-zero, r must be below the curve order, s must be low.
 * v in {0, 1, 27, 28} is normalized to 27/28 before recovery.
 */
export function inspectSignature(signature) {
  const hex = String(signature ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(hex)) return { ok: false, reason: "bad_signature" };
  const byteLength = (hex.length - 2) / 2;
  if (byteLength !== 65) return { ok: false, reason: "erc1271_refused" };
  const r = BigInt(`0x${hex.slice(2, 66)}`);
  const s = BigInt(`0x${hex.slice(66, 130)}`);
  const vRaw = Number.parseInt(hex.slice(130, 132), 16);
  if (r <= 0n || r >= SECP256K1_N) return { ok: false, reason: "bad_r" };
  if (s <= 0n || s > SECP256K1_HALF_N) return { ok: false, reason: "bad_s" };
  if (vRaw !== 0 && vRaw !== 1 && vRaw !== 27 && vRaw !== 28) return { ok: false, reason: "bad_v" };
  const v = vRaw >= 27 ? vRaw : vRaw + 27;
  const normalized = `0x${hex.slice(2, 130)}${v.toString(16).padStart(2, "0")}`;
  return { ok: true, r, s, vRaw, v, normalized };
}

export function recoverSigner(hash, signature) {
  const inspected = inspectSignature(signature);
  if (!inspected.ok) return inspected;
  try {
    const compact = hexToBytes(`0x${inspected.normalized.slice(2, 130)}`);
    const point = secp256k1.Signature.fromCompact(compact).addRecoveryBit(inspected.v - 27).recoverPublicKey(hexToBytes(hash));
    const raw = point.toRawBytes(false);
    const digest = keccak256(raw.subarray(1));
    return { ok: true, address: `0x${digest.slice(-40)}`, ...inspected };
  } catch {
    return { ok: false, reason: "recover_failed" };
  }
}

function bytes32(value) {
  const text = String(value).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(text)) return null;
  return text;
}

const DECIMAL_UINT = /^(0|[1-9][0-9]*)$/;

/** Canonical base-10 integer. Hex, signs, blanks, and leading zeroes are rejected. */
function decimalUint(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    const text = String(value);
    return DECIMAL_UINT.test(text) ? text : null;
  }
  if (typeof value === "bigint") {
    if (value < 0n) return null;
    const text = value.toString(10);
    return DECIMAL_UINT.test(text) ? text : null;
  }
  if (typeof value !== "string" || !DECIMAL_UINT.test(value)) return null;
  return value;
}

export function linkHash(message) {
  if (!message || typeof message !== "object") return { ok: false, reason: "bad_link" };
  const logIndex = decimalUint(message.logIndex);
  const nonce = decimalUint(message.nonce);
  if (logIndex === null || nonce === null) return { ok: false, reason: "bad_link" };
  const escrowId = bytes32(message.escrowId);
  const txHash = bytes32(message.txHash);
  if (!escrowId || !txHash) return null;
  try {
    return hashTypedData({
      domain: POINTS_DOMAIN,
      types: POINTS_LINK_TYPES,
      primaryType: "PointsLink",
      message: {
        escrowId,
        action: String(message.action),
        txHash,
        logIndex: BigInt(logIndex),
        nonce: BigInt(nonce),
        expiry: BigInt(message.expiry),
        wallet: getAddress(message.wallet),
      },
    });
  } catch {
    return { ok: false, reason: "bad_link" };
  }
}

export function entryHash(entry) {
  return hashTypedData({
    domain: POINTS_DOMAIN,
    types: DECISION_ENTRY_TYPES,
    primaryType: "DecisionEntry",
    message: {
      actorId: getAddress(entry.actorId),
      actorType: String(entry.actorType),
      modelVersion: String(entry.modelVersion ?? ""),
      timestamp: BigInt(entry.timestamp),
      scope: String(entry.scope ?? ""),
      authority: String(entry.authority),
      accountableHumanId: getAddress(entry.accountableHumanId || ZERO_ADDRESS),
    },
  });
}

export function expiryAccepts(blockTimestamp, expiry) {
  const start = BigInt(blockTimestamp);
  const value = BigInt(expiry);
  return value >= start && value <= start + 86400n;
}

/**
 * Structural chain check. Block-timestamp order is applied later, per log.
 * Origin tags come from the server register. The signed actorType must match that tag.
 */
export function evaluateChain(entries, origins, blockTimestamp = null) {
  if (!Array.isArray(entries) || entries.length < 2) {
    return { accepted: false, reason: "missing_chain", maxTimestamp: null };
  }
  const authorities = entries.map((entry) => entry.authority);
  if (authorities[0] !== "propose" || authorities[authorities.length - 1] !== "approve") {
    return { accepted: false, reason: "chain_order", maxTimestamp: null };
  }
  if (authorities.slice(1, -1).some((authority) => authority !== "review")) {
    return { accepted: false, reason: "chain_order", maxTimestamp: null };
  }

  let maxTimestamp = 0;
  for (const entry of entries) {
    const timestamp = Number(entry.timestamp);
    if (!Number.isInteger(timestamp) || timestamp < 0) {
      return { accepted: false, reason: "bad_timestamp", maxTimestamp: null };
    }
    maxTimestamp = Math.max(maxTimestamp, timestamp);
    if (!entry.scope || String(entry.scope).trim() === "") {
      return { accepted: false, reason: "missing_scope", maxTimestamp: null };
    }
    const actorId = String(entry.actorId || "").toLowerCase();
    const origin = origins.get(actorId);
    if (!origin) return { accepted: false, reason: "origin_unset", maxTimestamp: null };
    if (origin.actorType !== entry.actorType) {
      return { accepted: false, reason: "origin_mismatch", maxTimestamp: null };
    }
    const hash = entryHash(entry);
    const recovered = recoverSigner(hash, entry.signature);
    if (!recovered.ok) return { accepted: false, reason: recovered.reason, maxTimestamp: null };
    if (recovered.address !== actorId) {
      return { accepted: false, reason: "entry_signer", maxTimestamp: null };
    }
    if (entry.actorType === "ai") {
      if (!entry.modelVersion) return { accepted: false, reason: "model_version", maxTimestamp: null };
      if (origin.modelVersion && origin.modelVersion !== entry.modelVersion) {
        return { accepted: false, reason: "model_version", maxTimestamp: null };
      }
    } else if (entry.actorType === "human") {
      if (!origin.identityAnchor || !origin.behavioralSignals) {
        return { accepted: false, reason: "human_anchor", maxTimestamp: null };
      }
    } else {
      return { accepted: false, reason: "actor_type", maxTimestamp: null };
    }
  }

  const terminal = entries[entries.length - 1];
  if (terminal.actorType !== "human") {
    return { accepted: false, reason: "terminal_not_human", maxTimestamp };
  }
  if (blockTimestamp !== null && maxTimestamp >= Number(blockTimestamp)) {
    return { accepted: false, reason: "chain_after_log", maxTimestamp };
  }
  return {
    accepted: true,
    reason: "ok",
    maxTimestamp,
    terminalWallet: String(terminal.actorId).toLowerCase(),
  };
}
