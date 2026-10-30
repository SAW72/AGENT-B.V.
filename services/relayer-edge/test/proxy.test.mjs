import assert from "node:assert/strict";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { ORIGIN, edgeSecret, handle, reservedAdminPath, reservedSanctionsPath } from "../src/index.mjs";

const SECRET = "test-edge-auth";
const PAGES = "https://agent-bv.pages.dev";
const WORKER = "https://agent-bv-relayer-edge.s-a-wight72.workers.dev";

function incoming({ path = "/health", method = "GET", headers = {}, cf = {}, body } = {}) {
  const init = { method, headers };
  if (body !== undefined) init.body = body;
  const request = new Request(`${WORKER}${path}`, init);
  Object.defineProperty(request, "cf", { value: cf });
  return request;
}

function recorder(status = 200, responseHeaders = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(status === 204 ? null : JSON.stringify({ ok: true }), {
      status,
      headers: { "content-type": "application/json", ...responseHeaders },
    });
  };
  return { calls, fetchImpl };
}

function headerValues(headers, name) {
  const wanted = name.toLowerCase();
  const values = [];
  for (const [key, value] of headers) {
    if (key.toLowerCase() === wanted) values.push(value);
  }
  return values;
}

describe("relayer edge proxy", () => {
  it("replaces an injected x-relayer-edge-auth and drops injected cf-* headers", async () => {
    const { calls, fetchImpl } = recorder();
    const headers = new Headers();
    headers.append("x-relayer-edge-auth", "injected-one");
    headers.append("x-relayer-edge-auth", "injected-two");
    headers.set("CF-IPCountry", "US");
    headers.set("cf-region-code", "CA");
    headers.set("CF-Region", "California");
    headers.set("CF-Ray", "injected-ray");
    headers.set("CF-Connecting-IP", "203.0.113.10");
    headers.set("X-Edge-Country", "US");
    headers.set("X-Edge-Client-IP", "198.51.100.7");
    headers.set("content-type", "application/json");
    const response = await handle(
      incoming({
        path: "/v1/claims?dry=1",
        method: "POST",
        headers,
        cf: { country: "DE", regionCode: "BE", region: "Berlin" },
        body: JSON.stringify({ claimId: "1" }),
      }),
      { RELAYER_EDGE_AUTH: SECRET },
      fetchImpl,
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${ORIGIN}/v1/claims?dry=1`);
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(headerValues(calls[0].init.headers, "x-relayer-edge-auth"), [SECRET]);
    assert.equal(headerValues(calls[0].init.headers, "cf-ray").length, 0);
    assert.equal(headerValues(calls[0].init.headers, "cf-connecting-ip").length, 0);
    assert.equal(calls[0].init.headers.get("x-edge-country"), "DE");
    assert.equal(calls[0].init.headers.get("x-edge-client-ip"), "203.0.113.10");
    assert.equal(JSON.stringify([...calls[0].init.headers]).includes("198.51.100.7"), false);
    const forwarded = Buffer.from(calls[0].init.body).toString("utf8");
    assert.equal(forwarded, JSON.stringify({ claimId: "1" }));
    assert.equal(calls[0].init.headers.get("content-type"), "application/json");
  });

  it("strips client location headers and sends request.cf instead", async () => {
    const { calls, fetchImpl } = recorder();
    await handle(
      incoming({
        headers: {
          "CF-IPCountry": "US",
          "CF-Region-Code": "CA",
          "CF-Region": "California",
          "cf-visitor": "{\"scheme\":\"https\"}",
          "x-edge-country": "US",
          "x-edge-region-code": "CA",
          "x-edge-region": "California",
          "x-relayer-edge-auth": "not-the-proxy",
          Origin: PAGES,
        },
        cf: { country: "UA", regionCode: "40", region: "Sevastopol" },
      }),
      { RELAYER_EDGE_AUTH: `  ${SECRET}  ` },
      fetchImpl,
    );
    assert.equal(calls.length, 1);
    const headers = calls[0].init.headers;
    assert.equal(headers.get("x-edge-country"), "UA");
    assert.equal(headers.get("x-edge-region-code"), "40");
    assert.equal(headers.get("x-edge-region"), "Sevastopol");
    assert.equal(headers.get("cf-ipcountry"), null);
    assert.equal(headers.get("cf-region-code"), null);
    assert.equal(headers.get("cf-region"), null);
    assert.equal(headers.get("cf-visitor"), null);
    assert.equal(headers.get("x-relayer-edge-auth"), SECRET);
    assert.equal(headers.get("origin"), PAGES);
    assert.equal(JSON.stringify([...headers]).includes("US"), false);
    assert.equal(JSON.stringify([...headers]).includes("California"), false);
    assert.equal(JSON.stringify([...headers]).includes("not-the-proxy"), false);
    const emptyCf = recorder();
    await handle(
      incoming({
        headers: { "CF-IPCountry": "US", "CF-Region-Code": "CA", "CF-Region": "California" },
        cf: {},
      }),
      { RELAYER_EDGE_AUTH: SECRET },
      emptyCf.fetchImpl,
    );
    assert.equal(emptyCf.calls[0].init.headers.get("x-edge-country"), "");
    assert.equal(emptyCf.calls[0].init.headers.get("x-edge-region-code"), "");
    assert.equal(emptyCf.calls[0].init.headers.get("x-edge-region"), "");
    assert.equal(emptyCf.calls[0].init.headers.get("cf-ipcountry"), null);
  });

  it("returns 503 and forwards nothing when the secret is missing", async () => {
    for (const env of [{}, { RELAYER_EDGE_AUTH: "" }, { RELAYER_EDGE_AUTH: "   " }, { RELAYER_EDGE_AUTH: 1 }]) {
      const { calls, fetchImpl } = recorder();
      const response = await handle(
        incoming({
          path: "/health",
          headers: { Origin: PAGES, "x-relayer-edge-auth": "injected", "CF-IPCountry": "US" },
        }),
        env,
        fetchImpl,
      );
      const text = await response.text();
      assert.equal(response.status, 503);
      assert.deepEqual(JSON.parse(text), { ok: false, error: "unavailable" });
      assert.equal(text.includes(SECRET), false);
      assert.equal(response.headers.get("access-control-allow-origin"), PAGES);
      assert.equal(calls.length, 0);
    }
    const refused = recorder();
    const other = await handle(
      incoming({ headers: { Origin: "https://evil.example" } }),
      {},
      refused.fetchImpl,
    );
    assert.equal(other.status, 503);
    assert.equal(other.headers.get("access-control-allow-origin"), null);
    assert.equal(refused.calls.length, 0);
  });

  it("sends region headers from request.cf", async () => {
    const { calls, fetchImpl } = recorder();
    await handle(
      incoming({
        cf: { country: "DE", regionCode: "BE", region: "Berlin" },
      }),
      { RELAYER_EDGE_AUTH: SECRET },
      fetchImpl,
    );
    const headers = calls[0].init.headers;
    assert.equal(headers.get("x-edge-country"), "DE");
    assert.equal(headers.get("x-edge-region-code"), "BE");
    assert.equal(headers.get("x-edge-region"), "Berlin");
    assert.equal(headers.get("cf-ipcountry"), null);
  });

  it("sets x-edge-client-ip from the platform header and strips forwarded client addresses", async () => {
    const { calls, fetchImpl } = recorder();
    await handle(
      incoming({
        headers: {
          "CF-Connecting-IP": "203.0.113.10",
          "X-Forwarded-For": "198.51.100.9, 203.0.113.10",
          "X-Real-IP": "198.51.100.8",
          Forwarded: "for=198.51.100.8",
          "X-Edge-Client-IP": "198.51.100.7",
          "True-Client-IP": "198.51.100.8",
        },
        cf: { country: "DE", regionCode: "BE", region: "Berlin" },
      }),
      { RELAYER_EDGE_AUTH: SECRET },
      fetchImpl,
    );
    const headers = calls[0].init.headers;
    assert.equal(headers.get("x-edge-client-ip"), "203.0.113.10");
    assert.equal(headers.get("cf-connecting-ip"), null);
    assert.equal(headers.get("x-forwarded-for"), null);
    assert.equal(headers.get("x-real-ip"), null);
    assert.equal(headers.get("forwarded"), null);
    assert.equal(JSON.stringify([...headers]).includes("198.51.100.9"), false);
    assert.equal(JSON.stringify([...headers]).includes("198.51.100.7"), false);
    assert.equal(headers.get("true-client-ip"), "198.51.100.8");
  });

  it("never forwards /internal/sanctions/*", async () => {
    const paths = [
      "/internal/sanctions",
      "/internal/sanctions/",
      "/internal/sanctions/list",
      "/internal/sanctions/list?format=json",
    ];
    for (const path of paths) {
      const { calls, fetchImpl } = recorder();
      const response = await handle(
        incoming({
          path,
          method: "POST",
          headers: { Origin: PAGES, "content-type": "application/json" },
          body: JSON.stringify({ address: "0xabc" }),
        }),
        { RELAYER_EDGE_AUTH: SECRET },
        fetchImpl,
      );
      assert.equal(response.status, 503, path);
      assert.deepEqual(await response.json(), { ok: false, error: "unavailable" });
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal(calls.length, 0, path);
    }
    const missingSecret = recorder();
    const blocked = await handle(
      incoming({ path: "/internal/sanctions/list" }),
      {},
      missingSecret.fetchImpl,
    );
    assert.equal(blocked.status, 503);
    assert.equal(missingSecret.calls.length, 0);
    assert.equal(reservedSanctionsPath("/internal/sanctions-other"), false);
    assert.equal(reservedSanctionsPath("/Internal/Sanctions"), true);
    assert.equal(reservedSanctionsPath("/internal/%73anctions"), true);
    assert.equal(reservedSanctionsPath("/%2569nternal/sanctions"), true);
    assert.equal(reservedSanctionsPath("/internal/sanctions%00"), true);
    const allowed = recorder();
    const forwarded = await handle(
      incoming({ path: "/internal/sanctions-other" }),
      { RELAYER_EDGE_AUTH: SECRET },
      allowed.fetchImpl,
    );
    assert.equal(forwarded.status, 200);
    assert.equal(allowed.calls.length, 1);
    assert.equal(allowed.calls[0].url, `${ORIGIN}/internal/sanctions-other`);
  });

  it("passes method and path through and keeps Pages CORS from the origin", async () => {
    const { calls, fetchImpl } = recorder(200, { "access-control-allow-origin": PAGES });
    const response = await handle(
      incoming({
        path: "/health",
        method: "GET",
        headers: { Origin: PAGES },
        cf: { country: "US", regionCode: "", region: "" },
      }),
      { RELAYER_EDGE_AUTH: SECRET },
      fetchImpl,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), PAGES);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].url, `${ORIGIN}/health`);
    assert.equal(calls[0].init.body, undefined);
    assert.equal(calls[0].init.headers.get("origin"), PAGES);
    const options = recorder(204, {
      "access-control-allow-origin": PAGES,
      "access-control-allow-methods": "GET,POST,OPTIONS",
    });
    const preflight = await handle(
      incoming({ path: "/v1/claims", method: "OPTIONS", headers: { Origin: PAGES } }),
      { RELAYER_EDGE_AUTH: SECRET },
      options.fetchImpl,
    );
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), PAGES);
    assert.equal(options.calls[0].init.method, "OPTIONS");
    assert.equal(options.calls[0].url, `${ORIGIN}/v1/claims`);
  });

  it("does not call a different host when the path is scheme-relative", async () => {
    const { calls, fetchImpl } = recorder();
    const response = await handle(
      incoming({ path: "//evil.example/health" }),
      { RELAYER_EDGE_AUTH: SECRET },
      fetchImpl,
    );
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).origin, ORIGIN);
    assert.equal(response.status, 200);
  });

  it("never forwards a decoded or mixed-case sanctions path", async () => {
    const paths = [
      "/Internal/Sanctions",
      "/INTERNAL/sanctions/List",
      "/internal/%73anctions",
      "/%2569nternal/sanctions",
      "/internal/sanctions%00",
    ];
    for (const path of paths) {
      const { calls, fetchImpl } = recorder();
      const response = await handle(
        incoming({ path, method: "POST", headers: { Origin: PAGES } }),
        { RELAYER_EDGE_AUTH: SECRET },
        fetchImpl,
      );
      assert.equal(response.status, 503, path);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal(calls.length, 0, path);
    }
    const missingSecret = recorder();
    const blocked = await handle(
      incoming({ path: "/Internal/Sanctions" }),
      {},
      missingSecret.fetchImpl,
    );
    assert.equal(blocked.status, 503);
    assert.equal(missingSecret.calls.length, 0);
  });

  it("returns 404 for /v1/admin and does not forward", async () => {
    const paths = [
      "/v1/admin",
      "/v1/admin/",
      "/v1/admin/pause",
      "/V1/Admin/Pause",
      "/v1/admin%2fpause",
      "/v1/%61dmin/unpause",
    ];
    for (const path of paths) {
      const { calls, fetchImpl } = recorder();
      const response = await handle(
        incoming({
          path,
          method: "POST",
          headers: { Origin: PAGES, "content-type": "application/json" },
          body: "{}",
        }),
        { RELAYER_EDGE_AUTH: SECRET },
        fetchImpl,
      );
      assert.equal(response.status, 404, path);
      assert.deepEqual(await response.json(), { ok: false, error: "not_found" });
      assert.equal(response.headers.get("access-control-allow-origin"), PAGES);
      assert.equal(calls.length, 0, path);
      assert.equal(reservedAdminPath(path), true, path);
    }
    const missingSecret = recorder();
    const blocked = await handle(
      incoming({ path: "/v1/admin/pause" }),
      {},
      missingSecret.fetchImpl,
    );
    assert.equal(blocked.status, 404);
    assert.equal(missingSecret.calls.length, 0);
    assert.equal(reservedAdminPath("/v1/administrator"), false);
    assert.equal(reservedAdminPath("/v1/admin-other"), false);
    const allowed = recorder();
    const forwarded = await handle(
      incoming({ path: "/v1/administrator" }),
      { RELAYER_EDGE_AUTH: SECRET },
      allowed.fetchImpl,
    );
    assert.equal(forwarded.status, 200);
    assert.equal(allowed.calls.length, 1);
    assert.equal(allowed.calls[0].url, `${ORIGIN}/v1/administrator`);
  });

  it("blocks %2e, %2F, and a leading double slash on sanctions and admin paths", async () => {
    const paths = [
      "/internal/%2e/sanctions",
      "/internal%2Fsanctions",
      "//internal/sanctions",
      "/v1/%2e/admin",
      "/v1%2Fadmin",
      "//v1/admin",
    ];
    for (const path of paths) {
      const { calls, fetchImpl } = recorder();
      const response = await handle(
        incoming({ path, method: "POST", headers: { Origin: PAGES } }),
        { RELAYER_EDGE_AUTH: SECRET },
        fetchImpl,
      );
      const sanctions = path.includes("sanction");
      assert.equal(reservedSanctionsPath(path), sanctions, path);
      assert.equal(reservedAdminPath(path), !sanctions, path);
      assert.equal(calls.length, 0, path);
      if (sanctions) {
        // In-worker data API. No data secret means unavailable, and the path is not forwarded.
        assert.equal(response.status, 503, path);
        assert.deepEqual(await response.json(), { ok: false, error: "unavailable" });
        assert.equal(response.headers.get("access-control-allow-origin"), null);
      } else {
        assert.equal(response.status, 404, path);
        assert.deepEqual(await response.json(), { ok: false, error: "not_found" });
      }
    }
  });

  it("does not echo localhost on worker CORS responses", async () => {
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173"]) {
      const missing = recorder();
      const denied = await handle(
        incoming({ path: "/health", headers: { Origin: origin } }),
        {},
        missing.fetchImpl,
      );
      assert.equal(denied.status, 503);
      assert.equal(denied.headers.get("access-control-allow-origin"), null);
      const admin = recorder();
      const hidden = await handle(
        incoming({ path: "/v1/admin/pause", headers: { Origin: origin } }),
        { RELAYER_EDGE_AUTH: SECRET },
        admin.fetchImpl,
      );
      assert.equal(hidden.status, 404);
      assert.equal(hidden.headers.get("access-control-allow-origin"), null);
      assert.equal(admin.calls.length, 0);
    }
  });

  it("strips spoofed x-relayer-data headers and never proxies an internal path", async () => {
    const { calls, fetchImpl } = recorder();
    const response = await handle(
      incoming({
        path: "/health",
        headers: {
          "x-relayer-data-sig": "spoofed-sig",
          "x-relayer-data-extra": "spoofed-extra",
          "x-relayer-ts": "1",
          "content-type": "application/json",
        },
      }),
      { RELAYER_EDGE_AUTH: SECRET },
      fetchImpl,
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.get("x-relayer-data-sig"), null);
    assert.equal(calls[0].init.headers.get("x-relayer-data-extra"), null);
    assert.equal(JSON.stringify([...calls[0].init.headers]).includes("spoofed-sig"), false);
    assert.equal(JSON.stringify([...calls[0].init.headers]).includes("spoofed-extra"), false);
    const dataSecret = "test-relayer-data-auth";
    const body = JSON.stringify({});
    const ts = String(Date.now());
    const nonce = randomBytes(16).toString("base64url");
    const path = "/internal/sanctions/not-an-op";
    const hash = createHash("sha256").update(body).digest("hex");
    const sig = createHmac("sha256", dataSecret).update(`POST\n${path}\n${ts}\n${nonce}\n${hash}`).digest("hex");
    const internal = recorder();
    const hidden = await handle(
      incoming({
        path,
        method: "POST",
        headers: {
          Origin: PAGES,
          "content-type": "application/json",
          "x-relayer-ts": ts,
          "x-relayer-nonce": nonce,
          "x-relayer-data-sig": sig,
        },
        body,
      }),
      { RELAYER_EDGE_AUTH: SECRET, RELAYER_DATA_AUTH: dataSecret },
      internal.fetchImpl,
    );
    assert.equal(hidden.status, 404);
    assert.deepEqual(await hidden.json(), { ok: false, error: "not_found" });
    assert.equal(hidden.headers.get("access-control-allow-origin"), null);
    assert.equal(internal.calls.length, 0);
    const wrong = recorder();
    const rejected = await handle(
      incoming({
        path: "/internal/sanctions/health",
        method: "POST",
        headers: {
          "x-relayer-ts": ts,
          "x-relayer-nonce": nonce,
          "x-relayer-data-sig": "ab".repeat(32),
        },
        body,
      }),
      { RELAYER_DATA_AUTH: dataSecret },
      wrong.fetchImpl,
    );
    assert.equal(rejected.status, 401);
    assert.equal(wrong.calls.length, 0);
  });

  it("treats a blank secret as unset", () => {
    assert.equal(edgeSecret(undefined), "");
    assert.equal(edgeSecret({}), "");
    assert.equal(edgeSecret({ RELAYER_EDGE_AUTH: "  " }), "");
    assert.equal(edgeSecret({ RELAYER_EDGE_AUTH: SECRET }), SECRET);
  });
});
