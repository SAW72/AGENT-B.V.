import { keccak256, toBytes } from "viem";

const BLOOM_BYTES = 256;

export type WindowLog = {
  address?: string;
  topics?: unknown;
  data?: string;
  blockHash?: string;
  blockNumber?: unknown;
  transactionHash?: string;
  logIndex?: unknown;
  removed?: boolean;
};

export type WindowBlock = {
  hash?: string;
  logsBloom?: string;
  transactions?: unknown[] | null;
  receipts?: unknown[] | null;
};

function bloomBytes(bloom: string) {
  try {
    const bytes = toBytes(bloom as `0x${string}`);
    if (bytes.length !== BLOOM_BYTES) return null;
    return bytes;
  } catch {
    return null;
  }
}

function addressBytes(address: string) {
  try {
    const bytes = toBytes(address as `0x${string}`);
    if (bytes.length !== 20) return null;
    return bytes;
  } catch {
    return null;
  }
}

/** True when the block bloom can contain logs from `address`. A negative bloom proves the address is absent. */
export function addressInBloom(bloom: string, address: string) {
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

/** Receipts are required when the bloom is missing or either watched address may be present. */
export function bloomNeedsReceipts(bloom: string, addresses: string[]) {
  if (bloomBytes(bloom) == null) return true;
  return addresses.some((address) => addressInBloom(bloom, address));
}

/** Build a bloom that contains exactly the given addresses. Tests use this. */
export function bloomForAddresses(addresses: string[]) {
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
  let hex = "";
  for (const byte of bloom) hex += byte.toString(16).padStart(2, "0");
  return `0x${hex}`;
}

function lower(value: unknown) {
  return String(value ?? "").toLowerCase();
}

function asInt(value: unknown) {
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

export function logIdentity(log: WindowLog) {
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

function sameIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((id, index) => id === b[index]);
}

/**
 * Decide whether a scanned window matches the headers and receipts.
 * A removed log is checked against the header hash and then left out of the
 * receipt comparison. This worker already records that flag as an anomaly
 * instead of refusing the window.
 */
export function reconcileWindow(input: {
  fromBlock: number;
  toBlock: number;
  logs: unknown;
  blocks: Map<number, WindowBlock>;
  addresses: string[];
}): { ok: true } | { ok: false; reason: "unverifiable_log" | "logs_incomplete" | "logs_unverified" } {
  const { fromBlock, toBlock, logs, blocks, addresses } = input;
  if (!Array.isArray(logs)) return { ok: false, reason: "unverifiable_log" };
  if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock) || toBlock < fromBlock) {
    return { ok: false, reason: "logs_unverified" };
  }
  const watched = addresses.map(lower);
  const byBlock = new Map<number, WindowLog[]>();
  const removed: WindowLog[] = [];
  for (const log of logs as WindowLog[]) {
    if (!log || typeof log !== "object") return { ok: false, reason: "unverifiable_log" };
    const blockNumber = asInt(log.blockNumber);
    if (!Number.isInteger(blockNumber) || blockNumber < fromBlock || blockNumber > toBlock) {
      return { ok: false, reason: "logs_unverified" };
    }
    if (!watched.includes(lower(log.address))) return { ok: false, reason: "logs_unverified" };
    if (log.removed === true) {
      removed.push(log);
      continue;
    }
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
    for (const log of removed) {
      if (asInt(log.blockNumber) !== blockNumber) continue;
      if (lower(log.blockHash) !== lower(block.hash)) return { ok: false, reason: "logs_unverified" };
    }
    if (!bloomNeedsReceipts(block.logsBloom ?? "", watched)) {
      if (scanned.length > 0) return { ok: false, reason: "logs_incomplete" };
      continue;
    }
    if (!Array.isArray(block.receipts) || !Array.isArray(block.transactions)) {
      return { ok: false, reason: "logs_unverified" };
    }
    const wantTx = block.transactions.map(lower);
    const gotTx = block.receipts.map((receipt) => lower((receipt as { transactionHash?: unknown })?.transactionHash));
    if (!sameIds(wantTx, gotTx)) return { ok: false, reason: "logs_unverified" };
    const expected: WindowLog[] = [];
    for (const receipt of block.receipts) {
      const row = receipt as { blockHash?: unknown; logs?: unknown };
      if (!row || lower(row.blockHash) !== lower(block.hash)) {
        return { ok: false, reason: "logs_unverified" };
      }
      if (!Array.isArray(row.logs)) return { ok: false, reason: "logs_unverified" };
      for (const log of row.logs as WindowLog[]) {
        if (log?.removed === true) continue;
        if (watched.includes(lower(log?.address))) expected.push(log);
      }
    }
    if (!sameIds(scanned.map(logIdentity), expected.map(logIdentity))) {
      return { ok: false, reason: "logs_incomplete" };
    }
  }
  return { ok: true };
}
