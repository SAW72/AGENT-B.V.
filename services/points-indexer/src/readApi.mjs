/**
 * Read-only preview routes for committed ledger rows.
 * Importing this module does not open a database, a socket, or a timer.
 * The core calls the injected store and does not read process.env.
 * The host passes an env object in. A node listener is a thin wrapper
 * around handle().
 */

import { isIP } from "node:net";
import { CHAIN_ID, ESCROW_START_BLOCK } from "./constants.mjs";
import { pointsEnabled } from "./pointsFlag.mjs";

export { pointsEnabled };

export const DEFAULT_RATE_PER_MINUTE = 60;
export const DEFAULT_PROXY_HOPS = 0;
export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_MAX_ENTRIES = 16384;
export const DEFAULT_COARSE_MAX_ENTRIES = 4096;
export const COARSE_LIMIT_FACTOR = 8;
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
  "POINTS_CLOUDFLARE_INGRESS",
]);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EXACT_HTTPS_ORIGIN =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const ALLOW = "GET, HEAD, OPTIONS";
const HISTORY_ACTIONS = Object.freeze({
  fund: 1,
  release_or_refund: 2,
  dispute_open_or_vote: 3,
  first_activity: 4,
  return_day: 5,
});
const DISCLAIMER_LINK_SLOTS = [
  "master_disclaimer",
  "legal_notice_url",
  "as_is",
  "not_investment",
  "eligibility_notice",
  "abuse_policy",
];

/** One sentence for every public read response. */
export const DISCLAIMER_TEXT = "Testnet only. Not a token. Can't be transferred, sold, or redeemed. May be adjusted or cancelled, and does not convert to anything.";

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
 * Unset or blank is an empty allowlist. No origin is allowed.
 * Entries that are not an exact https origin are dropped.
 * @param {unknown} value
 */
export function parseCorsList(value) {
  if (value == null || String(value).trim() === "") return [];
  const out = [];
  for (const part of String(value).split(",")) {
    const parsed = parseExactHttpsOrigin(part);
    if (parsed.ok && !out.includes(parsed.origin)) out.push(parsed.origin);
  }
  return out;
}

/**
 * Non-negative integer. Blank or malformed falls back to 0.
 * Zero means the forwarded header is not trusted.
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
    cloudflareIngress: source.POINTS_CLOUDFLARE_INGRESS === "true",
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

/**
 * A second limit for the whole prefix. IPv4 keys share a /24.
 * IPv6 /64 buckets share a /48. Other keys have no coarse bucket.
 * @param {string} key
 * @returns {string | null}
 */
export function coarseBucket(key) {
  if (typeof key !== "string" || key === "unknown") return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(key);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  const v6 = /^([0-9a-f]+):([0-9a-f]+):([0-9a-f]+):[0-9a-f]+::\/64$/.exec(key);
  if (v6) return `${v6[1]}:${v6[2]}:${v6[3]}::/48`;
  return null;
}

/**
 * Config notice links are https URLs with no userinfo. Anything else is null.
 * @param {unknown} value
 * @returns {string | null}
 */
export function httpsNoticeUrl(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;
  return url.href;
}

function socketBucket(input) {
  const address = input?.remoteAddress ?? input?.socket?.remoteAddress;
  return bucketClientAddress(address) || "unknown";
}

function headerText(value) {
  if (Array.isArray(value)) return value.join(",");
  return typeof value === "string" ? value : null;
}

/**
 * A forwarded header longer than 2048 characters is rejected.
 * Hop 0 does not read X-Forwarded-For, so that header's length is ignored.
 * @param {{ headers?: object }} input
 * @param {number} [hops]
 * @param {{ cloudflareIngress?: boolean }} [options]
 */
export function headerTooLong(input, hops = DEFAULT_PROXY_HOPS, options = {}) {
  if (options.cloudflareIngress === true) {
    const value = headerText(input?.headers?.["cf-connecting-ip"]);
    if (value != null && value.length > MAX_FORWARDED_CHARS) return true;
  }
  const hopCount = Number.isInteger(hops) && hops >= 0 ? hops : DEFAULT_PROXY_HOPS;
  if (hopCount === 0) return false;
  const header = headerText(input?.headers?.["x-forwarded-for"]);
  return header != null && header.length > MAX_FORWARDED_CHARS;
}

