/**
 * Read-only HTTP routes for committed ledger rows.
 * Importing this module does not open a database, a socket, or a timer.
 * The handler reads the ledger through the injected store and does not
 * assume the sqlite file is still on disk after a restart.
 */

import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
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

const WEIGHT_KEYS = [
  "first_activity",
  "fund",
  "release_or_refund",
  "dispute_open_or_vote",
  "vote",
  "return_day",
];
const GATE_KEYS = [
  "same_pair_per_day",
  "same_pair_lifetime",
  "min_escrow_amount_wei",
  "min_escrow_duration_seconds",
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
 * POINTS_READ_API_ENABLED is off unless the value is 1, true, on, or yes.
 * @param {NodeJS.ProcessEnv | { POINTS_READ_API_ENABLED?: unknown } | undefined} env
 */
export function readApiEnabled(env) {
  const raw = env?.POINTS_READ_API_ENABLED;
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

function socketBucket(req) {
  return bucketClientAddress(req.socket?.remoteAddress) || "unknown";
}

/**
 * Trusted proxy hops are counted from the right of X-Forwarded-For.
 * Hop 1 is the rightmost entry (the address a single appending proxy adds).
 * Hop 0 uses the socket. A missing, empty, too-short, or malformed header
 * uses the socket as well. The leftmost entry is never selected on its own.
 * @param {import("node:http").IncomingMessage} req
 * @param {number} [hops]
 */
export function clientIp(req, hops = DEFAULT_PROXY_HOPS) {
  const socket = socketBucket(req);
  const hopCount = Number.isInteger(hops) && hops >= 0 ? hops : DEFAULT_PROXY_HOPS;
  if (hopCount === 0) return socket;
  const rawHeader = req.headers?.["x-forwarded-for"];
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

function scalarOrNull(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value;
  return null;
}

function loadPointsFile() {
  const filePath = fileURLToPath(new URL("../config/points.json", import.meta.url));
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  const weights = {};
  for (const key of WEIGHT_KEYS) weights[key] = scalarOrNull(raw?.weights?.[key]);
  const gates = {};
  for (const key of GATE_KEYS) gates[key] = scalarOrNull(raw?.gates?.[key]);
  const rule = raw?.rule_version;
  const ruleVersion = rule == null ? null : (typeof rule === "string" ? rule : null);
  return { weights, gates, rule_version: ruleVersion };
}

function disclaimer() {
  const links = {};
  for (const key of DISCLAIMER_LINK_SLOTS) links[key] = null;
  return { text: DISCLAIMER_TEXT, links };
}

function asInt(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function emptySync() {
  return {
    indexed_to_block: null,
    finalized_block: null,
    behind: null,
    syncing: true,
  };
}

function readSync(store) {
  if (!store || typeof store.db !== "function") return { db: null, ...emptySync() };
  const db = store.db();
  if (!db) return { db: null, ...emptySync() };
  const cursor = asInt(store.lastScannedBlock());
  const finalized = asInt(store.finalizedBlock());
  const behind = blocksBehind(finalized, cursor);
  const pass = store.passCompleted() === true;
  const syncing = !pass || behind == null || behind > 0;
  return {
    db,
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

function addressBody(sync, wallet) {
  const base = {
    address: wallet,
    chainId: CHAIN_ID,
    points_total: 0,
    points_withheld: true,
    eligibility: { status: "unverified", reason: "ofac_unconfigured" },
    rows_count: 0,
    first_activity_utc_day: null,
    ...syncFields(sync),
    disclaimer: disclaimer(),
  };
  if (!sync.db) return base;
  const totals = sync.db.prepare(
    `SELECT COALESCE(SUM(points), 0) AS points_total, COUNT(*) AS rows_count
     FROM ledger_rows WHERE wallet = ? AND chain_id = ?`,
  ).get(wallet, CHAIN_ID);
  const first = sync.db.prepare(
    `SELECT utc_day FROM ledger_rows
     WHERE wallet = ? AND chain_id = ? AND action = 'first_activity'
     LIMIT 1`,
  ).get(wallet, CHAIN_ID);
  return {
    ...base,
    points_total: Number(totals.points_total),
    rows_count: Number(totals.rows_count),
    first_activity_utc_day: first ? first.utc_day : null,
  };
}

function historyBody(sync, wallet, limit, cursor) {
  const fields = {
    address: wallet,
    chainId: CHAIN_ID,
    limit,
    items: [],
    next_cursor: null,
    ...syncFields(sync),
  };
  if (!sync.db) return fields;
  const rows = sync.db.prepare(
    `SELECT * FROM ledger_rows
     WHERE wallet = ? AND chain_id = ? AND seq > ?
     ORDER BY seq ASC
     LIMIT ?`,
  ).all(wallet, CHAIN_ID, cursor, limit + 1);
  const page = rows.slice(0, limit);
  fields.items = page.map(publicHistoryItem);
  fields.next_cursor = rows.length > limit ? String(page[page.length - 1].seq) : null;
  return fields;
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
 * @param {{ store?: object, config?: object, now?: () => number, enabled?: boolean | (() => boolean) }} [options]
 * @returns {((req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) & { close: () => void }}
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
  const enabledFn = typeof options.enabled === "function"
    ? options.enabled
    : () => readApiEnabled(options.enabled === true ? { POINTS_READ_API_ENABLED: "1" } : {});
  let pointsCache = config.points ?? null;

  function pointsView() {
    if (!pointsCache) pointsCache = loadPointsFile();
    return pointsCache;
  }

  function corsHeaders(req) {
    const headers = {
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, OPTIONS",
      vary: "Origin",
    };
    const origin = req.headers?.origin;
    if (typeof origin !== "string") return headers;
    const parsed = parseExactHttpsOrigin(origin);
    if (parsed.ok && origins.has(parsed.origin)) {
      headers["access-control-allow-origin"] = parsed.origin;
    }
    return headers;
  }

  function send(res, req, status, body, extra) {
    const headers = {
      "cache-control": "no-store",
      ...corsHeaders(req),
      ...extra,
    };
    if (body == null) {
      headers["content-length"] = "0";
      res.writeHead(status, headers);
      res.end();
      return;
    }
    const payload = JSON.stringify(body);
    headers["content-type"] = "application/json; charset=utf-8";
    headers["content-length"] = Buffer.byteLength(payload);
    res.writeHead(status, headers);
    res.end(payload);
  }

  function fail(res, req, status, code, extra) {
    send(res, req, status, { ok: false, error: code }, extra);
  }

  function handler(req, res) {
    try {
      if (enabledFn() !== true) {
        fail(res, req, 404, "not_found");
        return;
      }
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const pathname = url.pathname.replace(/\/+$/, "") || "/";
      const route = routeOf(pathname);
      if (req.method === "OPTIONS" && route) {
        send(res, req, 204, null, { allow: "GET, OPTIONS" });
        return;
      }
      if (req.method !== "OPTIONS") {
        const decision = limiter.allow(clientIp(req, hops));
        if (!decision.ok) {
          fail(res, req, 429, "rate_limited", { "retry-after": String(decision.retryAfterSec) });
          return;
        }
      }
      if (!route) {
        fail(res, req, 404, "not_found");
        return;
      }
      if (req.method !== "GET") {
        fail(res, req, 405, "method_not_allowed", { allow: "GET, OPTIONS" });
        return;
      }
      if (!parseChain(url.searchParams.get("chainId")).ok) {
        fail(res, req, 400, "wrong_chain");
        return;
      }
      if (route.kind === "config") {
        const points = pointsView();
        send(res, req, 200, {
          chainId: CHAIN_ID,
          status: "draft",
          weights: points.weights,
          gates: points.gates,
          rule_version: points.rule_version,
        });
        return;
      }
      let addressText;
      try {
        addressText = decodeURIComponent(route.address);
      } catch {
        fail(res, req, 400, "invalid_address");
        return;
      }
      if (!ADDRESS.test(addressText)) {
        fail(res, req, 400, "invalid_address");
        return;
      }
      const wallet = addressText.toLowerCase();
      const sync = readSync(options.store);
      if (route.kind === "address") {
        send(res, req, 200, addressBody(sync, wallet));
        return;
      }
      const limit = parseLimit(url.searchParams.get("limit"));
      if (!limit.ok) {
        fail(res, req, 400, "invalid_limit");
        return;
      }
      const cursor = parseCursor(url.searchParams.get("cursor"));
      if (!cursor.ok) {
        fail(res, req, 400, "invalid_cursor");
        return;
      }
      send(res, req, 200, historyBody(sync, wallet, limit.limit, cursor.seq));
    } catch {
      if (res.headersSent) {
        res.end();
        return;
      }
      const payload = JSON.stringify({ ok: false, error: "internal" });
      const headers = {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(payload),
      };
      try {
        Object.assign(headers, corsHeaders(req));
      } catch {
        // The body stays the generic code.
      }
      res.writeHead(500, headers);
      res.end(payload);
    }
  }

  handler.close = () => limiter.close();
  return handler;
}
