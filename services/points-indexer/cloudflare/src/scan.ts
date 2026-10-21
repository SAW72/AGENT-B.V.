import { CHAIN_ID, ESCROW, ESCROW_START_BLOCK, PANEL, isAcceptedChain } from "../../src/constants.mjs";
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
import { PointsError } from "../../src/hex.mjs";
import { createScanPacer, jitterMs, scanErrorClass, sleepMs, textIsRateLimit } from "./pace";
import { BudgetExceeded, createRpc, createSubrequestMeter, publicDetail, RpcError, SUBREQUEST_BUDGET } from "./rpc";

type Storage = {
  sql: {
    exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
  };
  transactionSync<T>(closure: () => T): T;
  setAlarm(scheduledTime: number | Date): Promise<void>;
};

const CATCH_UP_MS = 1_000;
const STEADY_MS = 15_000;
const ERROR_BACKOFF_START_MS = 1_000;
const ERROR_BACKOFF_CAP_MS = 15 * 60 * 1000;
export const MAX_ALARM_WALL_MS = 20_000;

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
  if (textIsRateLimit(rangeText(record))) return false;
  const code = numericCode(record.code);
  if (code === -32614) return true;
  const status = numericCode(record.status ?? record.statusCode);
  if (status === 413 || code === 413) return true;
  const text = rangeText(record);
  if (code === -32602) return true;
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
    const capped = Math.min(window, clamped);
    if (capped < window) return { window: capped, ceiling: clamped };
    const halved = Math.min(clamped, Math.max(1, Math.floor(window / 2)));
    return { window: halved, ceiling: clamped };
  }
  return { window: Math.max(1, Math.floor(window / 2)), ceiling: null };
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
  if (error instanceof PointsError || (error instanceof Error && error.name === "PointsError")) {
    const reason = (error as { reason?: unknown }).reason;
    if (reason === "unverifiable_log" || (error instanceof Error && error.message === "unverifiable_log")) {
      return "unverifiable_log";
    }
    return "ledger_error";
  }
  if (isRangeError(error)) return "range_error";
  const classified = scanErrorClass(error);
  if (classified === "rate_limited" || classified === "server_error" || classified === "timeout") return classified;
  if (error instanceof RpcError && error.kind === "timeout") return "timeout";
  const message = error instanceof Error ? error.message : "";
  if (message === "log_outside_request") return "log_outside_request";
  if (/sqlite|unique constraint/i.test(message)) return "ledger_error";
  if (
    message.startsWith("CHAIN_ID")
    || message.startsWith("RPC chain")
    || message.startsWith("POINTS_")
    || message.startsWith("missing_rpc")
    || message.startsWith("contract code")
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
  const started = now();
  let pollMs = STEADY_MS;
  let deferMs = 0;

  const fast = String(env.POINTS_FAST_PACE) === "1";

  const schedule = async (behind: number) => {
    const base = behind > 0 ? CATCH_UP_MS : pollMs;
    const delay = Math.max(base, deferMs);
    await storage.setAlarm(now() + delay);
    return delay;
  };

  // Non-config failures wait 1s, then double, and stop at 15 minutes.
  // Config errors stay on POINTS_POLL_MS and do not grow this counter.
  const scheduleError = async (defer: number) => {
    let prior = 0;
    try {
      prior = metaInt(storage.sql, "error_backoff_ms") ?? 0;
    } catch {
      prior = 0;
    }
    const base = prior > 0 ? Math.min(ERROR_BACKOFF_CAP_MS, prior * 2) : ERROR_BACKOFF_START_MS;
    const jitter = fast ? 0 : jitterMs();
    const delay = Math.min(ERROR_BACKOFF_CAP_MS, Math.max(base + jitter, defer));
    try {
      if (metaGet(storage.sql, "config_wait_ms") != null) {
        storage.sql.exec("DELETE FROM meta WHERE key = ?", "config_wait_ms");
      }
      metaSet(storage.sql, "error_backoff_ms", String(delay));
    } catch {
      // Schema or storage failed. Still reschedule below.
    }
    await storage.setAlarm(now() + delay);
    return delay;
  };

  const rpcUrl = String(env.BASE_SEPOLIA_RPC_URL ?? "").trim();
  try {
    pollMs = positiveInt(env.POINTS_POLL_MS, STEADY_MS);
    const logRange = positiveInt(env.POINTS_LOG_RANGE, 200);
    const maxWindows = positiveInt(env.POINTS_MAX_WINDOWS_PER_RUN, 40);
    if (String(env.CHAIN_ID ?? "").trim() !== String(CHAIN_ID)) {
      throw new Error(`CHAIN_ID must be ${CHAIN_ID}`);
    }
    if (!rpcUrl) throw new Error("missing_rpc");

    const scan = createScanPacer({
      now,
      sleep: fast ? async () => {} : sleepMs,
      jitter: fast ? () => 0 : () => jitterMs(),
      classify(error) {
        if (error instanceof BudgetExceeded || error instanceof PointsError) return null;
        if (isRangeError(error)) return null;
        return scanErrorClass(error);
      },
    });

    const meter = createSubrequestMeter(SUBREQUEST_BUDGET);
    const rpc = createRpc(rpcUrl, fetch, meter);
    const reported = await rpc.chainId();
    if (!isAcceptedChain(reported)) {
      throw new Error(`RPC chain id is ${String(reported)}, expected ${CHAIN_ID}`);
    }
    await rpc.getCode(ESCROW);
    await rpc.getCode(PANEL);
    const headBlock = await rpc.finalizedBlock();
    if (!headBlock || !Number.isSafeInteger(headBlock.number) || headBlock.number < 0) {
      throw new Error("RPC finalized block is not a safe integer");
    }
    const latestBlock = await rpc.latestBlock();
    if (!latestBlock || !Number.isSafeInteger(latestBlock.number) || latestBlock.number < 0) {
      throw new Error("RPC latest block is not a safe integer");
    }
    if (headBlock.number > latestBlock.number) {
      throw new Error("RPC finalized block is above the latest block");
    }
    const rpcHead = headBlock.number;
    const storedChain = metaInt(storage.sql, "chain_head");
    if (storedChain != null && rpcHead < storedChain) {
      metaSet(storage.sql, "finalized_lag", "1");
      console.error(JSON.stringify({ message: "finalized_head_lag", rpcHead, storedHead: storedChain }));
    } else {
      metaSet(storage.sql, "finalized_lag", "0");
      if (storedChain == null || rpcHead > storedChain) metaSet(storage.sql, "chain_head", String(rpcHead));
    }
    const head = rpcHead;
    const storedCursor = lastScannedBlock(storage.sql);
    const previousCursor = storedCursor == null ? null : Math.max(storedCursor, ESCROW_START_BLOCK - 1);
    const origin = previousCursor == null ? ESCROW_START_BLOCK - 1 : previousCursor;
    const scanHead = Math.min(head, origin + maxWindows * logRange);
    let from = previousCursor == null ? ESCROW_START_BLOCK : previousCursor + 1;
    let window = metaInt(storage.sql, "learned_window") ?? logRange;
    const storedCeiling = metaInt(storage.sql, "window_ceiling");
    if (storedCeiling != null) window = Math.min(window, storedCeiling);
    let inserted = 0;
    let removed = 0;
    let committedWindows = 0;
    let earlyReason: string | null = null;
    let stopReason: string | null = null;
    while (from <= scanHead && committedWindows < maxWindows) {
      if (now() - started >= MAX_ALARM_WALL_MS) {
        stopReason = "wall_time";
        break;
      }
      const to = Math.min(scanHead, from + window - 1);
      let logs;
      try {
        const scanned = await scan.run(() => rpc.readWindow(from as number, to));
        if (!scanned.ok) {
          earlyReason = scanned.reason;
          deferMs = scanned.deferMs ?? 0;
          break;
        }
        if (!scanned.value.ok) {
          earlyReason = scanned.value.reason;
          break;
        }
        logs = scanned.value.logs;
      } catch (error) {
        if (error instanceof BudgetExceeded) {
          stopReason = "subrequest_budget";
          break;
        }
        if (isRangeError(error) && window > 1) {
          const shrunk = nextRangeWindow(window, error as { details?: unknown; shortMessage?: unknown }, logRange);
          window = shrunk.window;
          if (shrunk.ceiling != null) metaSet(storage.sql, "window_ceiling", String(shrunk.ceiling));
          metaSet(storage.sql, "learned_window", String(window));
          continue;
        }
        throw error;
      }
      const committed = commitScanWindow(storage, logs, to, CHAIN_ID, head);
      inserted += committed.inserted;
      removed += committed.removed;
      committedWindows += 1;
      from = to + 1;
      const ceiling = metaInt(storage.sql, "window_ceiling") ?? logRange;
      if (window < ceiling) {
        window = Math.min(ceiling, window * 2);
        metaSet(storage.sql, "learned_window", String(window));
      }
      metaSet(storage.sql, "last_pass_at", String(now()));
      metaSet(storage.sql, "last_error", "");
    }
    const previous = finalizedBlock(storage.sql);
    const cursorNow = lastScannedBlock(storage.sql);
    const verified = cursorNow == null ? null : Math.min(head, cursorNow);
    const headResult = verified == null
      ? { moved: false, previous, finalizedBlock: previous ?? head }
      : setFinalizedBlock(storage.sql, verified);
    const crossed = newlyFinalCount(storage.sql, previous, headResult.finalizedBlock);
    const dirty = metaGet(storage.sql, "dirty") === "1";
    let rebuilds = 0;
    if (inserted > 0 || removed > 0 || crossed > 0 || dirty) {
      try {
        rebuild(storage);
        rebuilds = 1;
      } catch (error) {
        metaSet(storage.sql, "last_error", "ledger_error");
        metaSet(storage.sql, "stale", "1");
        console.error(JSON.stringify({
          message: "ledger_error",
          detail: publicDetail(error instanceof Error ? error.message : "", rpcUrl),
        }));
        await scheduleError(0);
        return { ok: false, error: "ledger_error", rebuilds: 0 };
      }
    }
    const cursor = lastScannedBlock(storage.sql);
    const behind = blocksBehind(head, cursor);
    if (earlyReason) {
      metaSet(storage.sql, "last_error", earlyReason);
      metaSet(storage.sql, "early_reason", earlyReason);
      metaSet(storage.sql, "stale", "1");
      metaSet(storage.sql, "pass_completed", "1");
      console.error(JSON.stringify({ message: "pass_ended_early", reason: earlyReason }));
      await scheduleError(deferMs);
    } else {
      metaSet(storage.sql, "last_error", "");
      metaSet(storage.sql, "early_reason", stopReason ?? "");
      metaSet(storage.sql, "stale", "0");
      metaSet(storage.sql, "pass_completed", "1");
      metaSet(storage.sql, "last_pass_at", String(now()));
      clearErrorBackoff();
      clearConfigWait();
      await schedule(behind);
    }
    return {
      ok: true,
      endedEarly: earlyReason != null || stopReason != null,
      reason: earlyReason ?? stopReason,
      inserted,
      rebuilds,
      behind,
      windows: committedWindows,
    };
  } catch (error) {
    const code = errorCode(error);
    try {
      metaSet(storage.sql, "last_error", code);
      metaSet(storage.sql, "stale", "1");
    } catch {
      // Schema or storage failed. Still reschedule below.
    }
    console.error(JSON.stringify({
      message: code,
      detail: publicDetail(error instanceof Error ? error.message : "", rpcUrl),
    }));
    if (code === "config_error") {
      const delay = await schedule(0);
      try {
        clearErrorBackoff();
        metaSet(storage.sql, "config_wait_ms", String(delay));
      } catch {
        // The alarm is already scheduled.
      }
    } else {
      await scheduleError(0);
    }
    return { ok: false, error: code };
  }

  function clearErrorBackoff() {
    const current = metaGet(storage.sql, "error_backoff_ms");
    if (current == null || current === "" || current === "0") return;
    metaSet(storage.sql, "error_backoff_ms", "0");
  }

  function clearConfigWait() {
    if (metaGet(storage.sql, "config_wait_ms") == null) return;
    storage.sql.exec("DELETE FROM meta WHERE key = ?", "config_wait_ms");
  }
}
