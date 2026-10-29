import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { healthPayload, httpError, isSha256Hex, retiredEscrowError } from "./config.mjs";
import { KILL_SWITCH } from "./killSwitch.mjs";
import {
  assertBaseSepolia,
  buildFixtureClaim,
  buildFixtureQuote,
  describeCalldata,
  liveSubmitError,
  submitLiveClaim,
  wantsLiveSubmit,
} from "./claims.mjs";
import { prepareLiveClaim } from "./liveAuth.mjs";
import { createReputationCors } from "./reputation/cors.mjs";
import { createRateLimiter } from "./reputation/rateLimit.mjs";
import { createDefaultHooks } from "./reputation/hooks.mjs";
import { createReputationRuntime, handleReputationRequest } from "./reputation/runtime.mjs";
import { createSanctionsGate } from "./sanctionsGate.mjs";
import { PUBLIC_DENIAL_MESSAGE } from "./sanctions.mjs";
import { decideGeoblock, geoLog } from "./geoblock.mjs";

const MAX_BODY = 32 * 1024;

const RELEASE_ADMIN_DUMMY = createHash("sha256").update("sanctions-release-admin-unset", "utf8").digest();

function digestSecret(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest();
}

function digestEqual(actual, expected) {
  if (!Buffer.isBuffer(actual) || !Buffer.isBuffer(expected) || actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// Hash both sides first so timingSafeEqual always compares equal-length digests.
export function secretsEqual(provided, expected) {
  if (!expected) return false;
  return digestEqual(digestSecret(provided), digestSecret(expected));
}

function bearerToken(req) {
  const auth = String(req.headers.authorization || "");
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

export function adminAuthorized(req, adminSecret) {
  if (!adminSecret) return false;
  const header = req.headers["x-admin-secret"] || "";
  const headerOk = secretsEqual(header, adminSecret);
  const bearerOk = secretsEqual(bearerToken(req), adminSecret);
  return headerOk || bearerOk;
}

const RELEASE_ACTOR_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * SANCTIONS_RELEASE_ADMINS maps an admin id to the sha256 hex of that admin's secret.
 * The request carries x-sanctions-actor plus x-admin-secret or Authorization: Bearer.
 * An unknown actor still runs the compare, against a dummy digest.
 */
export function authorizeReleaseAdmin(req, admins) {
  const actor = String(req.headers["x-sanctions-actor"] || "").trim();
  const validId = RELEASE_ACTOR_ID.test(actor);
  const stored = validId && admins && typeof admins === "object" ? admins[actor] : "";
  const expected = isSha256Hex(stored) ? Buffer.from(stored, "hex") : RELEASE_ADMIN_DUMMY;
  const headerOk = digestEqual(digestSecret(req.headers["x-admin-secret"] || ""), expected);
  const bearerOk = digestEqual(digestSecret(bearerToken(req)), expected);
  if (!validId || !isSha256Hex(stored) || !(headerOk || bearerOk)) return { ok: false, actor: "" };
  return { ok: true, actor };
}

export function createCors(allowedOrigins) {
  const allowed = new Set(
    (Array.isArray(allowedOrigins) ? allowedOrigins : String(allowedOrigins || "").split(","))
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );
  return function corsHeaders(req) {
    const headers = {
      "access-control-allow-headers": "content-type,x-admin-secret,authorization,x-screen-session",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      vary: "Origin",
    };
    const origin = req.headers.origin;
    const normalized = origin ? String(origin).replace(/\/$/, "") : "";
    if (normalized && allowed.has(normalized)) headers["access-control-allow-origin"] = origin;
    return headers;
  };
}

function sendJson(res, req, status, body, corsHeaders) {
  const payload = JSON.stringify(body);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    ...corsHeaders(req),
  };
  const retryAfter = Number(body?.retryAfter);
  if (status === 429 && Number.isInteger(retryAfter) && retryAfter > 0) {
    headers["retry-after"] = String(retryAfter);
  }
  res.writeHead(status, headers);
  res.end(payload);
}

/**
 * Render's public proxy is the only hop in front of this process.
 * It appends the connecting client to X-Forwarded-For, so a caller can
 * prepend spoofed addresses. Only the rightmost hop is trusted.
 * Missing header (local tests, or a request that did not pass that proxy)
 * falls back to the socket address. X-Real-IP and Cloudflare headers are
 * not read. This service is not behind Cloudflare.
 */
function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "");
  const hops = forwarded
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (hops.length > 0) return hops[hops.length - 1];
  return req.socket?.remoteAddress || "unknown";
}