/**
 * Trusted proxy hops are counted from the end of X-Forwarded-For.
 * Hop 0, the default, uses remoteAddress and ignores the header.
 * A positive hop count is an operator setting for a proxy they have checked.
 * A missing, empty, too-short, or malformed header uses remoteAddress.
 * A header longer than 2048 characters returns null. It is not the socket.
 * The first list entry is never selected on its own.
 * @param {{ headers?: object, remoteAddress?: string, socket?: { remoteAddress?: string } }} input
 * @param {number} [hops]
 */
export function clientIp(input, hops = DEFAULT_PROXY_HOPS, options = {}) {
  const socket = socketBucket(input);
  if (options.cloudflareIngress === true) {
    const header = input?.headers?.["cf-connecting-ip"];
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value === "string" && value.length > MAX_FORWARDED_CHARS) return null;
    return bucketClientAddress(typeof value === "string" ? value.trim() : "") || socket;
  }
  const hopCount = Number.isInteger(hops) && hops >= 0 ? hops : DEFAULT_PROXY_HOPS;
  if (hopCount === 0) return socket;
  const header = headerText(input?.headers?.["x-forwarded-for"]);
  if (header == null || header.length === 0) return socket;
  if (header.length > MAX_FORWARDED_CHARS) return null;
  const parts = header.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < hopCount) return socket;
  const selected = parts[parts.length - hopCount];
  return bucketClientAddress(selected) || socket;
}

function createTouchMap() {
  const map = new Map();
  let touches = 0;
  return {
    get touches() {
      return touches;
    },
    get size() {
      return map.size;
    },
    get(key) {
      touches += 1;
      return map.get(key);
    },
    set(key, value) {
      touches += 1;
      map.set(key, value);
    },
    has(key) {
      touches += 1;
      return map.has(key);
    },
    delete(key) {
      touches += 1;
      return map.delete(key);
    },
    keys() {
      const iter = map.keys();
      return {
        next() {
          touches += 1;
          return iter.next();
        },
        [Symbol.iterator]() {
          return this;
        },
      };
    },
    [Symbol.iterator]() {
      const iter = map.entries();
      return {
        next() {
          touches += 1;
          return iter.next();
        },
        [Symbol.iterator]() {
          return this;
        },
      };
    },
  };
}

const OVERFLOW_KEY = "\0overflow";

function liveStamps(map, id, now, windowMs) {
  const stamps = map.get(id);
  if (!stamps || stamps.length === 0) return [];
  let start = 0;
  while (start < stamps.length && now - stamps[start] >= windowMs) start += 1;
  if (start === 0) return stamps;
  if (start === stamps.length) return [];
  return stamps.slice(start);
}

function retryAfter(stamps, now, windowMs) {
  const retryAfterMs = stamps.length === 0 ? windowMs : Math.max(0, stamps[0] + windowMs - now);
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
}

/**
 * In-memory window limiter. The sweep timer is unref'd so it does not
 * keep the process alive. A request touches only its own key, its prefix
 * key, and at most one eviction candidate. The timer drops expired keys.
 * A limited key is never evicted. When every resident key is limited, new
 * keys share one overflow bucket.
 * The prefix map has its own cap. When it is full, the least recently seen
 * prefix that is under its limit is evicted. A prefix at its limit stays.
 * If every resident prefix is at its limit, a new prefix is refused.
 * Evicting an under-limit key clears that key's count.
 * @param {{ windowMs?: number, max?: number, coarseMax?: number, coarseMaxEntries?: number, maxEntries?: number, clock?: () => number, sweepMs?: number }} [options]
 */
