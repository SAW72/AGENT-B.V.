import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ESCROW_START_BLOCK } from "../src/constants.mjs";
import { loadConfig, start } from "../src/main.mjs";
import {
  bucketClientAddress,
  createRateLimiter,
  createReadApi,
  pointsEnabled,
  READ_ENV_ALLOWLIST,
  readSettings,
} from "../src/readApi.mjs";

const POINTS_FILE = fileURLToPath(new URL("../config/points.json", import.meta.url));
const READ_SOURCE = fileURLToPath(new URL("../src/readApi.mjs", import.meta.url));
const MAIN_SOURCE = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
const ADDRESS = "0x1111111111111111111111111111111111111111";
const PAGE_WALLET = "0x00000000000000000000000000000000000000a1";

const FORBIDDEN_KEYS = new Set([
  "identity_anchor",
  "behavioral_signals",
  "model_version",
  "actor_id",
  "actor_type",
  "entries_json",
  "entries",
  "signature",
  "nonce",
  "topics_json",
  "topics",
  "raw_logs",
  "origins",
  "chains",
  "nonces",
  "source_action",
  "source_tx_hash",
  "source_log_index",
  "block_timestamp",
  "block_hash",
  "tx_from",
  "removed",
  "rule_weight",
  "counts_for_return_day",
  "support",
  "dispute_id",
  "seq",
  "contract",
  "chain_id",
  "wallet",
  "eligibility_status",
  "data",
]);

function fakeStore(overrides = {}) {
  const cursor = overrides.cursor ?? {
    last_scanned_block: null,
    finalized_block: null,
    pass_completed: false,
  };
  const summary = overrides.summary ?? {
    points_total: 0,
    rows_count: 0,
    first_activity_utc_day: null,
  };
  const rows = overrides.rows ?? [];
  const config = overrides.config ?? { weights: {}, gates: {}, rule_version: null };
  return {
    getCursor() {
      if (overrides.throwOn === "cursor") throw overrides.error ?? new Error("store down");
      return typeof overrides.cursor === "function" ? overrides.cursor() : cursor;
    },
    getLedgerSummary() {
      if (overrides.throwOn === "summary") throw overrides.error ?? new Error("store down");
      return summary;
    },
    listLedgerRows(address, query) {
      if (overrides.throwOn === "rows") throw overrides.error ?? new Error("store down");
      const afterSeq = query?.afterSeq ?? 0;
      const limit = Number.isInteger(query?.limit) ? query.limit : rows.length;
      return rows
        .filter((row) => (row.wallet == null || row.wallet === address) && row.seq > afterSeq)
        .slice(0, limit);
    },
    getConfig() {
      if (overrides.throwOn === "config") throw overrides.error ?? new Error("store down");
      return config;
    },
  };
}

async function withServer(options, fn) {
  const api = createReadApi({
    store: options.store ?? fakeStore(),
    config: options.config,
    now: options.now,
    enabled: options.enabled,
  });
  const server = createServer(api);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, api);
  } finally {
    api.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: options.headers,
  });
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { response, text, json };
}

function assertJsonNoStore(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  const origin = response.headers.get("access-control-allow-origin");
  assert.equal(origin == null || origin === "https://agent-bv.pages.dev", true);
  assert.notEqual(origin, "*");
}

function walkKeys(value, found) {
  if (Array.isArray(value)) {
    for (const item of value) walkKeys(item, found);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) found.push(key);
      walkKeys(child, found);
    }
  }
}

