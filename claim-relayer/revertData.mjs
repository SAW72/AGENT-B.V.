/**
 * Pull raw revert bytes off a broadcast failure.
 * Only a validated hex string is returned. Messages, stacks, URLs, and request
 * bodies are ignored. Missing, empty, odd-length, non-hex, or oversized data
 * is null. Oversized data is not truncated.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Wallet-facing meanings for contract reverts the relayer may surface in
 * `revert_data`. `dispute` itself is not relayed. `DisputeVotesCast` is the
 * retained selector. Filing opens the panel case in the same transaction.
 * Votes cast on another case are not read.
 */
export const REVERT_COPY = JSON.parse(
  readFileSync(fileURLToPath(new URL("./revertCopy.json", import.meta.url)), "utf8"),
);

export function contractRevertCopy(revertData) {
  if (typeof revertData !== "string") return null;
  const selector = revertData.toLowerCase().slice(0, 10);
  for (const [name, entry] of Object.entries(REVERT_COPY)) {
    if (entry?.selector === selector) return { name, selector: entry.selector, meaning: entry.meaning };
  }
  return null;
}

/** BotAttestationEscrow.RulingPending() */
export const RULING_PENDING_SELECTOR = "0x3a0621bd";

const HEX_RE = /^0x[0-9a-fA-F]*$/;

export function isRulingPending(revertData) {
  return typeof revertData === "string" && revertData.toLowerCase().startsWith(RULING_PENDING_SELECTOR);
}

/** 4 KiB of revert bytes. Custom errors are a selector plus a few words. */
export const MAX_REVERT_DATA_BYTES = 4096;

const MAX_WALK_NODES = 32;
const MAX_DATA_DEPTH = 4;

/**
 * @param {unknown} value
 * @returns {string | null} lowercase `0x` hex, or null
 */
export function sanitizeRevertData(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!HEX_RE.test(text)) return null;
  const digits = text.length - 2;
  if (digits === 0 || digits % 2 !== 0) return null;
  if (digits / 2 > MAX_REVERT_DATA_BYTES) return null;
  return text.toLowerCase();
}

function hexFromDataField(data, depth) {
  if (depth > MAX_DATA_DEPTH) return null;
  const direct = sanitizeRevertData(data);
  if (direct) return direct;
  if (data && typeof data === "object" && !Array.isArray(data) && "data" in data) {
    return hexFromDataField(data.data, depth + 1);
  }
  return null;
}

function candidateFrom(node) {
  if (!node || typeof node !== "object") return null;
  const raw = sanitizeRevertData(node.raw);
  if (raw) return raw;
  if ("data" in node) return hexFromDataField(node.data, 0);
  return null;
}

function leaksKey(hex, key) {
  const raw = String(key || "").trim();
  if (!raw) return false;
  const bare = (raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw).toLowerCase();
  if (!bare) return false;
  return hex.includes(bare);
}

/**
 * Walk `cause`, `error`, and `info.error` the way viem and ethers nest RPC
 * failures. The deepest valid hex wins (`raw`, then `data`, then `data.data`).
 * @param {unknown} err
 * @param {string} [privateKey] when set, a payload that contains the key is null
 * @returns {string | null}
 */
export function extractRevertData(err, privateKey) {
  try {
    const seen = new Set();
    let found = null;
    let nodes = 0;

    function visit(node) {
      if (!node || typeof node !== "object" || seen.has(node) || nodes >= MAX_WALK_NODES) return;
      seen.add(node);
      nodes += 1;
      const candidate = candidateFrom(node);
      if (candidate) found = candidate;
      if (typeof node.walk === "function") {
        try {
          const deepest = node.walk();
          if (deepest && deepest !== node) visit(deepest);
        } catch {
          /* a walk failure is not revert data */
        }
      }
      if ("cause" in node) visit(node.cause);
      if (node.error && typeof node.error === "object") visit(node.error);
      if (node.info && typeof node.info === "object") {
        visit(node.info);
        if (node.info.error && typeof node.info.error === "object") visit(node.info.error);
      }
    }

    visit(err);
    if (!found || leaksKey(found, privateKey)) return null;
    return found;
  } catch {
    return null;
  }
}

/**
 * Prefer an already attached `revert_data`, then search the error tree.
 * @param {unknown} err
 * @param {string} [privateKey]
 * @returns {string | null}
 */
export function revertDataFrom(err, privateKey) {
  if (err && typeof err === "object" && "revert_data" in err) {
    const attached = sanitizeRevertData(err.revert_data);
    if (attached && !leaksKey(attached, privateKey)) return attached;
  }
  return extractRevertData(err, privateKey);
}
