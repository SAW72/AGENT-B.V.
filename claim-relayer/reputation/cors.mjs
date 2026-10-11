/**
 * CORS for the reputation read API only.
 * Exact https origins. No suffix match, no substring match, no credentials,
 * and no Access-Control-Allow-Origin: *.
 */

const EXACT_HTTPS_ORIGIN =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Accept only `https://host` with no userinfo, port, path, query, hash,
 * trailing slash, or `*`. Empty input is skipped by the caller.
 * @param {unknown} raw
 */
export function parseExactHttpsOrigin(raw) {
  const entry = String(raw ?? "").trim();
  if (!entry) return { ok: false, reason: "empty", entry };
  if (entry.includes("*")) return { ok: false, reason: "wildcard", entry };
  if (entry.endsWith("/")) return { ok: false, reason: "trailing_slash", entry };
  if (!entry.startsWith("https://")) return { ok: false, reason: "scheme", entry };
  if (!EXACT_HTTPS_ORIGIN.test(entry)) return { ok: false, reason: "malformed", entry };
  let url;
  try {
    url = new URL(entry);
  } catch {
    return { ok: false, reason: "malformed", entry };
  }
  if (
    url.origin !== entry ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    return { ok: false, reason: "malformed", entry };
  }
  return { ok: true, origin: entry };
}

export function createReputationCors(policy) {
  const allowed = new Set(Array.isArray(policy?.origins) ? policy.origins : []);
  return function reputationCorsHeaders(req) {
    const headers = {
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,OPTIONS",
      vary: "Origin",
    };
    const origin = req.headers?.origin;
    if (typeof origin === "string" && allowed.has(origin)) {
      headers["access-control-allow-origin"] = origin;
    }
    return headers;
  };
}
