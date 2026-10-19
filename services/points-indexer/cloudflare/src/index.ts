import { pointsEnabled, type ReadResult } from "./read-api";
import { PointsObject } from "./points-object";

export { PointsObject };

const OBJECT_NAME = "base-sepolia";

function stub(env: Env) {
  return env.POINTS.get(env.POINTS.idFromName(OBJECT_NAME));
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
  const body = JSON.stringify({ ok: false, error: "points_disabled" });
  return new Response(body, {
    status: 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-length": String(new TextEncoder().encode(body).byteLength),
    },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/health") {
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
      if (!pointsEnabled(env)) return disabledResponse();
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
