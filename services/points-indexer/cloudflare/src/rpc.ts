import { decodeEventLog, type Abi } from "viem";
import escrowAbi from "../../../../apps/wallet-ux/src/abi/BotAttestationEscrow.json";
import panelAbi from "../../../../apps/wallet-ux/src/abi/DisputePanel.json";
import { ESCROW, PANEL } from "../../src/constants.mjs";
import { RPC_TIMEOUT_MS } from "./pace";

const URL_PATTERN = /https?:\/\/\S+/gi;

export function redact(text: string, rpcUrl?: string) {
  let out = String(text ?? "");
  if (rpcUrl) out = out.split(String(rpcUrl)).join("[redacted-url]");
  return out.replace(URL_PATTERN, "[redacted-url]");
}

export class RpcError extends Error {
  status: number | null;
  code: number | null;
  details: string;
  shortMessage: string;
  headers: Headers | null;

  constructor(message: string, fields: { status?: number | null; code?: number | null; details?: string; headers?: Headers | null } = {}) {
    super(message);
    this.name = "RpcError";
    this.status = fields.status ?? null;
    this.code = fields.code ?? null;
    this.details = fields.details ?? "";
    this.shortMessage = this.details;
    this.headers = fields.headers ?? null;
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

async function postJson(url: string, body: unknown, fetchImpl: typeof fetch) {
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
      throw new RpcError("rpc_timeout", { details: "timeout" });
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

export async function rpcCall(url: string, method: string, params: unknown[], fetchImpl: typeof fetch = fetch) {
  const { response, parsed } = await postJson(url, { jsonrpc: "2.0", id: 1, method, params }, fetchImpl);
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

export function createRpc(url: string, fetchImpl: typeof fetch = fetch) {
  return {
    async chainId() {
      return hexToInt(await rpcCall(url, "eth_chainId", [], fetchImpl));
    },
    async finalizedBlock() {
      const result = asRecord(await rpcCall(url, "eth_getBlockByNumber", ["finalized", false], fetchImpl));
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
      }], fetchImpl);
      const rows = Array.isArray(result) ? result.map((row) => asRecord(row)).filter((row): row is RawLog => row != null) : [];
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
        const { response, parsed } = await postJson(url, calls, fetchImpl);
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
        if (stamped) logs.push(stamped);
      }
      return logs;
    },
  };
}
