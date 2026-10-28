import { ESCROW, ESCROW_START_BLOCK } from "../../src/constants.mjs";
import { bloomForAddresses } from "../src/logWindow";

const EMPTY_BLOOM = `0x${"00".repeat(256)}`;
const DUMMY_TX = `0x${"ab".repeat(32)}`;

export type FakeLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
  transactionIndex: number;
  blockHash: string;
  logIndex: number;
  removed: boolean;
  blockTimestamp?: string;
};

export type RpcRequest = {
  jsonrpc: string;
  id: number;
  method: string;
  params: unknown[];
};

type HandlerResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  rpcError?: { code: number; message: string };
  throwName?: string;
};

/**
 * In-isolate JSON-RPC stand-in. vitest-pool-workers runs tests in the same
 * isolate as the worker, so replacing global fetch covers Durable Object calls.
 */
export function installRpc(handler: (request: RpcRequest) => HandlerResult) {
  const original = globalThis.fetch;
  const calls: RpcRequest[] = [];
  const liveSignals: boolean[] = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== "http://rpc.test/base") {
      throw new Error(`unexpected fetch ${url}`);
    }
    liveSignals.push(init?.signal instanceof AbortSignal && init.signal.aborted === false);
    const parsed = JSON.parse(String(init?.body ?? "null")) as RpcRequest | RpcRequest[];
    if (Array.isArray(parsed)) {
      calls.push(...parsed);
      const results = parsed.map((request) => handler(request));
      const thrown = results.find((result) => result.throwName);
      if (thrown?.throwName) {
        const error = new Error(thrown.throwName);
        error.name = thrown.throwName;
        throw error;
      }
      const httpFail = results.find((result) => (
        result.status === 413
        || result.status === 429
        || (result.status >= 500 && result.status <= 599)
      ));
      if (httpFail) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: parsed[0]?.id ?? 1,
          error: httpFail.rpcError ?? { code: httpFail.status, message: "rpc failed" },
        }), {
          status: httpFail.status,
          headers: { "content-type": "application/json", ...(httpFail.headers ?? {}) },
        });
      }
      const rows = parsed.map((request, index) => {
        const result = results[index];
        if (result.rpcError || result.status !== 200) {
          return {
            jsonrpc: "2.0",
            id: request.id,
            error: result.rpcError ?? { code: result.status, message: "batch failed" },
          };
        }
        return { jsonrpc: "2.0", id: request.id, result: result.body };
      });
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    calls.push(parsed);
    const result = handler(parsed);
    if (result.throwName) {
      const error = new Error(result.throwName);
      error.name = result.throwName;
      throw error;
    }
    if (result.rpcError) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, error: result.rpcError }), {
        status: result.status,
        headers: { "content-type": "application/json", ...(result.headers ?? {}) },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: result.body, error: result.status === 200 ? undefined : { code: result.status, message: "rpc failed" } }), {
      status: result.status,
      headers: { "content-type": "application/json", ...(result.headers ?? {}) },
    });
  };
  return {
    calls,
    liveSignals,
    restore() {
      globalThis.fetch = original;
    },
  };
}

export function hex(value: number): string {
  return `0x${value.toString(16)}`;
}

