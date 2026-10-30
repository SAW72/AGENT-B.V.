// Signed client for the edge Worker sanctions API. Fail closed on timeout and HTTP errors.
// The secret never goes in a log, a URL, or an error message.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { httpError } from "./config.mjs";

export const ADDRESS_JSON_MAX = 80_000;
const DEFAULT_TIMEOUT_MS = 3000;

export function fitAddressesJson(addressesJson) {
  const json = typeof addressesJson === "string" ? addressesJson : "";
  if (json.length <= ADDRESS_JSON_MAX) return json;
  let count = 0;
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) count = parsed.length;
  } catch {
    count = 0;
  }
  return JSON.stringify({ count, omitted: true });
}

export function assertSanctionsDataConfig(env) {
  const raw = String(env?.SANCTIONS_DATA_URL || "").trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw httpError(500, "sanctions_data_config_required");
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const secret = String(env?.RELAYER_DATA_AUTH || "").trim();
  const timeoutRaw = env?.SANCTIONS_DATA_TIMEOUT_MS;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeoutRaw != null && String(timeoutRaw).trim() !== "") {
    timeoutMs = Number(timeoutRaw);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || path !== "/internal/sanctions"
    || !/^[0-9a-fA-F]{64,}$/.test(secret)
    || secret.length % 2 !== 0
    || !Number.isFinite(timeoutMs)
    || timeoutMs <= 0
  ) {
    throw httpError(500, "sanctions_data_config_required");
  }
  return { url: `${url.origin}/internal/sanctions`, secret, timeoutMs };
}

function dataError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

export function createSanctionsDataClient(options = {}) {
  const base = String(options.url || "").replace(/\/+$/, "");
  const secret = String(options.secret || "");
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const nextNonce = options.nonce || (() => randomBytes(16).toString("base64url"));

  async function call(op, body = {}) {
    const payload = JSON.stringify(body ?? {});
    const ts = String(now());
    const nonce = nextNonce();
    const path = `${new URL(base).pathname}/${op}`;
    const bodyHash = createHash("sha256").update(payload).digest("hex");
    const sig = createHmac("sha256", secret).update(`POST\n${path}\n${ts}\n${nonce}\n${bodyHash}`).digest("hex");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const response = await fetchImpl(`${base}/${op}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-relayer-ts": ts,
          "x-relayer-nonce": nonce,
          "x-relayer-data-sig": sig,
        },
        body: payload,
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!response.ok || !parsed || parsed.ok !== true) {
        throw dataError(parsed?.error || "unavailable", response.status);
      }
      return parsed.result;
    } catch (error) {
      if (error && error.code && Number.isFinite(error.status)) throw error;
      const aborted = error && (error.name === "AbortError" || error.code === "ABORT_ERR");
      throw dataError(aborted ? "timeout" : "unavailable", 0);
    } finally {
      clearTimeout(timer);
    }
  }

  return { call };
}