async function storeClaimResult(store, key, status, body) {
  if (!store || typeof store.commit !== "function" || !key) return;
  await store.commit(key, { status, body });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(httpError(413, "payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(httpError(400, "invalid_json"));
          return;
        }
        resolve(parsed);
      } catch {
        reject(httpError(400, "invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function errorBody(err) {
  const body = {
    ok: false,
    error: err.error || "request_failed",
  };
  for (const key of [
    "reason",
    "field",
    "chainId",
    "mode",
    "txHash",
    "blockers",
    "dryRun",
    "escrowBooked",
    "escrowAddress",
    "escrowRetired",
    "submitsDisabled",
    "address",
    "current",
    "action",
    "signature",
    "selector",
    "calldata",
    "valueWei",
    "calldataStatus",
    "senderConstraint",
    "senderNote",
    "fixture",
    "revert_data",
    "retryAfter",
  ]) {
    if (err[key] !== undefined) body[key] = err[key];
  }
  return body;
}

function rejectLive(config, body) {
  const err = liveSubmitError(config);
  Object.assign(err, describeCalldata(body));
  throw err;
}

function rejectQuoteBroadcast(config, body) {
  const err = httpError(409, "live_submit_blocked", {
    reason: "quote_does_not_broadcast",
    blockers: [],
    mode: "fixture",
    txHash: null,
    dryRun: true,
    escrowBooked: config.escrowBooked,
    escrowAddress: config.escrowAddress,
  });
  Object.assign(err, describeCalldata(body));
  throw err;
}

/**
 * HTTP control plane. Quotes stay dry-run. Claims broadcast only when live submit is allowed.
 * @param {object} deps
 * @param {ReturnType<import('./config.mjs').loadConfig>} deps.config
 * @param {{ isOn: Function, engage: Function, release: Function }} deps.killSwitch
 * @param {{ reserve: Function }} deps.nonceStore
 * @param {{ claim: Function, commit: Function }} deps.intentNonces
 * @param {{ check: Function, consume: Function }} deps.abuse
 * @param {{ readEscrow: Function, isValidSignature: Function, simulate: Function }} deps.chain
 * @param {{ append: Function }} deps.claimLog
 * @param {() => number} [deps.now]
 * @param {{ send: Function } | null} [deps.broadcaster]
 */
export function createClaimRelayer(deps) {
  const config = deps.config;
  const killSwitch = deps.killSwitch;
  const nonceStore = deps.nonceStore;
  const intentNonces = deps.intentNonces;
  const abuse = deps.abuse;
  const chain = deps.chain;
  const claimLog = deps.claimLog;
  const broadcaster = deps.broadcaster || null;
  const now = deps.now || Date.now;
  const corsHeaders = createCors(config.corsOrigins);
  const reputationCorsHeaders = createReputationCors(config.reputationCors);
  const sanctions = deps.sanctions || createSanctionsGate({
    pepper: typeof deps.walletHashPepper === "string" ? deps.walletHashPepper : "",
  });
  const reputation = deps.reputation || createReputationRuntime({
    hooks: createDefaultHooks({ getScreen: () => sanctions.snapshot() }),
  });
  const limitReputation =
    deps.reputationRateLimit ||
    createRateLimiter({ max: reputation.latest.read_api.rate_limit_per_minute });
  const limitAdmin =
    typeof deps.adminRateLimit === "function"
      ? deps.adminRateLimit
      : createRateLimiter({ windowMs: 60_000, max: 30, clock: now });
  const limitScreen =
    typeof deps.screenRateLimit === "function"
      ? deps.screenRateLimit
      : createRateLimiter({ windowMs: 60_000, max: 30, clock: now });

  function refuseIfKilled(res, req) {
    if (!killSwitch.isOn()) return false;
    sendJson(res, req, 503, { ok: false, error: KILL_SWITCH }, corsHeaders);
    return true;
  }

  function denyScreen(res, req) {
    sendJson(res, req, 403, { ok: false, message: PUBLIC_DENIAL_MESSAGE }, corsHeaders);
    return true;
  }

  function headerValue(req, name) {
    const value = req.headers[String(name || "").toLowerCase()];
    if (Array.isArray(value)) return String(value[0] || "");
    return value == null ? "" : String(value);
  }

  // Production reads a country header only when x-relayer-edge-auth matches
  // RELAYER_EDGE_AUTH. A missing or different value is off-edge, which denies.
  // There is no default country. deps.edgeCountry is a test seam and is used
  // only when that secret is unset. startServer does not set it.
  function trustedEdge(req) {
    const secret = typeof config.relayerEdgeAuth === "string" ? config.relayerEdgeAuth : "";
    if (secret) {
      if (!secretsEqual(headerValue(req, "x-relayer-edge-auth"), secret)) {
        return { edge: false, country: "", regionCode: "", region: "" };
      }
      return {
        edge: true,
        country: headerValue(req, "cf-ipcountry"),
        regionCode: headerValue(req, "cf-region-code"),
        region: headerValue(req, "cf-region"),
      };
    }
    const country = typeof deps.edgeCountry === "string" ? deps.edgeCountry.trim() : "";
    if (!country) return { edge: false, country: "", regionCode: "", region: "" };
    return {
      edge: true,
      country,
      regionCode: String(deps.edgeRegionCode || ""),
      region: String(deps.edgeRegion || ""),
    };
  }

  function locationDenied(req) {
    try {
      const trusted = trustedEdge(req);
      const geo = decideGeoblock({
        country: trusted.country,
        regionCode: trusted.regionCode,
        region: trusted.region,
        edge: trusted.edge,
        publicRoute: true,
        at: now(),
      });
      console.info(JSON.stringify(geoLog(geo)));
      return geo.decision === "deny";
    } catch {
      return true;
    }
  }

  function screenRoute(path) {
    if (path === "/v1/screen/signup") return "signup";
    if (path === "/v1/screen/link") return "link";
    if (path === "/v1/screen/change") return "change";
    if (path === "/v1/screen/unlink") return "unlink";
    return "";
  }

  function claimWallets(body) {
    const sources = [body, body?.intent];
    const wallets = [];
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      for (const key of ["payer", "payee", "sender", "wallet"]) {
        const value = source[key];
        if (typeof value === "string" && value.trim() !== "") wallets.push(value);
      }
    }
    return wallets;
  }

  function walletsDenied(body) {
    try {
      const wallets = claimWallets(body);
      // A fixture or a rejected live body may name no party. Those paths do not broadcast.
      // A named party that is not clear denies before any signature or broadcast.
      if (wallets.length === 0) return false;
      for (const wallet of wallets) {
        const decision = sanctions.screen(wallet, "claim");
        if (!decision || decision.result !== "clear") return true;
        if (sanctions.blocks(wallet)) return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/v1/reputation" || path.startsWith("/v1/reputation/")) {
        if (req.method === "OPTIONS") {
          res.writeHead(204, reputationCorsHeaders(req));
          res.end();
          return;
        }
        if (req.method !== "GET") {
          sendJson(res, req, 405, { ok: false, error: "method_not_allowed" }, reputationCorsHeaders);
          return;
        }
        const ip = req.socket?.remoteAddress || "unknown";
        if (!limitReputation(ip)) {
          sendJson(res, req, 429, { ok: false, error: "rate_limited" }, reputationCorsHeaders);
          return;
        }
        try {
          sendJson(res, req, 200, handleReputationRequest(reputation, url), reputationCorsHeaders);
        } catch (err) {
          const status = Number(err.status) || 500;
          const payload = { ok: false, error: err.error || "request_failed" };
          if (err.chainId !== undefined) payload.chainId = err.chainId;
          sendJson(res, req, status, payload, reputationCorsHeaders);
        }
        return;
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }

      if ((req.method === "GET" || req.method === "HEAD") && path === "/") {
        res.writeHead(302, {
          location: "/health",
          "cache-control": "no-store",
          "content-length": 0,
          ...corsHeaders(req),
        });
        res.end();
        return;
      }

      if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
        sendJson(res, req, 200, healthPayload(config, killSwitch.isOn()), corsHeaders);
        return;
      }

      if (path === "/v1/admin" || path.startsWith("/v1/admin/")) {
        if (!limitAdmin(clientIp(req))) {
          sendJson(res, req, 429, { ok: false, error: "rate_limited", retryAfter: 60 }, corsHeaders);
          return;
        }
      }

      if (path === "/v1/screen" || path.startsWith("/v1/screen/")) {
        if (!limitScreen(clientIp(req))) {
          sendJson(res, req, 429, { ok: false, error: "rate_limited", retryAfter: 60 }, corsHeaders);
          return;
        }
      }

      if (req.method === "POST" && (path === "/v1/admin/pause" || path === "/v1/admin/unpause")) {
        if (!config.adminSecret) {
          sendJson(
            res,
            req,
            200,
            {
              ok: true,
              noop: true,
              killSwitch: killSwitch.isOn(),
              docs: "ADMIN_SECRET is unset. Pause and unpause do not change the kill switch. Set ADMIN_SECRET to gate those routes. KILL_SWITCH=1 still starts the process paused.",
            },
            corsHeaders,
          );
          return;
        }
        if (!adminAuthorized(req, config.adminSecret)) {
          sendJson(res, req, 401, { ok: false, error: "unauthorized" }, corsHeaders);
          return;
        }
        if (path.endsWith("/pause")) killSwitch.engage();
        else killSwitch.release();
        await claimLog.append({
          event: path.endsWith("/pause") ? "kill_switch_on" : "kill_switch_off",
          killSwitch: killSwitch.isOn(),
          chainId: config.chainId,
        });
        sendJson(res, req, 200, { ok: true, killSwitch: killSwitch.isOn(), noop: false }, corsHeaders);
        return;
      }

      if (req.method === "POST" && path === "/v1/admin/sanctions/untie") {
        const admin = authorizeReleaseAdmin(req, config.sanctionsReleaseAdmins);
        if (!admin.ok) {
          sendJson(res, req, 401, { ok: false, error: "unauthorized" }, corsHeaders);
          return;
        }
        const body = await readBody(req);
        const result = sanctions.dropTie(body.accountId, body.wallet, admin.actor);
        sendJson(
          res,
          req,
          result.ok ? 200 : result.http,
          result.ok ? { ok: true } : { ok: false, error: result.error },
          corsHeaders,
        );
        return;
      }

      if (req.method === "POST" && path === "/v1/admin/sanctions/release") {
        const admin = authorizeReleaseAdmin(req, config.sanctionsReleaseAdmins);
        if (!admin.ok) {
          sendJson(res, req, 401, { ok: false, error: "unauthorized" }, corsHeaders);
          return;
        }
        const body = await readBody(req);
        const result = await sanctions.release(body.wallet, admin.actor);
        sendJson(
          res,
          req,
          result.ok ? 200 : result.http,
          result.ok ? { ok: true } : { ok: false, error: result.error },
          corsHeaders,
        );
        return;
      }

      if (req.method === "POST" && (path === "/v1/screen/nonce" || screenRoute(path))) {
        if (locationDenied(req)) {
          denyScreen(res, req);
          return;
        }
        if (path === "/v1/screen/nonce") {
          const issued = sanctions.issueNonce();
          sendJson(res, req, 200, { ok: true, nonce: issued.nonce, expiresAt: issued.expiresAt }, corsHeaders);
          return;
        }
        const body = await readBody(req);
        const op = screenRoute(path);
        const auth = await sanctions.verifyScreen(op, body, headerValue(req, "x-screen-session"), {
          domain: config.screenSiweDomain,
          chainId: config.chainId,
        });
        if (!auth.ok) {
          sendJson(res, req, 401, { ok: false, error: "unproven" }, corsHeaders);
          return;
        }
        const result = await sanctions[op]({
          accountId: auth.accountId,
          wallet: auth.wallet,
          proven: true,
        });
        if (result.http === 401) {
          sendJson(res, req, 401, { ok: false, error: "unproven" }, corsHeaders);
          return;
        }
        const payload = result.ok
          ? { ok: true, status: "unverified" }
          : { ok: false, message: PUBLIC_DENIAL_MESSAGE };
        if (op === "signup" && result.ok) payload.session = sanctions.sessionFor(auth.accountId, auth.wallet);
        sendJson(res, req, result.ok ? 200 : 403, payload, corsHeaders);
        return;
      }

      if (req.method === "POST" && path === "/v1/claims/quote") {
        if (refuseIfKilled(res, req)) return;
        const body = await readBody(req);
        assertBaseSepolia(body);
        if (config.escrowRetired && wantsLiveSubmit(body)) throw retiredEscrowError(config);
        if (locationDenied(req) || walletsDenied(body)) {
          denyScreen(res, req);
          return;
        }
        if (wantsLiveSubmit(body)) {
          if (!config.liveSubmit.allowed) rejectLive(config, body);
          rejectQuoteBroadcast(config, body);
        }
        const quote = await buildFixtureQuote({ body, config, nonceStore, now });
        await claimLog.append({ event: "quote", ...quote, ok: true });
        sendJson(res, req, 200, quote, corsHeaders);
        return;
      }

      if (req.method === "POST" && path === "/v1/claims") {
        if (config.escrowRetired) throw retiredEscrowError(config);
        if (refuseIfKilled(res, req)) return;
        if (abuse && typeof abuse.takeIp === "function") {
          await abuse.takeIp(clientIp(req), now());
        }
        const body = await readBody(req);
        assertBaseSepolia(body);
        if (locationDenied(req) || walletsDenied(body)) {
          denyScreen(res, req);
          return;
        }
        if (wantsLiveSubmit(body)) {
          if (!config.liveSubmit.allowed) rejectLive(config, body);
          const prepared = await prepareLiveClaim({
            body,
            config,
            chain,
            intentNonces,
            abuse,
            nowMs: now(),
            ip: clientIp(req),
          });
          if (walletsDenied({
            sender: prepared.sender,
            payer: prepared.payer,
            payee: prepared.payee,
          })) {
            await storeClaimResult(intentNonces, prepared.nonceKey, 403, {
              ok: false,
              message: PUBLIC_DENIAL_MESSAGE,
            });
            denyScreen(res, req);
            return;
          }
          let result;
          try {
            result = {
              ...(await submitLiveClaim({
                body,
                config,
                broadcaster,
                prepared: { encoded: prepared.encoded, claimId: prepared.claimId },
              })),
              domainMatched: prepared.domainMatched,
            };
          } catch (err) {
            await storeClaimResult(intentNonces, prepared.nonceKey, err.status || 502, errorBody(err));
            throw err;
          }
          await storeClaimResult(intentNonces, prepared.nonceKey, 200, result);
          await claimLog.append({
            event: "claim_live",
            ...result,
            payer: body.payer,
            payee: body.payee,
            amountWei: body.amountWei,
            chainId: config.chainId,
            escrowBooked: config.escrowBooked,
            relayerAddress: config.relayerAddress,
          });
          sendJson(res, req, 200, result, corsHeaders);
          return;
        }
        const result = buildFixtureClaim(body, config);
        await claimLog.append({
          event: "claim_fixture",
          ...result,
          payer: body.payer,
          payee: body.payee,
          amountWei: body.amountWei,
          chainId: config.chainId,
          escrowBooked: config.escrowBooked,
          relayerAddress: config.relayerAddress,
        });
        sendJson(res, req, 200, result, corsHeaders);
        return;
      }

      sendJson(res, req, 404, { ok: false, error: "not_found" }, corsHeaders);
    } catch (err) {
      const status = Number(err.status) || 500;
      const body = errorBody(status === 500 ? { error: "request_failed" } : err);
      if (err.nonceClaimed && err.nonceKey) {
        try {
          await storeClaimResult(intentNonces, err.nonceKey, status, body);
        } catch {
          /* a failed nonce write must not hide the response */
        }
      }
      if (status === 500 || status === 502) {
        console.error("claim_relayer_error", err.error || "request_failed");
      }
      try {
        await claimLog.append({
          event: "claim_error",
          error: body.error,
          reason: body.reason,
          status,
          chainId: config.chainId,
        });
      } catch {
        /* logging must not hide the response */
      }
      if (!res.headersSent) sendJson(res, req, status, body, corsHeaders);
    }
  });
}
