import { ESCROW, ESCROW_START_BLOCK } from "../../src/constants.mjs";

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
      const rows = parsed.map((request) => {
        const result = handler(request);
        if (result.status !== 200) {
          return { jsonrpc: "2.0", id: request.id, error: { code: result.status, message: "batch failed" } };
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

export function chainHandler(options: {
  head: number;
  logs?: FakeLog[];
  getLogsStatus?: (fromBlock: number, toBlock: number, seen: number) => { status: number; retryAfter?: string } | null;
  timestamps?: Record<number, number>;
}) {
  let getLogsSeen = 0;
  return (request: RpcRequest): HandlerResult => {
    if (request.method === "eth_chainId") {
      return { status: 200, body: hex(84532) };
    }
    if (request.method === "eth_getBlockByNumber") {
      const tag = String(request.params[0]);
      if (tag === "finalized") {
        return { status: 200, body: { number: hex(options.head) } };
      }
      const number = Number(tag);
      const timestamp = options.timestamps?.[number] ?? 1_700_000_000;
      return { status: 200, body: { number: tag, timestamp: hex(timestamp) } };
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
        };
      }
      const rows = (options.logs ?? []).filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock).map(toRpcLog);
      return { status: 200, body: rows };
    }
    throw new Error(`unexpected method ${request.method}`);
  };
}

export { ESCROW_START_BLOCK };
