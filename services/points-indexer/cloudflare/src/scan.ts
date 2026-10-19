import { CHAIN_ID, ESCROW_START_BLOCK, isAcceptedChain } from "../../src/constants.mjs";
import {
  commitScanWindow,
  ensureSchema,
  finalizedBlock,
  lastScannedBlock,
  metaGet,
  metaInt,
  metaSet,
  newlyFinalCount,
  rebuild,
  setFinalizedBlock,
} from "./ledger";
import { createScanPacer, jitterMs, scanErrorClass, sleepMs } from "./pace";
import { createRpc, redact, RpcError } from "./rpc";

type Storage = {
  sql: {
    exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
  };
  transactionSync<T>(closure: () => T): T;
  setAlarm(scheduledTime: number | Date): Promise<void>;
};

const CATCH_UP_MS = 1_000;
const STEADY_MS = 15_000;

function numericCode(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) return Number(value);
  return null;
}

function rangeText(error: { details?: unknown; shortMessage?: unknown }) {
  return [error.details, error.shortMessage].filter((part) => part != null && part !== "").join(" ").toLowerCase();
}

function textIsRange(text: string) {
  if (!text) return false;
  if (text.includes("limited to")) return true;
  if (text.includes("block range")) return true;
  if (text.includes("too large")) return true;
  if (text.includes("too many results") || text.includes("too many logs")) return true;
  if (text.includes("query returned more")) return true;
  if (text.includes("exceed")) return true;
  if (text.includes("log limit")) return true;
  if (text.includes("response size") && text.includes("log")) return true;
  if (text.includes("more than") && (text.includes("result") || text.includes("log"))) return true;
  return false;
}

export function isRangeError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; status?: unknown; statusCode?: unknown; details?: unknown; shortMessage?: unknown };
  const code = numericCode(record.code);
  if (code === -32614) return true;
  const status = numericCode(record.status ?? record.statusCode);
  if (status === 413 || code === 413) return true;
  const text = rangeText(record);
  if (code === -32005 || code === -32602) return textIsRange(text);
  return textIsRange(text);
}

function rangeLimit(error: { details?: unknown; shortMessage?: unknown }) {
  const text = [error.details, error.shortMessage].filter((part) => part != null && part !== "").join(" ");
  const match = /limited to a (\d+) range/i.exec(text);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function nextRangeWindow(window: number, error: { details?: unknown; shortMessage?: unknown }, max: number) {
  const limit = rangeLimit(error);
  if (limit != null) {
    const clamped = Math.min(max, Math.max(1, limit));
    if (clamped < window) return clamped;
  }
  return Math.max(1, Math.floor(window / 2));
}

function positiveInt(value: unknown, fallback: number) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error("POINTS_ setting must be a positive integer");
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error("POINTS_ setting must be a positive integer");
  return parsed;
}

export function blocksBehind(head: number, cursor: number | null) {
  if (!Number.isSafeInteger(head)) return 0;
  if (cursor == null) {
    if (head < ESCROW_START_BLOCK) return 0;
    return head - ESCROW_START_BLOCK + 1;
  }
  return Math.max(0, head - cursor);
}

export function healthDecision(status: { lastPassAt: number | null; pollMs: number; now: number; behind?: number }) {
  const fresh = status.lastPassAt != null && status.now - status.lastPassAt <= 3 * status.pollMs;
  const behind = Number.isSafeInteger(status.behind) ? Math.max(0, status.behind as number) : 0;
  return { ok: fresh, statusCode: fresh ? 200 : 503, behind };
}

function errorCode(error: unknown) {
  if (isRangeError(error)) return "range_error";
  if (error instanceof RpcError && error.status === 429) return "rate_limited";
  if (error instanceof RpcError && error.status != null && error.status >= 500) return "server_error";
  if (error instanceof Error && error.name === "TimeoutError") return "network_error";
  const message = error instanceof Error ? error.message : "";
  if (
    message.startsWith("CHAIN_ID")
    || message.startsWith("RPC chain")
    || message.startsWith("POINTS_")
    || message.startsWith("missing_rpc")
  ) {
    return "config_error";
  }
  return "rpc_error";
}

