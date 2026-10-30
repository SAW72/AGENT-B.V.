// Cloudflare Worker in front of the Render claim relayer.
// The browser calls this Worker. This Worker is the only hop that may
// set x-relayer-edge-auth and the location headers the origin trusts.
// RELAYER_EDGE_AUTH is a Worker secret. It is not in wrangler.toml.
// /internal/sanctions/* is the relayer data API. It is never forwarded.

import { handleSanctions } from "./sanctionsApi.mjs";

export const ORIGIN = "https://bot-verifier-claim-relayer.onrender.com";

const CLAIM_CORS = new Set([
  "https://agent-bv.pages.dev",
]);

const DROPPED_HEADERS = new Set([
  "x-relayer-edge-auth",
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "host",
  "content-length",
]);

export function edgeSecret(env) {
  const value = env && env.RELAYER_EDGE_AUTH;
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizePath(pathname) {
  let current = String(pathname || "");
  for (let i = 0; i < 5; i += 1) {
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      break;
    }
    if (decoded === current) break;
    current = decoded;
  }
  const noQuery = current.split("?")[0].split("#")[0];
  const pieces = [];
  for (const raw of noQuery.split(/[/\\]/)) {
    const segment = raw.split("\0")[0];
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      pieces.pop();
      continue;
    }
    pieces.push(segment);
  }
  return `/${pieces.join("/")}`.toLowerCase();
}

function pathUnder(pathname, root) {
  const path = normalizePath(pathname);
  return path === root || path.startsWith(`${root}/`);
}

export function reservedSanctionsPath(pathname) {
  return pathUnder(pathname, "/internal/sanctions");
}

export function reservedAdminPath(pathname) {
  return pathUnder(pathname, "/v1/admin");
}

function textField(value) {
  return typeof value === "string" ? value : "";
}

function dropClientHeader(name) {
  const lower = String(name || "").toLowerCase();
  if (DROPPED_HEADERS.has(lower)) return true;
  if (lower.startsWith("cf-")) return true;
  if (lower.startsWith("x-edge-")) return true;
  if (lower.startsWith("x-relayer-data-")) return true;
  return false;
}

export function forwardedHeaders(request, secret) {
  // CF-Connecting-IP is the platform address on this Worker.
  // The origin trusts x-edge-client-ip, not the Cloudflare header name.
  const clientIp = (request.headers.get("CF-Connecting-IP") || "").trim();
  const cf = request.cf && typeof request.cf === "object" ? request.cf : {};
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (dropClientHeader(name)) continue;
    headers.append(name, value);
  }
  headers.set("x-relayer-edge-auth", secret);
  headers.set("x-edge-country", textField(cf.country));
  headers.set("x-edge-region-code", textField(cf.regionCode));
  headers.set("x-edge-region", textField(cf.region));
  headers.set("x-edge-client-ip", clientIp);
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
    return handleSanctions(request, env, url.pathname, normalizePath(url.pathname));
  }
  if (reservedAdminPath(url.pathname)) {
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
