import { decodeEventLog, type Abi } from "viem";
import escrowAbi from "../../../../apps/wallet-ux/src/abi/BotAttestationEscrow.json";
import panelAbi from "../../../../apps/wallet-ux/src/abi/DisputePanel.json";
import { ESCROW, PANEL } from "../../src/constants.mjs";
import { PointsError } from "../../src/hex.mjs";
import { bloomNeedsReceipts, reconcileWindow, type WindowBlock } from "./logWindow";
import { RPC_TIMEOUT_MS, scanErrorClass } from "./pace";

export const SUBREQUEST_BUDGET = 45;

export class BudgetExceeded extends Error {
  constructor() {
    super("subrequest_budget");
    this.name = "BudgetExceeded";
  }
}

export function createSubrequestMeter(max = SUBREQUEST_BUDGET) {
  let used = 0;
  return {
    get used() {
      return used;
    },
    charge() {
      if (used >= max) throw new BudgetExceeded();
      used += 1;
    },
  };
}

const URL_PATTERN = /https?:\/\/\S+/gi;

const HEX_RUN = /0x[0-9a-f]{40,}/gi;
const BARE_ADDRESS = /(?<![0-9a-f])[0-9a-f]{40,}/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}/gi;
const SENSITIVE_HEADER = /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|hmac|cf-connecting-ip)\b[^,\n}]*/gi;

export function redact(text: string, rpcUrl?: string) {
  let out = String(text ?? "");
  if (rpcUrl) out = out.split(String(rpcUrl)).join("[redacted-url]");
  return out.replace(URL_PATTERN, "[redacted-url]");
}

/** Strip client addresses, header secrets, and RPC URLs before a console line. */
export function publicDetail(text: string, rpcUrl?: string) {
  return redact(text, rpcUrl)
    .replace(SENSITIVE_HEADER, "[redacted]")
    .replace(HEX_RUN, "[redacted]")
    .replace(BARE_ADDRESS, "[redacted]")
    .replace(IPV4, "[redacted]")
    .replace(IPV6, "[redacted]");
}

export class RpcError extends Error {
  status: number | null;
  code: number | null;
  details: string;
  shortMessage: string;
  headers: Headers | null;
  kind: "timeout" | null;

  constructor(message: string, fields: { status?: number | null; code?: number | null; details?: string; headers?: Headers | null; kind?: "timeout" | null } = {}) {
    super(message);
    this.name = "RpcError";
    this.status = fields.status ?? null;
    this.code = fields.code ?? null;
    this.details = fields.details ?? "";
    this.shortMessage = this.details;
    this.headers = fields.headers ?? null;
    this.kind = fields.kind ?? null;
  }
}

function hexQuantity(value: number) {
  return `0x${value.toString(16)}`;
}

export function hexToInt(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  const text = String(value ?? "").trim();
  if (/^0x[0-9a-f]+$/i.test(text)) {
    const parsed = Number.parseInt(text, 16);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (/^[0-9]+$/.test(text)) {
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

async function postJson(
  url: string,
  body: unknown,
  fetchImpl: typeof fetch,
  meter?: { charge(): void },
) {
  meter?.charge();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new RpcError("rpc_timeout", { details: "timeout", kind: "timeout" });
    }
    throw error;
  }
  if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
    throw new RpcError("rpc_http", { status: response.status, headers: response.headers, details: response.statusText });
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new RpcError("rpc_http", { status: response.status, headers: response.headers, details: "bad_json" });
  }
  return { response, parsed };
}

function asRecord(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

export async function rpcCall(
  url: string,
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch = fetch,
  meter?: { charge(): void },
) {
  const { response, parsed } = await postJson(url, { jsonrpc: "2.0", id: 1, method, params }, fetchImpl, meter);
  const record = asRecord(parsed);
  const error = asRecord(record?.error);
  if (error) {
    const code = typeof error.code === "number" ? error.code : null;
    const details = typeof error.message === "string" ? error.message : "";
    throw new RpcError("rpc_error", { status: response.status, code, details, headers: response.headers });
  }
  return record?.result;
}

export function decodeKnownLog(log: { address?: string; topics?: string[]; data?: string }) {
  const address = String(log.address ?? "").toLowerCase();
  const abi = (address === ESCROW ? escrowAbi : panelAbi) as Abi;
  try {
    return decodeEventLog({
      abi,
      data: (log.data ?? "0x") as `0x${string}`,
      topics: (log.topics ?? []) as [signature: `0x${string}`, ...`0x${string}`[]],
    });
  } catch {
    return null;
  }
}

export type RpcLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  blockHash: string;
  blockTimestamp: number;
  transactionHash: string;
  logIndex: number;
  removed: boolean;
  transactionFrom: string | null;
  decoded: boolean;
};

