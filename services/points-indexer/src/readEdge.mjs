/**
 * Origin checks and client keys shared by the read API and the process
 * entry. This module does not open a database, a socket, or a timer,
 * and it does not import the read API. The process entry can use it
 * when the read module fails to load.
 */

import { isIP } from "node:net";

export const DEFAULT_RATE_PER_MINUTE = 60;
export const DEFAULT_PROXY_HOPS = 0;
export const DEFAULT_MAX_ENTRIES = 16384;
export const MAX_FORWARDED_CHARS = 2048;
export const FALLBACK_WINDOW_MS = 60_000;

const EXACT_HTTPS_ORIGIN =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

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
 * The allowlisted origin to reflect, or null.
 * @param {unknown} listValue
 * @param {unknown} originHeader
 */
export function reflectedOrigin(listValue, originHeader) {
  if (typeof originHeader !== "string") return null;
  const parsed = parseExactHttpsOrigin(originHeader);
  if (!parsed.ok) return null;
  return parseCorsList(listValue).includes(parsed.origin) ? parsed.origin : null;
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
 * @param {{ cloudflareIngress?: boolean }} [options]
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

function liveStamps(stamps, now, windowMs) {
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
 * Window limiter for the path where the read module did not load.
 * The map holds 16384 keys. When it is full, an idle key that is under
 * its limit is evicted. Expired keys are swept only when the clock has
 * reached the oldest live stamp plus the window, or when no idle key is
 * left. The sweep walks the map in place. A refused key is moved without
 * a new stamp, so that time is the oldest stamp, not the map order.
 * A key that has hit its limit inside the window is not evicted.
 * There is no timer. `clock` defaults to `Date.now`. `rate` is read
 * on each call and defaults to 60.
 * @param {{ clock?: () => number, rate?: () => number }} [options]
 */
export function createFallbackLimiter(options = {}) {
  const windowMs = FALLBACK_WINDOW_MS;
  const maxEntries = DEFAULT_MAX_ENTRIES;
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const rate = typeof options.rate === "function" ? options.rate : () => DEFAULT_RATE_PER_MINUTE;
  const hits = new Map();
  const idle = new Map();
  let sweeps = 0;
  let nextSweepAt = Infinity;
  let emptySweepMark = null;

  const remember = (id, fresh, atCap) => {
    if (hits.has(id)) hits.delete(id);
    hits.set(id, fresh);
    idle.delete(id);
    if (!atCap) idle.set(id, true);
  };

  const noteExpiry = (fresh) => {
    if (fresh.length === 0) return;
    const expiry = fresh[0] + windowMs;
    if (expiry < nextSweepAt) nextSweepAt = expiry;
  };

  const sweep = (now) => {
    sweeps += 1;
    let oldest = Infinity;
    for (const [id, stamps] of hits) {
      const fresh = liveStamps(stamps, now, windowMs);
      if (fresh.length === 0) {
        hits.delete(id);
        idle.delete(id);
        continue;
      }
      if (fresh !== stamps) hits.set(id, fresh);
      const expiry = fresh[0] + windowMs;
      if (expiry < oldest) oldest = expiry;
    }
    nextSweepAt = oldest;
    emptySweepMark = oldest;
  };

  return {
    size: () => hits.size,
    sweeps: () => sweeps,
    allow(key) {
      const max = rate();
      const now = clock();
      const id = key || "unknown";
      const live = liveStamps(hits.get(id), now, windowMs);
      if (live.length >= max) {
        remember(id, live, true);
        return retryAfter(live, now, windowMs);
      }
      if (!hits.has(id) && hits.size >= maxEntries) {
        if (now >= nextSweepAt || (idle.size === 0 && emptySweepMark !== nextSweepAt)) {
          sweep(now);
        }
        if (hits.size >= maxEntries) {
          const next = idle.keys().next();
          if (next.done) return retryAfter([], now, windowMs);
          const idleLive = liveStamps(hits.get(next.value), now, windowMs);
          if (idleLive.length >= max) return retryAfter([], now, windowMs);
          hits.delete(next.value);
          idle.delete(next.value);
        }
      }
      live.push(now);
      remember(id, live, live.length >= max);
      noteExpiry(live);
      return { ok: true };
    },
  };
}
