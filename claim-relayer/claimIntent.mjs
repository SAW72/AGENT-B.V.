/**
 * EIP-712 ClaimIntent. The JSON file is the single schema shared with wallet-ux.
 * The signed uint8 for refund stays 1. Release stays uint8 0 so an old approval
 * is recognized and refused, and is not remapped onto refund.
 * createEscrow, dispute, withdraw, and withdrawTo are not in this list.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getAddress,
  isAddress,
  isHex,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
} from "viem";
import { SUPERSEDED } from "./addressBook.mjs";
import { httpError, RETIRED_SEPOLIA_ESCROWS } from "./config.mjs";

export const CLAIM_INTENT_SCHEMA = JSON.parse(
  readFileSync(fileURLToPath(new URL("./claimIntent.json", import.meta.url)), "utf8"),
);

export const CLAIM_INTENT_TYPE_STRING = CLAIM_INTENT_SCHEMA.typeString;
export const CLAIM_INTENT_TYPEHASH = keccak256(toBytes(CLAIM_INTENT_TYPE_STRING));
export const DEADLINE_WINDOW_SECONDS = CLAIM_INTENT_SCHEMA.deadlineWindowSeconds;
export const RETIRED_ESCROW = SUPERSEDED.botAttestationEscrow;

const ACTION_VALUES = CLAIM_INTENT_SCHEMA.actionValues;
const REFUSED_ACTIONS = CLAIM_INTENT_SCHEMA.refusedActions;

function isNonScalar(value) {
  return Array.isArray(value) || (value !== null && typeof value === "object");
}

/** Case, whitespace, and numeric-string aliases of release. Not "0x0" and not "1". */
export function isReleaseAlias(action) {
  if (isNonScalar(action)) return false;
  if (typeof action === "bigint") return action === 0n;
  if (typeof action === "number") return Number.isInteger(action) && action === 0;
  if (typeof action !== "string") return false;
  const trimmed = action.trim();
  return trimmed.toLowerCase() === "release" || /^0+$/.test(trimmed);
}

function valueForName(name) {
  if (Object.prototype.hasOwnProperty.call(ACTION_VALUES, name)) return ACTION_VALUES[name];
  if (Object.prototype.hasOwnProperty.call(REFUSED_ACTIONS, name)) return REFUSED_ACTIONS[name];
  return null;
}

function nameForValue(value) {
  for (const [name, index] of Object.entries(ACTION_VALUES)) {
    if (index === value) return name;
  }
  for (const [name, index] of Object.entries(REFUSED_ACTIONS)) {
    if (index === value) return name;
  }
  return null;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** secp256k1n / 2. Signatures with s above this are malleable and are rejected. */
export const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export function claimIntentTypes() {
  return { ClaimIntent: CLAIM_INTENT_SCHEMA.types.ClaimIntent.map((field) => ({ ...field })) };
}

export function claimIntentDomain(chainId, verifyingContract) {
  return {
    name: CLAIM_INTENT_SCHEMA.domainName,
    version: CLAIM_INTENT_SCHEMA.domainVersion,
    chainId: Number(chainId),
    verifyingContract: getAddress(verifyingContract),
  };
}

export function actionIndex(action) {
  if (isNonScalar(action)) return null;
  if (typeof action === "bigint") {
    if (action < 0n || action > 255n) return null;
    return actionIndex(Number(action));
  }
  if (typeof action === "number" && Number.isInteger(action)) {
    return nameForValue(action) === null ? null : action;
  }
  const value = valueForName(String(action ?? "").trim());
  return value === null ? null : value;
}

export function actionName(action) {
  if (isNonScalar(action)) return null;
  if (typeof action === "bigint") {
    if (action < 0n || action > 255n) return null;
    return actionName(Number(action));
  }
  if (typeof action === "number" && Number.isInteger(action)) return nameForValue(action);
  const name = String(action ?? "").trim();
  return valueForName(name) === null ? null : name;
}

function sameAddress(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function parseBytes32(value, field) {
  const text = String(value ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(text) || /^0x0{64}$/i.test(text)) {
    throw httpError(400, "invalid_bytes32", { field });
  }
  return text.toLowerCase();
}

function parseUint256(value, field) {
  if (typeof value === "bigint") {
    if (value < 0n || value >= 2n ** 256n) throw httpError(400, field);
    return value;
  }
  const text = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(text)) throw httpError(400, field);
  const parsed = BigInt(text);
  if (parsed >= 2n ** 256n) throw httpError(400, field);
  return parsed;
}

function parseDeadline(value) {
  const parsed = parseUint256(value, "invalid_deadline");
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw httpError(400, "invalid_deadline");
  return parsed;
}

/**
 * Pull the signed intent off a live claim body.
 * Domain name and version are the schema constants. chainId and verifyingContract
 * come from the client so they can be rejected before recovery.
 */
export function parseClaimIntent(body) {
  const intent = body?.intent;
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    throw httpError(400, "intent_required");
  }
  if (isNonScalar(intent.action)) {
    throw httpError(400, "action_not_claim", { field: "action", txHash: null, dryRun: false });
  }
  if (isReleaseAlias(intent.action)) {
    throw httpError(400, "release_not_relayable", { txHash: null, dryRun: false });
  }
  const action = actionName(intent.action);

  const signature = String(body.signature ?? "").trim();
  if (!isHex(signature) || signature.length < 10) throw httpError(400, "invalid_signature");

  if (!action || !Object.prototype.hasOwnProperty.call(ACTION_VALUES, action)) {
    throw httpError(400, "action_not_claim", { field: "action", txHash: null, dryRun: false });
  }
  const escrowId = parseBytes32(intent.escrowId, "escrowId");
  const senderText = String(intent.sender ?? "").trim();
  if (!isAddress(senderText) || sameAddress(senderText, ZERO_ADDRESS)) {
    throw httpError(400, "invalid_address", { field: "sender" });
  }
  const nonce = parseUint256(intent.nonce, "invalid_nonce");
  if (nonce === 0n) throw httpError(400, "invalid_nonce");
  const deadline = parseDeadline(intent.deadline);

  if (intent.chainId === undefined || intent.chainId === null || intent.chainId === "") {
    throw httpError(400, "wrong_chain");
  }
  const chainId = Number(intent.chainId);
  if (!Number.isInteger(chainId)) throw httpError(400, "wrong_chain", { chainId: intent.chainId });

  const verifyingText = String(intent.verifyingContract ?? "").trim();
  if (!isAddress(verifyingText) || sameAddress(verifyingText, ZERO_ADDRESS)) {
    throw httpError(400, "invalid_address", { field: "verifyingContract" });
  }

  return {
    action,
    actionIndex: actionIndex(action),
    escrowId,
    sender: getAddress(senderText),
    nonce,
    deadline,
    chainId,
    verifyingContract: getAddress(verifyingText),
    signature,
  };
}