type RawLog = Record<string, unknown>;

function normalizeRpcLog(raw: RawLog, timestamp: number | null): RpcLog | null {
  const blockNumber = hexToInt(raw.blockNumber);
  const logIndex = hexToInt(raw.logIndex);
  const blockTimestamp = timestamp ?? hexToInt(raw.blockTimestamp);
  if (blockNumber == null || logIndex == null || blockTimestamp == null) return null;
  const topics = Array.isArray(raw.topics) ? raw.topics.map((topic) => String(topic)) : [];
  const log = {
    address: String(raw.address ?? ""),
    topics,
    data: String(raw.data ?? "0x"),
    blockNumber,
    blockHash: String(raw.blockHash ?? ""),
    blockTimestamp,
    transactionHash: String(raw.transactionHash ?? ""),
    logIndex,
    removed: raw.removed === true,
    transactionFrom: raw.transactionFrom ? String(raw.transactionFrom) : null,
  };
  const decoded = decodeKnownLog(log);
  return { ...log, decoded: decoded != null };
}

function emptyCode(code: unknown) {
  const text = String(code ?? "").trim().toLowerCase();
  return text === "" || text === "0x" || /^0x0+$/.test(text);
}

export function createRpc(url: string, fetchImpl: typeof fetch = fetch, meter?: { charge(): void }) {
  return {
    async chainId() {
      return hexToInt(await rpcCall(url, "eth_chainId", [], fetchImpl, meter));
    },
    async getCode(address: string) {
      const code = await rpcCall(url, "eth_getCode", [address, "latest"], fetchImpl, meter);
      if (emptyCode(code)) throw new Error(`contract code is empty for ${address}`);
      return code;
    },
    async finalizedBlock() {
      const result = asRecord(await rpcCall(url, "eth_getBlockByNumber", ["finalized", false], fetchImpl, meter));
      if (!result) return null;
      const number = hexToInt(result.number);
      if (number == null) return null;
      return { number, timestamp: hexToInt(result.timestamp) };
    },
    async latestBlock() {
      const result = asRecord(await rpcCall(url, "eth_getBlockByNumber", ["latest", false], fetchImpl, meter));
      if (!result) return null;
      const number = hexToInt(result.number);
      if (number == null) return null;
      return { number, timestamp: hexToInt(result.timestamp) };
    },
    async getLogs(fromBlock: number, toBlock: number) {
      const result = await rpcCall(url, "eth_getLogs", [{
        fromBlock: hexQuantity(fromBlock),
        toBlock: hexQuantity(toBlock),
        address: [ESCROW, PANEL],
      }], fetchImpl, meter);
      if (!Array.isArray(result)) throw new PointsError("unverifiable_log");
      const rows = result.map((row) => asRecord(row)).filter((row): row is RawLog => row != null);
      const allowed = new Set([ESCROW.toLowerCase(), PANEL.toLowerCase()]);
      for (const row of rows) {
        const block = hexToInt(row.blockNumber);
        const address = String(row.address ?? "").toLowerCase();
        if (block == null || block < fromBlock || block > toBlock || !allowed.has(address)) {
          throw new RpcError("log_outside_request", { details: "log outside requested range" });
        }
      }
      const missing = new Set<number>();
      for (const row of rows) {
        if (hexToInt(row.blockTimestamp) == null) {
          const block = hexToInt(row.blockNumber);
          if (block != null) missing.add(block);
        }
      }
      const timestamps = new Map<number, number>();
      if (missing.size > 0) {
        const calls = [...missing].map((block, index) => ({
          jsonrpc: "2.0",
          id: index + 1,
          method: "eth_getBlockByNumber",
          params: [hexQuantity(block), false],
        }));
        const { response, parsed } = await postJson(url, calls, fetchImpl, meter);
        const batch = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of batch) {
          const record = asRecord(item);
          const error = asRecord(record?.error);
          if (error) {
            const code = typeof error.code === "number" ? error.code : null;
            throw new RpcError("rpc_error", {
              status: response.status,
              code,
              details: typeof error.message === "string" ? error.message : "",
              headers: response.headers,
            });
          }
          const block = asRecord(record?.result);
          const number = hexToInt(block?.number);
          const timestamp = hexToInt(block?.timestamp);
          if (number != null && timestamp != null) timestamps.set(number, timestamp);
        }
      }
      const logs: RpcLog[] = [];
      for (const row of rows) {
        const block = hexToInt(row.blockNumber);
        const stamped = normalizeRpcLog(row, block == null ? null : timestamps.get(block) ?? null);
        if (!stamped) throw new PointsError("unverifiable_log");
        logs.push(stamped);
      }
      return logs;
    },
    /**
     * One subrequest for the log window, its headers, and its receipts.
     * A non-array log result does not count as an empty window.
     */
    async readWindow(fromBlock: number, toBlock: number): Promise<
      | { ok: true; logs: RpcLog[] }
      | { ok: false; reason: "unverifiable_log" | "logs_incomplete" | "logs_unverified" }
    > {
      const calls: { jsonrpc: string; id: number; method: string; params: unknown[] }[] = [{
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getLogs",
        params: [{
          fromBlock: hexQuantity(fromBlock),
          toBlock: hexQuantity(toBlock),
          address: [ESCROW, PANEL],
        }],
      }];
      const headerIds = new Map<number, number>();
      const receiptIds = new Map<number, number>();
      let nextId = 2;
      for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1) {
        headerIds.set(blockNumber, nextId);
        calls.push({
          jsonrpc: "2.0",
          id: nextId,
          method: "eth_getBlockByNumber",
          params: [hexQuantity(blockNumber), true],
        });
        nextId += 1;
        receiptIds.set(blockNumber, nextId);
        calls.push({
          jsonrpc: "2.0",
          id: nextId,
          method: "eth_getBlockReceipts",
          params: [hexQuantity(blockNumber)],
        });
        nextId += 1;
      }
      const { response, parsed } = await postJson(url, calls, fetchImpl, meter);
      if (!Array.isArray(parsed)) {
        const record = asRecord(parsed);
        const error = asRecord(record?.error);
        if (error || response.status !== 200) {
          throw rpcFailure(response, error, response.status);
        }
        return { ok: false, reason: "unverifiable_log" };
      }
      const logsItem = batchItem(parsed, 1);
      const logsError = asRecord(logsItem?.error);
      if (logsError) throw rpcFailure(response, logsError, response.status);
      if (!Array.isArray(logsItem?.result)) return { ok: false, reason: "unverifiable_log" };
      const rows = logsItem.result.map((row) => asRecord(row)).filter((row): row is RawLog => row != null);
      const allowed = new Set([ESCROW.toLowerCase(), PANEL.toLowerCase()]);
      for (const row of rows) {
        const block = hexToInt(row.blockNumber);
        const address = String(row.address ?? "").toLowerCase();
        if (block == null || block < fromBlock || block > toBlock || !allowed.has(address)) {
          throw new RpcError("log_outside_request", { details: "log outside requested range" });
        }
      }
      const watched = [ESCROW, PANEL];
      const timestamps = new Map<number, number>();
      const blocks = new Map<number, WindowBlock>();
      const fallbackBlocks: number[] = [];
      for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1) {
        const headerItem = batchItem(parsed, headerIds.get(blockNumber) ?? 0);
        const headerError = asRecord(headerItem?.error);
        if (headerError) {
          const failure = rpcFailure(response, headerError, response.status);
          if (scanErrorClass(failure)) throw failure;
          return { ok: false, reason: "logs_unverified" };
        }
        const header = asRecord(headerItem?.result);
        const hash = typeof header?.hash === "string" ? header.hash : "";
        const logsBloom = typeof header?.logsBloom === "string" ? header.logsBloom : "";
        const transactions = transactionHashes(header?.transactions);
        const timestamp = hexToInt(header?.timestamp);
        if (timestamp != null) timestamps.set(blockNumber, timestamp);
        const receiptItem = batchItem(parsed, receiptIds.get(blockNumber) ?? 0);
        const receiptError = asRecord(receiptItem?.error);
        let receipts: unknown[] | null = null;
        let missingMethod = false;
        if (receiptError) {
          const failure = rpcFailure(response, receiptError, response.status);
          if (failure.code === -32601) missingMethod = true;
          else if (scanErrorClass(failure)) throw failure;
          else if (bloomNeedsReceipts(logsBloom, watched)) return { ok: false, reason: "logs_unverified" };
        } else if (Array.isArray(receiptItem?.result)) {
          receipts = receiptItem.result;
        } else if (bloomNeedsReceipts(logsBloom, watched)) {
          return { ok: false, reason: "logs_unverified" };
        }
        if (missingMethod && bloomNeedsReceipts(logsBloom, watched)) fallbackBlocks.push(blockNumber);
        blocks.set(blockNumber, { hash, logsBloom, transactions, receipts: missingMethod ? null : receipts });
      }
      if (fallbackBlocks.length > 0) {
        const loaded = await loadReceiptFallback(url, fetchImpl, meter, fallbackBlocks, blocks);
        if (!loaded.ok) return loaded;
      }
      const logs: RpcLog[] = [];
      for (const row of rows) {
        const block = hexToInt(row.blockNumber);
        const stamped = normalizeRpcLog(row, block == null ? null : timestamps.get(block) ?? null);
        if (!stamped) throw new PointsError("unverifiable_log");
        logs.push(stamped);
      }
      const confirmed = reconcileWindow({ fromBlock, toBlock, logs, blocks, addresses: watched });
      if (!confirmed.ok) return confirmed;
      return { ok: true, logs };
    },
  };
}

