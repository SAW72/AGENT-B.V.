/**
 * Bounded retry for a future claim broadcast.
 * Transient RPC / account-nonce / replacement only.
 * Permanent claim, chain, and signature errors must not loop.
 * This helper does not send transactions.
 */

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 200;

const PERMANENT_MARKERS = [
  "invalidsignature",
  "invalid_signature",
  "usednonce",
  "used_nonce",
  "replay",
  "invalidparties",
  "invalid_parties",
  "escrownotbooked",
  "escrow_not_booked",
  "live_submit_blocked",
  "kill_switch",
  "wrongchain",
  "wrong_chain",
  "mainnet_refused",
  "mainnet",
  "simulation_failed",
  "user rejected",
  "user denied",
];

const TRANSIENT_MARKERS = [
  "timeout",
  "timed out",
  "etimedout",
  "econnreset",
  "econnrefused",
  "enotfound",
  "eai_again",
  "socket hang up",
  "fetch failed",
  "network",
  "rate limit",
  "too many requests",
  "temporarily unavailable",
  "internal json-rpc",
  "header not found",
  "nonce too low",
  "nonce has already been used",
  "replacement transaction underpriced",
  "replacement underpriced",
  "already known",
  "alreadyknown",
  "try again",
  "server error",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
];

/**
 * HTTP status codes that mean "try again". Matched only as standalone
 * tokens so a hex address containing those digits (the live escrow
 * includes 502) is not treated as a gateway error.
 */
const TRANSIENT_STATUS_CODES = ["429", "502", "503", "504"];

function blob(err) {
  if (!err) return "";
  const parts = [
    err.shortMessage,
    err.details,
    err.message,
    err.name,
    err.code,
    err.error,
    err.cause?.message,
    err.cause?.code,
  ];
  return parts
    .filter((part) => part !== undefined && part !== null)
    .join(" ")
    .toLowerCase();
}

function hasStatusCode(text, code) {
  const re = new RegExp(`(^|[^0-9a-f])${code}([^0-9a-f]|$)`);
  return re.test(text);
}

export function isTransientClaimError(err) {
  const text = blob(err);
  if (!text) return false;
  if (PERMANENT_MARKERS.some((marker) => text.includes(marker))) return false;
  if (TRANSIENT_MARKERS.some((marker) => text.includes(marker))) return true;
  return TRANSIENT_STATUS_CODES.some((code) => hasStatusCode(text, code));
}

export function backoffMs(attempt, baseDelayMs = DEFAULT_BASE_DELAY_MS) {
  const exp = Math.max(0, attempt - 1);
  return Number(baseDelayMs) * 2 ** exp;
}

/**
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts]
 * @param {number} [opts.baseDelayMs]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {(info: object) => void} [opts.log]
 */
export async function withClaimRetry(fn, opts = {}) {
  const maxAttempts = Math.max(1, Number(opts.maxAttempts || DEFAULT_MAX_ATTEMPTS));
  const baseDelayMs = Number(opts.baseDelayMs || DEFAULT_BASE_DELAY_MS);
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = opts.log || (() => {});

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const transient = isTransientClaimError(err);
      const delayMs = attempt < maxAttempts && transient ? backoffMs(attempt, baseDelayMs) : 0;
      const message = err && (err.shortMessage || err.message || String(err));
      log({
        event: "claim_retry",
        attempt,
        maxAttempts,
        transient,
        delayMs,
        message: String(message || "unknown").slice(0, 240),
      });
      if (!transient || attempt === maxAttempts) throw err;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}