export async function runAlarm(options: {
  storage: Storage;
  env: Record<string, string | undefined>;
  now?: () => number;
}) {
  const storage = options.storage;
  const env = options.env;
  const now = options.now ?? Date.now;
  ensureSchema(storage.sql);
  const pollMs = positiveInt(env.POINTS_POLL_MS, STEADY_MS);
  void pollMs;
  const logRange = positiveInt(env.POINTS_LOG_RANGE, 200);
  const maxWindows = positiveInt(env.POINTS_MAX_WINDOWS_PER_RUN, 40);
  const fast = env.POINTS_FAST_PACE === "1";
  const rpcUrl = String(env.BASE_SEPOLIA_RPC_URL ?? "").trim();

  const finish = async (behind: number) => {
    const delay = behind > 0 ? CATCH_UP_MS : STEADY_MS;
    await storage.setAlarm(now() + delay);
    return delay;
  };

  if (!rpcUrl) {
    metaSet(storage.sql, "last_error", "config_error");
    metaSet(storage.sql, "stale", "1");
    console.error(JSON.stringify({ message: "missing_rpc" }));
    await finish(0);
    return { ok: false, error: "config_error" };
  }

  const scan = createScanPacer({
    now,
    sleep: fast ? async () => {} : sleepMs,
    jitter: fast ? () => 0 : () => jitterMs(),
    classify(error) {
      if (isRangeError(error)) return null;
      return scanErrorClass(error);
    },
  });

  try {
    const rpc = createRpc(rpcUrl);
    if (metaGet(storage.sql, "chain_checked") !== String(CHAIN_ID)) {
      const reported = await rpc.chainId();
      if (!isAcceptedChain(reported)) {
        throw new Error(`RPC chain id is ${String(reported)}, expected ${CHAIN_ID}`);
      }
      metaSet(storage.sql, "chain_checked", String(CHAIN_ID));
    }
    const headBlock = await rpc.finalizedBlock();
    if (!headBlock || !Number.isSafeInteger(headBlock.number) || headBlock.number < 0) {
      throw new Error("RPC finalized block is not a safe integer");
    }
    const head = Math.max(finalizedBlock(storage.sql) ?? 0, headBlock.number);
    let from = lastScannedBlock(storage.sql);
    from = from == null ? ESCROW_START_BLOCK : Math.max(ESCROW_START_BLOCK, from + 1);
    let window = metaInt(storage.sql, "learned_window") ?? logRange;
    let inserted = 0;
    let committedWindows = 0;
    let earlyReason: string | null = null;
    while (from <= head && committedWindows < maxWindows) {
      const to = Math.min(head, from + window - 1);
      let logs;
      try {
        const scanned = await scan.run(() => rpc.getLogs(from, to));
        if (!scanned.ok) {
          earlyReason = scanned.reason;
          break;
        }
        logs = scanned.value;
      } catch (error) {
        if (isRangeError(error) && window > 1) {
          window = nextRangeWindow(window, error as { details?: unknown; shortMessage?: unknown }, logRange);
          metaSet(storage.sql, "learned_window", String(window));
          continue;
        }
        throw error;
      }
      const committed = commitScanWindow(storage, logs, to, CHAIN_ID);
      inserted += committed.inserted;
      committedWindows += 1;
      from = to + 1;
      window = Math.min(logRange, window * 2);
      metaSet(storage.sql, "learned_window", String(window));
      metaSet(storage.sql, "last_pass_at", String(now()));
      metaSet(storage.sql, "last_error", "");
    }
    const previous = finalizedBlock(storage.sql);
    const headResult = setFinalizedBlock(storage.sql, head);
    const crossed = newlyFinalCount(storage.sql, previous, headResult.finalizedBlock);
    let rebuilds = 0;
    if (inserted > 0 || crossed > 0) {
      rebuild(storage);
      rebuilds = 1;
    }
    const cursor = lastScannedBlock(storage.sql);
    const behind = blocksBehind(head, cursor);
    if (earlyReason) {
      metaSet(storage.sql, "last_error", earlyReason);
      metaSet(storage.sql, "early_reason", earlyReason);
      metaSet(storage.sql, "stale", "1");
      metaSet(storage.sql, "pass_completed", "1");
      console.error(JSON.stringify({ message: "pass_ended_early", reason: earlyReason }));
    } else {
      metaSet(storage.sql, "last_error", "");
      metaSet(storage.sql, "early_reason", "");
      metaSet(storage.sql, "stale", "0");
      metaSet(storage.sql, "pass_completed", "1");
      metaSet(storage.sql, "last_pass_at", String(now()));
    }
    await finish(behind);
    return {
      ok: true,
      endedEarly: earlyReason != null,
      reason: earlyReason,
      inserted,
      rebuilds,
      behind,
      windows: committedWindows,
    };
  } catch (error) {
    const code = errorCode(error);
    metaSet(storage.sql, "last_error", code);
    metaSet(storage.sql, "stale", "1");
    console.error(JSON.stringify({
      message: code,
      detail: redact(error instanceof Error ? error.message : "", rpcUrl),
    }));
    const cursor = lastScannedBlock(storage.sql);
    const storedHead = finalizedBlock(storage.sql);
    const behind = storedHead == null ? 1 : blocksBehind(storedHead, cursor);
    await finish(behind > 0 ? behind : 1);
    return { ok: false, error: code };
  }
}
