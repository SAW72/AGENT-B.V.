import assert from "node:assert/strict";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createClaimLog } from "../claimLog.mjs";
import { loadConfig } from "../config.mjs";
import { createClaimRelayer } from "../app.mjs";
import { createKillSwitch } from "../killSwitch.mjs";
import { createNonceStore } from "../nonceStore.mjs";
import { assertSanctionsDataConfig, createSanctionsDataClient } from "../sanctionsData.mjs";
import { createSanctionsGate } from "../sanctionsGate.mjs";
import { SANCTIONS_REFRESH_EVERY_MS, startSanctionsRefresh } from "../sanctionsRefresh.mjs";
import { screenFromAddressList } from "../sanctions.mjs";
import { startServer } from "../server.mjs";
import { TEST_PEPPER } from "./clearGate.mjs";

const CLEAR = "0x5555555555555555555555555555555555555555";
const OTHER = "0x6666666666666666666666666666666666666666";

function hexSecret() {
  return randomBytes(32).toString("hex");
}

function dataEnv(extra = {}) {
  return {
    SANCTIONS_DATA_URL: "https://sanctions.test/internal/sanctions",
    RELAYER_DATA_AUTH: hexSecret(),
    ...extra,
  };
}

describe("production sanctions data config", () => {
  it("refuses a bad url or a short secret", () => {
    assert.throws(() => assertSanctionsDataConfig({}), /sanctions_data_config_required/);
    assert.throws(() => assertSanctionsDataConfig({
      SANCTIONS_DATA_URL: "http://sanctions.test/internal/sanctions",
      RELAYER_DATA_AUTH: hexSecret(),
    }), /sanctions_data_config_required/);
    assert.throws(() => assertSanctionsDataConfig({
      SANCTIONS_DATA_URL: "https://sanctions.test/internal/other",
      RELAYER_DATA_AUTH: hexSecret(),
    }), /sanctions_data_config_required/);
    assert.throws(() => assertSanctionsDataConfig({
      SANCTIONS_DATA_URL: "https://sanctions.test/internal/sanctions?x=1",
      RELAYER_DATA_AUTH: hexSecret(),
    }), /sanctions_data_config_required/);
    assert.throws(() => assertSanctionsDataConfig({
      SANCTIONS_DATA_URL: "https://user:secret@sanctions.test/internal/sanctions",
      RELAYER_DATA_AUTH: hexSecret(),
    }), /sanctions_data_config_required/);
    assert.throws(() => assertSanctionsDataConfig({
      SANCTIONS_DATA_URL: "https://sanctions.test/internal/sanctions",
      RELAYER_DATA_AUTH: "short",
    }), /sanctions_data_config_required/);
    assert.throws(() => assertSanctionsDataConfig({
      SANCTIONS_DATA_URL: "https://sanctions.test/internal/sanctions",
      RELAYER_DATA_AUTH: "a".repeat(65),
    }), /sanctions_data_config_required/);
    const config = assertSanctionsDataConfig({
      ...dataEnv(),
      SANCTIONS_DATA_URL: "https://sanctions.test/internal/sanctions/",
    });
    assert.equal(config.url, "https://sanctions.test/internal/sanctions");
    assert.equal(config.timeoutMs, 3000);
  });

  it("refuses to start when health is missing", async () => {
    await assert.rejects(() => startServer({}), /sanctions_data_config_required/);
    const previous = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: { applied: false } }), { status: 200 });
    try {
      await assert.rejects(() => startServer(dataEnv({ PORT: "18791", HOST: "127.0.0.1", SANCTIONS_REFRESH: "0" })), /sanctions_data_config_required/);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("refreshes at start and schedules the next refresh 12 hours later", async () => {
    const calls = [];
    const timers = [];
    const gate = {
      async refresh(fetchImpl) {
        calls.push(fetchImpl);
        return { refreshed: true };
      },
    };
    const refresh = startSanctionsRefresh(gate, {
      fetchImpl: async () => ({ ok: false }),
      setInterval(fn, ms) {
        timers.push({ fn, ms });
        return { unref() {} };
      },
      clearInterval() {},
    });
    await refresh.started;
    assert.equal(calls.length, 1);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, SANCTIONS_REFRESH_EVERY_MS);
    assert.equal(SANCTIONS_REFRESH_EVERY_MS, 12 * 60 * 60 * 1000);
    await timers[0].fn();
    assert.equal(calls.length, 2);
    refresh.stop();
  });

  it("startServer checks health and refreshes at boot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sanctions-data-"));
    const calls = [];
    const previous = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("/internal/sanctions/")) {
        const op = target.slice(target.lastIndexOf("/") + 1);
        const result = op === "health"
          ? { applied: true, name: "0001_sanctions.sql" }
          : op === "snapshot.load"
            ? { cache: null, wallets: [] }
            : op === "linked.list"
              ? { rows: [] }
              : {};
        return new Response(JSON.stringify({ ok: true, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("nope", { status: 503 });
    };
    const probe = net.createServer();
    const port = await new Promise((resolve, reject) => {
      probe.listen(0, "127.0.0.1", () => resolve(probe.address().port));
      probe.on("error", reject);
    });
    await new Promise((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
    let server;
    try {
      server = await startServer({
        PORT: String(port),
        HOST: "127.0.0.1",
        ...dataEnv(),
        CLAIM_LOG_PATH: join(dir, "claims.jsonl"),
        INTENT_NONCE_PATH: join(dir, "nonces.jsonl"),
        ABUSE_STATE_PATH: join(dir, "abuse.json"),
      });
      await once(server, "listening");
      await server.sanctionsRefreshStarted;
      assert.equal(calls.some((url) => url.endsWith("/internal/sanctions/health")), true);
      assert.equal(calls.some((url) => url.includes("ofac.treas.gov")), true);
    } finally {
      globalThis.fetch = previous;
      if (server) {
        await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      }
    }
  });
});

function request(port, method, path, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function signedServer(handler) {
  const secret = "unit-data-secret";
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const message = `POST\n${path}\n${req.headers["x-relayer-ts"]}\n${req.headers["x-relayer-nonce"]}\n${bodyHash}`;
    const expected = createHmac("sha256", secret).update(message).digest("hex");
    if (expected !== req.headers["x-relayer-data-sig"]) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    await handler(req, res, path, body);
  });
  return { secret, server };
}

