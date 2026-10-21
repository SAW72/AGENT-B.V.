import sepolia from "../../../../config/reputation/sepolia.json";
import { CHAIN_ID, ESCROW_START_BLOCK } from "../../src/constants.mjs";
import { DISCLAIMER } from "./disclaimer.mjs";

export const DEFAULT_RATE_PER_MINUTE = 60;
export const HISTORY_DEFAULT_LIMIT = 25;
export const HISTORY_MAX_LIMIT = 100;
export const DEFAULT_BREAKER_FAILURES = 5;
export const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EXACT_HTTPS_ORIGIN =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ALLOW = "GET, HEAD, OPTIONS";
const HISTORY_ORDER: Record<string, number> = {
  fund: 1,
  release_or_refund: 2,
  dispute_open_or_vote: 3,
  first_activity: 4,
  return_day: 5,
};
const DISCLAIMER_LINK_SLOTS = [
  "master_disclaimer",
  "legal_notice_url",
  "as_is",
  "not_investment",
  "eligibility_notice",
  "abuse_policy",
] as const;

export function pointsEnabled(env: { POINTS_ENABLED?: string } | undefined) {
  return env?.POINTS_ENABLED === "true";
}

export function parseExactHttpsOrigin(raw: unknown) {
  const original = String(raw ?? "").trim();
  if (!original) return { ok: false as const };
  if (original.includes("*")) return { ok: false as const };
  if (original.toLowerCase() === "null") return { ok: false as const };
  const stripped = original.endsWith("/") ? original.slice(0, -1) : original;
  const separator = stripped.indexOf("://");
  if (separator <= 0) return { ok: false as const };
  const scheme = stripped.slice(0, separator).toLowerCase();
  if (scheme !== "https") return { ok: false as const };
  const rest = stripped.slice(separator + 3);
  if (!rest || rest.includes("@")) return { ok: false as const };
  const tailAt = rest.search(/[/?#]/);
  const hostRaw = tailAt === -1 ? rest : rest.slice(0, tailAt);
  const tail = tailAt === -1 ? "" : rest.slice(tailAt);
  if (tail) return { ok: false as const };
  if (hostRaw.includes(":")) return { ok: false as const };
  const entry = `https://${hostRaw.toLowerCase()}`;
  if (!EXACT_HTTPS_ORIGIN.test(entry)) return { ok: false as const };
  return { ok: true as const, origin: entry };
}

export function parseCorsList(value: unknown) {
  if (value == null || String(value).trim() === "") return [];
  const out: string[] = [];
  for (const part of String(value).split(",")) {
    const parsed = parseExactHttpsOrigin(part);
    if (parsed.ok && !out.includes(parsed.origin)) out.push(parsed.origin);
  }
  return out;
}

export function blocksBehind(head: number | null, cursor: number | null) {
  if (!Number.isSafeInteger(head)) return null;
  if (cursor == null) {
    if ((head as number) < ESCROW_START_BLOCK) return 0;
    return (head as number) - ESCROW_START_BLOCK + 1;
  }
  if (!Number.isSafeInteger(cursor)) return null;
  return Math.max(0, (head as number) - cursor);
}

function historyOrder(action: string) {
  return HISTORY_ORDER[action] ?? 9;
}

export function rowFollowsCursor(row: { block_number: number; log_index: number; action: string; utc_day: number }, after: { block_number: number; log_index: number; action: string; utc_day: number } | null) {
  if (!after) return true;
  const key = [row.block_number, row.log_index, historyOrder(row.action), row.utc_day];
  const bound = [after.block_number, after.log_index, historyOrder(after.action), after.utc_day];
  for (let index = 0; index < key.length; index += 1) {
    if (key[index] > bound[index]) return true;
    if (key[index] < bound[index]) return false;
  }
  return false;
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToText(value: string) {
  const pad = (4 - (value.length % 4)) % 4;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat(pad);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function encodeCursor(row: { block_number: number; log_index: number; action: string; utc_day: number }) {
  const payload = JSON.stringify([row.block_number, row.log_index, row.action, row.utc_day]);
  return bytesToBase64Url(new TextEncoder().encode(payload));
}

export function disclaimerLinks(source: Record<string, unknown> | null | undefined) {
  const links: Record<string, string | null> = {};
  for (const key of DISCLAIMER_LINK_SLOTS) links[key] = httpsUrl(source?.[key]);
  return links;
}

export function httpsUrl(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text || !/^https:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

function disclaimer() {
  const links = disclaimerLinks(sepolia.disclaimer_links as Record<string, string>);
  if (sepolia.display.disclaimer !== DISCLAIMER) {
    throw new Error("display.disclaimer mismatch");
  }
  return { text: DISCLAIMER, links };
}

function expandIPv6(input: string) {
  let text = input.trim().toLowerCase();
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
  const nums: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    nums.push(Number.parseInt(group, 16));
  }
  return nums;
}

function isIPv4(text: string) {
  const parts = text.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function bucketClientAddress(address: unknown) {
  if (typeof address !== "string") return null;
  let text = address.trim();
  if (!text) return null;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end <= 1) return null;
    text = text.slice(1, end);
  } else {
    const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(text);
    if (v4port) text = v4port[1];
  }
  if (isIPv4(text)) return text;
  const groups = expandIPv6(text);
  if (!groups) return null;
  const mapped = groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff;
  if (mapped) {
    const hi = groups[6];
    const lo = groups[7];
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  const prefix = groups.slice(0, 4).map((part) => part.toString(16)).join(":");
  return `${prefix}::/64`;
}

/** Client address is CF-Connecting-IP. X-Forwarded-For is not read. */
export function clientIp(input: { cfConnectingIp?: string | null }) {
  return bucketClientAddress(input?.cfConnectingIp) || "unknown";
}

function byteLength(text: string) {
  return new TextEncoder().encode(text).byteLength;
}

export type ReadInput = {
  method?: string;
  path?: string;
  query?: Record<string, string | null>;
  origin?: string | null;
  cfConnectingIp?: string | null;
};

export type ReadResult = {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
};

type Store = {
  getCursor(): {
    last_scanned_block: number | null;
    finalized_block: number | null;
    pass_completed: boolean;
    stale: boolean;
  };
  getLedgerSummary(address: string): { rows_count: number; first_activity_utc_day: number | null };
  listLedgerRows(address: string, query: { limit: number; after: { block_number: number; log_index: number; action: string; utc_day: number } | null }): Array<Record<string, unknown>>;
  getConfig(): { weights: unknown; gates: unknown; rule_version: string | null };
};

function createBreaker(limit: number, cooldownMs: number, clock: () => number) {
  let state = "closed";
  let consecutive = 0;
  let openedAt = 0;
  const open = () => {
    state = "open";
    openedAt = clock();
    consecutive = 0;
  };
  return {
    state: () => state,
    blocked() {
      if (state === "closed") return false;
      if (state === "half_open") return true;
      return clock() - openedAt < cooldownMs;
    },
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

function routeOf(pathname: string) {
  if (pathname === "/v1/points/config") return { kind: "config" as const };
  const history = pathname.match(/^\/v1\/points\/([^/]+)\/history$/);
  if (history) return { kind: "history" as const, address: history[1] };
  const balance = pathname.match(/^\/v1\/points\/([^/]+)$/);
  if (balance) return { kind: "address" as const, address: balance[1] };
  return null;
}

function parseChain(raw: string | null | undefined) {
  if (raw == null || String(raw).trim() === "") return { ok: true };
  return { ok: String(raw).trim() === String(CHAIN_ID) };
}

function parseLimit(raw: string | null | undefined) {
  if (raw == null || raw === "") return { ok: true as const, limit: HISTORY_DEFAULT_LIMIT };
  if (!/^[1-9][0-9]*$/.test(raw)) return { ok: false as const };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return { ok: false as const };
  return { ok: true as const, limit: Math.min(HISTORY_MAX_LIMIT, value) };
}

function parseCursor(raw: string | null | undefined) {
  if (raw == null || raw === "") return { ok: true as const, after: null };
  if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return { ok: false as const };
  let text: string;
  try {
    text = base64UrlToText(raw);
  } catch {
    return { ok: false as const };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false as const };
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) return { ok: false as const };
  const [block, logIndex, action, utcDay] = parsed;
  if (!Number.isSafeInteger(block) || block < 0) return { ok: false as const };
  if (!Number.isSafeInteger(logIndex) || logIndex < 0) return { ok: false as const };
  if (typeof action !== "string" || !/^[a-z0-9_]{1,64}$/.test(action)) return { ok: false as const };
  if (!Number.isSafeInteger(utcDay)) return { ok: false as const };
  return { ok: true as const, after: { block_number: block, log_index: logIndex, action, utc_day: utcDay } };
}

export function createReadApi(options: {
  store: Store;
  allow?: (ip: string) => { ok: boolean; retryAfterSec?: number };
  corsOrigins?: string[];
  now?: () => number;
  breakerFailures?: number;
  breakerCooldownMs?: number;
}) {
  const origins = new Set(options.corsOrigins ?? []);
  const clock = options.now ?? Date.now;
  const breaker = createBreaker(
    options.breakerFailures ?? DEFAULT_BREAKER_FAILURES,
    options.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS,
    clock,
  );
  const store = options.store;

  function corsHeaders(input: ReadInput) {
    const headers: Record<string, string> = {
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": ALLOW,
      vary: "Origin",
    };
    const origin = input.origin;
    if (typeof origin !== "string") return headers;
    const parsed = parseExactHttpsOrigin(origin);
    if (parsed.ok && origins.has(parsed.origin)) headers["access-control-allow-origin"] = parsed.origin;
    return headers;
  }

  function result(status: number, body: Record<string, unknown> | null, input: ReadInput, extra: Record<string, string> = {}): ReadResult {
    const headers: Record<string, string> = {
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
    headers["content-length"] = String(byteLength(payload));
    return { status, headers, body };
  }

  function fail(status: number, code: string, input: ReadInput, extra?: Record<string, string>) {
    return result(status, { ok: false, error: code }, input, extra);
  }

  function rateLimit(input: ReadInput) {
    if (!options.allow) return null;
    const decision = options.allow(clientIp(input));
    if (decision.ok) return null;
    return fail(429, "rate_limited", input, { "retry-after": String(decision.retryAfterSec ?? 1) });
  }

  function asHead(outcome: ReadResult): ReadResult {
    if (outcome.body == null) return outcome;
    return { status: outcome.status, headers: outcome.headers, body: null };
  }

  function finish(input: ReadInput, outcome: ReadResult) {
    return input.method === "HEAD" ? asHead(outcome) : outcome;
  }

  function readSync() {
    const raw = store.getCursor();
    const cursor = Number.isSafeInteger(raw.last_scanned_block) ? raw.last_scanned_block : null;
    const finalized = Number.isSafeInteger(raw.finalized_block) ? raw.finalized_block : null;
    const behind = blocksBehind(finalized, cursor);
    const syncing = raw.pass_completed !== true || behind == null || behind > 0;
    return {
      indexed_to_block: cursor,
      finalized_block: finalized,
      behind,
      syncing,
      stale: raw.stale === true,
    };
  }

  function publicHistoryItem(row: Record<string, unknown>) {
    const withheld = row.points_withheld === 1 || row.points_withheld === true;
    return {
      action: row.action,
      utc_day: row.utc_day,
      tx_hash: row.tx_hash,
      log_index: row.log_index,
      block_number: row.block_number,
      escrow_id: row.escrow_id,
      points: withheld ? 0 : Number(row.points),
      points_withheld: withheld,
      eligibility_reason: row.eligibility_reason,
      register_status: row.register_status ?? null,
    };
  }

  function serve(input: ReadInput): ReadResult {
    const method = input.method;
    const head = method === "HEAD";
    const pathname = String(input.path || "/").replace(/\/+$/, "") || "/";
    const query = input.query ?? {};
    const route = routeOf(pathname);
    if (method === "OPTIONS" && route) return result(204, null, input, { allow: ALLOW });
    if (!route) {
      if (method !== "OPTIONS") {
        const limited = rateLimit(input);
        if (limited) return finish(input, limited);
      }
      return finish(input, fail(404, "not_found", input));
    }
    if (method !== "GET" && !head) {
      if (method !== "OPTIONS") {
        const limited = rateLimit(input);
        if (limited) return finish(input, limited);
      }
      return finish(input, fail(405, "method_not_allowed", input, { allow: ALLOW }));
    }
    if (!parseChain(query.chainId).ok) {
      const limited = rateLimit(input);
      if (limited) return finish(input, limited);
      return finish(input, fail(400, "wrong_chain", input));
    }
    let wallet: string | null = null;
    let limit: number | null = null;
    let after: { block_number: number; log_index: number; action: string; utc_day: number } | null = null;
    if (route.kind !== "config") {
      let addressText: string;
      try {
        addressText = decodeURIComponent(route.address);
      } catch {
        const limited = rateLimit(input);
        if (limited) return finish(input, limited);
        return finish(input, fail(400, "invalid_address", input));
      }
      if (!ADDRESS.test(addressText)) {
        const limited = rateLimit(input);
        if (limited) return finish(input, limited);
        return finish(input, fail(400, "invalid_address", input));
      }
      wallet = addressText.toLowerCase();
      if (route.kind === "history") {
        const parsedLimit = parseLimit(query.limit);
        if (!parsedLimit.ok) {
          const limited = rateLimit(input);
          if (limited) return finish(input, limited);
          return finish(input, fail(400, "invalid_limit", input));
        }
        const cursor = parseCursor(query.cursor);
        if (!cursor.ok) {
          const limited = rateLimit(input);
          if (limited) return finish(input, limited);
          return finish(input, fail(400, "invalid_cursor", input));
        }
        limit = parsedLimit.limit;
        after = cursor.after;
      }
    }
    if (breaker.blocked()) return finish(input, fail(503, "points_unavailable", input));
    const limited = rateLimit(input);
    if (limited) return finish(input, limited);
    breaker.begin();
    try {
      let outcome: ReadResult;
      if (route.kind === "config") {
        const points = store.getConfig();
        outcome = result(200, {
          chainId: CHAIN_ID,
          status: "draft",
          weights: points.weights as Record<string, unknown>,
          gates: points.gates as Record<string, unknown>,
          rule_version: points.rule_version,
          disclaimer: disclaimer(),
        }, input);
      } else {
        const sync = readSync();
        if (route.kind === "address") {
          const summary = store.getLedgerSummary(wallet as string);
          outcome = result(200, {
            address: wallet,
            chainId: CHAIN_ID,
            points_total: 0,
            points_withheld: true,
            eligibility: { status: "unverified", reason: "ofac_unconfigured" },
            rows_count: Number(summary.rows_count),
            first_activity_utc_day: summary.first_activity_utc_day ?? null,
            ...sync,
            disclaimer: disclaimer(),
          }, input);
        } else {
          const rows = store.listLedgerRows(wallet as string, { limit: (limit as number) + 1, after });
          const page = rows.slice(0, limit as number);
          outcome = result(200, {
            address: wallet,
            chainId: CHAIN_ID,
            limit,
            items: page.map(publicHistoryItem),
            next_cursor: rows.length > (limit as number) ? encodeCursor(page[page.length - 1] as { block_number: number; log_index: number; action: string; utc_day: number }) : null,
            ...sync,
            disclaimer: disclaimer(),
          }, input);
        }
      }
      breaker.success();
      return finish(input, outcome);
    } catch (error) {
      breaker.failure();
      throw error;
    }
  }

  function handle(input: ReadInput): ReadResult {
    try {
      return serve(input);
    } catch {
      return fail(500, "internal", input);
    }
  }

  return { handle, breakerState: () => breaker.state() };
}