export function createRateLimiter(options = {}) {
  const windowMs = Number.isInteger(options.windowMs) && options.windowMs > 0 ? options.windowMs : DEFAULT_WINDOW_MS;
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : DEFAULT_RATE_PER_MINUTE;
  const coarseMax = Number.isInteger(options.coarseMax) && options.coarseMax > 0
    ? options.coarseMax
    : max * COARSE_LIMIT_FACTOR;
  const coarseMaxEntries = Number.isInteger(options.coarseMaxEntries) && options.coarseMaxEntries > 0
    ? options.coarseMaxEntries
    : DEFAULT_COARSE_MAX_ENTRIES;
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : DEFAULT_MAX_ENTRIES;
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const sweepMs = Number.isInteger(options.sweepMs) && options.sweepMs > 0 ? options.sweepMs : DEFAULT_SWEEP_MS;
  const hits = createTouchMap();
  const coarseHits = createTouchMap();
  const idle = createTouchMap();
  const coarseIdle = createTouchMap();

  const remember = (map, id, fresh, atCap) => {
    if (map.has(id)) map.delete(id);
    map.set(id, fresh);
    const idleMap = map === hits ? idle : (map === coarseHits ? coarseIdle : null);
    if (!idleMap) return;
    idleMap.delete(id);
    if (!atCap && id !== OVERFLOW_KEY) idleMap.set(id, true);
  };

  const sweepMap = (map, now, limit) => {
    const idleMap = map === hits ? idle : coarseIdle;
    for (const [key, stamps] of map) {
      const fresh = liveStamps(map, key, now, windowMs);
      if (fresh.length === 0) {
        map.delete(key);
        idleMap.delete(key);
      } else if (fresh !== stamps) {
        remember(map, key, fresh, fresh.length >= limit);
      } else if (fresh.length < limit && key !== OVERFLOW_KEY) {
        idleMap.set(key, true);
      }
    }
  };

  const sweep = () => {
    const now = clock();
    sweepMap(hits, now, max);
    sweepMap(coarseHits, now, coarseMax);
  };

  const evictIdle = (now) => {
    const nextIdle = idle.keys().next();
    if (!nextIdle.done) {
      hits.delete(nextIdle.value);
      idle.delete(nextIdle.value);
      return true;
    }
    const oldest = hits.keys().next();
    if (oldest.done) return false;
    let id = oldest.value;
    if (id === OVERFLOW_KEY) {
      const rest = hits.keys();
      rest.next();
      const second = rest.next();
      if (second.done) return false;
      id = second.value;
    }
    const live = liveStamps(hits, id, now, windowMs);
    if (live.length >= max) return false;
    hits.delete(id);
    idle.delete(id);
    return true;
  };

  const evictCoarse = () => {
    const nextIdle = coarseIdle.keys().next();
    if (nextIdle.done) return false;
    coarseHits.delete(nextIdle.value);
    coarseIdle.delete(nextIdle.value);
    return true;
  };

  const chargeOverflow = (now) => {
    const live = liveStamps(hits, OVERFLOW_KEY, now, windowMs);
    if (live.length >= max) {
      if (hits.has(OVERFLOW_KEY)) remember(hits, OVERFLOW_KEY, live, true);
      return retryAfter(live, now, windowMs);
    }
    live.push(now);
    remember(hits, OVERFLOW_KEY, live, live.length >= max);
    return { ok: true };
  };

  const timer = setInterval(sweep, sweepMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    timer,
    sweep,
    size: () => hits.size,
    coarseSize: () => coarseHits.size,
    touchCount: () => hits.touches + coarseHits.touches + idle.touches + coarseIdle.touches,
    close() {
      clearInterval(timer);
    },
    allow(key) {
      const now = clock();
      const id = String(key || "unknown");
      const clientLive = liveStamps(hits, id, now, windowMs);
      if (clientLive.length >= max) {
        remember(hits, id, clientLive, true);
        return retryAfter(clientLive, now, windowMs);
      }
      const coarse = coarseBucket(id);
      let coarseLive = null;
      if (coarse) {
        if (!coarseHits.has(coarse) && coarseHits.size >= coarseMaxEntries && !evictCoarse()) {
          return retryAfter([], now, windowMs);
        }
        coarseLive = liveStamps(coarseHits, coarse, now, windowMs);
        if (coarseLive.length >= coarseMax) {
          remember(coarseHits, coarse, coarseLive, true);
          return retryAfter(coarseLive, now, windowMs);
        }
      }
      if (!hits.has(id) && hits.size >= maxEntries && !evictIdle(now)) {
        return chargeOverflow(now);
      }
      clientLive.push(now);
      remember(hits, id, clientLive, clientLive.length >= max);
      if (coarse) {
        coarseLive.push(now);
        remember(coarseHits, coarse, coarseLive, coarseLive.length >= coarseMax);
      }
      return { ok: true };
    },
  };
}

