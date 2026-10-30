// Cloudflare Worker in front of the Render claim relayer.
// The browser calls this Worker. This Worker is the only hop that may
// set x-relayer-edge-auth and the location headers the origin trusts.
// RELAYER_EDGE_AUTH is a Worker secret. It is not in wrangler.toml.

export const ORIGIN = "https://bot-verifier-claim-relayer.onrender.com";

const CLAIM_CORS = new Set([
  "https://agent-bv.pages.dev",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

export function edgeSecret(env) {
  const value = env && env.RELAYER_EDGE_AUTH;
  if (typeof value !== "string") return "";
  return value.trim();
}

export function reservedSanctionsPath(pathname) {
  return pathname === "/internal/sanctions" || pathname.startsWith("/internal/sanctions/");
}

function textField(value) {
  return typeof value === "string" ? value : "";
}

export function forwardedHeaders(request, secret) {
  const clientIp = (request.headers.get("CF-Connecting-IP") || "").trim();
  const cf = request.cf && typeof request.cf === "object" ? request.cf : {};
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (lower === "x-relayer-edge-auth" || lower.startsWith("cf-")) continue;
    if (lower === "host" || lower === "content-length") continue;
    headers.append(name, value);
  }
  headers.set("x-relayer-edge-auth", secret);
  headers.set("cf-ipcountry", textField(cf.country));
  headers.set("cf-region-code", textField(cf.regionCode));
  headers.set("cf-region", textField(cf.region));
  headers.set("CF-Connecting-IP", clientIp);
  return headers;
}

function corsFor(request) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-headers": "content-type,x-admin-secret,authorization,x-screen-session",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    vary: "Origin",
  };
  const origin = request.headers.get("origin");
  const normalized = origin ? String(origin).replace(/\/$/, "") : "";
  if (normalized && CLAIM_CORS.has(normalized)) headers["access-control-allow-origin"] = origin;
  return headers;
}

function json(status, body, request) {
  return new Response(JSON.stringify(body), { status, headers: corsFor(request) });
}

function originUrl(requestUrl) {
  const url = new URL(requestUrl);
  const target = new URL(ORIGIN);
  target.pathname = url.pathname;
  target.search = url.search;
  if (target.origin !== ORIGIN) return null;
  return target;
}

export async function handle(request, env, fetchImpl = globalThis.fetch) {
  const url = new URL(request.url);
  if (reservedSanctionsPath(url.pathname)) {
    return json(404, { ok: false, error: "not_found" }, request);
  }
  const secret = edgeSecret(env);
  if (!secret) {
    return json(503, { ok: false, error: "unavailable" }, request);
  }
  const target = originUrl(request.url);
  if (!target) {
    return json(404, { ok: false, error: "not_found" }, request);
  }
  const headers = forwardedHeaders(request, secret);
  const init = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  return fetchImpl(target, init);
}

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
