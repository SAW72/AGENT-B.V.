import { keccak256, toBytes } from "viem";

const BLOOM_BYTES = 256;

function bloomBytes(bloom) {
  try {
    const bytes = toBytes(bloom);
    if (bytes.length !== BLOOM_BYTES) return null;
    return bytes;
  } catch {
    return null;
  }
}

function addressBytes(address) {
  try {
    const bytes = toBytes(address);
    if (bytes.length !== 20) return null;
    return bytes;
  } catch {
    return null;
  }
}

/**
 * True when the block bloom can contain logs from `address`.
 * A negative bloom proves the address is absent. A positive bloom can be a false positive.
 * @param {string} bloom
 * @param {string} address
 */
export function addressInBloom(bloom, address) {
  const bytes = bloomBytes(bloom);
  const addr = addressBytes(address);
  if (!bytes || !addr) return false;
  const hash = toBytes(keccak256(addr));
  for (let i = 0; i < 6; i += 2) {
    const bit = ((hash[i] << 8) | hash[i + 1]) & 2047;
    const byteIndex = BLOOM_BYTES - 1 - Math.floor(bit / 8);
    const mask = 1 << (bit % 8);
    if ((bytes[byteIndex] & mask) === 0) return false;
  }
  return true;
}

/**
 * Receipts are required when the bloom is missing or either watched address may be present.
 * @param {string} bloom
 * @param {string[]} addresses
 */
export function bloomNeedsReceipts(bloom, addresses) {
  if (bloomBytes(bloom) == null) return true;
  return addresses.some((address) => addressInBloom(bloom, address));
}

/** Build a bloom that contains exactly the given addresses. Tests use this. */
export function bloomForAddresses(addresses) {
  const bloom = new Uint8Array(BLOOM_BYTES);
  for (const address of addresses) {
    const addr = addressBytes(address);
    if (!addr) throw new Error("bloom address must be 20 bytes");
    const hash = toBytes(keccak256(addr));
    for (let i = 0; i < 6; i += 2) {
      const bit = ((hash[i] << 8) | hash[i + 1]) & 2047;
      const byteIndex = BLOOM_BYTES - 1 - Math.floor(bit / 8);
      bloom[byteIndex] |= 1 << (bit % 8);
    }
  }
  return `0x${Buffer.from(bloom).toString("hex")}`;
}

function lower(value) {
  return String(value ?? "").toLowerCase();
}

function asInt(value) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return Number.isInteger(value) ? value : NaN;
  if (typeof value === "string" && value.trim() !== "") {
    try {
      const parsed = BigInt(value);
      const asNumber = Number(parsed);
      if (!Number.isSafeInteger(asNumber) || BigInt(asNumber) !== parsed) return NaN;
      return asNumber;
    } catch {
      return NaN;
    }
  }
  return NaN;
}

export function logIdentity(log) {
  const topics = Array.isArray(log?.topics) ? log.topics.map(lower).join(",") : "";
  return [
    lower(log?.address),
    lower(log?.transactionHash),
    String(asInt(log?.logIndex)),
    lower(log?.blockHash),
    topics,
    lower(log?.data),
  ].join("|");
}

function sameIds(left, right) {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((id, index) => id === b[index]);
}

/**
 * Decide whether a scanned window matches the headers and receipts.
 * `blocks` is a Map of block number to `{ hash, logsBloom, transactions, receipts }`.
 * `receipts` is null when the bloom proves neither watched address is in the block.
 * @returns {{ ok: true } | { ok: false, reason: "unverifiable_log" | "logs_incomplete" | "logs_unverified" }}
 */
export function reconcileWindow({ fromBlock, toBlock, logs, blocks, addresses }) {
  if (!Array.isArray(logs)) return { ok: false, reason: "unverifiable_log" };
  if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock) || toBlock < fromBlock) {
    return { ok: false, reason: "logs_unverified" };
  }
  const watched = addresses.map(lower);
  const byBlock = new Map();
  for (const log of logs) {
    if (!log || typeof log !== "object") return { ok: false, reason: "unverifiable_log" };
    if (log.removed === true) return { ok: false, reason: "logs_unverified" };
    const blockNumber = asInt(log.blockNumber);
    if (!Number.isInteger(blockNumber) || blockNumber < fromBlock || blockNumber > toBlock) {
      return { ok: false, reason: "logs_unverified" };
    }
    if (!watched.includes(lower(log.address))) return { ok: false, reason: "logs_unverified" };
    const list = byBlock.get(blockNumber) ?? [];
    list.push(log);
    byBlock.set(blockNumber, list);
  }

  for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1) {
    const block = blocks.get(blockNumber);
    if (!block || typeof block.hash !== "string" || block.hash === "") {
      return { ok: false, reason: "logs_unverified" };
    }
    const scanned = byBlock.get(blockNumber) ?? [];
    for (const log of scanned) {
      if (lower(log.blockHash) !== lower(block.hash)) return { ok: false, reason: "logs_unverified" };
    }
    if (!bloomNeedsReceipts(block.logsBloom, watched)) {
      if (scanned.length > 0) return { ok: false, reason: "logs_incomplete" };
      continue;
    }
    if (!Array.isArray(block.receipts) || !Array.isArray(block.transactions)) {
      return { ok: false, reason: "logs_unverified" };
    }
    const wantTx = block.transactions.map(lower);
    const gotTx = block.receipts.map((receipt) => lower(receipt?.transactionHash));
    if (!sameIds(wantTx, gotTx)) return { ok: false, reason: "logs_unverified" };
    const expected = [];
    for (const receipt of block.receipts) {
      if (!receipt || lower(receipt.blockHash) !== lower(block.hash)) {
        return { ok: false, reason: "logs_unverified" };
      }
      if (!Array.isArray(receipt.logs)) return { ok: false, reason: "logs_unverified" };
      for (const log of receipt.logs) {
        if (watched.includes(lower(log?.address))) expected.push(log);
      }
    }
    if (!sameIds(scanned.map(logIdentity), expected.map(logIdentity))) {
      return { ok: false, reason: "logs_incomplete" };
    }
  }
  return { ok: true };
}
