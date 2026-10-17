/**
 * Read-only preview routes for committed ledger rows.
 * Importing this module does not open a database, a socket, or a timer.
 * The core calls the injected store and does not read process.env.
 * The host passes an env object in. A node listener is a thin wrapper
 * around handle().
 */

import { isIP } from "node:net";
import { CHAIN_ID, ESCROW_START_BLOCK } from "./constants.mjs";

export const DEFAULT_CORS_ORIGIN = "https://agent-bv.pages.dev";
export const DEFAULT_RATE_PER_MINUTE = 60;
export const DEFAULT_PROXY_HOPS = 1;
export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_MAX_ENTRIES = 4096;
export const DEFAULT_SWEEP_MS = 60_000;
export const HISTORY_DEFAULT_LIMIT = 25;
export const HISTORY_MAX_LIMIT = 100;
export const MAX_FORWARDED_CHARS = 2048;
export const DEFAULT_BREAKER_FAILURES = 5;
export const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;

/** Names the host may pass on the env object. This module does not read process.env. */
export const READ_ENV_ALLOWLIST = Object.freeze([
  "POINTS_ENABLED",
  "POINTS_CORS_ORIGINS",
  "POINTS_TRUSTED_PROXY_HOPS",
  "POINTS_READ_RATE_PER_MINUTE",
  "POINTS_BREAKER_FAILURES",
  "POINTS_BREAKER_COOLDOWN_MS",
]);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EXACT_HTTPS_ORIGIN =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const DISCLAIMER_TEXT = "Testnet only. Not a token. It cannot be transferred, sold, or redeemed. It may be adjusted or cancelled.";
const DISCLAIMER_LINK_SLOTS = [
  "master_disclaimer",
  "bvt_securities_disclaimer",
  "as_is",
  "not_investment",
  "eligibility_notice",
  "abuse_policy",
];

/**
 * Distance from the scan cursor to the stored finalized head.
 * With no cursor, the distance is from the escrow start block.
 * @param {number | null} head
 * @param {number | null} cursor
 */
export function blocksBehind(head, cursor) {
  if (!Number.isSafeInteger(head)) return null;
  if (cursor == null) {
    if (head < ESCROW_START_BLOCK) return 0;
    return head - ESCROW_START_BLOCK + 1;
  }
  if (!Number.isSafeInteger(cursor)) return null;
  return Math.max(0, head - cursor);
}

/**
 * POINTS_ENABLED is off unless the value is 1, true, on, or yes.
 * An unset or blank value stays off.
 * @param {{ POINTS_ENABLED?: unknown } | undefined} env
 */
export function pointsEnabled(env) {
  const raw = env?.POINTS_ENABLED;
  if (raw == null || String(raw).trim() === "") return false;
  const text = String(raw).trim().toLowerCase();
  return text === "1" || text === "true" || text === "on" || text === "yes";
}

/**
 * @param {unknown} raw
 */