/**
 * Store the host injects. The core calls only these four methods.
 * getCursor() returns last_scanned_block, finalized_block, and pass_completed.
 * getLedgerSummary(address) returns points_total, rows_count, and first_activity_utc_day.
 * listLedgerRows(address, { limit, after }) returns row objects.
 * after is null or { block_number, log_index, action, utc_day }. seq is not a cursor.
 * getConfig() returns weights, gates, rule_version, and legal_notice_url.
 * getCursor() may set stale when the last pass failed.
 */

function disclaimer(config) {
  const links = {};
  for (const key of DISCLAIMER_LINK_SLOTS) links[key] = null;
  links.legal_notice_url = httpsNoticeUrl(config?.legal_notice_url);
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
    stale: raw?.stale === true,
  };
}

function syncFields(sync) {
  return {
    indexed_to_block: sync.indexed_to_block,
    finalized_block: sync.finalized_block,
    behind: sync.behind,
    syncing: sync.syncing,
    stale: sync.stale === true,
  };
}

/**
 * History order. Matches the order used by the sqlite adapter.
 * seq is assigned again on rebuild, so it is not part of this key.
 * @param {string} action
 */
export function historyOrder(action) {
  return HISTORY_ACTIONS[action] ?? 9;
}

/**
 * @param {object} row
 * @param {{ block_number: number, log_index: number, action: string, utc_day: number } | null} after
 */
export function rowFollowsCursor(row, after) {
  if (!after) return true;
  const key = [row.block_number, row.log_index, historyOrder(row.action), row.utc_day];
  const bound = [after.block_number, after.log_index, historyOrder(after.action), after.utc_day];
  for (let index = 0; index < key.length; index += 1) {
    if (key[index] > bound[index]) return true;
    if (key[index] < bound[index]) return false;
  }
  return false;
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify([
    row.block_number,
    row.log_index,
    row.action,
    row.utc_day,
  ]), "utf8").toString("base64url");
}

/**
 * Named columns only. The history cursor is the keyset, not seq.
 * @param {object} row
 */
function publicHistoryItem(row) {
  const withheld = row.points_withheld === 1 || row.points_withheld === true;
  const stored = typeof row.points === "bigint" ? Number(row.points) : row.points;
  return {
    action: row.action,
    utc_day: row.utc_day,
    tx_hash: row.tx_hash,
    log_index: row.log_index,
    block_number: row.block_number,
    escrow_id: row.escrow_id,
    points: withheld ? 0 : stored,
    points_withheld: withheld,
    eligibility_reason: row.eligibility_reason,
    register_status: row.register_status ?? null,
  };
}

function addressBody(sync, wallet, summary) {
  return {
    address: wallet,
    chainId: CHAIN_ID,
    points_total: 0,
    points_withheld: true,
    eligibility: { status: "unverified", reason: "ofac_unconfigured" },
    rows_count: Number(summary.rows_count),
    first_activity_utc_day: summary.first_activity_utc_day ?? null,
    ...syncFields(sync),
    disclaimer: disclaimer(),
  };
}