function batchItem(parsed: unknown[], id: number) {
  for (const item of parsed) {
    const record = asRecord(item);
    if (Number(record?.id) === id) return record;
  }
  return null;
}

function rpcFailure(response: Response, error: Record<string, unknown> | null, status: number) {
  const code = typeof error?.code === "number" ? error.code : (status !== 200 ? status : null);
  const details = typeof error?.message === "string" ? error.message : "";
  return new RpcError("rpc_error", { status, code, details, headers: response.headers });
}

function transactionHashes(transactions: unknown) {
  if (!Array.isArray(transactions)) return null;
  const hashes: string[] = [];
  for (const tx of transactions) {
    if (typeof tx === "string") hashes.push(tx);
    else if (tx && typeof tx === "object" && "hash" in tx) hashes.push(String((tx as { hash: unknown }).hash));
    else return null;
  }
  return hashes;
}

async function loadReceiptFallback(
  url: string,
  fetchImpl: typeof fetch,
  meter: { charge(): void } | undefined,
  blockNumbers: number[],
  blocks: Map<number, WindowBlock>,
): Promise<{ ok: false; reason: "logs_unverified" } | { ok: true }> {
  const wanted: { blockNumber: number; hash: string }[] = [];
  for (const blockNumber of blockNumbers) {
    const block = blocks.get(blockNumber);
    if (!block || !Array.isArray(block.transactions)) return { ok: false, reason: "logs_unverified" };
    for (const hash of block.transactions) wanted.push({ blockNumber, hash: String(hash) });
  }
  const grouped = new Map<number, unknown[]>();
  for (const blockNumber of blockNumbers) grouped.set(blockNumber, []);
  if (wanted.length > 0) {
    const calls = wanted.map((entry, index) => ({
      jsonrpc: "2.0",
      id: index + 1,
      method: "eth_getTransactionReceipt",
      params: [entry.hash],
    }));
    const { response, parsed } = await postJson(url, calls, fetchImpl, meter);
    if (!Array.isArray(parsed)) return { ok: false, reason: "logs_unverified" };
    for (let index = 0; index < wanted.length; index += 1) {
      const record = batchItem(parsed, index + 1);
      const error = asRecord(record?.error);
      if (error) {
        const failure = rpcFailure(response, error, response.status);
        if (scanErrorClass(failure)) throw failure;
        return { ok: false, reason: "logs_unverified" };
      }
      if (!record?.result || typeof record.result !== "object") return { ok: false, reason: "logs_unverified" };
      grouped.get(wanted[index].blockNumber)?.push(record.result);
    }
  }
  for (const [blockNumber, receipts] of grouped) {
    const block = blocks.get(blockNumber);
    if (block) block.receipts = receipts;
  }
  return { ok: true };
}
