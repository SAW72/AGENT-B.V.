/**
 * CORS for the reputation read API only.
 * Exact https origins. No suffix match, no substring match, no credentials,
 * and no Access-Control-Allow-Origin: *.
 * One trailing slash is removed, and the scheme and host are lowercased,
 * before that exact check. Wildcards, null, http, ports, paths, query,
 * hash, and userinfo are still rejected.
 */

const EXACT_HTTPS_ORIGIN =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Normalize one trailing slash and the scheme/host case, then accept only
 * `https://host`. Empty input is skipped by the caller.
 * @param {unknown} raw
 */
export function parseExactHttpsOrigin(raw) {
  const original = String(raw ?? "").trim();
  if (!original) return { ok: false, reason: "empty", entry: original };
  if (original.includes("*")) return { ok: false, reason: "wildcard", entry: original };
  if (original.toLowerCase() === "null") return { ok: false, reason: "null", entry: original };

  const stripped = original.endsWith("/") ? original.slice(0, -1) : original;
  const separator = stripped.indexOf("://");
  if (separator <= 0) return { ok: false, reason: "scheme", entry: original };
  const scheme = stripped.slice(0, separator).toLowerCase();
  if (scheme !== "https") return { ok: false, reason: "scheme", entry: original };
  const rest = stripped.slice(separator + 3);
  if (!rest) return { ok: false, reason: "malformed", entry: original };
  if (rest.includes("@")) return { ok: false, reason: "userinfo", entry: original };
  const tailAt = rest.search(/[/?#]/);
  const hostRaw = tailAt === -1 ? rest : rest.slice(0, tailAt);
  const tail = tailAt === -1 ? "" : rest.slice(tailAt);
  if (tail.startsWith("?")) return { ok: false, reason: "query", entry: original };
  if (tail.startsWith("#")) return { ok: false, reason: "hash", entry: original };
  if (tail) return { ok: false, reason: "path", entry: original };
  if (hostRaw.includes(":")) return { ok: false, reason: "port", entry: original };
  const entry = `https://${hostRaw.toLowerCase()}`;
  if (!EXACT_HTTPS_ORIGIN.test(entry)) return { ok: false, reason: "malformed", entry: original };
  let url;
  try {
    url = new URL(entry);
  } catch {
    return { ok: false, reason: "malformed", entry: original };
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
    return { ok: false, reason: "malformed", entry: original };
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