/**
 * 65-byte ECDSA signatures must use low s and v in {0, 1, 27, 28}.
 * Longer signatures are left for ERC-1271 when that flag is on.
 * @returns {"ecdsa" | "other"}
 */
export function assertLowS(signature) {
  const hex = String(signature || "").toLowerCase();
  if (!/^0x[0-9a-f]{130}$/.test(hex)) return "other";
  const s = BigInt(`0x${hex.slice(66, 130)}`);
  const v = Number.parseInt(hex.slice(130, 132), 16);
  if (v !== 0 && v !== 1 && v !== 27 && v !== 28) throw httpError(400, "invalid_signature");
  if (s > SECP256K1_HALF_N) throw httpError(400, "high_s");
  return "ecdsa";
}

/**
 * Step 1. Domain chain id and verifying contract must be this relayer's escrow.
 * The retired escrow is rejected even when it is not the configured address.
 */
export function assertIntentDomain(intent, config) {
  const retired = RETIRED_SEPOLIA_ESCROWS.find((address) => sameAddress(intent.verifyingContract, address));
  if (retired || sameAddress(intent.verifyingContract, RETIRED_ESCROW)) {
    throw httpError(400, "retired_or_superseded_address", {
      address: intent.verifyingContract,
      current: config.escrowAddress,
    });
  }
  if (intent.chainId === 1 || intent.chainId === 8453) {
    throw httpError(400, "mainnet_refused", { chainId: intent.chainId });
  }
  if (intent.chainId !== config.chainId) {
    throw httpError(400, "wrong_chain", { chainId: intent.chainId });
  }
  if (!config.escrowAddress || !sameAddress(intent.verifyingContract, config.escrowAddress)) {
    throw httpError(409, "domain_mismatch", {
      escrowAddress: config.escrowAddress,
    });
  }
}

/** Step 2. deadline is in the future and no more than 300 seconds ahead. */
export function assertIntentDeadline(intent, nowMs) {
  const nowSeconds = BigInt(Math.floor(Number(nowMs) / 1000));
  if (intent.deadline <= nowSeconds) throw httpError(400, "deadline_expired");
  if (intent.deadline - nowSeconds > BigInt(DEADLINE_WINDOW_SECONDS)) {
    throw httpError(400, "deadline_too_far");
  }
}

export function typedDataFor(intent, config) {
  return {
    domain: claimIntentDomain(config.chainId, config.escrowAddress),
    types: claimIntentTypes(),
    primaryType: CLAIM_INTENT_SCHEMA.primaryType,
    message: {
      action: intent.actionIndex,
      escrowId: intent.escrowId,
      sender: intent.sender,
      nonce: intent.nonce,
      deadline: intent.deadline,
    },
  };
}

/**
 * Step 3. Recovered signer equals intent.sender.
 * ERC-1271 runs only when ERC1271_ENABLED is on, and only after ECDSA does not match.
 */
export async function assertIntentSigner(intent, config, chain) {
  const shape = assertLowS(intent.signature);
  const typed = typedDataFor(intent, config);
  let recovered = null;
  if (shape === "ecdsa") {
    try {
      recovered = await recoverTypedDataAddress({ ...typed, signature: intent.signature });
    } catch {
      recovered = null;
    }
    if (recovered && sameAddress(recovered, intent.sender)) return;
  }
  if (!config.erc1271Enabled) throw httpError(401, "invalid_signature");
  if (!chain || typeof chain.isValidSignature !== "function") throw httpError(401, "invalid_signature");
  const magic = await chain.isValidSignature(intent.sender, typed, intent.signature);
  if (magic !== true) throw httpError(401, "invalid_signature");
}

export function nonceKey(sender, nonce) {
  return `${getAddress(sender).toLowerCase()}:${nonce.toString()}`;
}
