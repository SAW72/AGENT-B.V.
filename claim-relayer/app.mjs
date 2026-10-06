import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { healthPayload, httpError, retiredEscrowError } from "./config.mjs";
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
import { createReputationRuntime, handleReputationRequest } from "./reputation/runtime.mjs";

const MAX_BODY = 32 * 1024;

function secretsEqual(provided, expected) {
  const a = Buffer.from(String(provided || ""), "utf8");
  const b = Buffer.from(String(expected || ""), "utf8");
  if (!expected || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerToken(req) {
  const auth = String(req.headers.authorization || "");
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

export function adminAuthorized(req, adminSecret) {
  if (!adminSecret) return false;
  const header = req.headers["x-admin-secret"] || "";
  return secretsEqual(header, adminSecret) || secretsEqual(bearerToken(req), adminSecret);
}

export function createCors(allowedOrigins) {
  const allowed = new Set(
    (Array.isArray(allowedOrigins) ? allowedOrigins : String(allowedOrigins || "").split(","))
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );
  return function corsHeaders(req) {
    const headers = {
      "access-control-allow-headers": "content-type,x-admin-secret,authorization",
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
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    ...corsHeaders(req),
  });
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
  const reputation = deps.reputation || createReputationRuntime();
  const limitReputation =
    deps.reputationRateLimit ||
    createRateLimiter({ max: reputation.latest.read_api.rate_limit_per_minute });

  function refuseIfKilled(res, req) {
    if (!killSwitch.isOn()) return false;
    sendJson(res, req, 503, { ok: false, error: KILL_SWITCH }, corsHeaders);
    return true;
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

      if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
        sendJson(res, req, 200, healthPayload(config, killSwitch.isOn()), corsHeaders);
        return;
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

      if (req.method === "POST" && path === "/v1/claims/quote") {
        if (refuseIfKilled(res, req)) return;
        const body = await readBody(req);
        assertBaseSepolia(body);
        if (config.escrowRetired && wantsLiveSubmit(body)) throw retiredEscrowError(config);
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
          let result;
          try {
            result = await submitLiveClaim({
              body,
              config,
              broadcaster,
              prepared: { encoded: prepared.encoded, claimId: prepared.claimId },
            });
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
