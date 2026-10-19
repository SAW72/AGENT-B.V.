import {
  clientIp,
  parseCorsList,
  parseExactHttpsOrigin,
  pointsEnabled,
  type ReadResult,
} from "./read-api";
import { PointsObject } from "./points-object";

export { PointsObject };

const OBJECT_NAME = "base-sepolia";
const ALLOW = "GET, HEAD, OPTIONS";

type Limiter = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

function stub(env: Env) {
  return env.POINTS.get(env.POINTS.idFromName(OBJECT_NAME));
}

function limiter(env: Env) {
  return (env as Env & { POINTS_RATE_LIMITER?: Limiter }).POINTS_RATE_LIMITER;
}

function queryOf(url: URL) {
  const query: Record<string, string> = {};
  for (const key of url.searchParams.keys()) {
    if (query[key] === undefined) {
      const value = url.searchParams.get(key);
      if (value != null) query[key] = value;
    }
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

/**
 * Enabled /health reads the object because behind/ok lives there.
 * Disabled /health and every OPTIONS stay in this Worker.
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

async function enforceRateLimit(request: Request, env: Env): Promise<Response | null> {
  const binding = limiter(env);
  if (!binding) return json(503, { ok: false, error: "rate_limited" });
  try {
    const result = await binding.limit({ key: clientIp({ cfConnectingIp: request.headers.get("CF-Connecting-IP") }) });
    if (result.success === true) return null;
  } catch {
    return json(503, { ok: false, error: "rate_limited" });
  }
  return json(429, { ok: false, error: "rate_limited" }, { "retry-after": "60" });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/health") {
      if (!pointsEnabled(env)) return json(503, { status: "disabled" });
      const result = await stub(env).health();
      return toResponse({
        status: result.status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
        body: result.body,
      });
    }
    if (path === "/v1/points" || path.startsWith("/v1/points/")) {
      if (request.method === "OPTIONS") return optionsResponse(request, env);
      if (!pointsEnabled(env)) return disabledResponse();
      const limited = await enforceRateLimit(request, env);
      if (limited) return limited;
      const result: ReadResult = await stub(env).read({
        method: request.method,
        path,
        query: queryOf(url),
        origin: request.headers.get("Origin"),
        cfConnectingIp: request.headers.get("CF-Connecting-IP"),
      });
      return toResponse(result);
    }
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  },
} satisfies ExportedHandler<Env>;
