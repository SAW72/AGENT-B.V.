import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeSanctionsAddress } from "./sanctions.mjs";
import { sha256Utf8 } from "./sha256.mjs";

const ALLOWED = new Set([
  "event",
  "ts",
  "claimId",
  "payer",
  "payee",
  "amountWei",
  "fixture",
  "mode",
  "expiresAt",
  "chainId",
  "escrowBooked",
  "escrowAddress",
  "escrowSource",
  "relayerAddress",
  "relayerNonce",
  "txHash",
  "reason",
  "error",
  "attempt",
  "attempts",
  "ok",
  "killSwitch",
  "status",
  "field",
  "action",
  "signature",
  "selector",
  "calldata",
  "valueWei",
  "dryRun",
  "calldataStatus",
  "senderConstraint",
  "senderNote",
  "blockers",
]);

/**
 * Keep an allowlisted flat record. Nested objects and secret-shaped strings
 * are dropped so a request body cannot land a key in the JSONL file.
 */
export function sanitizeLogRecord(record) {
  const out = {};
  if (!record || typeof record !== "object") return out;
  for (const key of ALLOWED) {
    if (record[key] === undefined) continue;
    const value = record[key];
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      out[key] = value;
      continue;
    }
    if (typeof value === "bigint") {
      out[key] = value.toString();
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      out[key] = value.join(",");
      continue;
    }
    if (typeof value === "string") {
      if (key === "payer" || key === "payee") {
        const normalized = normalizeSanctionsAddress(value);
        if (!normalized) continue;
        out[key] = sha256Utf8(normalized);
        continue;
      }
      if (/private[_-]?key|secret|mnemonic|seed phrase/i.test(value)) continue;
      const limit = key === "calldata" ? 4096 : 300;
      out[key] = value.slice(0, limit);
    }
  }
  return out;
}

/**
 * Append-only JSONL. filePath comes from CLAIM_LOG_PATH.
 * @param {{ filePath?: string, now?: () => number }} [opts]
 */
export function createClaimLog(opts = {}) {
  const filePath = opts.filePath || "./data/claims.jsonl";
  const now = opts.now || Date.now;
  let ready = null;

  async function ensureDir() {
    if (!ready) ready = mkdir(dirname(filePath), { recursive: true });
    await ready;
  }

  async function append(event) {
    await ensureDir();
    const record = sanitizeLogRecord({
      ts: new Date(now()).toISOString(),
      ...event,
    });
    await appendFile(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return record;
  }

  return { append, filePath, sanitizeLogRecord };
}