export function parseExactHttpsOrigin(raw) {
  const original = String(raw ?? "").trim();
  if (!original) return { ok: false };
  if (original.includes("*")) return { ok: false };
  if (original.toLowerCase() === "null") return { ok: false };
  const stripped = original.endsWith("/") ? original.slice(0, -1) : original;
  const separator = stripped.indexOf("://");
  if (separator <= 0) return { ok: false };
  const scheme = stripped.slice(0, separator).toLowerCase();
  if (scheme !== "https") return { ok: false };
  const rest = stripped.slice(separator + 3);
  if (!rest || rest.includes("@")) return { ok: false };
  const tailAt = rest.search(/[/?#]/);
  const hostRaw = tailAt === -1 ? rest : rest.slice(0, tailAt);
  const tail = tailAt === -1 ? "" : rest.slice(tailAt);
  if (tail) return { ok: false };
  if (hostRaw.includes(":")) return { ok: false };
  const entry = `https://${hostRaw.toLowerCase()}`;
  if (!EXACT_HTTPS_ORIGIN.test(entry)) return { ok: false };
  let url;
  try {
    url = new URL(entry);
  } catch {
    return { ok: false };
  }
  if (
    url.origin !== entry
    || url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    return { ok: false };
  }
  return { ok: true, origin: entry };
}

/**
 * Blank means the default origin. A set value replaces that default.
 * Entries that are not an exact https origin are dropped.
 * @param {unknown} value
 */
export function parseCorsList(value) {
  if (value == null || String(value).trim() === "") return [DEFAULT_CORS_ORIGIN];
  const out = [];
  for (const part of String(value).split(",")) {
    const parsed = parseExactHttpsOrigin(part);
    if (parsed.ok && !out.includes(parsed.origin)) out.push(parsed.origin);
  }
  return out;
}

/**
 * Non-negative integer. Blank or malformed falls back to 1.
 * Zero is kept: it means the forwarded header is not trusted.
 * @param {unknown} value
 */
export function parseProxyHops(value) {
  if (value == null || String(value).trim() === "") return DEFAULT_PROXY_HOPS;
  const text = String(value).trim();
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return DEFAULT_PROXY_HOPS;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_PROXY_HOPS;
  return parsed;
}

/**
 * Positive integer. Blank or malformed falls back to the design default.
 * @param {unknown} value
 */
export function parseRatePerMinute(value) {
  if (value == null || String(value).trim() === "") return DEFAULT_RATE_PER_MINUTE;
  const text = String(value).trim();
  if (!/^[1-9][0-9]*$/.test(text)) return DEFAULT_RATE_PER_MINUTE;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_RATE_PER_MINUTE;
  return parsed;
}

/**
 * Positive integer. Blank or malformed falls back to 5.
 * @param {unknown} value
 */
export function parseBreakerFailures(value) {
  if (value == null || String(value).trim() === "") return DEFAULT_BREAKER_FAILURES;
  const text = String(value).trim();
  if (!/^[1-9][0-9]*$/.test(text)) return DEFAULT_BREAKER_FAILURES;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_BREAKER_FAILURES;
  return parsed;
}

/**
 * Non-negative integer milliseconds. Blank or malformed falls back to 30000.
 * @param {unknown} value
 */
export function parseBreakerCooldownMs(value) {
  if (value == null || String(value).trim() === "") return DEFAULT_BREAKER_COOLDOWN_MS;
  const text = String(value).trim();
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return DEFAULT_BREAKER_COOLDOWN_MS;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_BREAKER_COOLDOWN_MS;
  return parsed;
}

/**
 * Settings the host reads off an env object. This does not touch process.env.
 * @param {object | undefined} env
 */
export function readSettings(env) {
  const source = env ?? {};
  return {
    corsOrigins: parseCorsList(source.POINTS_CORS_ORIGINS),
    trustedProxyHops: parseProxyHops(source.POINTS_TRUSTED_PROXY_HOPS),
    ratePerMinute: parseRatePerMinute(source.POINTS_READ_RATE_PER_MINUTE),
    breakerFailures: parseBreakerFailures(source.POINTS_BREAKER_FAILURES),
    breakerCooldownMs: parseBreakerCooldownMs(source.POINTS_BREAKER_COOLDOWN_MS),
  };
}

function expandIPv6(input) {
  let text = String(input).trim().toLowerCase();
  if (text.includes("%")) return null;
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const parts = dotted[2].split(".").map((part) => Number(part));
    if (parts.some((part) => !Number.isInteger(part) || part > 255)) return null;
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    text = `${dotted[1]}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : halves[1].split(":")) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 && missing < 1) return null;
  const groups = halves.length === 2 ? [...head, ...Array(missing).fill("0"), ...tail] : head;
  if (groups.length !== 8) return null;
  const nums = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    nums.push(Number.parseInt(group, 16));
  }
  return nums;
}

/**
 * IPv4 stays as itself. IPv4-mapped IPv6 is unwrapped to that IPv4.
 * Other IPv6 addresses share a bucket for the high 64 bits.
 * @param {unknown} address
 * @returns {string | null}
 */
export function bucketClientAddress(address) {
  if (typeof address !== "string") return null;
  let text = address.trim();
  if (!text) return null;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end <= 1) return null;
    const rest = text.slice(end + 1);
    if (rest !== "" && !/^:\d+$/.test(rest)) return null;
    text = text.slice(1, end);
  } else {
    const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(text);
    if (v4port) text = v4port[1];
  }
  const kind = isIP(text);
  if (kind === 4) return text;
  if (kind !== 6) return null;
  const groups = expandIPv6(text);
  if (!groups) return null;
  const mapped = groups[0] === 0
    && groups[1] === 0
    && groups[2] === 0
    && groups[3] === 0
    && groups[4] === 0
    && groups[5] === 0xffff;
  if (mapped) {
    const hi = groups[6];
    const lo = groups[7];
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  const prefix = groups.slice(0, 4).map((part) => part.toString(16)).join(":");
  return `${prefix}::/64`;
}

function socketBucket(input) {
  const address = input?.remoteAddress ?? input?.socket?.remoteAddress;
  return bucketClientAddress(address) || "unknown";
}

/**
 * Trusted proxy hops are counted from the right of X-Forwarded-For.
 * Hop 1 is the rightmost entry (the address a single appending proxy adds).
 * Hop 0 uses remoteAddress. A missing, empty, too-short, or malformed header
 * uses remoteAddress as well. The leftmost entry is never selected on its own.
 * @param {{ headers?: object, remoteAddress?: string, socket?: { remoteAddress?: string } }} input
 * @param {number} [hops]
 */
export function clientIp(input, hops = DEFAULT_PROXY_HOPS) {
  const socket = socketBucket(input);
  const hopCount = Number.isInteger(hops) && hops >= 0 ? hops : DEFAULT_PROXY_HOPS;
  if (hopCount === 0) return socket;
  const rawHeader = input?.headers?.["x-forwarded-for"];
  const header = Array.isArray(rawHeader) ? rawHeader.join(",") : rawHeader;
  if (typeof header !== "string") return socket;
  if (header.length === 0 || header.length > MAX_FORWARDED_CHARS) return socket;
  const parts = header.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < hopCount) return socket;
  const selected = parts[parts.length - hopCount];
  return bucketClientAddress(selected) || socket;
}

/**
 * In-memory window limiter. The sweep timer is unref'd so it does not
 * keep the process alive. maxEntries evicts the oldest key.
 * @param {{ windowMs?: number, max?: number, maxEntries?: number, clock?: () => number, sweepMs?: number }} [options]
 */
export function createRateLimiter(options = {}) {
  const windowMs = Number.isInteger(options.windowMs) && options.windowMs > 0 ? options.windowMs : DEFAULT_WINDOW_MS;
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : DEFAULT_RATE_PER_MINUTE;
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : DEFAULT_MAX_ENTRIES;
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const sweepMs = Number.isInteger(options.sweepMs) && options.sweepMs > 0 ? options.sweepMs : DEFAULT_SWEEP_MS;
  const hits = new Map();

  const sweep = () => {
    const now = clock();
    for (const [key, stamps] of hits) {
      const fresh = stamps.filter((ts) => now - ts < windowMs);
      if (fresh.length === 0) hits.delete(key);
      else hits.set(key, fresh);
    }
  };

  const timer = setInterval(sweep, sweepMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    timer,
    sweep,
    size: () => hits.size,
    close() {
      clearInterval(timer);
    },
    allow(key) {
      const now = clock();
      const id = String(key || "unknown");
      const prev = hits.get(id) || [];
      const fresh = prev.filter((ts) => now - ts < windowMs);
      if (fresh.length >= max) {
        hits.set(id, fresh);
        const retryAfterMs = Math.max(0, fresh[0] + windowMs - now);
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      }
      if (!hits.has(id) && hits.size >= maxEntries) {
        const oldest = hits.keys().next().value;
        if (oldest !== undefined) hits.delete(oldest);
      }
      fresh.push(now);
      hits.set(id, fresh);
      return { ok: true };
    },
  };
}

/**
 * Store the host injects. The core calls only these four methods.
 * getCursor() returns last_scanned_block, finalized_block, and pass_completed.
 * getLedgerSummary(address) returns points_total, rows_count, and first_activity_utc_day.
 * listLedgerRows(address, { limit, afterSeq }) returns row objects. seq is for the cursor.
 * getConfig() returns weights, gates, and rule_version.
 */

function disclaimer() {
  const links = {};
  for (const key of DISCLAIMER_LINK_SLOTS) links[key] = null;
  return { text: DISCLAIMER_TEXT, links };
}

function asInt(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function readSync(store) {
  const raw = store.getCursor();
  const cursor = asInt(raw?.last_scanned_block);
  const finalized = asInt(raw?.finalized_block);
  const behind = blocksBehind(finalized, cursor);
  const pass = raw?.pass_completed === true;
  const syncing = !pass || behind == null || behind > 0;
  return {
    indexed_to_block: cursor,
    finalized_block: finalized,
    behind,
    syncing,
  };
}

function syncFields(sync) {
  return {
    indexed_to_block: sync.indexed_to_block,
    finalized_block: sync.finalized_block,
    behind: sync.behind,
    syncing: sync.syncing,
  };
}

/**
 * Named columns only. seq is read for the cursor and is not returned.
 * @param {object} row
 */
function publicHistoryItem(row) {
  return {
    action: row.action,
    utc_day: row.utc_day,
    tx_hash: row.tx_hash,
    log_index: row.log_index,
    block_number: row.block_number,
    escrow_id: row.escrow_id,
    points: typeof row.points === "bigint" ? Number(row.points) : row.points,
    points_withheld: row.points_withheld === 1 || row.points_withheld === true,
    eligibility_reason: row.eligibility_reason,
    register_status: row.register_status ?? null,
  };
}

function addressBody(sync, wallet, summary) {
  return {
    address: wallet,
    chainId: CHAIN_ID,
    points_total: Number(summary.points_total),
    points_withheld: true,
    eligibility: { status: "unverified", reason: "ofac_unconfigured" },
    rows_count: Number(summary.rows_count),
    first_activity_utc_day: summary.first_activity_utc_day ?? null,
    ...syncFields(sync),
    disclaimer: disclaimer(),
  };
}

function historyBody(sync, wallet, limit, cursor, rows) {
  const page = rows.slice(0, limit);
  return {
    address: wallet,
    chainId: CHAIN_ID,
    limit,
    items: page.map(publicHistoryItem),
    next_cursor: rows.length > limit ? String(page[page.length - 1].seq) : null,
    ...syncFields(sync),
  };
}

function parseChain(raw) {
  if (raw == null || String(raw).trim() === "") return { ok: true };
  return { ok: String(raw).trim() === String(CHAIN_ID) };
}

function parseLimit(raw) {
  if (raw == null || raw === "") return { ok: true, limit: HISTORY_DEFAULT_LIMIT };
  if (!/^[1-9][0-9]*$/.test(raw)) return { ok: false };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return { ok: false };
  return { ok: true, limit: Math.min(HISTORY_MAX_LIMIT, value) };
}

function parseCursor(raw) {
  if (raw == null || raw === "") return { ok: true, seq: 0 };
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return { ok: false };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return { ok: false };
  return { ok: true, seq: value };
}

function routeOf(pathname) {
  if (pathname === "/v1/points/config") return { kind: "config" };
  const history = pathname.match(/^\/v1\/points\/([^/]+)\/history$/);
  if (history) return { kind: "history", address: history[1] };
  const balance = pathname.match(/^\/v1\/points\/([^/]+)$/);
  if (balance) return { kind: "address", address: balance[1] };
  return null;
}

/**
 * Consecutive thrown reads open the breaker. A cool-down then rejects
 * with points_unavailable. One probe after the cool-down closes it again
 * when that probe finishes, or opens it again when the probe throws.
 * @param {number} limit
 * @param {number} cooldownMs
 * @param {() => number} clock
 */
function createBreaker(limit, cooldownMs, clock) {
  let state = "closed";
  let consecutive = 0;
  let openedAt = 0;

  return {
    state() {
      return state;
    },
    admit() {
      if (state === "closed") return true;
      if (state === "half_open") return false;
      if (clock() - openedAt < cooldownMs) return false;
      state = "half_open";
      return true;
    },
    success() {
      consecutive = 0;
      state = "closed";
    },
    failure() {
      if (state === "half_open") {
        state = "open";
        openedAt = clock();
        consecutive = 0;
        return;
      }
      consecutive += 1;
      if (consecutive >= limit) {
        state = "open";
        openedAt = clock();
        consecutive = 0;
      }
    },
  };
}

/**
 * @param {{ store?: object, config?: object, now?: () => number, enabled?: boolean | (() => boolean) }} [options]
 * @returns {((req: object, res: object) => void) & { close: () => void, breakerState: () => string, handle: (input: object) => { status: number, headers: object, body: object | null } }}
 */
export function createReadApi(options = {}) {
  const config = options.config ?? {};
  const origins = new Set(
    Array.isArray(config.corsOrigins) ? config.corsOrigins : parseCorsList(config.corsOrigins),
  );
  const hops = Number.isInteger(config.trustedProxyHops) && config.trustedProxyHops >= 0
    ? config.trustedProxyHops
    : DEFAULT_PROXY_HOPS;
  const rateMax = Number.isInteger(config.ratePerMinute) && config.ratePerMinute > 0
    ? config.ratePerMinute
    : DEFAULT_RATE_PER_MINUTE;
  const clock = typeof options.now === "function" ? options.now : Date.now;
  const limiter = createRateLimiter({
    windowMs: config.windowMs,
    max: rateMax,
    maxEntries: config.maxEntries,
    clock,
    sweepMs: config.sweepMs,
  });
  const breakerFailures = Number.isInteger(config.breakerFailures) && config.breakerFailures > 0
    ? config.breakerFailures
    : DEFAULT_BREAKER_FAILURES;
  const breakerCooldownMs = Number.isInteger(config.breakerCooldownMs) && config.breakerCooldownMs >= 0
    ? config.breakerCooldownMs
    : DEFAULT_BREAKER_COOLDOWN_MS;
  const breaker = createBreaker(breakerFailures, breakerCooldownMs, clock);
  const enabledFn = typeof options.enabled === "function"
    ? options.enabled
    : () => pointsEnabled(options.enabled === true ? { POINTS_ENABLED: "1" } : {});
  const store = options.store;

  function requestOrigin(input) {
    if (typeof input?.origin === "string") return input.origin;
    const header = input?.headers?.origin;
    return typeof header === "string" ? header : undefined;
  }

  function corsHeaders(input) {
    const headers = {
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, OPTIONS",
      vary: "Origin",
    };
    const origin = requestOrigin(input);
    if (typeof origin !== "string") return headers;
    const parsed = parseExactHttpsOrigin(origin);
    if (parsed.ok && origins.has(parsed.origin)) {
      headers["access-control-allow-origin"] = parsed.origin;
    }
    return headers;
  }

  function result(status, body, input, extra) {
    const headers = {
      "cache-control": "no-store",
      ...corsHeaders(input),
      ...extra,
    };
    if (body == null) {
      headers["content-length"] = "0";
      return { status, headers, body: null };
    }
    const payload = JSON.stringify(body);
    headers["content-type"] = "application/json; charset=utf-8";
    headers["content-length"] = Buffer.byteLength(payload);
    return { status, headers, body };
  }

  function fail(status, code, input, extra) {
    return result(status, { ok: false, error: code }, input, extra);
  }

  function serve(input) {
    const pathname = String(input?.path || "/").replace(/\/+$/, "") || "/";
    const query = input?.query ?? {};
    const route = routeOf(pathname);
    if (input?.method === "OPTIONS" && route) {
      return result(204, null, input, { allow: "GET, OPTIONS" });
    }
    if (input?.method !== "OPTIONS") {
      const decision = limiter.allow(clientIp(input, hops));
      if (!decision.ok) {
        return fail(429, "rate_limited", input, { "retry-after": String(decision.retryAfterSec) });
      }
    }
    if (!route) return fail(404, "not_found", input);
    if (input?.method !== "GET") {
      return fail(405, "method_not_allowed", input, { allow: "GET, OPTIONS" });
    }
    if (!parseChain(query.chainId).ok) return fail(400, "wrong_chain", input);
    if (route.kind === "config") {
      const points = store.getConfig();
      return result(200, {
        chainId: CHAIN_ID,
        status: "draft",
        weights: points.weights,
        gates: points.gates,
        rule_version: points.rule_version,
      }, input);
    }
    let addressText;
    try {
      addressText = decodeURIComponent(route.address);
    } catch {
      return fail(400, "invalid_address", input);
    }
    if (!ADDRESS.test(addressText)) return fail(400, "invalid_address", input);
    const wallet = addressText.toLowerCase();
    const sync = readSync(store);
    if (route.kind === "address") {
      return result(200, addressBody(sync, wallet, store.getLedgerSummary(wallet)), input);
    }
    const limit = parseLimit(query.limit);
    if (!limit.ok) return fail(400, "invalid_limit", input);
    const cursor = parseCursor(query.cursor);
    if (!cursor.ok) return fail(400, "invalid_cursor", input);
    const rows = store.listLedgerRows(wallet, { limit: limit.limit + 1, afterSeq: cursor.seq });
    return result(200, historyBody(sync, wallet, limit.limit, cursor.seq, rows), input);
  }

  function handle(input) {
    try {
      if (enabledFn() !== true) return fail(503, "points_disabled", input);
      if (!breaker.admit()) {
        return fail(503, "points_unavailable", input);
      }
      try {
        const outcome = serve(input);
        breaker.success();
        return outcome;
      } catch (error) {
        breaker.failure();
        throw error;
      }
    } catch {
      try {
        return fail(500, "internal", input);
      } catch {
        return {
          status: 500,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "content-length": Buffer.byteLength('{"ok":false,"error":"internal"}'),
          },
          body: { ok: false, error: "internal" },
        };
      }
    }
  }

  function writeResult(res, outcome) {
    if (outcome.body == null) {
      res.writeHead(outcome.status, outcome.headers);
      res.end();
      return;
    }
    res.writeHead(outcome.status, outcome.headers);
    res.end(JSON.stringify(outcome.body));
  }

  function fromNodeRequest(req) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const query = {};
    for (const key of url.searchParams.keys()) {
      if (query[key] === undefined) query[key] = url.searchParams.get(key);
    }
    const headerOrigin = req.headers?.origin;
    return {
      method: req.method,
      path: url.pathname,
      query,
      headers: req.headers || {},
      remoteAddress: req.socket?.remoteAddress,
      origin: typeof headerOrigin === "string" ? headerOrigin : undefined,
    };
  }

  function nodeHandler(req, res) {
    try {
      writeResult(res, handle(fromNodeRequest(req)));
    } catch {
      try {
        if (res.headersSent) {
          res.end();
          return;
        }
        const payload = JSON.stringify({ ok: false, error: "internal" });
        res.writeHead(500, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
      } catch {
        try {
          if (typeof res.end === "function" && !res.writableEnded) res.end();
        } catch {
          // The request callback must not throw.
        }
      }
    }
  }

  nodeHandler.close = () => limiter.close();
  nodeHandler.breakerState = () => breaker.state();
  nodeHandler.handle = handle;
  return nodeHandler;
}