function historyBody(sync, wallet, limit, rows) {
  const page = rows.slice(0, limit);
  return {
    address: wallet,
    chainId: CHAIN_ID,
    limit,
    items: page.map(publicHistoryItem),
    next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    ...syncFields(sync),
    disclaimer: disclaimer(),
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
  if (raw == null || raw === "") return { ok: true, after: null };
  if (typeof raw !== "string" || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return { ok: false };
  let text;
  try {
    text = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return { ok: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) return { ok: false };
  const [block, logIndex, action, utcDay] = parsed;
  if (!Number.isSafeInteger(block) || block < 0) return { ok: false };
  if (!Number.isSafeInteger(logIndex) || logIndex < 0) return { ok: false };
  if (typeof action !== "string" || !/^[a-z0-9_]{1,64}$/.test(action)) return { ok: false };
  if (!Number.isSafeInteger(utcDay)) return { ok: false };
  return {
    ok: true,
    after: { block_number: block, log_index: logIndex, action, utc_day: utcDay },
  };
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
 * when that probe's store read finishes, or opens it again when the probe throws.
 * A response that never called the store does not change the breaker.
 * @param {number} limit
 * @param {number} cooldownMs
 * @param {() => number} clock
 * @param {() => void} [onOpen]
 */
function createBreaker(limit, cooldownMs, clock, onOpen) {
  let state = "closed";
  let consecutive = 0;
  let openedAt = 0;

  function open() {
    state = "open";
    openedAt = clock();
    consecutive = 0;
    if (typeof onOpen === "function") onOpen();
  }

  return {
    state() {
      return state;
    },
    /** True when the request must not call the store. Does not start a probe. */
    blocked() {
      if (state === "closed") return false;
      if (state === "half_open") return true;
      return clock() - openedAt < cooldownMs;
    },
    /** Mark the one allowed probe. No-op while the breaker is closed. */
    begin() {
      if (state === "open") state = "half_open";
    },
    success() {
      consecutive = 0;
      state = "closed";
    },
    failure() {
      if (state === "half_open") {
        open();
        return;
      }
      consecutive += 1;
      if (consecutive >= limit) open();
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
  const cloudflareIngress = config.cloudflareIngress === true;
  const rateMax = Number.isInteger(config.ratePerMinute) && config.ratePerMinute > 0
    ? config.ratePerMinute
    : DEFAULT_RATE_PER_MINUTE;
  const clock = typeof options.now === "function" ? options.now : Date.now;
  const limiter = createRateLimiter({
    windowMs: config.windowMs,
    max: rateMax,
    coarseMax: config.coarseMax,
    coarseMaxEntries: config.coarseMaxEntries,
    maxEntries: config.maxEntries,
    clock,
    sweepMs: config.sweepMs,
  });
  const configUnavailable = options.store?.configAvailable === false;
  const breakerFailures = Number.isInteger(config.breakerFailures) && config.breakerFailures > 0
    ? config.breakerFailures
    : DEFAULT_BREAKER_FAILURES;
  const breakerCooldownMs = Number.isInteger(config.breakerCooldownMs) && config.breakerCooldownMs >= 0
    ? config.breakerCooldownMs
    : DEFAULT_BREAKER_COOLDOWN_MS;
  const log = typeof options.log === "function"
    ? options.log
    : (line) => {
      console.error(line);
    };
  if (configUnavailable) log("points_read config_unavailable");
  const breaker = createBreaker(breakerFailures, breakerCooldownMs, clock, () => {
    log("points_read breaker_open");
  });
  const enabledFn = typeof options.enabled === "function"
    ? options.enabled
    : () => pointsEnabled(options.enabled === true ? { POINTS_ENABLED: "true" } : {});
  const store = options.store;

  function requestOrigin(input) {
    if (typeof input?.origin === "string") return input.origin;
    const header = input?.headers?.origin;
    return typeof header === "string" ? header : undefined;
  }

  function corsHeaders(input) {
    const headers = {
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": ALLOW,
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
      "x-content-type-options": "nosniff",
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

  function rateLimit(input) {
    const decision = limiter.allow(clientIp(input, hops, { cloudflareIngress }));
    if (decision.ok) return null;
    return fail(429, "rate_limited", input, { "retry-after": String(decision.retryAfterSec) });
  }

  function asHead(outcome) {
    if (outcome.body == null) return outcome;
    return { status: outcome.status, headers: outcome.headers, body: null };
  }

  function finish(input, outcome) {
    return input?.method === "HEAD" ? asHead(outcome) : outcome;
  }

  /**
   * Validation that does not call the store stays outside the breaker.
   * A store read is admitted only after that validation, and a 4xx or 429
   * that never called the store does not close the breaker.
   */
  function serve(input) {
    const method = input?.method;
    const head = method === "HEAD";
    const pathname = String(input?.path || "/").replace(/\/+$/, "") || "/";
    const query = input?.query ?? {};
    const route = routeOf(pathname);
    const tooLong = headerTooLong(input, hops, { cloudflareIngress });
    if (
      method === "OPTIONS"
      && route
      && input?.duplicateQuery !== true
      && !configUnavailable
      && !tooLong
    ) {
      return result(204, null, input, { allow: ALLOW });
    }
    const counted = rateLimit(input);
    if (counted) return finish(input, counted);
    if (configUnavailable) return finish(input, fail(503, "config_unavailable", input));
    if (tooLong) return finish(input, fail(400, "header_too_long", input));
    if (input?.duplicateQuery === true) return finish(input, fail(400, "duplicate_query", input));
    if (!route) return finish(input, fail(404, "not_found", input));
    if (method !== "GET" && !head) {
      return finish(input, fail(405, "method_not_allowed", input, { allow: ALLOW }));
    }
    if (!parseChain(query.chainId).ok) return finish(input, fail(400, "wrong_chain", input));

    let wallet = null;
    let limit = null;
    let after = null;
    if (route.kind !== "config") {
      let addressText;
      try {
        addressText = decodeURIComponent(route.address);
      } catch {
        return finish(input, fail(400, "invalid_address", input));
      }
      if (!ADDRESS.test(addressText)) return finish(input, fail(400, "invalid_address", input));
      wallet = addressText.toLowerCase();
      if (route.kind === "history") {
        const parsedLimit = parseLimit(query.limit);
        if (!parsedLimit.ok) return finish(input, fail(400, "invalid_limit", input));
        const cursor = parseCursor(query.cursor);
        if (!cursor.ok) return finish(input, fail(400, "invalid_cursor", input));
        limit = parsedLimit.limit;
        after = cursor.after;
      }
    }

    if (breaker.blocked()) return finish(input, fail(503, "points_unavailable", input));
    breaker.begin();
    try {
      let outcome;
      if (route.kind === "config") {
        const points = store.getConfig();
        outcome = result(200, {
          chainId: CHAIN_ID,
          status: "draft",
          weights: points.weights,
          gates: points.gates,
          rule_version: points.rule_version,
          disclaimer: disclaimer(points),
        }, input);
      } else {
        const sync = readSync(store);
        const notice = disclaimer(store.getConfig());
        if (route.kind === "address") {
          outcome = result(200, { ...addressBody(sync, wallet, store.getLedgerSummary(wallet)), disclaimer: notice }, input);
        } else {
          const rows = store.listLedgerRows(wallet, { limit: limit + 1, after });
          outcome = result(200, { ...historyBody(sync, wallet, limit, rows), disclaimer: notice }, input);
        }
      }
      breaker.success();
      return finish(input, outcome);
    } catch (error) {
      breaker.failure();
      throw error;
    }
  }

  function handle(input) {
    try {
      if (enabledFn() !== true) return finish(input, fail(503, "points_disabled", input));
      try {
        return serve(input);
      } catch {
        log("points_read internal");
        return finish(input, fail(500, "internal", input));
      }
    } catch {
      try {
        log("points_read internal");
        return finish(input, fail(500, "internal", input));
      } catch {
        return {
          status: 500,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
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
    let duplicateQuery = false;
    for (const key of url.searchParams.keys()) {
      const values = url.searchParams.getAll(key);
      if (values.length > 1) duplicateQuery = true;
      else query[key] = values[0];
    }
    const headerOrigin = req.headers?.origin;
    return {
      method: req.method,
      path: url.pathname,
      query,
      duplicateQuery,
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
          "x-content-type-options": "nosniff",
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
