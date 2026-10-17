/**
 * In-process getLogs pacing and retry waits.
 * The clock and sleep are injected so a test can advance time without a timer.
 * This module does not open a database and does not assume a sqlite file survives the process.
 */

/** Minimum gap between the start of one eth_getLogs call and the next. Five calls a second. */
export const GETLOGS_MIN_GAP_MS = 200;

/** Waits used when a retryable response has no readable Retry-After. One wait per retry. */
export const RETRY_BACKOFF_MS = Object.freeze([1_000, 2_000, 4_000]);

/** Extra attempts after the first getLogs failure. The pass then returns. */
export const MAX_SCAN_RETRIES = 3;

/**
 * Cap for a Retry-After delay. A larger delta-seconds value or a later HTTP-date
 * waits this long and no longer. 30 seconds.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT",
]);

export function sleepMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {{ now: () => number, sleep: (ms: number) => Promise<void>, minGapMs?: number }} options
 */
export function createRateLimiter(options) {
  const now = options.now;
  const sleep = options.sleep;
  const minGapMs = options.minGapMs ?? GETLOGS_MIN_GAP_MS;
  let nextAt = 0;
  let armed = false;
  return {
    async wait() {
      const current = now();
      if (armed && current < nextAt) await sleep(nextAt - current);
      nextAt = now() + minGapMs;
      armed = true;
    },
  };
}

function clampRetryAfter(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  if (ms > MAX_RETRY_AFTER_MS) return MAX_RETRY_AFTER_MS;
  return Math.floor(ms);
}

/**
 * Retry-After as integer seconds or an HTTP-date.
 * Returns milliseconds, or null when the header is missing or not one of those two forms.
 * A past HTTP-date is 0. Values above {@link MAX_RETRY_AFTER_MS} clamp to that cap.
 * @param {unknown} value
 * @param {number} nowMs
 * @returns {number | null}
 */
export function parseRetryAfter(value, nowMs) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isSafeInteger(seconds)) return null;
    return clampRetryAfter(seconds * 1000);
  }
  const dated = Date.parse(text);
  if (Number.isNaN(dated)) return null;
  const delta = dated - nowMs;
  if (!Number.isFinite(delta)) return null;
  return clampRetryAfter(Math.max(0, delta));
}

function walk(error) {
  const out = [];
  const seen = new Set();
  const queue = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    if (current.cause) queue.push(current.cause);
    if (Array.isArray(current.errors)) {
      for (const item of current.errors) queue.push(item);
    }
  }
  return out;
}

function numeric(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) return Number(value);
  return null;
}

function statusFrom(error) {
  for (const item of walk(error)) {
    const status = numeric(item.status ?? item.statusCode);
    if (status != null) return status;
  }
  return null;
}

function headerFrom(error, name) {
  const wanted = name.toLowerCase();
  for (const item of walk(error)) {
    const headers = item.headers;
    if (!headers) continue;
    if (typeof headers.get === "function") {
      const value = headers.get(name);
      if (value != null && String(value).trim() !== "") return String(value).trim();
    } else if (typeof headers === "object") {
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === wanted && value != null && String(value).trim() !== "") {
          return String(value).trim();
        }
      }
    }
  }
  return null;
}

/**
 * Rate-limit wording on details and shortMessage. The full viem message is ignored
 * because it embeds the request body.
 * @param {string} text
 */
export function textIsRateLimit(text) {
  const value = String(text ?? "").toLowerCase();
  if (!value) return false;
  if (value.includes("rate limit") || value.includes("rate-limit") || value.includes("ratelimit")) return true;
  if (value.includes("too many requests")) return true;
  if (value.includes("request limit") || value.includes("requests per")) return true;
  if (value.includes("throttl")) return true;
  if (value.includes("quota")) return true;
  if (/\b429\b/.test(value)) return true;
  return false;
}

function detailText(error) {
  const parts = [];
  for (const item of walk(error)) {
    if (item.details != null && item.details !== "") parts.push(item.details);
    if (item.shortMessage != null && item.shortMessage !== "") parts.push(item.shortMessage);
  }
  return parts.join(" ").toLowerCase();
}

function isNetworkError(error) {
  for (const item of walk(error)) {
    if (item.name === "TimeoutError") return true;
    if (typeof item.code === "string" && NETWORK_CODES.has(item.code)) return true;
    if (item.name === "TypeError" && /fetch failed/i.test(String(item.message ?? ""))) return true;
  }
  return false;
}

/**
 * Class for a retryable getLogs failure.
 * Range errors are not classified here; the caller must reject those first.
 * @param {unknown} error
 * @returns {"rate_limited" | "server_error" | "network_error" | null}
 */
export function scanErrorClass(error) {
  if (!error || typeof error !== "object") return null;
  const status = statusFrom(error);
  if (status === 429) return "rate_limited";
  if (status != null && status >= 500 && status <= 599) return "server_error";
  if (textIsRateLimit(detailText(error))) return "rate_limited";
  if (isNetworkError(error)) return "network_error";
  return null;
}

/**
 * Delay before the next attempt. A readable Retry-After replaces the schedule slot.
 * @param {unknown} error
 * @param {number} attempt 0-based index of the failure that just happened
 * @param {number} nowMs
 */
export function retryWaitMs(error, attempt, nowMs, options = {}) {
  const schedule = options.backoffMs ?? RETRY_BACKOFF_MS;
  const header = headerFrom(error, "retry-after");
  if (header != null) {
    const parsed = parseRetryAfter(header, nowMs);
    if (parsed != null) return parsed;
  }
  const index = Math.min(Math.max(attempt, 0), schedule.length - 1);
  return schedule[index];
}

/**
 * Pace every call and retry retryable failures. A non-retryable error is rethrown.
 * @param {{ now: () => number, sleep: (ms: number) => Promise<void>, minGapMs?: number, backoffMs?: number[], maxRetries?: number, classify?: (error: unknown) => string | null }} options
 */
export function createScanPacer(options) {
  const now = options.now;
  const sleep = options.sleep;
  const classify = options.classify ?? scanErrorClass;
  const maxRetries = options.maxRetries ?? MAX_SCAN_RETRIES;
  const limiter = createRateLimiter({
    now,
    sleep,
    minGapMs: options.minGapMs ?? GETLOGS_MIN_GAP_MS,
  });
  return {
    async run(fn) {
      let attempt = 0;
      for (;;) {
        await limiter.wait();
        try {
          return { ok: true, value: await fn() };
        } catch (error) {
          const reason = classify(error);
          if (!reason) throw error;
          if (attempt >= maxRetries) return { ok: false, reason, error };
          const wait = retryWaitMs(error, attempt, now(), {
            backoffMs: options.backoffMs,
          });
          if (wait > 0) await sleep(wait);
          attempt += 1;
        }
      }
    },
  };
}