export async function randomHex(bytes: number): Promise<string> {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return `0x${[...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function escrowLog(blockNumber: number, logIndex: number, timestampSeconds?: number): Promise<FakeLog> {
  const log: FakeLog = {
    address: ESCROW,
    topics: [await randomHex(32)],
    data: "0x",
    blockNumber,
    transactionHash: await randomHex(32),
    transactionIndex: 0,
    blockHash: await randomHex(32),
    logIndex,
    removed: false,
  };
  if (timestampSeconds !== undefined) log.blockTimestamp = hex(timestampSeconds);
  return log;
}

export function toRpcLog(log: FakeLog) {
  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: hex(log.blockNumber),
    transactionHash: log.transactionHash,
    transactionIndex: hex(log.transactionIndex),
    blockHash: log.blockHash,
    logIndex: hex(log.logIndex),
    removed: log.removed,
    ...(log.blockTimestamp ? { blockTimestamp: log.blockTimestamp } : {}),
  };
}

function logsOnBlock(logs: FakeLog[] | undefined, blockNumber: number) {
  return (logs ?? []).filter((log) => log.blockNumber === blockNumber);
}

function blockBody(
  options: {
    logs?: FakeLog[];
    headerHashFor?: (blockNumber: number) => string;
    bloomAddresses?: string[];
  },
  blockNumber: number,
  tag: string,
  timestamp: number,
) {
  const inBlock = logsOnBlock(options.logs, blockNumber);
  const hash = options.headerHashFor?.(blockNumber)
    ?? inBlock[0]?.blockHash
    ?? `0x${blockNumber.toString(16).padStart(64, "0")}`;
  const bloom = options.bloomAddresses && inBlock.length === 0
    ? bloomForAddresses(options.bloomAddresses)
    : inBlock.length > 0
      ? bloomForAddresses([...new Set(inBlock.map((log) => log.address))])
      : EMPTY_BLOOM;
  const transactions = options.bloomAddresses && inBlock.length === 0
    ? [DUMMY_TX]
    : [...new Set(inBlock.map((log) => log.transactionHash))];
  return {
    number: tag,
    timestamp: hex(timestamp),
    hash,
    logsBloom: bloom,
    transactions: transactions.map((txHash) => ({ hash: txHash })),
  };
}

function receiptsForBlock(
  options: {
    logs?: FakeLog[];
    headerHashFor?: (blockNumber: number) => string;
    bloomAddresses?: string[];
  },
  blockNumber: number,
) {
  const inBlock = logsOnBlock(options.logs, blockNumber);
  const hash = options.headerHashFor?.(blockNumber)
    ?? inBlock[0]?.blockHash
    ?? `0x${blockNumber.toString(16).padStart(64, "0")}`;
  if (options.bloomAddresses && inBlock.length === 0) {
    return [{ transactionHash: DUMMY_TX, blockHash: hash, logs: [] }];
  }
  const byTx = new Map<string, FakeLog[]>();
  for (const log of inBlock) {
    const list = byTx.get(log.transactionHash) ?? [];
    list.push(log);
    byTx.set(log.transactionHash, list);
  }
  return [...byTx.entries()].map(([transactionHash, txLogs]) => ({
    transactionHash,
    blockHash: txLogs[0]?.blockHash ?? hash,
    logs: txLogs.map(toRpcLog),
  }));
}

export function chainHandler(options: {
  head: number | (() => number);
  latest?: number | (() => number);
  logs?: FakeLog[];
  code?: string;
  omitTimestamp?: boolean;
  keepOutside?: boolean;
  getLogsStatus?: (
    fromBlock: number,
    toBlock: number,
    seen: number,
  ) => { status: number; retryAfter?: string; rpcError?: { code: number; message: string }; throwName?: string } | null;
  timestamps?: Record<number, number>;
  nonArrayLogs?: boolean;
  scanFilter?: (log: FakeLog) => boolean;
  headerHashFor?: (blockNumber: number) => string;
  bloomAddresses?: string[];
  omitReceipts?: boolean;
  receiptMethodMissing?: boolean;
}) {
  let getLogsSeen = 0;
  const headNow = () => (typeof options.head === "function" ? options.head() : options.head);
  return (request: RpcRequest): HandlerResult => {
    if (request.method === "eth_chainId") {
      return { status: 200, body: hex(84532) };
    }
    if (request.method === "eth_getCode") {
      return { status: 200, body: options.code ?? "0x1" };
    }
    if (request.method === "eth_getBlockByNumber") {
      const tag = String(request.params[0]);
      if (tag === "finalized") {
        return { status: 200, body: { number: hex(headNow()) } };
      }
      if (tag === "latest") {
        const latestNow = typeof options.latest === "function" ? options.latest() : (options.latest ?? headNow());
        return { status: 200, body: { number: hex(latestNow) } };
      }
      if (options.omitTimestamp) return { status: 200, body: null };
      const number = Number(tag);
      const timestamp = options.timestamps?.[number] ?? 1_700_000_000;
      return { status: 200, body: blockBody(options, number, tag, timestamp) };
    }
    if (request.method === "eth_getBlockReceipts") {
      if (options.receiptMethodMissing) {
        return { status: 200, body: null, rpcError: { code: -32601, message: "method not found" } };
      }
      if (options.omitReceipts) return { status: 200, body: null };
      const number = Number(request.params[0]);
      return { status: 200, body: receiptsForBlock(options, number) };
    }
    if (request.method === "eth_getTransactionReceipt") {
      const hash = String(request.params[0]).toLowerCase();
      const matches = (options.logs ?? []).filter((log) => log.transactionHash.toLowerCase() === hash);
      return {
        status: 200,
        body: {
          transactionHash: request.params[0],
          blockHash: matches[0]?.blockHash ?? `0x${"00".repeat(32)}`,
          logs: matches.map(toRpcLog),
        },
      };
    }
    if (request.method === "eth_getLogs") {
      getLogsSeen += 1;
      const params = request.params[0] as { fromBlock: string; toBlock: string };
      const fromBlock = Number(params.fromBlock);
      const toBlock = Number(params.toBlock);
      const failure = options.getLogsStatus?.(fromBlock, toBlock, getLogsSeen);
      if (failure) {
        return {
          status: failure.status,
          body: null,
          headers: failure.retryAfter ? { "retry-after": failure.retryAfter } : undefined,
          rpcError: failure.rpcError,
          throwName: failure.throwName,
        };
      }
      if (options.nonArrayLogs) return { status: 200, body: { unexpected: true } };
      if (fromBlock > headNow()) return { status: 200, body: [] };
      const pool = (options.logs ?? []).filter((log) => options.scanFilter?.(log) ?? true);
      const rows = (options.keepOutside ? pool : pool.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock)).map(toRpcLog);
      return { status: 200, body: rows };
    }
    throw new Error(`unexpected method ${request.method}`);
  };
}

export { ESCROW_START_BLOCK };
