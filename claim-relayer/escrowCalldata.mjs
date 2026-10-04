import { keccak_256 } from "@noble/hashes/sha3";
import { httpError } from "./config.mjs";

/**
 * Canonical signatures for BotAttestationEscrow external claim calls.
 * Selectors are keccak256(signature)[0:4], not hand-written.
 * createEscrow is payable: msg.value is valueWei, not an ABI argument.
 * Solidity `30 days` is 2_592_000 seconds (`durationSeconds > 30 days` reverts).
 */
export const ESCROW_SIGNATURES = {
  createEscrow: "createEscrow(bytes32,address,bytes32,bytes32,uint256)",
  release: "release(bytes32)",
  refund: "refund(bytes32)",
  dispute: "dispute(bytes32,bytes32,string)",
};

/** Public getters. `owner()` is inherited from OpenZeppelin Ownable. */
export const ESCROW_VIEW_SIGNATURES = {
  owner: "owner()",
  governance: "governance()",
  disputePanel: "disputePanel()",
  denylist: "denylist()",
  vault: "vault()",
  lockedValue: "lockedValue()",
};

/** `uint256 public arbitratorCount` on DisputePanel. */
export const PANEL_VIEW_SIGNATURES = {
  arbitratorCount: "arbitratorCount()",
};

export const MAX_DURATION_SECONDS = 2_592_000n;

const CLAIM_ACTIONS = new Set(Object.keys(ESCROW_SIGNATURES));

/**
 * Who the contract accepts as msg.sender.
 * release is not relayable. While Open, only the payer stored at createEscrow
 * may call it. After the linked case is resolved and upheld, the payer or the
 * payee may. The relayer key is neither, so a relayed release reverts.
 */
const SENDER_CONSTRAINT = {
  createEscrow: "vault_operator_must_send",
  release: "payer_while_open",
  refund: "permissionless",
  dispute: "party_must_send",
};

/** Signature, selector, and sender constraint for an allowlisted claim action. */
export function claimActionMeta(action) {
  const name = String(action || "").trim();
  if (!CLAIM_ACTIONS.has(name)) throw httpError(400, "action_not_claim", { field: "action" });
  const signature = ESCROW_SIGNATURES[name];
  return {
    action: name,
    signature,
    selector: selectorFor(signature),
    senderConstraint: SENDER_CONSTRAINT[name],
  };
}

export function selectorFor(signature) {
  const hash = keccak_256(new TextEncoder().encode(signature));
  return "0x" + Buffer.from(hash.subarray(0, 4)).toString("hex");
}

export function encodeWords(signature, words) {
  return selectorFor(signature) + words.join("");
}

function bytes32Word(value, field) {
  const text = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(text) || /^0x0{64}$/i.test(text)) {
    throw httpError(400, "invalid_bytes32", { field });
  }
  return text.slice(2).toLowerCase();
}

function addressWord(value, field) {
  const text = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(text) || /^0x0{40}$/i.test(text)) {
    throw httpError(400, "invalid_address", { field });
  }
  return text.slice(2).toLowerCase().padStart(64, "0");
}

function parseUint(value, field) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw httpError(400, "invalid_uint", { field });
  }
  if (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string") {
    throw httpError(400, "invalid_uint", { field });
  }
  const text = typeof value === "bigint" ? value.toString() : String(value).trim();
  if (!/^[0-9]+$/.test(text)) throw httpError(400, "invalid_uint", { field });
  const parsed = BigInt(text);
  if (parsed >= 2n ** 256n) throw httpError(400, "invalid_uint", { field });
  return parsed;
}

function uintWord(value) {
  return value.toString(16).padStart(64, "0");
}

/** ABI tail for a dynamic string: offset is written by the caller. Length is UTF-8 bytes, capped at 256. */
function reasonTail(value, field = "reason") {
  if (typeof value !== "string") throw httpError(400, "invalid_reason", { field });
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 256) throw httpError(400, "reason_too_long", { field });
  const padded = Buffer.alloc(Math.ceil(bytes.length / 32) * 32);
  bytes.copy(padded);
  return uintWord(BigInt(bytes.length)) + padded.toString("hex");
}

function escrowIdWord(body) {
  if (body.escrowId !== undefined && body.escrowId !== null && String(body.escrowId).trim() !== "") {
    return bytes32Word(body.escrowId, "escrowId");
  }
  return bytes32Word(body.claimId, "claimId");
}

function assertNoValue(body) {
  if (body.amountWei !== undefined && body.amountWei !== null && String(body.amountWei).trim() !== "") {
    throw httpError(400, "value_not_allowed");
  }
}

/**
 * Encode one claim-flow call. Does not sign and does not broadcast.
 * Governance setters (setDenylist, setVault, setDisputePanel) are refused.
 */
export function encodeEscrowAction(body) {
  const action = String(body.action || "").trim();
  if (!CLAIM_ACTIONS.has(action)) throw httpError(400, "action_not_claim", { field: "action" });
  const signature = ESCROW_SIGNATURES[action];

  if (action === "createEscrow") {
    const durationValue = parseUint(body.durationSeconds, "durationSeconds");
    if (durationValue < 1n || durationValue > MAX_DURATION_SECONDS) {
      throw httpError(400, "invalid_duration", { field: "durationSeconds" });
    }
    if (body.amountWei === undefined || body.amountWei === null || String(body.amountWei).trim() === "") {
      throw httpError(400, "invalid_amount");
    }
    const value = parseUint(body.amountWei, "amountWei");
    if (value === 0n) throw httpError(400, "invalid_amount");
    const words = [
      escrowIdWord(body),
      addressWord(body.payee, "payee"),
      bytes32Word(body.payerBotId, "payerBotId"),
      bytes32Word(body.payeeBotId, "payeeBotId"),
      uintWord(durationValue),
    ];
    if (words[2] === words[3]) throw httpError(400, "invalid_parties");
    return {
      action,
      signature,
      selector: selectorFor(signature),
      calldata: encodeWords(signature, words),
      valueWei: value.toString(),
      stateMutability: "payable",
      senderConstraint: SENDER_CONSTRAINT.createEscrow,
    };
  }

  if (action === "dispute") {
    assertNoValue(body);
    if (body.reason === undefined || body.reason === null) throw httpError(400, "invalid_reason", { field: "reason" });
    const words = [
      escrowIdWord(body),
      bytes32Word(body.disputeId, "disputeId"),
      uintWord(96n),
      reasonTail(body.reason, "reason"),
    ];
    return {
      action,
      signature,
      selector: selectorFor(signature),
      calldata: encodeWords(signature, words),
      valueWei: "0",
      stateMutability: "nonpayable",
      senderConstraint: SENDER_CONSTRAINT.dispute,
    };
  }

  assertNoValue(body);
  const words = [escrowIdWord(body)];
  return {
    action,
    signature,
    selector: selectorFor(signature),
    calldata: encodeWords(signature, words),
    valueWei: "0",
    stateMutability: "nonpayable",
    senderConstraint: SENDER_CONSTRAINT[action],
  };
}

/** Pull `function name(type arg, ...)` out of the Solidity source and canonicalize it. */
export function externalSignatureFromSource(source, name) {
  const match = source.match(new RegExp(`function\\s+${name}\\s*\\(([^)]*)\\)`));
  if (!match) return null;
  const types = match[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(/\s+/)[0]);
  return `${name}(${types.join(",")})`;
}
