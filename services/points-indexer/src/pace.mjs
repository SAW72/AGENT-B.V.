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
 * Cap for one in-pass Retry-After sleep. A larger value sleeps this long, ends
 * the pass, and the next pass waits the remainder before any RPC. 30 seconds.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const RFC_850_DATE = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
const ASCTIME_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4}$/;

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
 * @param {{ now: () => number, sleep: (ms: number) => Promise<void>, minGapMs?: number, gapJitterMs?: number, random?: () => number }} options
 */
export function createRateLimiter(options) {
  const now = options.now;
  const sleep = options.sleep;
  const minGapMs = options.minGapMs ?? GETLOGS_MIN_GAP_MS;
  const gapJitterMs = options.gapJitterMs ?? 0;
  const random = options.random ?? Math.random;
  let nextAt = 0;
  let armed = false;
  return {
    async wait() {
      const current = now();
      if (armed && current < nextAt) await sleep(nextAt - current);
      nextAt = now() + minGapMs + jitterMs(gapJitterMs, random);
      armed = true;
    },
  };
}

function clampRetryAfter(ms, cap = MAX_RETRY_AFTER_MS) {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  if (ms > cap) return cap;
  return Math.floor(ms);
}

function isHttpDate(text) {
  return IMF_FIXDATE.test(text) || RFC_850_DATE.test(text) || ASCTIME_DATE.test(text);
}

/**
 * Unclamped Retry-After in milliseconds.
 * Integer seconds, or an HTTP-date in IMF-fixdate, RFC 850, or asctime form.
 * Anything else, including a fraction or a leading minus, is null.
 * A past HTTP-date is 0.
 * @param {unknown} value
 * @param {number} nowMs
 * @returns {number | null}
 */
function readRetryAfter(value, nowMs) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isSafeInteger(seconds)) return null;
    return seconds * 1000;
  }
  if (!isHttpDate(text)) return null;
  const dated = Date.parse(text);
  if (Number.isNaN(dated)) return null;
  const delta = dated - nowMs;
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return Math.floor(delta);
}

/**
 * Retry-After as integer seconds or an HTTP-date.
 * Returns milliseconds, or null when the header is missing or not one of those two forms.
 * A past HTTP-date is 0. Values above {@link MAX_RETRY_AFTER_MS} clamp to that cap.
 * The unclamped value is what a pass carries when the header is longer than the cap.
 * @param {unknown} value
 * @param {number} nowMs wall-clock epoch milliseconds, for an HTTP-date only
 * @param {number} [cap]
 * @returns {number | null}
 */
export function parseRetryAfter(value, nowMs, cap = MAX_RETRY_AFTER_MS) {
  const full = readRetryAfter(value, nowMs);
  if (full == null) return null;
  return clampRetryAfter(full, cap);
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
  if (value.includes("rate exceeded")) return true;
  if (value.includes("too many requests")) return true;
  if (value.includes("request limit") || value.includes("requests per")) return true;
  if (value.includes("throttl")) return true;
  if (value.includes("quota")) return true;
  if (value.includes("compute units")) return true;
  if (value.includes("capacity")) return true;
  if (value.includes("credits exceeded")) return true;
  if (value.includes("daily request count exceeded")) return true;
  if (value.includes("limit exceeded")) return true;
  if (/\b429\b/.test(value)) return true;
  return false;
}

/**
 * The provider head has not reached the requested block yet.
 * This is a wait, not a window shrink. "block range is too large" does not match.
 * @param {string} text
 */
export function textIsHeadLag(text) {
  const value = String(text ?? "").toLowerCase();
  if (!value) return false;
  if (value.includes("beyond current head")) return true;
  if (value.includes("extends beyond") && value.includes("head")) return true;
  return false;
}

/**
 * Extra delay added on top of a gap or a schedule slot. A span of 0 is 0.
 * The roll is in [0, 1). The result is never negative, so the minimum gap stays put.
 * @param {number} span
 * @param {() => number} [random]
 */
export function jitterMs(span, random = Math.random) {
  const width = Number(span);
  if (!Number.isFinite(width) || width <= 0) return 0;
  const roll = Number(random());
  if (!Number.isFinite(roll) || roll <= 0) return 0;
  if (roll >= 1) return Math.floor(width);
  return Math.floor(roll * width);
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
 * @returns {"rate_limited" | "server_error" | "network_error" | "head_lag" | null}
 */
export function scanErrorClass(error) {
  if (!error || typeof error !== "object") return null;
  const status = statusFrom(error);
  if (status === 429) return "rate_limited";
  if (status != null && status >= 500 && status <= 599) return "server_error";
  const text = detailText(error);
  if (textIsHeadLag(text)) return "head_lag";
  if (textIsRateLimit(text)) return "rate_limited";
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
  const cap = options.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS;
  const header = headerFrom(error, "retry-after");
  if (header != null) {
    const parsed = parseRetryAfter(header, nowMs, cap);
    if (parsed != null) return parsed;
  }
  const index = Math.min(Math.max(attempt, 0), schedule.length - 1);
  const random = options.random ?? Math.random;
  return schedule[index] + jitterMs(options.backoffJitterMs ?? 0, random);
}

/**
 * Pace every call and retry retryable failures. A non-retryable error is rethrown.
 * `now` is the monotonic gap clock. `wallNow` is epoch milliseconds and is used
 * only when Retry-After is an HTTP-date. Jitter is added on top of the gap and
 * the schedule. A readable Retry-After is not jittered. A Retry-After longer
 * than the cap sleeps the cap once, ends this call, and returns `deferUntil`
 * so the next pass can wait out the rest before it dials.
 * @param {{ now: () => number, wallNow?: () => number, sleep: (ms: number) => Promise<void>, minGapMs?: number, gapJitterMs?: number, backoffMs?: number[], backoffJitterMs?: number, maxRetries?: number, maxRetryAfterMs?: number, random?: () => number, classify?: (error: unknown) => string | null }} options
 */
export function createScanPacer(options) {
  const now = options.now;
  const wallNow = options.wallNow ?? (() => Date.now());
  const sleep = options.sleep;
  const classify = options.classify ?? scanErrorClass;
  const maxRetries = options.maxRetries ?? MAX_SCAN_RETRIES;
  const random = options.random ?? Math.random;
  const limiter = createRateLimiter({
    now,
    sleep,
    minGapMs: options.minGapMs ?? GETLOGS_MIN_GAP_MS,
    gapJitterMs: options.gapJitterMs ?? 0,
    random,
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
          const cap = options.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS;
          const header = headerFrom(error, "retry-after");
          if (header != null) {
            const started = wallNow();
            const full = readRetryAfter(header, started);
            if (full != null && full > cap) {
              const wait = Math.min(full, cap);
              if (wait > 0) await sleep(wait);
              return { ok: false, reason, error, deferUntil: started + full };
            }
          }
          if (attempt >= maxRetries) return { ok: false, reason, error };
          const wait = retryWaitMs(error, attempt, wallNow(), {
            backoffMs: options.backoffMs,
            maxRetryAfterMs: cap,
            backoffJitterMs: options.backoffJitterMs ?? 0,
            random,
          });
          if (wait > 0) await sleep(wait);
          attempt += 1;
        }
      }
    },
  };
}