describe("sanctions data client fails closed", () => {
  it("accepts a signed health call and denies a claim on timeout or 5xx", async () => {
    const seen = [];
    const mode = { value: "ok" };
    const signed = signedServer(async (req, res, path) => {
      seen.push(path);
      if (mode.value === "hang") return;
      if (mode.value === "down") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unavailable" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: path.endsWith("wallet.blocked") ? { blocked: false } : { blocked: false, applied: true } }));
    });
    signed.server.listen(0, "127.0.0.1");
    await once(signed.server, "listening");
    const port = signed.server.address().port;
    const base = `http://127.0.0.1:${port}/internal/sanctions`;
    try {
      const client = createSanctionsDataClient({ url: base, secret: signed.secret, timeoutMs: 200 });
      const health = await client.call("health", {});
      assert.equal(health.applied, true);
      assert.equal(seen[0], "/internal/sanctions/health");
      const now = Date.now();
      const sanctions = createSanctionsGate({
        pepper: TEST_PEPPER,
        now: () => now,
        data: client,
        screen: screenFromAddressList(["0x3333333333333333333333333333333333333333"], now, { minAddresses: 1 }),
      });
      const dir = await mkdtemp(join(tmpdir(), "sanctions-client-"));
      const config = loadConfig({ CLAIM_LOG_PATH: join(dir, "claims.jsonl") });
      let broadcasts = 0;
      const app = createClaimRelayer({
        config,
        killSwitch: createKillSwitch({ initial: false }),
        nonceStore: createNonceStore(),
        claimLog: createClaimLog({ filePath: join(dir, "claims.jsonl") }),
        broadcaster: { async send() { broadcasts += 1; return { txHash: "0xabc" }; } },
        sanctions,
        now: () => now,
        edgeCountry: "US",
      });
      app.listen(0, "127.0.0.1");
      await once(app, "listening");
      try {
        const allowed = await request(app.address().port, "POST", "/v1/claims", {
          payer: CLEAR,
          payee: OTHER,
          claimId: "clear-through-data",
        });
        assert.equal(allowed.status, 200);
        assert.equal(allowed.json.ok, true);
        assert.equal(broadcasts, 0);
        mode.value = "down";
        const denied = await request(app.address().port, "POST", "/v1/claims", {
          payer: CLEAR,
          payee: OTHER,
          claimId: "down-through-data",
        });
        assert.equal(denied.status, 403);
        assert.equal(denied.json.message.includes("available"), true);
        mode.value = "hang";
        const slow = createSanctionsDataClient({ url: base, secret: signed.secret, timeoutMs: 30 });
        const slowGate = createSanctionsGate({
          pepper: TEST_PEPPER,
          now: () => now,
          data: slow,
          screen: screenFromAddressList(["0x3333333333333333333333333333333333333333"], now, { minAddresses: 1 }),
        });
        const decision = await slowGate.screen(CLEAR, "claim");
        assert.equal(decision.result, "unavailable");
      } finally {
        await new Promise((resolve, reject) => app.close((err) => (err ? reject(err) : resolve())));
      }
    } finally {
      await new Promise((resolve) => signed.server.close(() => resolve()));
    }
  });
});
