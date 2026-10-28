import {
  bucketClientAddress,
  parseCorsList,
  parseExactHttpsOrigin,
  pointsEnabled,
  type ReadResult,
} from "./read-api";
import { PointsObject } from "./points-object";
import { PUBLIC_DENIAL_MESSAGE } from "../../src/sanctions.mjs";
import { decideGeoblock, geoInputFromHeaders, geoLog } from "../../../../claim-relayer/geoblock.mjs";

export { PointsObject };

const OBJECT_NAME = "base-sepolia";
const ALLOW = "GET, HEAD, OPTIONS";
const HEALTH_CACHE_SECONDS = 15;
const GLOBAL_KEY = "global";

type Limiter = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

type Limits = {
  POINTS_RATE_LIMITER?: Limiter;
  POINTS_HEALTH_LIMITER?: Limiter;
  POINTS_GLOBAL_LIMITER?: Limiter;
};

function stub(env: Env) {
  return env.POINTS.get(env.POINTS.idFromName(OBJECT_NAME));
}

function limiterOf(env: Env, name: keyof Limits) {
  return (env as Env & Limits)[name];
}

function duplicateQuery(url: URL) {
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function queryOf(url: URL) {
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (query[key] === undefined) query[key] = value;
  }
  return query;
}

function json(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-length": String(new TextEncoder().encode(payload).byteLength),
      ...extra,
    },
  });
}

function toResponse(result: { status: number; headers?: Record<string, string>; body: unknown }) {
  const headers = new Headers(result.headers);
  if (!headers.has("content-type") && result.body != null) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(result.body == null ? null : JSON.stringify(result.body), {
    status: result.status,
    headers,
  });
}

function disabledResponse(): Response {
  return json(503, { ok: false, error: "points_disabled" });
}

function corsFor(request: Request, env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": ALLOW,
    vary: "Origin",
  };
  const origins = new Set(parseCorsList(env.POINTS_CORS_ORIGINS));
  const origin = request.headers.get("Origin");
  if (origin) {
    const parsed = parseExactHttpsOrigin(origin);
    if (parsed.ok && origins.has(parsed.origin)) headers["access-control-allow-origin"] = parsed.origin;
  }
  return headers;
}

function duplicateResponse(request: Request, env: Env): Response {
  return json(400, { ok: false, error: "duplicate_query" }, corsFor(request, env));
}

/**
 * Enabled /health charges the per-address limiter, then rejects a repeated
 * query, then uses the cache. A repeated query does not spend the global cap
 * and does not call the object. A disabled route returns 503 before that.
 * OPTIONS is always 204 and does not reach this function.
 */
function optionsResponse(request: Request, env: Env): Response {
  const origins = new Set(parseCorsList(env.POINTS_CORS_ORIGINS));
  const headers = new Headers({
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": ALLOW,
    allow: ALLOW,
    vary: "Origin",
    "cache-control": "no-store",
    "content-length": "0",
  });
  const origin = request.headers.get("Origin");
  if (origin) {
    const parsed = parseExactHttpsOrigin(origin);
    if (parsed.ok && origins.has(parsed.origin)) headers.set("access-control-allow-origin", parsed.origin);
  }
  return new Response(null, { status: 204, headers });
}

async function charge(binding: Limiter | undefined, key: string): Promise<Response | null> {
  if (!binding) return json(503, { ok: false, error: "rate_limited" });
  try {
    const result = await binding.limit({ key });
    if (result.success === true) return null;
  } catch {
    return json(503, { ok: false, error: "rate_limited" });
  }
  return json(429, { ok: false, error: "rate_limited" }, { "retry-after": "60" });
}

function applyCors(request: Request, env: Env, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsFor(request, env))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function clientKey(request: Request) {
  return bucketClientAddress(request.headers.get("CF-Connecting-IP"));
}

function healthCacheKey() {
  return new Request("https://points.internal/health", { method: "GET" });
}

async function enabledHealth(request: Request, env: Env, repeated: boolean): Promise<Response> {
  const address = clientKey(request);
  if (!address) return json(400, { ok: false, error: "client_address_required" });
  const limited = await charge(limiterOf(env, "POINTS_HEALTH_LIMITER"), address);
  if (limited) return limited;
  if (repeated) return duplicateResponse(request, env);
  // wrangler types the toml default as the literal "". Tests set the same var to 1.
  const fast = String(env.POINTS_FAST_PACE) === "1";
  const cacheKey = healthCacheKey();
  if (!fast) {
    const hit = await caches.default.match(cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("x-points-cache", "hit");
      return new Response(hit.body, { status: hit.status, headers });
    }
  }
  const globalLimited = await charge(limiterOf(env, "POINTS_GLOBAL_LIMITER"), GLOBAL_KEY);
  if (globalLimited) return globalLimited;
  const result = await stub(env).health();
  const payload = JSON.stringify(result.body);
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": fast ? "no-store" : `public, max-age=${HEALTH_CACHE_SECONDS}`,
    "x-content-type-options": "nosniff",
    "x-points-cache": "miss",
    "content-length": String(new TextEncoder().encode(payload).byteLength),
  });
  const response = new Response(payload, { status: result.status, headers });
  if (!fast) await caches.default.put(cacheKey, response.clone());
  return response;
}

function geoDenied(request: Request): Response | null {
  try {
    const decision = decideGeoblock(geoInputFromHeaders(request.headers, request.cf, true));
    console.info(JSON.stringify(geoLog(decision)));
    if (decision.decision !== "deny") return null;
    return json(403, { ok: false, message: PUBLIC_DENIAL_MESSAGE });
  } catch {
    return json(403, { ok: false, message: PUBLIC_DENIAL_MESSAGE });
  }
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const repeated = duplicateQuery(url);
  if (path === "/health") {
    if (!pointsEnabled(env)) return json(503, { status: "disabled" });
    const blocked = geoDenied(request);
    if (blocked) return blocked;
    return enabledHealth(request, env, repeated);
  }
  if (path === "/v1/points" || path.startsWith("/v1/points/")) {
    if (!pointsEnabled(env)) return disabledResponse();
    const blocked = geoDenied(request);
    if (blocked) return blocked;
    const address = clientKey(request);
    if (!address) return json(400, { ok: false, error: "client_address_required" });
    const limited = await charge(limiterOf(env, "POINTS_RATE_LIMITER"), address);
    if (limited) return limited;
    if (repeated) return duplicateResponse(request, env);
    const globalLimited = await charge(limiterOf(env, "POINTS_GLOBAL_LIMITER"), GLOBAL_KEY);
    if (globalLimited) return globalLimited;
    const result: ReadResult = await stub(env).read({
      method: request.method,
      path,
      query: queryOf(url),
      origin: request.headers.get("Origin"),
      cfConnectingIp: request.headers.get("CF-Connecting-IP"),
    });
    return toResponse(result);
  }
  if (repeated) return duplicateResponse(request, env);
  return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method === "OPTIONS") return optionsResponse(request, env);
    return applyCors(request, env, await route(request, env));
  },
} satisfies ExportedHandler<Env>;
