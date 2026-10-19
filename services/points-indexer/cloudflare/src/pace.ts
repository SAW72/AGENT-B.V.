/**
 * getLogs pacing. Numbers match the Node pace module:
 * 200 ms minimum gap, backoff 1 s / 2 s / 4 s, 3 retries, 30 s Retry-After cap.
 * Jitter is added on top of the gap and does not shrink it.
 */

export const GETLOGS_MIN_GAP_MS = 200;
export const RETRY_BACKOFF_MS = Object.freeze([1_000, 2_000, 4_000]);
export const MAX_SCAN_RETRIES = 3;
export const MAX_RETRY_AFTER_MS = 30_000;
export const RPC_TIMEOUT_MS = 15_000;

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

export function sleepMs(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Uniform integer in [0, span). Uses crypto.getRandomValues. */
export function jitterMs(span = GETLOGS_MIN_GAP_MS) {
  if (!Number.isInteger(span) || span <= 1) return 0;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % span;
}

export function createRateLimiter(options: {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  minGapMs?: number;
  jitter?: () => number;
}) {
  const now = options.now;
  const sleep = options.sleep;
  const minGapMs = options.minGapMs ?? GETLOGS_MIN_GAP_MS;
  const jitter = options.jitter ?? (() => jitterMs(minGapMs));
  let nextAt = 0;
  let armed = false;
  return {
    async wait() {
      const current = now();
      if (armed && current < nextAt) await sleep(nextAt - current);
      nextAt = now() + minGapMs + jitter();
      armed = true;
    },
  };
}

function clampRetryAfter(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  if (ms > MAX_RETRY_AFTER_MS) return MAX_RETRY_AFTER_MS;
  return Math.floor(ms);
}

export function parseRetryAfter(value: unknown, nowMs: number) {
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

function walk(error: unknown) {
  const out: object[] = [];
  const seen = new Set<object>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    const record = current as { cause?: unknown; errors?: unknown[] };
    if (record.cause) queue.push(record.cause);
    if (Array.isArray(record.errors)) {
      for (const item of record.errors) queue.push(item);
    }
  }
  return out;
}

function numeric(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) return Number(value);
  return null;
}

function statusFrom(error: unknown) {
  for (const item of walk(error)) {
    const record = item as { status?: unknown; statusCode?: unknown };
    const status = numeric(record.status ?? record.statusCode);
    if (status != null) return status;
  }
  return null;
}

function headerFrom(error: unknown, name: string) {
  const wanted = name.toLowerCase();
  for (const item of walk(error)) {
    const headers = (item as { headers?: unknown }).headers as
      | { get?: (name: string) => string | null }
      | Record<string, unknown>
      | undefined;
    if (!headers) continue;
    if (typeof (headers as { get?: unknown }).get === "function") {
      const value = (headers as { get: (name: string) => string | null }).get(name);
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

export function textIsRateLimit(text: string) {
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

function detailText(error: unknown) {
  const parts: string[] = [];
  for (const item of walk(error)) {
    const record = item as { details?: unknown; shortMessage?: unknown };
    if (record.details != null && record.details !== "") parts.push(String(record.details));
    if (record.shortMessage != null && record.shortMessage !== "") parts.push(String(record.shortMessage));
  }
  return parts.join(" ").toLowerCase();
}

function isNetworkError(error: unknown) {
  for (const item of walk(error)) {
    const record = item as { name?: string; code?: unknown; message?: unknown };
    if (record.name === "TimeoutError") return true;
    if (typeof record.code === "string" && NETWORK_CODES.has(record.code)) return true;
    if (record.name === "TypeError" && /fetch failed/i.test(String(record.message ?? ""))) return true;
  }
  return false;
}

export function scanErrorClass(error: unknown): "rate_limited" | "server_error" | "network_error" | null {
  if (!error || typeof error !== "object") return null;
  const status = statusFrom(error);
  if (status === 429) return "rate_limited";
  if (status != null && status >= 500 && status <= 599) return "server_error";
  if (textIsRateLimit(detailText(error))) return "rate_limited";
  if (isNetworkError(error)) return "network_error";
  return null;
}

export function retryWaitMs(error: unknown, attempt: number, nowMs: number, options: { backoffMs?: readonly number[] } = {}) {
  const schedule = options.backoffMs ?? RETRY_BACKOFF_MS;
  const header = headerFrom(error, "retry-after");
  if (header != null) {
    const parsed = parseRetryAfter(header, nowMs);
    if (parsed != null) return parsed;
  }
  const index = Math.min(Math.max(attempt, 0), schedule.length - 1);
  return schedule[index];
}

export function createScanPacer(options: {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  minGapMs?: number;
  backoffMs?: readonly number[];
  maxRetries?: number;
  jitter?: () => number;
  classify?: (error: unknown) => string | null;
}) {
  const now = options.now;
  const sleep = options.sleep;
  const classify = options.classify ?? scanErrorClass;
  const maxRetries = options.maxRetries ?? MAX_SCAN_RETRIES;
  const limiter = createRateLimiter({
    now,
    sleep,
    minGapMs: options.minGapMs ?? GETLOGS_MIN_GAP_MS,
    jitter: options.jitter,
  });
  return {
    async run<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: string; error: unknown }> {
      let attempt = 0;
      for (;;) {
        await limiter.wait();
        try {
          return { ok: true, value: await fn() };
        } catch (error) {
          const reason = classify(error);
          if (!reason) throw error;
          if (attempt >= maxRetries) return { ok: false, reason, error };
          const wait = retryWaitMs(error, attempt, now(), { backoffMs: options.backoffMs });
          if (wait > 0) await sleep(wait);
          attempt += 1;
        }
      }
    },
  };
}