function txHash(index) {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

function ledgerRow(index, wallet, extra = {}) {
  return {
    seq: index,
    wallet,
    action: extra.action ?? "fund",
    utc_day: extra.utc_day ?? 19000 + index,
    tx_hash: extra.tx_hash ?? txHash(index),
    log_index: index,
    block_number: ESCROW_START_BLOCK + index,
    escrow_id: `0x${"11".repeat(32)}`,
    points: extra.points ?? 0,
    points_withheld: extra.points_withheld ?? 1,
    eligibility_reason: "ofac_unconfigured",
    register_status: null,
    ...extra,
  };
}

function expectedItem(row) {
  return {
    action: row.action,
    utc_day: row.utc_day,
    tx_hash: row.tx_hash,
    log_index: row.log_index,
    block_number: row.block_number,
    escrow_id: row.escrow_id,
    points: row.points,
    points_withheld: row.points_withheld === 1,
    eligibility_reason: row.eligibility_reason,
    register_status: row.register_status,
  };
}

describe("points read API", { concurrency: false }, () => {
  it("reads optional env in loadConfig and stays off unless the flag is set", () => {
    const config = loadConfig({});
    assert.equal(config.chainId, 84532);
    assert.equal(config.dbPath, "points-indexer.sqlite");
    assert.equal(config.pointsEnabled, false);
    assert.equal(loadConfig({ POINTS_ENABLED: "1" }).pointsEnabled, true);
    assert.equal(loadConfig({ POINTS_ENABLED: "true" }).pointsEnabled, true);
    assert.equal(loadConfig({ POINTS_ENABLED: "" }).pointsEnabled, false);
    assert.equal(loadConfig({ POINTS_ENABLED: "0" }).pointsEnabled, false);
    assert.equal(pointsEnabled({}), false);
    assert.equal(pointsEnabled({ POINTS_ENABLED: "1" }), true);
    assert.equal(pointsEnabled({ POINTS_ENABLED: "true" }), true);
    assert.equal(pointsEnabled({ POINTS_ENABLED: "on" }), true);
    assert.equal(pointsEnabled({ POINTS_ENABLED: "yes" }), true);
    assert.equal(pointsEnabled({ POINTS_ENABLED: "0" }), false);
    assert.equal(pointsEnabled({ POINTS_ENABLED: "false" }), false);
    assert.equal(pointsEnabled({ POINTS_READ_API_ENABLED: "1" }), false);
    const settings = readSettings({});
    assert.equal(settings.ratePerMinute, 60);
    assert.equal(settings.trustedProxyHops, 1);
    assert.equal(settings.breakerFailures, 5);
    assert.equal(settings.breakerCooldownMs, 30_000);
    assert.deepEqual(settings.corsOrigins, ["https://agent-bv.pages.dev"]);
    assert.equal(readSettings({ POINTS_TRUSTED_PROXY_HOPS: "0" }).trustedProxyHops, 0);
    assert.equal(readSettings({ POINTS_TRUSTED_PROXY_HOPS: "2" }).trustedProxyHops, 2);
    assert.equal(readSettings({ POINTS_TRUSTED_PROXY_HOPS: "nope" }).trustedProxyHops, 1);
    assert.equal(readSettings({ POINTS_READ_RATE_PER_MINUTE: "15" }).ratePerMinute, 15);
    assert.equal(readSettings({ POINTS_READ_RATE_PER_MINUTE: "0" }).ratePerMinute, 60);
    assert.equal(readSettings({ POINTS_BREAKER_FAILURES: "3" }).breakerFailures, 3);
    assert.equal(readSettings({ POINTS_BREAKER_FAILURES: "0" }).breakerFailures, 5);
    assert.equal(readSettings({ POINTS_BREAKER_COOLDOWN_MS: "0" }).breakerCooldownMs, 0);
    assert.equal(readSettings({ POINTS_BREAKER_COOLDOWN_MS: "nope" }).breakerCooldownMs, 30_000);
    assert.deepEqual(
      readSettings({ POINTS_CORS_ORIGINS: "*,https://agent-bv.pages.dev/,https://example.com" }).corsOrigins,
      ["https://agent-bv.pages.dev", "https://example.com"],
    );
  });

  it("returns 503 points_disabled for points routes when the flag is off", async () => {
    let on = false;
    await withServer({ enabled: () => on, config: { ratePerMinute: 1 } }, async (base) => {
      const hidden = await request(base, "/v1/points/config");
      assert.equal(hidden.response.status, 503);
      assert.deepEqual(hidden.json, { ok: false, error: "points_disabled" });
      assertJsonNoStore(hidden.response);
      const posted = await request(base, "/v1/points/config", { method: "POST" });
      assert.equal(posted.response.status, 503);
      assert.equal(posted.json.error, "points_disabled");
      on = true;
      const shown = await request(base, "/v1/points/config");
      assert.equal(shown.response.status, 200);
    });
    await withServer({ config: { ratePerMinute: 10 } }, async (base) => {
      const hidden = await request(base, `/v1/points/${ADDRESS}`);
      assert.equal(hidden.response.status, 503);
      assert.deepEqual(hidden.json, { ok: false, error: "points_disabled" });
    });
  });

  it("returns draft config for chain 84532 and rejects every other chain id", async () => {
    const file = JSON.parse(readFileSync(POINTS_FILE, "utf8"));
    const store = fakeStore({
      config: { weights: file.weights, gates: file.gates, rule_version: null, model_version: "sentinel-model-9c2e" },
    });
    await withServer({ enabled: () => true, store, config: { ratePerMinute: 100 } }, async (base) => {
      const missing = await request(base, "/v1/points/config");
      assert.equal(missing.response.status, 200);
      assertJsonNoStore(missing.response);
      assert.equal(missing.json.chainId, 84532);
      assert.equal(missing.json.status, "draft");
      assert.equal(missing.json.rule_version, null);
      assert.deepEqual(missing.json.weights, file.weights);
      assert.deepEqual(missing.json.gates, file.gates);
      assert.ok(Object.values(missing.json.weights).every((value) => value === null));
      assert.ok(Object.values(missing.json.gates).every((value) => value === null));
      const blank = await request(base, "/v1/points/config?chainId=");
      assert.equal(blank.response.status, 200);
      for (const chainId of ["1", "8453", "abc", "0", "84532.0", "084532"]) {
        const rejected = await request(base, `/v1/points/config?chainId=${chainId}`);
        assert.equal(rejected.response.status, 400, chainId);
        assert.deepEqual(rejected.json, { ok: false, error: "wrong_chain" });
        assertJsonNoStore(rejected.response);
      }
      const address = await request(base, `/v1/points/${ADDRESS}?chainId=1`);
      assert.equal(address.response.status, 400);
      assert.equal(address.json.error, "wrong_chain");
    });
  });

  it("rejects an invalid address and an unknown route", async () => {
    await withServer({ enabled: () => true, config: { ratePerMinute: 50 } }, async (base) => {
      for (const path of [
        "/v1/points/0x1234",
        "/v1/points/1111111111111111111111111111111111111111",
        `/v1/points/${"0x" + "gg".padEnd(40, "1").slice(0, 42)}`,
        "/v1/points/0x1111111111111111111111111111111111111111/nope",
      ]) {
        const rejected = await request(base, `${path}?chainId=84532`);
        if (path.endsWith("/nope")) {
          assert.equal(rejected.response.status, 404, path);
          assert.equal(rejected.json.error, "not_found");
        } else {
          assert.equal(rejected.response.status, 400, path);
          assert.deepEqual(rejected.json, { ok: false, error: "invalid_address" });
        }
      }
      for (const path of ["/v1/points", "/v1/points/config/extra"]) {
        const missing = await request(base, path);
        assert.equal(missing.response.status, 404, path);
        assert.deepEqual(missing.json, { ok: false, error: "not_found" });
        assertJsonNoStore(missing.response);
      }
    });
  });

  it("rejects a method other than GET or OPTIONS", async () => {
    await withServer({ enabled: () => true, config: { ratePerMinute: 20 } }, async (base) => {
      const posted = await request(base, "/v1/points/config", { method: "POST" });
      assert.equal(posted.response.status, 405);
      assert.deepEqual(posted.json, { ok: false, error: "method_not_allowed" });
      assert.equal(posted.response.headers.get("allow"), "GET, OPTIONS");
      assertJsonNoStore(posted.response);
      const preflight = await request(base, "/v1/points/config", {
        method: "OPTIONS",
        headers: { origin: "https://agent-bv.pages.dev" },
      });
      assert.equal(preflight.response.status, 204);
      assert.equal(preflight.text, "");
      assert.equal(preflight.response.headers.get("allow"), "GET, OPTIONS");
      assert.equal(preflight.response.headers.get("access-control-allow-origin"), "https://agent-bv.pages.dev");
      assert.equal(preflight.response.headers.get("cache-control"), "no-store");
      const denied = await request(base, "/v1/points/config", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example" },
      });
      assert.equal(denied.response.status, 204);
      assert.equal(denied.response.headers.get("access-control-allow-origin"), null);
    });
  });

  it("allows only the configured exact origins", async () => {
    await withServer({
      enabled: () => true,
      config: { ratePerMinute: 20, corsOrigins: "https://agent-bv.pages.dev,https://example.com/" },
    }, async (base) => {
      const allowed = await request(base, "/v1/points/config", {
        headers: { origin: "https://example.com" },
      });
      assert.equal(allowed.response.status, 200);
      assert.equal(allowed.response.headers.get("access-control-allow-origin"), "https://example.com");
      const denied = await request(base, "/v1/points/config", {
        headers: { origin: "https://evil.example" },
      });
      assert.equal(denied.response.status, 200);
      assert.equal(denied.response.headers.get("access-control-allow-origin"), null);
      assert.equal(JSON.stringify(denied.json).includes("*"), false);
    });
  });

  it("sums points_total from committed rows", async () => {
    const wallet = ADDRESS;
    const mixed = `0x${ADDRESS.slice(2).toUpperCase()}`;
    const rows = [
      ledgerRow(1, wallet, { action: "fund", points: 3, utc_day: 20_000 }),
      ledgerRow(2, wallet, { action: "first_activity", points: 5, utc_day: 20_000 }),
    ];
    await withServer({
      enabled: () => true,
      store: fakeStore({
        cursor: { last_scanned_block: 100_000_000, finalized_block: 100_000_000, pass_completed: true },
        summary: { points_total: 8, rows_count: 2, first_activity_utc_day: 20_000 },
        rows,
      }),
      config: { ratePerMinute: 20 },
    }, async (base) => {
      const body = await request(base, `/v1/points/${mixed}?chainId=84532`);
      assert.equal(body.response.status, 200);
      assert.equal(body.json.address, wallet);
      assert.equal(body.json.points_total, 8);
      assert.equal(body.json.points_withheld, true);
      assert.deepEqual(body.json.eligibility, { status: "unverified", reason: "ofac_unconfigured" });
      assert.equal(body.json.rows_count, 2);
      assert.equal(body.json.first_activity_utc_day, 20_000);
      assert.equal(body.json.indexed_to_block, 100_000_000);
      assert.equal(body.json.finalized_block, 100_000_000);
      assert.equal(body.json.behind, 0);
      assert.equal(body.json.syncing, false);
      assert.equal(body.json.disclaimer.links.master_disclaimer, null);
      assert.ok(Object.values(body.json.disclaimer.links).every((value) => value === null));
      const history = await request(base, `/v1/points/${wallet}/history?chainId=84532`);
      assert.deepEqual(history.json.items, rows.map(expectedItem));
      assert.equal(history.json.items.reduce((sum, item) => sum + item.points, 0), 8);
      assert.equal(history.json.next_cursor, null);
    });
  });

  it("private fields never appear in a read response", async () => {
    const sentinels = [
      "sentinel-source-77ab",
      "sentinel-model-9c2e",
      "sentinel-chain-b31d",
      "sentinel-rawlog-4e8b",
      "sentinel-link-55d0",
    ];
    const rows = [
      ledgerRow(1, ADDRESS, {
        source_tx_hash: sentinels[0],
        model_version: sentinels[1],
        entries_json: sentinels[2],
        block_hash: sentinels[3],
        signature: sentinels[4],
        identity_anchor: "anchor",
        behavioral_signals: "signals",
        nonce: "99",
      }),
    ];
    await withServer({
      enabled: () => true,
      store: fakeStore({
        cursor: { last_scanned_block: 10, finalized_block: 10, pass_completed: true },
        summary: { points_total: 0, rows_count: 1, first_activity_utc_day: null },
        rows,
        config: { weights: {}, gates: {}, rule_version: null, model_version: sentinels[1] },
      }),
      config: { ratePerMinute: 20 },
    }, async (base) => {
      const bodies = [];
      for (const path of [
        "/v1/points/config?chainId=84532",
        `/v1/points/${ADDRESS}?chainId=84532`,
        `/v1/points/${ADDRESS}/history?chainId=84532&limit=25`,
      ]) {
        const result = await request(base, path);
        assert.equal(result.response.status, 200, path);
        bodies.push(result.text);
        const found = [];
        walkKeys(result.json, found);
        assert.deepEqual(found, [], path);
      }
      const joined = bodies.join("\n");
      for (const sentinel of sentinels) {
        assert.equal(joined.includes(sentinel), false, sentinel);
      }
      for (const key of ["identity_anchor", "behavioral_signals", "model_version", "source_tx_hash", "entries_json"]) {
        assert.equal(joined.includes(`"${key}"`), false, key);
      }
    });
  });

  it("clamps a limit above 100 and rejects 0, negative, and non-numeric limits", async () => {
    const rows = [];
    for (let index = 1; index <= 101; index += 1) rows.push(ledgerRow(index, PAGE_WALLET));
    await withServer({
      enabled: () => true,
      store: fakeStore({
        cursor: { last_scanned_block: ESCROW_START_BLOCK + 200, finalized_block: ESCROW_START_BLOCK + 200, pass_completed: true },
        rows,
      }),
      config: { ratePerMinute: 30 },
    }, async (base) => {
        const clamped = await request(base, `/v1/points/${PAGE_WALLET}/history?chainId=84532&limit=101`);
        assert.equal(clamped.response.status, 200);
        assert.equal(clamped.json.limit, 100);
        assert.equal(clamped.json.items.length, 100);
        assert.equal(clamped.json.items[99].tx_hash, txHash(100));
        assert.equal(clamped.json.next_cursor, "100");
        const rest = await request(base, `/v1/points/${PAGE_WALLET}/history?chainId=84532&limit=25&cursor=100`);
        assert.equal(rest.json.items.length, 1);
        assert.equal(rest.json.items[0].tx_hash, txHash(101));
        assert.equal(rest.json.next_cursor, null);
        const first = await request(base, `/v1/points/${PAGE_WALLET}/history?chainId=84532`);
        assert.equal(first.json.limit, 25);
        assert.equal(first.json.items.length, 25);
        assert.equal(first.json.items[0].tx_hash, txHash(1));
        for (const limit of ["0", "-1", "abc", "1.5", "01"]) {
          const rejected = await request(base, `/v1/points/${PAGE_WALLET}/history?chainId=84532&limit=${limit}`);
          assert.equal(rejected.response.status, 400, limit);
          assert.deepEqual(rejected.json, { ok: false, error: "invalid_limit" });
        }
        const cursor = await request(base, `/v1/points/${PAGE_WALLET}/history?chainId=84532&cursor=abc`);
        assert.equal(cursor.response.status, 400);
        assert.equal(cursor.json.error, "invalid_cursor");
    });
  });

  it("indexed_to_block follows the scan cursor", async () => {
    await withServer({
      enabled: () => true,
      store: fakeStore({
        cursor: {
          last_scanned_block: ESCROW_START_BLOCK + 25,
          finalized_block: ESCROW_START_BLOCK + 1000,
          pass_completed: true,
        },
      }),
      config: { ratePerMinute: 20 },
    }, async (base) => {
        const body = await request(base, `/v1/points/${ADDRESS}?chainId=84532`);
        assert.equal(body.response.status, 200);
        assert.equal(body.json.indexed_to_block, ESCROW_START_BLOCK + 25);
        assert.equal(body.json.finalized_block, ESCROW_START_BLOCK + 1000);
        assert.notEqual(body.json.indexed_to_block, body.json.finalized_block);
        assert.equal(body.json.behind, 975);
        assert.equal(body.json.syncing, true);
        assert.equal(body.json.points_total, 0);
        const history = await request(base, `/v1/points/${ADDRESS}/history?chainId=84532`);
        assert.equal(history.json.indexed_to_block, ESCROW_START_BLOCK + 25);
        assert.equal(history.json.syncing, true);
    });
    await withServer({
      enabled: () => true,
      store: fakeStore({
        cursor: { last_scanned_block: null, finalized_block: 10, pass_completed: false },
      }),
      config: { ratePerMinute: 10 },
    }, async (base) => {
        const body = await request(base, `/v1/points/${ADDRESS}`);
        assert.equal(body.json.indexed_to_block, null);
        assert.equal(body.json.finalized_block, 10);
        assert.equal(body.json.behind, 0);
        assert.equal(body.json.syncing, true);
        assert.equal(body.json.points_total, 0);
        assert.equal(body.json.rows_count, 0);
        assert.equal(body.json.first_activity_utc_day, null);
    });
    await withServer({
      enabled: () => true,
      store: fakeStore({
        cursor: { last_scanned_block: null, finalized_block: 10, pass_completed: true },
      }),
      config: { ratePerMinute: 10 },
    }, async (base) => {
        const body = await request(base, `/v1/points/${ADDRESS}`);
        assert.equal(body.json.syncing, false);
        assert.equal(body.json.behind, 0);
        assert.equal(body.json.indexed_to_block, null);
    });
    await withServer({
      enabled: () => true,
      store: fakeStore(),
      config: { ratePerMinute: 10 },
    }, async (base) => {
        const body = await request(base, `/v1/points/${ADDRESS}`);
        assert.equal(body.response.status, 200);
        assert.equal(body.json.syncing, true);
        assert.equal(body.json.indexed_to_block, null);
        assert.equal(body.json.finalized_block, null);
        assert.equal(body.json.behind, null);
        assert.equal(body.json.points_total, 0);
    });
  });

  it("returns 500 from an injected failing store without the thrown detail", async () => {
    const secret = "SECRET https://evil.example/x /tmp/ledger.sqlite";
    const error = new Error(secret);
    error.stack = `Error: ${secret}\n    at Object.prepare (/tmp/ledger.sqlite:10:1)`;
    const store = fakeStore({ throwOn: "cursor", error });
    await withServer({
      enabled: () => true,
      store,
      config: { ratePerMinute: 10 },
    }, async (base) => {
      const failed = await request(base, `/v1/points/${ADDRESS}?chainId=84532`, {
        headers: { origin: "https://agent-bv.pages.dev" },
      });
      assert.equal(failed.response.status, 500);
      assert.deepEqual(failed.json, { ok: false, error: "internal" });
      assert.equal(failed.text, '{"ok":false,"error":"internal"}');
      assertJsonNoStore(failed.response);
      assert.equal(failed.response.headers.get("access-control-allow-origin"), "https://agent-bv.pages.dev");
      assert.equal(failed.text.includes("SECRET"), false);
      assert.equal(failed.text.includes("https://"), false);
      assert.equal(failed.text.includes("/tmp"), false);
      assert.equal(failed.text.includes("stack"), false);
      const config = await request(base, "/v1/points/config");
      assert.equal(config.response.status, 200);
    });
  });

  it("falls back to the socket when X-Forwarded-For is missing, empty, or malformed", async () => {
    await withServer({
      enabled: () => true,
      config: { ratePerMinute: 1, trustedProxyHops: 1 },
    }, async (base) => {
      const first = await request(base, "/v1/points/config");
      assert.equal(first.response.status, 200);
      const garbage = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "not-an-ip" },
      });
      assert.equal(garbage.response.status, 429);
      const empty = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": " , " },
      });
      assert.equal(empty.response.status, 429);
      const huge = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "a".repeat(3000) },
      });
      assert.equal(huge.response.status, 429);
    });
  });

  it("ignores a spoofed leftmost X-Forwarded-For entry", async () => {
    await withServer({
      enabled: () => true,
      config: { ratePerMinute: 1, trustedProxyHops: 1 },
    }, async (base) => {
      const first = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" },
      });
      assert.equal(first.response.status, 200);
      const spoofed = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "9.9.9.9, 2.2.2.2" },
      });
      assert.equal(spoofed.response.status, 429);
      assert.equal(spoofed.response.headers.get("retry-after"), "60");
      const moved = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "2.2.2.2, 3.3.3.3" },
      });
      assert.equal(moved.response.status, 200);
    });
  });

  it("counts trusted proxy hops from the right, including 0 and 2", async () => {
    await withServer({
      enabled: () => true,
      config: { ratePerMinute: 1, trustedProxyHops: 0 },
    }, async (base) => {
      const first = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "1.1.1.1" },
      });
      assert.equal(first.response.status, 200);
      const second = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "2.2.2.2" },
      });
      assert.equal(second.response.status, 429);
    });
    await withServer({
      enabled: () => true,
      config: { ratePerMinute: 1, trustedProxyHops: 2 },
    }, async (base) => {
      const first = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "9.9.9.9, 8.8.8.8, 7.7.7.7" },
      });
      assert.equal(first.response.status, 200);
      const sameClient = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "1.1.1.1, 8.8.8.8, 2.2.2.2" },
      });
      assert.equal(sameClient.response.status, 429);
      const otherClient = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "9.9.9.9, 4.4.4.4, 7.7.7.7" },
      });
      assert.equal(otherClient.response.status, 200);
      const tooShort = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "5.5.5.5" },
      });
      assert.equal(tooShort.response.status, 200);
      const socketAgain = await request(base, "/v1/points/config");
      assert.equal(socketAgain.response.status, 429);
    });
  });

  it("buckets IPv6 clients by /64", async () => {
    assert.equal(
      bucketClientAddress("2001:db8:1:2::1"),
      bucketClientAddress("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"),
    );
    assert.notEqual(bucketClientAddress("2001:db8:1:2::1"), bucketClientAddress("2001:db8:1:3::1"));
    assert.equal(bucketClientAddress("::ffff:10.0.0.1"), "10.0.0.1");
    assert.equal(bucketClientAddress("not-an-ip"), null);
    await withServer({
      enabled: () => true,
      config: { ratePerMinute: 1, trustedProxyHops: 1 },
    }, async (base) => {
      const first = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "2001:db8:1:2::1" },
      });
      assert.equal(first.response.status, 200);
      const samePrefix = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "2001:0db8:0001:0002:ffff:ffff:ffff:ffff" },
      });
      assert.equal(samePrefix.response.status, 429);
      const otherPrefix = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "2001:db8:1:3::1" },
      });
      assert.equal(otherPrefix.response.status, 200);
      const mapped = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "::ffff:10.1.2.3" },
      });
      assert.equal(mapped.response.status, 200);
      const otherMapped = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "::ffff:10.1.2.4" },
      });
      assert.equal(otherMapped.response.status, 200);
    });
  });

  it("evicts the oldest limiter entry at the map cap", async () => {
    await withServer({
      enabled: () => true,
      config: { ratePerMinute: 1, maxEntries: 2, trustedProxyHops: 1 },
    }, async (base) => {
      const headers = (ip) => ({ "x-forwarded-for": ip });
      assert.equal((await request(base, "/v1/points/config", { headers: headers("10.0.0.1") })).response.status, 200);
      assert.equal((await request(base, "/v1/points/config", { headers: headers("10.0.0.1") })).response.status, 429);
      assert.equal((await request(base, "/v1/points/config", { headers: headers("10.0.0.2") })).response.status, 200);
      assert.equal((await request(base, "/v1/points/config", { headers: headers("10.0.0.3") })).response.status, 200);
      assert.equal((await request(base, "/v1/points/config", { headers: headers("10.0.0.1") })).response.status, 200);
    });
  });

  it("resets the rate window from the injected clock", async () => {
    let now = 1_000_000;
    await withServer({
      enabled: () => true,
      now: () => now,
      config: { ratePerMinute: 1, windowMs: 60_000, trustedProxyHops: 0 },
    }, async (base) => {
      assert.equal((await request(base, "/v1/points/config")).response.status, 200);
      const blocked = await request(base, "/v1/points/config");
      assert.equal(blocked.response.status, 429);
      assert.equal(blocked.response.headers.get("retry-after"), "60");
      assert.deepEqual(blocked.json, { ok: false, error: "rate_limited" });
      now += 59_999;
      assert.equal((await request(base, "/v1/points/config")).response.status, 429);
      now += 1;
      assert.equal((await request(base, "/v1/points/config")).response.status, 200);
    });
  });

  it("allows 60 requests in the default window and rejects the next one", async () => {
    let now = 50_000;
    await withServer({
      enabled: () => true,
      now: () => now,
      config: { trustedProxyHops: 0 },
    }, async (base) => {
      for (let index = 0; index < 60; index += 1) {
        const allowed = await request(base, "/v1/points/config");
        assert.equal(allowed.response.status, 200, `request ${index}`);
      }
      const blocked = await request(base, "/v1/points/config");
      assert.equal(blocked.response.status, 429);
      const preflight = await request(base, "/v1/points/config", { method: "OPTIONS" });
      assert.equal(preflight.response.status, 204);
    });
  });

  it("sweeps expired limiter keys and does not ref the timer", async () => {
    let now = 0;
    const limiter = createRateLimiter({
      windowMs: 1000,
      max: 5,
      maxEntries: 10,
      clock: () => now,
      sweepMs: 20,
    });
    try {
      assert.equal(limiter.timer.hasRef(), false);
      assert.equal(limiter.allow("client").ok, true);
      assert.equal(limiter.size(), 1);
      now = 5000;
      const started = Date.now();
      while (limiter.size() !== 0 && Date.now() - started < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(limiter.size(), 0);
    } finally {
      limiter.close();
    }
  });

  it("does not call sqlite from the read core", () => {
    const source = readFileSync(READ_SOURCE, "utf8");
    assert.equal(source.includes("raw_logs"), false);
    assert.equal(source.includes("node:sqlite"), false);
    assert.equal(source.includes("SELECT"), false);
    assert.equal(source.includes(".prepare"), false);
    assert.equal(source.includes("readApiSqliteStore"), false);
  });

  it("answers a plain object from handle without a node response", () => {
    const api = createReadApi({
      store: fakeStore({
        config: { weights: { fund: null }, gates: {}, rule_version: null },
      }),
      enabled: () => true,
      config: { ratePerMinute: 5 },
    });
    try {
      const result = api.handle({
        method: "GET",
        path: "/v1/points/config",
        query: { chainId: "84532" },
        headers: { origin: "https://agent-bv.pages.dev" },
        remoteAddress: "127.0.0.1",
        origin: "https://agent-bv.pages.dev",
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.status, "draft");
      assert.equal(result.body.chainId, 84532);
      assert.equal(result.headers["cache-control"], "no-store");
      assert.equal(result.headers["access-control-allow-origin"], "https://agent-bv.pages.dev");
      assert.equal(result.headers["content-type"], "application/json; charset=utf-8");
    } finally {
      api.close();
    }
  });

  it("does not read a relayer key or process.env outside the allowlist", () => {
    const source = readFileSync(READ_SOURCE, "utf8");
    assert.equal(source.includes("RELAYER_PRIVATE_KEY"), false);
    assert.equal(source.includes("privateKey"), false);
    assert.equal(source.includes("signer"), false);
    assert.equal(source.includes("claim-relayer"), false);
    assert.deepEqual([...READ_ENV_ALLOWLIST], [
      "POINTS_ENABLED",
      "POINTS_CORS_ORIGINS",
      "POINTS_TRUSTED_PROXY_HOPS",
      "POINTS_READ_RATE_PER_MINUTE",
      "POINTS_BREAKER_FAILURES",
      "POINTS_BREAKER_COOLDOWN_MS",
    ]);
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const allow = new Set(READ_ENV_ALLOWLIST);
    const accesses = [...code.matchAll(/process\.env(?:\.([A-Za-z0-9_]+)|\[\s*["']([A-Za-z0-9_]+)["']\s*\])?/g)];
    for (const match of accesses) {
      const name = match[1] || match[2];
      assert.ok(name && allow.has(name), match[0]);
    }
    assert.equal(/process\.env\s*\[/.test(code), false);
  });

  it("loads the read module from main only with a dynamic import", () => {
    const source = readFileSync(MAIN_SOURCE, "utf8");
    assert.equal(source.includes('from "./readApi.mjs"'), false);
    assert.equal(source.includes('from "./readApiSqliteStore.mjs"'), false);
    assert.equal(source.includes('import("./readApi.mjs")'), true);
    assert.equal(source.includes('import("./readApiSqliteStore.mjs")'), true);
    const gateAt = source.indexOf("if (!pointsGate(env))");
    const importAt = source.indexOf('import("./readApi.mjs")');
    const storeAt = source.indexOf('import("./readApiSqliteStore.mjs")');
    assert.ok(gateAt !== -1 && importAt !== -1 && storeAt !== -1);
    assert.ok(gateAt < importAt);
    assert.ok(gateAt < storeAt);
  });

  it("opens after five internal failures and closes on a probe after 30 seconds", async () => {
    let now = 5_000;
    let broken = true;
    let calls = 0;
    let during = null;
    let api;
    const store = {
      getCursor() {
        calls += 1;
        during = api.breakerState();
        if (broken) throw new Error("db down");
        return { last_scanned_block: 10, finalized_block: 10, pass_completed: true };
      },
      getLedgerSummary() {
        return { points_total: 0, rows_count: 0, first_activity_utc_day: null };
      },
      listLedgerRows() {
        return [];
      },
      getConfig() {
        return { weights: {}, gates: {}, rule_version: null };
      },
    };
    await withServer({
      store,
      now: () => now,
      enabled: () => true,
      config: { ratePerMinute: 100, trustedProxyHops: 0 },
    }, async (base, handler) => {
      api = handler;
      for (let index = 0; index < 5; index += 1) {
        const failed = await request(base, `/v1/points/${ADDRESS}`);
        assert.equal(failed.response.status, 500, `failure ${index}`);
        assert.deepEqual(failed.json, { ok: false, error: "internal" });
        assert.equal(failed.text.includes("db down"), false);
      }
      assert.equal(calls, 5);
      assert.equal(api.breakerState(), "open");
      const blocked = await request(base, `/v1/points/${ADDRESS}`);
      assert.equal(blocked.response.status, 503);
      assert.deepEqual(blocked.json, { ok: false, error: "points_unavailable" });
      assertJsonNoStore(blocked.response);
      assert.equal(calls, 5);
      now += 29_999;
      const early = await request(base, "/v1/points/config");
      assert.equal(early.response.status, 503);
      assert.equal(early.json.error, "points_unavailable");
      assert.equal(calls, 5);
      now += 1;
      broken = false;
      during = null;
      const probe = await request(base, `/v1/points/${ADDRESS}`);
      assert.equal(probe.response.status, 200);
      assert.equal(during, "half_open");
      assert.equal(api.breakerState(), "closed");
      assert.equal(calls, 6);
      const again = await request(base, `/v1/points/${ADDRESS}`);
      assert.equal(again.response.status, 200);
      assert.equal(again.json.points_total, 0);
      assert.equal(api.breakerState(), "closed");
      assert.equal(calls, 7);
    });
  });

  it("reopens when the half-open probe throws", async () => {
    let now = 0;
    let calls = 0;
    let during = null;
    let api;
    const store = {
      getCursor() {
        calls += 1;
        during = api.breakerState();
        throw new Error("still down");
      },
      getLedgerSummary() {
        return { points_total: 0, rows_count: 0, first_activity_utc_day: null };
      },
      listLedgerRows() {
        return [];
      },
      getConfig() {
        return { weights: {}, gates: {}, rule_version: null };
      },
    };
    await withServer({
      store,
      now: () => now,
      enabled: () => true,
      config: {
        ratePerMinute: 100,
        breakerFailures: 2,
        breakerCooldownMs: 30_000,
        trustedProxyHops: 0,
      },
    }, async (base, handler) => {
      api = handler;
      assert.equal((await request(base, `/v1/points/${ADDRESS}`)).response.status, 500);
      assert.equal(api.breakerState(), "closed");
      assert.equal((await request(base, `/v1/points/${ADDRESS}`)).response.status, 500);
      assert.equal(api.breakerState(), "open");
      assert.equal(calls, 2);
      const blocked = await request(base, `/v1/points/${ADDRESS}`);
      assert.equal(blocked.response.status, 503);
      assert.equal(blocked.json.error, "points_unavailable");
      assert.equal(calls, 2);
      now = 30_000;
      during = null;
      const probe = await request(base, `/v1/points/${ADDRESS}`);
      assert.equal(probe.response.status, 500);
      assert.equal(probe.json.error, "internal");
      assert.equal(during, "half_open");
      assert.equal(api.breakerState(), "open");
      assert.equal(calls, 3);
      const again = await request(base, `/v1/points/${ADDRESS}`);
      assert.equal(again.response.status, 503);
      assert.equal(again.json.error, "points_unavailable");
      assert.equal(calls, 3);
    });
  });

  it("clears the failure streak after a completed read or a rejected query", async () => {
    let broken = true;
    let calls = 0;
    const store = {
      getCursor() {
        calls += 1;
        if (broken) throw new Error("db down");
        return { last_scanned_block: null, finalized_block: null, pass_completed: true };
      },
      getLedgerSummary() {
        return { points_total: 0, rows_count: 0, first_activity_utc_day: null };
      },
      listLedgerRows() {
        return [];
      },
      getConfig() {
        return { weights: {}, gates: {}, rule_version: null };
      },
    };
    await withServer({
      store,
      enabled: () => true,
      config: { ratePerMinute: 100, trustedProxyHops: 0 },
    }, async (base, api) => {
      for (let index = 0; index < 4; index += 1) {
        assert.equal((await request(base, `/v1/points/${ADDRESS}`)).response.status, 500);
      }
      broken = false;
      assert.equal((await request(base, `/v1/points/${ADDRESS}`)).response.status, 200);
      assert.equal(api.breakerState(), "closed");
      broken = true;
      for (let index = 0; index < 4; index += 1) {
        assert.equal((await request(base, `/v1/points/${ADDRESS}`)).response.status, 500);
      }
      assert.equal(api.breakerState(), "closed");
      const next = await request(base, `/v1/points/${ADDRESS}`);
      assert.equal(next.response.status, 500);
      assert.equal(next.json.error, "internal");
      assert.equal(calls, 10);
      assert.equal(api.breakerState(), "open");
    });
    calls = 0;
    await withServer({
      store,
      enabled: () => true,
      config: { ratePerMinute: 100, trustedProxyHops: 0 },
    }, async (base, api) => {
      for (let index = 0; index < 4; index += 1) {
        assert.equal((await request(base, `/v1/points/${ADDRESS}`)).response.status, 500);
      }
      const rejected = await request(base, "/v1/points/config?chainId=1");
      assert.equal(rejected.response.status, 400);
      assert.equal(rejected.json.error, "wrong_chain");
      assert.equal(api.breakerState(), "closed");
      for (let index = 0; index < 4; index += 1) {
        assert.equal((await request(base, `/v1/points/${ADDRESS}`)).response.status, 500);
      }
      assert.equal(calls, 8);
      assert.equal(api.breakerState(), "closed");
    });
  });

  it("does not throw out of the request handler", () => {
    const api = createReadApi({
      store: fakeStore({ throwOn: "cursor", error: new Error("db down") }),
      enabled: () => true,
      config: { ratePerMinute: 10 },
    });
    const req = {
      method: "GET",
      url: `/v1/points/${ADDRESS}`,
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    };
    const res = {
      headersSent: false,
      writableEnded: false,
      writeHead() {
        throw new Error("cannot write");
      },
      end() {
        throw new Error("cannot end");
      },
    };
    try {
      assert.doesNotThrow(() => api(req, res));
      const direct = api.handle({
        method: "GET",
        path: `/v1/points/${ADDRESS}`,
        query: {},
        headers: {},
        remoteAddress: "127.0.0.1",
      });
      assert.equal(direct.status, 500);
      assert.deepEqual(direct.body, { ok: false, error: "internal" });
    } finally {
      api.close();
    }
  });

  it("serves the read API from main with the flag on and off", async () => {
    const env = {
      CHAIN_ID: "84532",
      POINTS_DB_PATH: ":memory:",
      POINTS_POLL_MS: "1000",
      POINTS_LOG_RANGE: "10",
      POINTS_MAX_WINDOWS_PER_PASS: "1",
    };
    let release;
    let health;
    const pending = start({
      once: true,
      serve: true,
      port: 0,
      env,
      onListening(info) {
        health = info;
      },
      rpc: {
        async chainId() {
          return 84532;
        },
        async getCode() {
          return "0x6001600055";
        },
        async finalizedBlockNumber() {
          if (!release) await new Promise((resolve) => { release = resolve; });
          return ESCROW_START_BLOCK - 1;
        },
        async getLogs() {
          throw new Error("unexpected getLogs");
        },
      },
    });
    let running;
    try {
      for (let attempt = 0; attempt < 100 && !health; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      for (let attempt = 0; attempt < 100 && !release; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.ok(health);
      assert.equal(typeof release, "function");
      const origin = health.url.replace(/\/health$/, "");
      const earlyHealth = await request(origin, "/health");
      assert.equal(earlyHealth.response.status, 503);
      assert.deepEqual(earlyHealth.json, { ok: false, chainId: 84532 });
      assert.equal(earlyHealth.response.headers.get("content-type"), "application/json");
      assert.equal(earlyHealth.response.headers.get("cache-control"), null);
      const hidden = await request(origin, "/v1/points/config", {
        headers: { origin: "https://agent-bv.pages.dev" },
      });
      assert.equal(hidden.response.status, 503);
      assert.deepEqual(hidden.json, { ok: false, error: "points_disabled" });
      assert.equal(hidden.response.headers.get("content-type"), "application/json; charset=utf-8");
      assert.equal(hidden.response.headers.get("cache-control"), "no-store");
      assert.equal(hidden.response.headers.get("access-control-allow-origin"), null);
      env.POINTS_ENABLED = "1";
      const syncing = await request(origin, `/v1/points/${ADDRESS}`);
      assert.equal(syncing.response.status, 200);
      assert.equal(syncing.json.syncing, true);
      assert.equal(syncing.json.indexed_to_block, null);
      assert.equal(syncing.json.points_total, 0);
      assert.equal(syncing.json.points_withheld, true);
      release();
      release = null;
      running = await pending;
      const fresh = await request(origin, "/health");
      assert.equal(fresh.response.status, 200);
      assert.deepEqual(fresh.json, { ok: true, chainId: 84532 });
      assert.equal(fresh.response.headers.get("content-type"), "application/json");
      assert.equal(fresh.response.headers.get("cache-control"), null);
      const config = await request(origin, "/v1/points/config?chainId=84532", {
        headers: { origin: "https://agent-bv.pages.dev" },
      });
      assert.equal(config.response.status, 200);
      assert.equal(config.json.status, "draft");
      assert.equal(config.json.chainId, 84532);
      assert.equal(config.response.headers.get("access-control-allow-origin"), "https://agent-bv.pages.dev");
      const caughtUp = await request(origin, `/v1/points/${ADDRESS}?chainId=84532`);
      assert.equal(caughtUp.json.syncing, false);
      assert.equal(caughtUp.json.behind, 0);
      assert.equal(caughtUp.json.indexed_to_block, null);
      assert.equal(caughtUp.json.finalized_block, ESCROW_START_BLOCK - 1);
      const missing = await request(origin, "/nope");
      assert.equal(missing.response.status, 404);
      assert.equal(missing.response.headers.get("content-type"), "text/plain");
      assert.equal(missing.text, "not found");
      env.POINTS_ENABLED = "0";
      const off = await request(origin, "/v1/points/config", {
        headers: { origin: "https://agent-bv.pages.dev" },
      });
      assert.equal(off.response.status, 503);
      assert.equal(off.json.error, "points_disabled");
      assert.equal(off.response.headers.get("access-control-allow-origin"), null);
      const stillHealthy = await request(origin, "/health");
      assert.deepEqual(stillHealthy.json, { ok: true, chainId: 84532 });
      env.POINTS_ENABLED = "1";
      const secret = "SECRET https://evil.example/x /tmp/ledger.sqlite";
      running.indexer.db.prepare = () => {
        const error = new Error(secret);
        error.stack = `Error: ${secret}\n    at Object.prepare (/tmp/ledger.sqlite:10:1)`;
        throw error;
      };
      const failed = await request(origin, `/v1/points/${ADDRESS}`);
      assert.equal(failed.response.status, 500);
      assert.equal(failed.text, '{"ok":false,"error":"internal"}');
      assert.equal(failed.text.includes("SECRET"), false);
      assert.equal(failed.text.includes("/tmp"), false);
      const healthAfter = await request(origin, "/health");
      assert.equal(healthAfter.response.status, 200);
      assert.deepEqual(healthAfter.json, { ok: true, chainId: 84532 });
      const configAfter = await request(origin, "/v1/points/config");
      assert.equal(configAfter.response.status, 200);
    } finally {
      if (release) release();
      if (!running) {
        try {
          running = await pending;
        } catch {
          running = null;
        }
      }
      if (running) await running.stop();
      else if (health) await health.close();
    }
  });
});
