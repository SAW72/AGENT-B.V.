import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ESCROW_START_BLOCK } from "../src/constants.mjs";
import { createdLog } from "./support.mjs";
import { loadConfig, start } from "../src/main.mjs";
import {
  bucketClientAddress,
  coarseBucket,
  createRateLimiter,
  clientIp,
  createReadApi,
  DEFAULT_COARSE_MAX_ENTRIES,
  DISCLAIMER_TEXT,
  headerTooLong,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  historyOrder,
  httpsNoticeUrl,
  parseExactHttpsOrigin,
  parseRatePerMinute as readRatePerMinute,
  pointsEnabled,
  READ_ENV_ALLOWLIST,
  readSettings,
  rowFollowsCursor,
} from "../src/readApi.mjs";
import {
  DEFAULT_MAX_ENTRIES,
  createFallbackLimiter,
  parseExactHttpsOrigin as edgeOrigin,
  parseRatePerMinute,
} from "../src/readEdge.mjs";

const POINTS_FILE = fileURLToPath(new URL("../config/points.json", import.meta.url));
const SEPOLIA_FILE = fileURLToPath(new URL("../../../config/reputation/sepolia.json", import.meta.url));
const RENDER_FILE = fileURLToPath(new URL("../render.yaml", import.meta.url));
const README_FILE = fileURLToPath(new URL("../README.md", import.meta.url));
const FLAG_SOURCE = fileURLToPath(new URL("../src/pointsFlag.mjs", import.meta.url));
const READ_SOURCE = fileURLToPath(new URL("../src/readApi.mjs", import.meta.url));
const MAIN_SOURCE = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
const ADDRESS = "0x1111111111111111111111111111111111111111";

function waitFor(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), 5000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
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
      const after = query?.after ?? null;
      const limit = Number.isInteger(query?.limit) ? query.limit : rows.length;
      return rows
        .filter((row) => (row.wallet == null || row.wallet === address) && rowFollowsCursor(row, after))
        .sort((left, right) => (
          left.block_number - right.block_number
          || left.log_index - right.log_index
          || historyOrder(left.action) - historyOrder(right.action)
          || left.utc_day - right.utc_day
        ))
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
    log: options.log,
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
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
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
  const withheld = row.points_withheld === 1 || row.points_withheld === true;
  return {
    action: row.action,
    utc_day: row.utc_day,
    tx_hash: row.tx_hash,
    log_index: row.log_index,
    block_number: row.block_number,
    escrow_id: row.escrow_id,
    points: withheld ? 0 : row.points,
    points_withheld: withheld,
    eligibility_reason: row.eligibility_reason,
    register_status: row.register_status,
  };
}

describe("points read API", { concurrency: false }, () => {
  it("reads optional env in loadConfig and stays off unless the flag is set", () => {
    const config = loadConfig({});
    assert.equal(config.chainId, 84532);
    assert.equal(config.dbPath, "points-indexer.sqlite");
    assert.equal(Object.hasOwn(config, "pointsEnabled"), false);
    assert.equal(Object.hasOwn(loadConfig({ POINTS_ENABLED: "true" }), "pointsEnabled"), false);
    assert.equal(pointsEnabled({}), false);
    assert.equal(pointsEnabled({ POINTS_ENABLED: "true" }), true);
    assert.equal(pointsEnabled({ POINTS_ENABLED: "TRUE" }), false);
    assert.equal(pointsEnabled({ POINTS_ENABLED: " true " }), false);
    assert.equal(pointsEnabled({ POINTS_ENABLED: "1" }), false);
    assert.equal(pointsEnabled({ POINTS_ENABLED: "yes" }), false);
    assert.equal(pointsEnabled({ POINTS_ENABLED: "on" }), false);
    assert.equal(pointsEnabled({ POINTS_ENABLED: "0" }), false);
    assert.equal(pointsEnabled({ POINTS_ENABLED: "false" }), false);
    assert.equal(pointsEnabled({ POINTS_READ_API_ENABLED: "1" }), false);
    const settings = readSettings({});
    assert.equal(settings.ratePerMinute, 60);
    assert.equal(settings.trustedProxyHops, 0);
    assert.equal(settings.cloudflareIngress, false);
    assert.equal(readSettings({ POINTS_CLOUDFLARE_INGRESS: "true" }).cloudflareIngress, true);
    assert.equal(readSettings({ POINTS_CLOUDFLARE_INGRESS: "TRUE" }).cloudflareIngress, false);
    assert.equal(settings.breakerFailures, 5);
    assert.equal(settings.breakerCooldownMs, 30_000);
    assert.deepEqual(settings.corsOrigins, []);
    assert.deepEqual(readSettings({ POINTS_CORS_ORIGINS: "" }).corsOrigins, []);
    assert.deepEqual(readSettings({ POINTS_CORS_ORIGINS: "   " }).corsOrigins, []);
    assert.equal(readSettings({ POINTS_TRUSTED_PROXY_HOPS: "0" }).trustedProxyHops, 0);
    assert.equal(readSettings({ POINTS_TRUSTED_PROXY_HOPS: "2" }).trustedProxyHops, 2);
    assert.equal(readSettings({ POINTS_TRUSTED_PROXY_HOPS: "nope" }).trustedProxyHops, 0);
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
    await withServer({
      enabled: () => true,
      config: { ratePerMinute: 20, corsOrigins: ["https://agent-bv.pages.dev"] },
    }, async (base) => {
      const posted = await request(base, "/v1/points/config", { method: "POST" });
      assert.equal(posted.response.status, 405);
      assert.deepEqual(posted.json, { ok: false, error: "method_not_allowed" });
      assert.equal(posted.response.headers.get("allow"), "GET, HEAD, OPTIONS");
      assertJsonNoStore(posted.response);
      const preflight = await request(base, "/v1/points/config", {
        method: "OPTIONS",
        headers: { origin: "https://agent-bv.pages.dev" },
      });
      assert.equal(preflight.response.status, 204);
      assert.equal(preflight.text, "");
      assert.equal(preflight.response.headers.get("allow"), "GET, HEAD, OPTIONS");
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

  it("sends no access-control-allow-origin when the allowlist is empty", async () => {
    await withServer({ enabled: () => true, config: { ratePerMinute: 20 } }, async (base) => {
      const read = await request(base, "/v1/points/config", {
        headers: { origin: "https://agent-bv.pages.dev" },
      });
      assert.equal(read.response.status, 200);
      assert.equal(read.response.headers.get("access-control-allow-origin"), null);
      assert.equal(read.response.headers.get("vary"), "Origin");
      const preflight = await request(base, "/v1/points/config", {
        method: "OPTIONS",
        headers: { origin: "https://agent-bv.pages.dev" },
      });
      assert.equal(preflight.response.status, 204);
      assert.equal(preflight.response.headers.get("access-control-allow-origin"), null);
      assert.equal(preflight.response.headers.get("vary"), "Origin");
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

  it("reports a zero total while points are withheld", async () => {
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
      assert.equal(body.json.points_total, 0);
      assert.equal(body.json.points_withheld, true);
      assert.deepEqual(body.json.eligibility, { status: "unverified", reason: "ofac_unconfigured" });
      assert.equal(body.json.rows_count, 2);
      assert.equal(body.json.first_activity_utc_day, 20_000);
      assert.equal(body.json.indexed_to_block, 100_000_000);
      assert.equal(body.json.finalized_block, 100_000_000);
      assert.equal(body.json.behind, 0);
      assert.equal(body.json.syncing, false);
      const sepolia = JSON.parse(readFileSync(SEPOLIA_FILE, "utf8"));
      assert.equal(body.json.disclaimer.text, DISCLAIMER_TEXT);
      assert.equal(body.json.disclaimer.text, sepolia.display.disclaimer);
      assert.equal(Object.hasOwn(body.json.disclaimer.links, "legal_notice_url"), true);
      assert.equal(Object.hasOwn(body.json.disclaimer.links, "bvt_securities_disclaimer"), false);
      assert.equal(body.json.disclaimer.links.legal_notice_url, null);
      assert.equal(body.json.disclaimer.links.master_disclaimer, null);
      assert.ok(Object.values(body.json.disclaimer.links).every((value) => value === null));
      const history = await request(base, `/v1/points/${wallet}/history?chainId=84532`);
      assert.deepEqual(history.json.items, rows.map(expectedItem));
      assert.equal(history.json.items.reduce((sum, item) => sum + item.points, 0), 0);
      assert.equal(history.json.items.every((item) => item.points_withheld === true), true);
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
        assert.equal(typeof clamped.json.next_cursor, "string");
        assert.equal(/^\d+$/.test(clamped.json.next_cursor), false);
        const rest = await request(base, `/v1/points/${PAGE_WALLET}/history?chainId=84532&limit=25&cursor=${encodeURIComponent(clamped.json.next_cursor)}`);
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
      config: { ratePerMinute: 10, corsOrigins: ["https://agent-bv.pages.dev"] },
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
    });
  });

  it("rejects a forwarded header over 2048 characters instead of sharing the socket bucket", async () => {
    assert.equal(headerTooLong({ headers: { "x-forwarded-for": "a".repeat(2048) } }, 0), false);
    assert.equal(headerTooLong({ headers: { "x-forwarded-for": "b".repeat(2048) } }, 1), false);
    assert.equal(headerTooLong({ headers: { "x-forwarded-for": "a".repeat(2049) } }, 0), false);
    assert.equal(headerTooLong({ headers: { "x-forwarded-for": "a".repeat(2049) } }, 1), true);
    assert.equal(headerTooLong({
      headers: { "cf-connecting-ip": "c".repeat(2048) },
    }, 0, { cloudflareIngress: true }), false);
    assert.equal(headerTooLong({
      headers: { "cf-connecting-ip": "c".repeat(2049) },
    }, 0, { cloudflareIngress: true }), true);
    assert.equal(headerTooLong({
      headers: { "cf-connecting-ip": "c".repeat(2049) },
    }, 0), false);
    assert.equal(clientIp({
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "a".repeat(2049) },
    }, 1), null);
    assert.equal(clientIp({
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "a".repeat(2049) },
    }, 0), "127.0.0.1");
    assert.equal(clientIp({
      remoteAddress: "127.0.0.1",
      headers: { "cf-connecting-ip": "c".repeat(2049) },
    }, 0, { cloudflareIngress: true }), null);
    await withServer({
      enabled: () => true,
      config: { ratePerMinute: 5, trustedProxyHops: 1 },
    }, async (base) => {
      const huge = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": `203.0.113.5,${"9".repeat(3000)}` },
      });
      assert.equal(huge.response.status, 400);
      assert.equal(huge.json.error, "header_too_long");
      const next = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "203.0.113.9" },
      });
      assert.equal(next.response.status, 200);
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

  it("keeps limited keys and shares one overflow bucket when the map is full", async () => {
    await withServer({
      enabled: () => true,
      config: { ratePerMinute: 1, maxEntries: 2, coarseMax: 100, trustedProxyHops: 1 },
    }, async (base) => {
      const headers = (ip) => ({ "x-forwarded-for": ip });
      const status = async (ip) => (await request(base, "/v1/points/config", { headers: headers(ip) })).response.status;
      assert.equal(await status("10.0.0.1"), 200);
      assert.equal(await status("10.0.0.1"), 429);
      assert.equal(await status("10.0.0.2"), 200);
      assert.equal(await status("10.1.0.3"), 200);
      assert.equal(await status("10.2.0.4"), 429);
      assert.equal(await status("10.0.0.1"), 429);
      assert.equal(await status("10.0.0.2"), 429);
    });
  });

  it("drops an expired limiter key before the map stays closed", async () => {
    let now = 0;
    await withServer({
      enabled: () => true,
      now: () => now,
      config: { ratePerMinute: 1, maxEntries: 1, coarseMax: 100, windowMs: 1_000, trustedProxyHops: 1 },
    }, async (base) => {
      const headers = (ip) => ({ "x-forwarded-for": ip });
      const status = async (ip) => (await request(base, "/v1/points/config", { headers: headers(ip) })).response.status;
      assert.equal(await status("10.0.0.1"), 200);
      assert.equal(await status("10.1.0.2"), 200);
      assert.equal(await status("10.2.0.3"), 429);
      now = 1_000;
      assert.equal(await status("10.2.0.3"), 200);
    });
  });

  it("does not let one IPv6 /48 flood lock out a new IPv4 client", () => {
    const limiter = createRateLimiter({
      max: 5,
      coarseMax: 4,
      maxEntries: 64,
      clock: () => 1_000,
      sweepMs: 60_000,
    });
    try {
      let admitted = 0;
      for (let index = 0; index < 30; index += 1) {
        const key = bucketClientAddress(`2001:db8:1:${index.toString(16)}::1`);
        assert.equal(coarseBucket(key), "2001:db8:1::/48");
        if (limiter.allow(key).ok) admitted += 1;
      }
      assert.equal(admitted, 4);
      assert.ok(limiter.size() < 64);
      const ipv4 = bucketClientAddress("198.51.100.7");
      assert.equal(coarseBucket(ipv4), "198.51.100.0/24");
      assert.equal(limiter.allow(ipv4).ok, true);
      assert.equal(limiter.allow(bucketClientAddress("2001:db8:2:1::1")).ok, true);
      let same24 = 0;
      for (let host = 1; host <= 10; host += 1) {
        if (limiter.allow(`203.0.113.${host}`).ok) same24 += 1;
      }
      assert.equal(same24, 4);
      assert.equal(limiter.allow("203.0.114.1").ok, true);
    } finally {
      limiter.close();
    }
  });

  it("counts a bounded number of map touches per request when the map is full", () => {
    function touchesFor(entries) {
      const limiter = createRateLimiter({
        max: 1,
        maxEntries: entries,
        coarseMax: 1_000_000,
        coarseMaxEntries: 1_000_000,
        clock: () => 0,
        sweepMs: 1_000_000,
      });
      try {
        for (let index = 0; index < entries; index += 1) limiter.allow(`k${index}`);
        const before = limiter.touchCount();
        const decision = limiter.allow("fresh-key");
        return { delta: limiter.touchCount() - before, ok: decision.ok };
      } finally {
        limiter.close();
      }
    }
    const small = touchesFor(32);
    const large = touchesFor(4000);
    assert.equal(small.ok, true);
    assert.equal(large.ok, true);
    assert.ok(small.delta > 0 && small.delta <= 24, `small touches ${small.delta}`);
    assert.ok(large.delta <= 24, `large touches ${large.delta}`);
    assert.ok(large.delta <= small.delta + 2, `small ${small.delta} large ${large.delta}`);
  });

  it("keeps the /48 map at its cap while admitting later prefixes", () => {
    assert.equal(DEFAULT_COARSE_MAX_ENTRIES, 4096);
    const cap = 128;
    const limiter = createRateLimiter({
      max: 1_000_000,
      coarseMax: 1_000_000,
      coarseMaxEntries: cap,
      maxEntries: cap,
      clock: () => 0,
      sweepMs: 1_000_000,
    });
    const prefixKey = (index) => {
      const hi = (index >>> 16) & 0xffff;
      const lo = index & 0xffff;
      return `2001:${hi.toString(16)}:${lo.toString(16)}:1::/64`;
    };
    try {
      let admitted = 0;
      const before = process.memoryUsage().heapUsed;
      for (let index = 0; index < 200_000; index += 1) {
        if (limiter.allow(prefixKey(index)).ok) admitted += 1;
      }
      const grew = process.memoryUsage().heapUsed - before;
      assert.equal(admitted, 200_000);
      assert.equal(limiter.coarseSize(), cap);
      assert.equal(limiter.size(), cap);
      assert.equal(limiter.allow(prefixKey(200_000)).ok, true);
      assert.equal(limiter.coarseSize(), cap);
      assert.ok(grew < 48 * 1024 * 1024, `heap grew ${grew}`);
    } finally {
      limiter.close();
    }
  });

  it("evicts the least recently seen under-limit prefix at about 68 requests per second", () => {
    assert.equal(DEFAULT_COARSE_MAX_ENTRIES, 4096);
    const cap = DEFAULT_COARSE_MAX_ENTRIES;
    const step = Math.round(1000 / 68);
    let now = 0;
    const limiter = createRateLimiter({
      max: 10_000,
      coarseMax: 8,
      coarseMaxEntries: cap,
      maxEntries: 20_000,
      windowMs: 60_000,
      clock: () => now,
      sweepMs: 1_000_000,
    });
    const prefixKey = (index) => {
      const hi = (index >>> 16) & 0xffff;
      const lo = index & 0xffff;
      return `2001:${hi.toString(16)}:${lo.toString(16)}:1::/64`;
    };
    try {
      for (let index = 0; index < cap; index += 1) {
        now += step;
        assert.equal(limiter.allow(prefixKey(index)).ok, true);
      }
      assert.equal(limiter.coarseSize(), cap);
      assert.ok(now >= 60_000);
      assert.ok(now < 62_000);
      now += step;
      assert.equal(limiter.allow(prefixKey(cap)).ok, true);
      assert.equal(limiter.coarseSize(), cap);
      now += step;
      assert.equal(limiter.allow(prefixKey(0)).ok, true);
      assert.equal(limiter.coarseSize(), cap);
    } finally {
      limiter.close();
    }
  });

  it("refuses a new prefix when every resident prefix is at its limit", () => {
    const limiter = createRateLimiter({
      max: 10,
      coarseMax: 2,
      coarseMaxEntries: 3,
      maxEntries: 20,
      clock: () => 1_000,
      sweepMs: 1_000_000,
    });
    const key = (a, b, c) => `2001:${a.toString(16)}:${b.toString(16)}:${c.toString(16)}::/64`;
    try {
      assert.equal(limiter.allow(key(1, 1, 1)).ok, true);
      assert.equal(limiter.allow(key(2, 2, 1)).ok, true);
      assert.equal(limiter.allow(key(2, 2, 2)).ok, true);
      assert.equal(limiter.allow(key(3, 3, 1)).ok, true);
      assert.equal(limiter.coarseSize(), 3);
      assert.equal(limiter.allow(key(4, 4, 1)).ok, true);
      assert.equal(limiter.coarseSize(), 3);
      assert.equal(limiter.allow(key(2, 2, 3)).ok, false);
      assert.equal(limiter.allow(key(1, 1, 2)).ok, true);
      assert.equal(limiter.coarseSize(), 3);
    } finally {
      limiter.close();
    }
  });

  it("evicts the least recently seen under-limit prefix, not the oldest insert or the newest", () => {
    const limiter = createRateLimiter({
      max: 100,
      coarseMax: 3,
      coarseMaxEntries: 2,
      maxEntries: 20,
      windowMs: 60_000,
      clock: () => 1_000,
      sweepMs: 1_000_000,
    });
    const key = (name) => `2001:${name}:${name}:1::/64`;
    try {
      assert.equal(limiter.allow(key("a")).ok, true);
      assert.equal(limiter.allow(key("b")).ok, true);
      assert.equal(limiter.allow(key("a")).ok, true);
      assert.equal(limiter.allow(key("c")).ok, true);
      assert.equal(limiter.coarseSize(), 2);
      assert.equal(limiter.allow(key("a")).ok, true);
      assert.equal(limiter.allow(key("a")).ok, false);
    } finally {
      limiter.close();
    }
  });

  it("does not evict a prefix that is already at its limit", () => {
    const limiter = createRateLimiter({
      max: 100,
      coarseMax: 2,
      coarseMaxEntries: 1,
      maxEntries: 20,
      windowMs: 60_000,
      clock: () => 1_000,
      sweepMs: 1_000_000,
    });
    const key = (name, host) => `2001:${name}:${name}:${host}::/64`;
    try {
      assert.equal(limiter.allow(key("a", "1")).ok, true);
      assert.equal(limiter.allow(key("a", "2")).ok, true);
      assert.equal(limiter.coarseSize(), 1);
      assert.equal(limiter.allow(key("a", "3")).ok, false);
      assert.equal(limiter.coarseSize(), 1);
      assert.equal(limiter.allow(key("b", "1")).ok, false);
      assert.equal(limiter.coarseSize(), 1);
      assert.equal(limiter.allow(key("a", "4")).ok, false);
      assert.equal(limiter.coarseSize(), 1);
    } finally {
      limiter.close();
    }
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
      config: { ratePerMinute: 5, corsOrigins: ["https://agent-bv.pages.dev"] },
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
      "POINTS_CLOUDFLARE_INGRESS",
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
    const gateAt = source.indexOf("if (!pointsEnabled(env))");
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

  it("clears the failure streak only after a completed store read", async () => {
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
      assert.equal(calls, 4);
      const fifth = await request(base, `/v1/points/${ADDRESS}`);
      assert.equal(fifth.response.status, 500);
      assert.equal(calls, 5);
      assert.equal(api.breakerState(), "open");
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
    let releaseHead;
    const headGate = new Promise((resolve) => { releaseHead = resolve; });
    let markEntered;
    const headEntered = new Promise((resolve) => { markEntered = resolve; });
    let markListening;
    const listening = new Promise((resolve) => { markListening = resolve; });
    let health;
    const pending = start({
      once: true,
      serve: true,
      port: 0,
      env,
      onListening(info) {
        health = info;
        markListening();
      },
      rpc: {
        async chainId() {
          return 84532;
        },
        async getCode() {
          return "0x6001600055";
        },
        async finalizedBlockNumber() {
          markEntered();
          await headGate;
          return ESCROW_START_BLOCK - 1;
        },
        async getLogs() {
          throw new Error("unexpected getLogs");
        },
      },
    });
    let running;
    try {
      await waitFor(listening, "health listener did not open");
      await waitFor(headEntered, "finalized head read did not start");
      assert.ok(health);
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
      assert.equal(hidden.response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(hidden.response.headers.get("access-control-allow-origin"), null);
      env.POINTS_ENABLED = "true";
      const syncing = await request(origin, `/v1/points/${ADDRESS}`);
      assert.equal(syncing.response.status, 200);
      assert.equal(syncing.json.syncing, true);
      assert.equal(syncing.json.indexed_to_block, null);
      assert.equal(syncing.json.points_total, 0);
      assert.equal(syncing.json.points_withheld, true);
      releaseHead();
      releaseHead = null;
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
      assert.equal(config.response.headers.get("access-control-allow-origin"), null);
      assert.equal(config.response.headers.get("vary"), "Origin");
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
      env.POINTS_ENABLED = "true";
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
      if (releaseHead) releaseHead();
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

  it("reports the live head while a restarted file database is still catching up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abv-restart-"));
    const dbPath = join(dir, "points.sqlite");
    const caughtUp = ESCROW_START_BLOCK + 50;
    const logRange = 200;
    const liveHead = caughtUp + 1_000_000;
    const env = {
      CHAIN_ID: "84532",
      POINTS_DB_PATH: dbPath,
      POINTS_POLL_MS: "60000",
      POINTS_LOG_RANGE: String(logRange),
      POINTS_MAX_WINDOWS_PER_PASS: "2",
      POINTS_ENABLED: "true",
    };
    const codeRpc = (head, getLogs) => ({
      async chainId() {
        return 84532;
      },
      async getCode() {
        return "0x6001600055";
      },
      async finalizedBlockNumber() {
        return head;
      },
      getLogs,
    });
    let running = null;
    let releaseSecond;
    const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
    let markSecond;
    const secondEntered = new Promise((resolve) => { markSecond = resolve; });
    try {
      const first = await start({
        once: true,
        serve: false,
        env,
        rpc: codeRpc(caughtUp, async () => []),
      });
      try {
        assert.equal(first.ingested.scannedThrough, caughtUp);
        assert.equal(first.indexer.lastScannedBlock(), caughtUp);
        assert.equal(first.indexer.finalizedBlock, caughtUp);
      } finally {
        await first.stop();
      }

      let calls = 0;
      let health = null;
      let opened = null;
      const pending = start({
        once: true,
        serve: true,
        port: 0,
        env,
        onListening(info) {
          health = info;
        },
        onIndexer(indexer) {
          opened = indexer;
        },
        rpc: codeRpc(liveHead, async () => {
          calls += 1;
          if (calls === 2) {
            markSecond();
            await secondGate;
          }
          return [];
        }),
      });
      try {
        await waitFor(secondEntered, "second window did not start");
        assert.equal(calls, 2);
        assert.ok(health);
        assert.ok(opened);
        const stored = Number(opened.db.prepare("SELECT value FROM meta WHERE key = 'finalized_block'").get().value);
        assert.equal(stored, caughtUp);
        const origin = health.url.replace(/\/health$/, "");
        const body = await request(origin, `/v1/points/${ADDRESS}?chainId=84532`);
        const cursor = caughtUp + logRange;
        assert.equal(body.response.status, 200);
        assert.equal(body.json.syncing, true);
        assert.equal(body.json.indexed_to_block, cursor);
        assert.equal(body.json.behind, liveHead - cursor);
        assert.ok(body.json.finalized_block >= body.json.indexed_to_block);
        assert.equal(body.json.finalized_block, liveHead);
        assert.equal(body.json.stale, false);
      } finally {
        if (releaseSecond) releaseSecond();
        try {
          running = await pending;
        } catch {
          running = null;
        }
        if (running) await running.stop();
        else if (health) await health.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores X-Forwarded-For until a hop count is set", async () => {
    assert.equal(readSettings({}).trustedProxyHops, 0);
    await withServer({
      enabled: () => true,
      config: { ratePerMinute: 1 },
    }, async (base) => {
      const first = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "1.1.1.1" },
      });
      assert.equal(first.response.status, 200);
      const otherHeader = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "2.2.2.2" },
      });
      assert.equal(otherHeader.response.status, 429);
      assert.equal(otherHeader.json.error, "rate_limited");
    });
  });

  it("answers HEAD with the GET headers and an empty body", async () => {
    await withServer({ enabled: () => true, config: { ratePerMinute: 10 } }, async (base) => {
      const got = await request(base, "/v1/points/config");
      const head = await request(base, "/v1/points/config", { method: "HEAD" });
      assert.equal(head.response.status, 200);
      assert.equal(head.text, "");
      assert.equal(head.response.headers.get("content-type"), got.response.headers.get("content-type"));
      assert.equal(head.response.headers.get("content-length"), got.response.headers.get("content-length"));
      assert.equal(head.response.headers.get("cache-control"), "no-store");
      assert.equal(head.response.headers.get("x-content-type-options"), "nosniff");
      const denied = await request(base, "/v1/points/config", { method: "POST" });
      assert.equal(denied.response.status, 405);
      assert.equal(denied.response.headers.get("allow"), "GET, HEAD, OPTIONS");
    });
  });

  it("does not let a 4xx that skipped the store close the breaker", async () => {
    let now = 0;
    let calls = 0;
    const lines = [];
    const store = {
      getCursor() {
        calls += 1;
        throw new Error("db down https://secret.example/key");
      },
      getLedgerSummary() {
        return { points_total: 9, rows_count: 1, first_activity_utc_day: null };
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
      log: (line) => lines.push(line),
      config: { ratePerMinute: 100, breakerFailures: 5, breakerCooldownMs: 30_000, trustedProxyHops: 0 },
    }, async (base, api) => {
      for (let index = 0; index < 5; index += 1) {
        const failed = await request(base, `/v1/points/${ADDRESS}`);
        assert.equal(failed.response.status, 500);
        assert.equal(failed.text.includes("secret.example"), false);
      }
      assert.equal(api.breakerState(), "open");
      assert.equal(lines.filter((line) => line === "points_read internal").length, 5);
      assert.equal(lines.filter((line) => line === "points_read breaker_open").length, 1);
      assert.equal(lines.some((line) => String(line).includes("secret.example")), false);
      const probe = await request(base, "/v1/points/0x1234");
      assert.equal(probe.response.status, 400);
      assert.equal(probe.json.error, "invalid_address");
      assert.equal(calls, 5);
      assert.equal(api.breakerState(), "open");
      const still = await request(base, `/v1/points/${ADDRESS}`);
      assert.equal(still.response.status, 503);
      assert.equal(still.json.error, "points_unavailable");
      assert.equal(calls, 5);
    });
  });

  it("locks page size, error codes, and the response fields", async () => {
    assert.equal(HISTORY_DEFAULT_LIMIT, 25);
    assert.equal(HISTORY_MAX_LIMIT, 100);
    const row = ledgerRow(1, ADDRESS, { points: 4, points_withheld: 1 });
    await withServer({
      enabled: () => true,
      store: fakeStore({
        cursor: { last_scanned_block: 10, finalized_block: 12, pass_completed: true, stale: true },
        summary: { points_total: 4, rows_count: 1, first_activity_utc_day: 20_000 },
        rows: [row],
      }),
      config: { ratePerMinute: 30 },
    }, async (base) => {
      const config = await request(base, "/v1/points/config?chainId=84532");
      assert.deepEqual(Object.keys(config.json).sort(), ["chainId", "disclaimer", "gates", "rule_version", "status", "weights"]);
      assert.equal(config.json.disclaimer.text, DISCLAIMER_TEXT);
      const address = await request(base, `/v1/points/${ADDRESS}?chainId=84532`);
      assert.deepEqual(Object.keys(address.json).sort(), [
        "address",
        "behind",
        "chainId",
        "disclaimer",
        "eligibility",
        "finalized_block",
        "first_activity_utc_day",
        "indexed_to_block",
        "points_total",
        "points_withheld",
        "rows_count",
        "stale",
        "syncing",
      ]);
      assert.deepEqual(Object.keys(address.json.eligibility).sort(), ["reason", "status"]);
      assert.deepEqual(Object.keys(address.json.disclaimer).sort(), ["links", "text"]);
      assert.equal(address.json.points_total, 0);
      assert.equal(address.json.stale, true);
      const history = await request(base, `/v1/points/${ADDRESS}/history?chainId=84532`);
      assert.equal(history.json.limit, 25);
      assert.deepEqual(Object.keys(history.json).sort(), [
        "address",
        "behind",
        "chainId",
        "disclaimer",
        "finalized_block",
        "indexed_to_block",
        "items",
        "limit",
        "next_cursor",
        "stale",
        "syncing",
      ]);
      assert.deepEqual(Object.keys(history.json.items[0]).sort(), [
        "action",
        "block_number",
        "eligibility_reason",
        "escrow_id",
        "log_index",
        "points",
        "points_withheld",
        "register_status",
        "tx_hash",
        "utc_day",
      ]);
      assert.equal(history.json.items[0].points, 0);
      const codes = [
        ["/v1/points/config?chainId=1", 400, "wrong_chain"],
        ["/v1/points/0x1234", 400, "invalid_address"],
        [`/v1/points/${ADDRESS}/history?limit=0`, 400, "invalid_limit"],
        [`/v1/points/${ADDRESS}/history?cursor=100`, 400, "invalid_cursor"],
        ["/v1/points/config/extra", 404, "not_found"],
      ];
      for (const [path, status, code] of codes) {
        const result = await request(base, path);
        assert.equal(result.response.status, status, path);
        assert.equal(result.json.error, code, path);
        assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
      }
    });
    await withServer({ enabled: () => true, config: { ratePerMinute: 1, trustedProxyHops: 0 } }, async (base) => {
      assert.equal((await request(base, "/v1/points/config")).response.status, 200);
      const limited = await request(base, "/v1/points/config");
      assert.equal(limited.response.status, 429);
      assert.equal(limited.json.error, "rate_limited");
    });
    await withServer({ enabled: () => false, config: { ratePerMinute: 10 } }, async (base) => {
      const disabled = await request(base, "/v1/points/config");
      assert.equal(disabled.response.status, 503);
      assert.equal(disabled.json.error, "points_disabled");
    });
  });

  it("logs a fixed code when a read throws and when the breaker opens", async () => {
    const lines = [];
    let throwCursor = true;
    await withServer({
      enabled: () => true,
      log: (line) => lines.push(String(line)),
      now: () => 0,
      store: {
        getCursor() {
          if (throwCursor) throw new Error("db down");
          return { last_scanned_block: 1, finalized_block: 1, pass_completed: true, stale: false };
        },
        getLedgerSummary() {
          return { points_total: 3, rows_count: 1, first_activity_utc_day: null };
        },
        listLedgerRows() {
          return [];
        },
        getConfig() {
          return { weights: {}, gates: {}, rule_version: null };
        },
      },
      config: { ratePerMinute: 20, breakerFailures: 1, breakerCooldownMs: 30_000 },
    }, async (base) => {
      const failed = await request(base, `/v1/points/${ADDRESS}`);
      assert.equal(failed.response.status, 500);
      assert.equal(failed.json.error, "internal");
      assert.deepEqual(lines, ["points_read breaker_open", "points_read internal"]);
      const blocked = await request(base, `/v1/points/${ADDRESS}`);
      assert.equal(blocked.response.status, 503);
      assert.equal(blocked.json.error, "points_unavailable");
      assert.equal(lines.length, 2);
    });
  });

  it("spells Agent-B.V. in the read API notes and reads the disclaimer from config", () => {
    const source = readFileSync(READ_SOURCE, "utf8");
    assert.equal(source.includes("It cannot be transferred"), false);
    assert.equal(source.includes(DISCLAIMER_TEXT), true);
    const readme = readFileSync(README_FILE, "utf8");
    const section = readme.split("## Read API")[1].split("## What it stores")[0];
    const shortName = JSON.parse(readFileSync(SEPOLIA_FILE, "utf8")).product.name;
    assert.equal(section.includes("Agent-B.V."), true);
    assert.equal(section.includes(shortName), false);
    assert.equal(section.includes(shortName.replace("-", " ")), false);
    const main = readFileSync(MAIN_SOURCE, "utf8");
    const flag = readFileSync(FLAG_SOURCE, "utf8");
    assert.equal(main.includes("function pointsGate"), false);
    assert.equal(main.includes('from "./pointsFlag.mjs"'), true);
    assert.equal(main.includes('text === "on"'), false);
    assert.equal(flag.includes('text === "on"'), false);
    assert.equal(flag.includes('POINTS_ENABLED === "true"'), true);
    assert.equal(flag.includes("node:sqlite"), false);
  });

  it("sets stale after an RPC pass fails and keeps the provider text out of the body", async () => {
    const env = {
      CHAIN_ID: "84532",
      POINTS_DB_PATH: ":memory:",
      POINTS_POLL_MS: "60000",
      POINTS_LOG_RANGE: "10",
      POINTS_MAX_WINDOWS_PER_PASS: "1",
      POINTS_ENABLED: "true",
    };
    const running = await start({
      once: false,
      serve: true,
      port: 0,
      env,
      rpc: {
        async chainId() {
          return 84532;
        },
        async getCode() {
          return "0x6001600055";
        },
        async finalizedBlockNumber() {
          throw new Error("rpc down https://secret.example/key");
        },
        async getLogs() {
          return [];
        },
      },
    });
    try {
      const origin = running.healthUrl.replace(/\/health$/, "");
      const body = await request(origin, `/v1/points/${ADDRESS}`);
      assert.equal(body.response.status, 200);
      assert.equal(body.json.stale, true);
      assert.equal(body.json.points_total, 0);
      assert.equal(body.json.syncing, true);
      assert.equal(body.text.includes("secret.example"), false);
      assert.equal(body.text.includes("https://"), false);
    } finally {
      await running.stop();
    }
  });

  it("reads a file database through a separate connection from the writer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abv-read-"));
    const dbPath = join(dir, "points.sqlite");
    const env = {
      CHAIN_ID: "84532",
      POINTS_DB_PATH: dbPath,
      POINTS_POLL_MS: "60000",
      POINTS_LOG_RANGE: "10",
      POINTS_MAX_WINDOWS_PER_PASS: "1",
      POINTS_ENABLED: "true",
    };
    const running = await start({
      once: true,
      serve: true,
      port: 0,
      env,
      rpc: {
        async chainId() {
          return 84532;
        },
        async getCode() {
          return "0x6001600055";
        },
        async finalizedBlockNumber() {
          return ESCROW_START_BLOCK;
        },
        async getLogs() {
          return [];
        },
      },
    });
    try {
      const origin = running.healthUrl.replace(/\/health$/, "");
      running.indexer.db.prepare(
        `INSERT INTO ledger_rows(
           seq, chain_id, contract, tx_hash, log_index, block_number, block_timestamp, utc_day,
           wallet, action, escrow_id, points, eligibility_status, eligibility_reason, points_withheld,
           rule_weight, counts_for_return_day, register_status, dispute_id, support,
           source_action, source_tx_hash, source_log_index
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        1,
        84532,
        "0x3d660502d75f1e97b08c110255921b437a3c4c42",
        txHash(1),
        1,
        ESCROW_START_BLOCK,
        1_700_000_000,
        20_000,
        ADDRESS,
        "fund",
        `0x${"11".repeat(32)}`,
        6,
        "unverified",
        "ofac_unconfigured",
        1,
        null,
        0,
        null,
        null,
        null,
        null,
        null,
        null,
      );
      const writerPrepare = running.indexer.db.prepare.bind(running.indexer.db);
      running.indexer.db.prepare = (sql) => {
        if (String(sql).includes("ledger_rows")) throw new Error("writer handle");
        return writerPrepare(sql);
      };
      const body = await request(origin, `/v1/points/${ADDRESS}?chainId=84532`);
      assert.equal(body.response.status, 200);
      assert.equal(body.json.rows_count, 1);
      assert.equal(body.json.points_total, 0);
      assert.equal(body.text.includes("writer handle"), false);
      const history = await request(origin, `/v1/points/${ADDRESS}/history?chainId=84532`);
      assert.equal(history.response.status, 200);
      assert.equal(history.json.items.length, 1);
      assert.equal(history.json.items[0].points, 0);
      assert.equal(history.json.items[0].points_withheld, true);
    } finally {
      await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a repeated query parameter and carries the shared disclaimer", async () => {
    function keysOf(value, found = []) {
      if (!value || typeof value !== "object") return found;
      if (Array.isArray(value)) {
        for (const item of value) keysOf(item, found);
        return found;
      }
      for (const key of Object.keys(value)) {
        found.push(key);
        keysOf(value[key], found);
      }
      return found;
    }
    await withServer({ enabled: () => true, config: { ratePerMinute: 20 } }, async (base) => {
      const repeated = await request(base, "/v1/points/config?chainId=84532&chainId=84532");
      assert.equal(repeated.response.status, 400);
      assert.equal(repeated.json.error, "duplicate_query");
      const historyRepeated = await request(base, `/v1/points/${ADDRESS}/history?limit=1&limit=2`);
      assert.equal(historyRepeated.response.status, 400);
      assert.equal(historyRepeated.json.error, "duplicate_query");
      const config = await request(base, "/v1/points/config");
      const history = await request(base, `/v1/points/${ADDRESS}/history`);
      const address = await request(base, `/v1/points/${ADDRESS}`);
      for (const body of [config.json, history.json, address.json, repeated.json]) {
        const banned = ["ra", "nk"].join("") + "|" + ["re", "ward"].join("");
        assert.equal(keysOf(body).some((key) => new RegExp(banned, "i").test(key)), false);
      }
      assert.equal(config.json.disclaimer.text, DISCLAIMER_TEXT);
      assert.equal(history.json.disclaimer.text, DISCLAIMER_TEXT);
      assert.equal(address.json.disclaimer.text, DISCLAIMER_TEXT);
      assert.equal(Object.hasOwn(config.json.disclaimer.links, "legal_notice_url"), true);
    });
    await withServer({ enabled: () => true, config: { ratePerMinute: 3 } }, async (base) => {
      for (let index = 0; index < 3; index += 1) {
        const repeated = await request(base, "/v1/points/config?chainId=84532&chainId=1");
        assert.equal(repeated.response.status, 400);
        assert.equal(repeated.json.error, "duplicate_query");
      }
      const blocked = await request(base, "/v1/points/config");
      assert.equal(blocked.response.status, 429);
      const preflight = await request(base, "/v1/points/config", { method: "OPTIONS" });
      assert.equal(preflight.response.status, 204);
    });
    await withServer({ enabled: () => true, config: { ratePerMinute: 1, trustedProxyHops: 1 } }, async (base) => {
      const huge = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "d".repeat(2049) },
      });
      assert.equal(huge.response.status, 400);
      assert.equal(huge.json.error, "header_too_long");
      const again = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "d".repeat(2049) },
      });
      assert.equal(again.response.status, 429);
    });
    await withServer({
      enabled: () => true,
      config: { ratePerMinute: 1, cloudflareIngress: true },
    }, async (base) => {
      const huge = await request(base, "/v1/points/config", {
        headers: { "cf-connecting-ip": "e".repeat(2049) },
      });
      assert.equal(huge.response.status, 400);
      assert.equal(huge.json.error, "header_too_long");
      const again = await request(base, "/v1/points/config", {
        headers: { "cf-connecting-ip": "e".repeat(2049) },
      });
      assert.equal(again.response.status, 429);
    });
    await withServer({ enabled: () => true, config: { ratePerMinute: 1, trustedProxyHops: 1 } }, async (base) => {
      const huge = await request(base, "/v1/points/config", {
        method: "OPTIONS",
        headers: { "x-forwarded-for": "d".repeat(2049) },
      });
      assert.equal(huge.response.status, 400);
      assert.equal(huge.json.error, "header_too_long");
      const again = await request(base, "/v1/points/config", {
        method: "OPTIONS",
        headers: { "x-forwarded-for": "d".repeat(2049) },
      });
      assert.equal(again.response.status, 429);
    });
    await withServer({
      enabled: () => true,
      store: {
        configAvailable: false,
        getConfig() {
          throw new Error("config_unavailable");
        },
      },
      config: { ratePerMinute: 1 },
    }, async (base) => {
      const preflight = await request(base, "/v1/points/config", { method: "OPTIONS" });
      assert.equal(preflight.response.status, 503);
      assert.equal(preflight.json.error, "config_unavailable");
      const again = await request(base, "/v1/points/config", { method: "OPTIONS" });
      assert.equal(again.response.status, 429);
    });
    await withServer({
      enabled: () => true,
      store: {
        configAvailable: false,
        getConfig() {
          throw new Error("config_unavailable");
        },
      },
      config: { ratePerMinute: 1 },
    }, async (base) => {
      const first = await request(base, "/v1/points/config");
      assert.equal(first.response.status, 503);
      assert.equal(first.json.error, "config_unavailable");
      const second = await request(base, "/v1/points/config");
      assert.equal(second.response.status, 429);
    });
  });

  it("reads an https legal notice from config and drops any other scheme", async () => {
    assert.equal(httpsNoticeUrl("https://notice.invalid/legal"), "https://notice.invalid/legal");
    assert.equal(httpsNoticeUrl("http://notice.invalid/legal"), null);
    assert.equal(httpsNoticeUrl("https://user:secret@notice.invalid/legal"), null);
    assert.equal(httpsNoticeUrl("https://user@notice.invalid/legal"), null);
    assert.equal(httpsNoticeUrl(""), null);
    assert.equal(httpsNoticeUrl("   "), null);
    assert.equal(httpsNoticeUrl(null), null);
    const notice = "https://notice.invalid/legal";
    await withServer({
      enabled: () => true,
      store: fakeStore({
        config: { weights: {}, gates: {}, rule_version: null, legal_notice_url: notice },
      }),
      config: { ratePerMinute: 20 },
    }, async (base) => {
      const config = await request(base, "/v1/points/config?chainId=84532");
      assert.equal(config.json.disclaimer.text, DISCLAIMER_TEXT);
      assert.equal(config.json.disclaimer.links.legal_notice_url, notice);
      const address = await request(base, `/v1/points/${ADDRESS}?notice=http://notice.invalid/other`);
      assert.equal(address.json.disclaimer.text, DISCLAIMER_TEXT);
      assert.equal(address.json.disclaimer.links.legal_notice_url, notice);
      const history = await request(base, `/v1/points/${ADDRESS}/history`);
      assert.equal(history.json.disclaimer.links.legal_notice_url, notice);
    });
    await withServer({
      enabled: () => true,
      store: fakeStore({
        config: { weights: {}, gates: {}, rule_version: null, legal_notice_url: "http://notice.invalid/legal" },
      }),
      config: { ratePerMinute: 10 },
    }, async (base) => {
      const config = await request(base, "/v1/points/config");
      assert.equal(config.json.disclaimer.links.legal_notice_url, null);
    });
  });

  it("keeps render.yaml hops at 0 so X-Forwarded-For is ignored", async () => {
    const text = readFileSync(RENDER_FILE, "utf8");
    assert.equal(text.includes("client is the rightmost"), false);
    assert.equal(/^\s*- key:\s*POINTS_CLOUDFLARE_INGRESS\s*$/m.test(text), false);
    const env = {};
    let key = null;
    for (const line of text.split("\n")) {
      const keyMatch = /^\s*- key:\s*(\S+)\s*$/.exec(line);
      if (keyMatch) {
        key = keyMatch[1];
        continue;
      }
      if (!key) continue;
      const valueMatch = /^\s*value:\s*(?:"([^"]*)"|(\S+))\s*$/.exec(line);
      if (valueMatch) {
        env[key] = valueMatch[1] ?? valueMatch[2];
        key = null;
      }
    }
    const hopAt = text.indexOf("key: POINTS_TRUSTED_PROXY_HOPS");
    const hopNote = text.slice(hopAt, hopAt + 220);
    assert.match(hopNote, /until/i);
    assert.match(hopNote, /echo/i);
    assert.equal(env.POINTS_TRUSTED_PROXY_HOPS, "0");
    assert.equal(Object.hasOwn(env, "POINTS_CLOUDFLARE_INGRESS"), false);
    const settings = readSettings(env);
    assert.equal(settings.trustedProxyHops, 0);
    assert.equal(settings.cloudflareIngress, false);
    await withServer({
      enabled: () => true,
      config: { ratePerMinute: 1, trustedProxyHops: settings.trustedProxyHops },
    }, async (base) => {
      const first = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "203.0.113.10" },
      });
      assert.equal(first.response.status, 200);
      const otherHeader = await request(base, "/v1/points/config", {
        headers: { "x-forwarded-for": "203.0.113.11" },
      });
      assert.equal(otherHeader.response.status, 429);
      assert.equal(clientIp({
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "203.0.113.10" },
      }, settings.trustedProxyHops), "127.0.0.1");
    });
  });

  it("returns 503 config_unavailable once when the cached config is unusable", async () => {
    const lines = [];
    const api = createReadApi({
      store: {
        configAvailable: false,
        getConfig() {
          throw new Error("config_unavailable");
        },
        getCursor() {
          throw new Error("should not read");
        },
        getLedgerSummary() {
          throw new Error("should not read");
        },
        listLedgerRows() {
          throw new Error("should not read");
        },
      },
      enabled: () => true,
      log: (line) => lines.push(String(line)),
      config: { ratePerMinute: 10 },
    });
    try {
      assert.deepEqual(lines, ["points_read config_unavailable"]);
      const first = api.handle({
        method: "GET",
        path: "/v1/points/config",
        remoteAddress: "127.0.0.1",
      });
      const second = api.handle({
        method: "GET",
        path: `/v1/points/${ADDRESS}`,
        remoteAddress: "127.0.0.1",
      });
      assert.equal(first.status, 503);
      assert.deepEqual(first.body, { ok: false, error: "config_unavailable" });
      assert.equal(second.status, 503);
      assert.equal(second.body.error, "config_unavailable");
      assert.deepEqual(lines, ["points_read config_unavailable"]);
      assert.equal(api.breakerState(), "closed");
    } finally {
      api.close();
    }
  });

  it("keeps /health up when the read config is missing", async () => {
    const lines = [];
    const original = console.error;
    console.error = (line) => lines.push(String(line));
    const env = {
      CHAIN_ID: "84532",
      POINTS_DB_PATH: ":memory:",
      POINTS_POLL_MS: "60000",
      POINTS_LOG_RANGE: "10",
      POINTS_ENABLED: "true",
      POINTS_CORS_ORIGINS: "https://app.invalid",
    };
    let running;
    try {
      running = await start({
        once: true,
        serve: true,
        port: 0,
        env,
        readConfigPaths: {
          points: "/tmp/abv-missing-points.json",
          notice: "/tmp/abv-missing-notice.json",
          noticeFallback: "/tmp/abv-missing-notice-fallback.json",
        },
        rpc: {
          async chainId() {
            return 84532;
          },
          async getCode() {
            return "0x6001600055";
          },
          async finalizedBlockNumber() {
            return ESCROW_START_BLOCK;
          },
          async getLogs() {
            return [];
          },
        },
      });
      const health = await fetch(running.healthUrl);
      const healthBody = await health.json();
      assert.equal(health.status, 200);
      assert.equal(healthBody.ok, true);
      assert.equal(healthBody.error, undefined);
      const origin = running.healthUrl.replace(/\/health$/, "");
      const first = await request(origin, "/v1/points/config", {
        headers: { origin: "https://app.invalid" },
      });
      const second = await request(origin, `/v1/points/${ADDRESS}`, {
        headers: { origin: "https://other.invalid" },
      });
      assert.equal(first.response.status, 503);
      assert.equal(first.json.error, "config_unavailable");
      assert.equal(first.response.headers.get("access-control-allow-origin"), "https://app.invalid");
      assert.equal(first.response.headers.get("vary"), "Origin");
      assert.equal(second.response.status, 503);
      assert.equal(second.json.error, "config_unavailable");
      assert.equal(second.response.headers.get("access-control-allow-origin"), null);
      assert.equal(lines.filter((line) => line.includes("config_unavailable")).length, 1);
      const again = await running.pass();
      assert.equal(again.ok, true);
    } finally {
      console.error = original;
      if (running) await running.stop();
    }
  });

  it("counts a config failure answered before the read handler is mounted", async () => {
    const lines = [];
    const original = console.error;
    console.error = (line) => lines.push(String(line));
    let running;
    try {
      running = await start({
        once: true,
        serve: true,
        port: 0,
        env: {
          CHAIN_ID: "84532",
          POINTS_DB_PATH: ":memory:",
          POINTS_POLL_MS: "60000",
          POINTS_LOG_RANGE: "10",
          POINTS_ENABLED: "true",
          POINTS_CORS_ORIGINS: "https://app.invalid",
          POINTS_READ_RATE_PER_MINUTE: "3",
          POINTS_TRUSTED_PROXY_HOPS: "0",
        },
        readApiFactory() {
          throw new Error("config_unavailable");
        },
        rpc: {
          async chainId() {
            return 84532;
          },
          async getCode() {
            return "0x6001600055";
          },
          async finalizedBlockNumber() {
            return ESCROW_START_BLOCK;
          },
          async getLogs() {
            return [];
          },
        },
      });
      const health = await fetch(running.healthUrl);
      assert.equal(health.status, 200);
      await health.text();
      const origin = running.healthUrl.replace(/\/health$/, "");
      const allowed = await request(origin, "/v1/points/config", {
        headers: { origin: "https://app.invalid" },
      });
      assert.equal(allowed.response.status, 503);
      assert.equal(allowed.json.error, "config_unavailable");
      assert.equal(allowed.response.headers.get("access-control-allow-origin"), "https://app.invalid");
      assert.equal(allowed.response.headers.get("vary"), "Origin");
      const other = await request(origin, "/v1/points/config", {
        headers: { origin: "https://other.invalid" },
      });
      assert.equal(other.response.status, 503);
      assert.equal(other.response.headers.get("access-control-allow-origin"), null);
      const preflight = await request(origin, "/v1/points/config", {
        method: "OPTIONS",
        headers: { origin: "https://app.invalid" },
      });
      assert.equal(preflight.response.status, 503);
      assert.equal(preflight.json.error, "config_unavailable");
      assert.equal(preflight.response.headers.get("access-control-allow-origin"), "https://app.invalid");
      const blocked = await request(origin, "/v1/points/config", {
        headers: { origin: "https://app.invalid" },
      });
      assert.equal(blocked.response.status, 429);
      assert.equal(blocked.json.error, "rate_limited");
      assert.equal(blocked.response.headers.get("access-control-allow-origin"), "https://app.invalid");
      assert.equal(blocked.response.headers.get("retry-after") != null, true);
      assert.equal(lines.filter((line) => line.includes("config_unavailable")).length, 1);
    } finally {
      console.error = original;
      if (running) await running.stop();
    }
  });

  it("counts a 503 when the read module fails to load", async () => {
    const lines = [];
    const original = console.error;
    console.error = (line) => lines.push(String(line));
    const env = {
      CHAIN_ID: "84532",
      POINTS_DB_PATH: ":memory:",
      POINTS_POLL_MS: "60000",
      POINTS_LOG_RANGE: "10",
      POINTS_CORS_ORIGINS: "https://app.invalid",
      POINTS_READ_RATE_PER_MINUTE: "2",
    };
    let running;
    try {
      running = await start({
        once: true,
        serve: true,
        port: 0,
        env,
        paceNow: () => 0,
        sleep: async () => {},
        readApiImport() {
          throw new Error("load failed");
        },
        rpc: {
          async chainId() {
            return 84532;
          },
          async getCode() {
            return "0x6001600055";
          },
          async finalizedBlockNumber() {
            return ESCROW_START_BLOCK;
          },
          async getLogs() {
            return [];
          },
        },
      });
      const health = await fetch(running.healthUrl);
      assert.equal(health.status, 200);
      await health.text();
      env.POINTS_ENABLED = "true";
      const origin = running.healthUrl.replace(/\/health$/, "");
      const allowed = await request(origin, "/v1/points/config", {
        headers: { origin: "https://app.invalid" },
      });
      assert.equal(allowed.response.status, 503);
      assert.equal(allowed.json.error, "config_unavailable");
      assert.equal(allowed.response.headers.get("access-control-allow-origin"), "https://app.invalid");
      assert.equal(allowed.response.headers.get("vary"), "Origin");
      const other = await request(origin, "/v1/points/config", {
        headers: { origin: "https://other.invalid" },
      });
      assert.equal(other.response.status, 503);
      assert.equal(other.response.headers.get("access-control-allow-origin"), null);
      const blocked = await request(origin, "/v1/points/config", {
        headers: { origin: "https://app.invalid" },
      });
      assert.equal(blocked.response.status, 429);
      assert.equal(blocked.json.error, "rate_limited");
      assert.equal(blocked.response.headers.get("access-control-allow-origin"), "https://app.invalid");
      assert.equal(blocked.response.headers.get("retry-after") != null, true);
      const still = await fetch(running.healthUrl);
      assert.equal(still.status, 200);
      await still.text();
      assert.equal(lines.filter((line) => line.includes("config_unavailable")).length, 1);
    } finally {
      console.error = original;
      if (running) await running.stop();
    }
  });

  it("keys the pre-load limiter by the hop count and the ingress header", async () => {
    const original = console.error;
    console.error = () => {};
    const baseEnv = {
      CHAIN_ID: "84532",
      POINTS_DB_PATH: ":memory:",
      POINTS_POLL_MS: "60000",
      POINTS_LOG_RANGE: "10",
      POINTS_ENABLED: "true",
      POINTS_READ_RATE_PER_MINUTE: "1",
    };
    const rpc = {
      async chainId() {
        return 84532;
      },
      async getCode() {
        return "0x6001600055";
      },
      async finalizedBlockNumber() {
        return ESCROW_START_BLOCK;
      },
      async getLogs() {
        return [];
      },
    };
    async function boot(extra) {
      return start({
        once: true,
        serve: true,
        port: 0,
        env: { ...baseEnv, ...extra },
        paceNow: () => 0,
        sleep: async () => {},
        readApiFactory() {
          throw new Error("config_unavailable");
        },
        rpc,
      });
    }
    let running;
    try {
      running = await boot({ POINTS_TRUSTED_PROXY_HOPS: "1" });
      const origin = running.healthUrl.replace(/\/health$/, "");
      const first = await request(origin, "/v1/points/config", {
        headers: { "x-forwarded-for": "203.0.113.5" },
      });
      const second = await request(origin, "/v1/points/config", {
        headers: { "x-forwarded-for": "203.0.113.6" },
      });
      const again = await request(origin, "/v1/points/config", {
        headers: { "x-forwarded-for": "203.0.113.5" },
      });
      assert.equal(first.response.status, 503);
      assert.equal(second.response.status, 503);
      assert.equal(again.response.status, 429);
      await running.stop();
      running = await boot({ POINTS_TRUSTED_PROXY_HOPS: "0" });
      const shared = running.healthUrl.replace(/\/health$/, "");
      const socketA = await request(shared, "/v1/points/config", {
        headers: { "x-forwarded-for": "203.0.113.7" },
      });
      const socketB = await request(shared, "/v1/points/config", {
        headers: { "x-forwarded-for": "203.0.113.8" },
      });
      assert.equal(socketA.response.status, 503);
      assert.equal(socketB.response.status, 429);
      await running.stop();
      running = await boot({ POINTS_CLOUDFLARE_INGRESS: "true" });
      const ingress = running.healthUrl.replace(/\/health$/, "");
      const cfA = await request(ingress, "/v1/points/config", {
        headers: { "cf-connecting-ip": "203.0.113.9" },
      });
      const cfB = await request(ingress, "/v1/points/config", {
        headers: { "cf-connecting-ip": "203.0.113.10" },
      });
      const cfAgain = await request(ingress, "/v1/points/config", {
        headers: { "cf-connecting-ip": "203.0.113.9" },
      });
      assert.equal(cfA.response.status, 503);
      assert.equal(cfB.response.status, 503);
      assert.equal(cfAgain.response.status, 429);
    } finally {
      console.error = original;
      if (running) await running.stop();
    }
  });

  it("reads CF-Connecting-IP only when Cloudflare ingress is declared", async () => {
    const input = {
      remoteAddress: "127.0.0.1",
      headers: { "cf-connecting-ip": "10.9.9.9", "x-forwarded-for": "10.8.8.8" },
    };
    assert.equal(clientIp(input, 0), "127.0.0.1");
    assert.equal(clientIp(input, 0, { cloudflareIngress: true }), "10.9.9.9");
    await withServer({
      enabled: () => true,
      config: { ratePerMinute: 1, cloudflareIngress: true },
    }, async (base) => {
      const first = await request(base, "/v1/points/config", {
        headers: { "cf-connecting-ip": "10.9.9.9" },
      });
      const other = await request(base, "/v1/points/config", {
        headers: { "cf-connecting-ip": "10.9.9.8" },
      });
      assert.equal(first.response.status, 200);
      assert.equal(other.response.status, 200);
    });
  });

  it("keeps a stale ledger on the read API after a window commit", async () => {
    let head = ESCROW_START_BLOCK - 1;
    let failRebuild = true;
    const block = ESCROW_START_BLOCK + 4;
    const log = createdLog({
      escrowId: `0x${"44".repeat(32)}`,
      payer: "0x1111111111111111111111111111111111111111",
      payee: "0x2222222222222222222222222222222222222222",
      expiresAt: 100,
      blockNumber: block,
      logIndex: 1,
      txHash: `0x${"c3".repeat(32)}`,
      timestamp: 21_100 * 86400,
    });
    const env = {
      CHAIN_ID: "84532",
      POINTS_DB_PATH: ":memory:",
      POINTS_POLL_MS: "60000",
      POINTS_LOG_RANGE: "10",
      POINTS_ENABLED: "true",
    };
    const running = await start({
      once: true,
      serve: true,
      port: 0,
      env,
      onIndexer(indexer) {
        const original = indexer.rebuild.bind(indexer);
        indexer.rebuild = () => {
          if (failRebuild) throw new Error("rebuild failed");
          return original();
        };
      },
      rpc: {
        async chainId() {
          return 84532;
        },
        async getCode() {
          return "0x6001600055";
        },
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs(args) {
          if (args.fromBlock <= block && args.toBlock >= block) return [log];
          return [];
        },
      },
    });
    try {
      const origin = running.healthUrl.replace(/\/health$/, "");
      head = block;
      await assert.rejects(() => running.pass(), /rebuild failed/);
      const failed = await request(origin, `/v1/points/${ADDRESS}`);
      assert.equal(failed.json.stale, true);
      head = ESCROW_START_BLOCK + 20;
      await assert.rejects(() => running.pass(), /rebuild failed/);
      const still = await request(origin, `/v1/points/${ADDRESS}`);
      assert.equal(still.json.stale, true);
      failRebuild = false;
      const healed = await running.pass();
      assert.equal(healed.ok, true);
      const fresh = await request(origin, `/v1/points/${ADDRESS}`);
      assert.equal(fresh.json.stale, false);
    } finally {
      await running.stop();
    }
  });

  function keyIp(n) {
    return `127.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
  }

  function httpResult(url, headers) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(url, { headers, agent: false }, (res) => {
        res.resume();
        res.on("end", () => resolve({
          status: res.statusCode,
          retry: res.headers["retry-after"] ?? null,
          acao: res.headers["access-control-allow-origin"] ?? null,
        }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  async function fillKeys(url, start, count) {
    const width = 64;
    for (let n = start; n < start + count; n += width) {
      const end = Math.min(start + count, n + width);
      const batch = [];
      for (let i = n; i < end; i += 1) {
        batch.push(httpResult(url, { "x-forwarded-for": keyIp(i) }));
      }
      const rows = await Promise.all(batch);
      for (const row of rows) assert.equal(row.status, 503);
    }
  }

  const fallbackRpc = {
    async chainId() {
      return 84532;
    },
    async getCode() {
      return "0x6001600055";
    },
    async finalizedBlockNumber() {
      return ESCROW_START_BLOCK;
    },
    async getLogs() {
      return [];
    },
  };

  async function withFallback(env, hooks, fn) {
    const original = console.error;
    console.error = () => {};
    let running;
    try {
      running = await start({
        once: true,
        serve: true,
        port: 0,
        env,
        paceNow: () => 0,
        sleep: async () => {},
        readApiImport() {
          throw new Error("load failed");
        },
        rpc: fallbackRpc,
        ...hooks,
      });
      const origin = running.healthUrl.replace(/\/health$/, "");
      await fn(origin, running);
    } finally {
      console.error = original;
      if (running) await running.stop();
    }
  }

  it("parses the fallback rate the same way as the read API, including unset and invalid", async () => {
    const expectedRates = [
      [undefined, 60],
      [null, 60],
      ["", 60],
      ["   ", 60],
      ["abc", 60],
      ["1e2", 60],
      ["08", 60],
      ["0", 60],
      ["2", 2],
      ["60", 60],
    ];
    for (const [value, expected] of expectedRates) {
      assert.equal(parseRatePerMinute(value), expected);
      assert.equal(readRatePerMinute(value), expected);
    }
    const base = {
      CHAIN_ID: "84532",
      POINTS_DB_PATH: ":memory:",
      POINTS_POLL_MS: "60000",
      POINTS_LOG_RANGE: "10",
      POINTS_ENABLED: "true",
    };
    for (const rate of [undefined, "abc", "1e2", "08"]) {
      const env = { ...base };
      if (rate != null) env.POINTS_READ_RATE_PER_MINUTE = rate;
      await withFallback(env, {}, async (origin) => {
        const url = `${origin}/v1/points/config`;
        for (let i = 0; i < 60; i += 1) {
          assert.equal((await httpResult(url)).status, 503);
        }
        assert.equal((await httpResult(url)).status, 429);
      });
    }
  });

  it("expires a fallback window on the 60 second boundary and reports Retry-After", async () => {
    let now = 5_000_000;
    const env = {
      CHAIN_ID: "84532",
      POINTS_DB_PATH: ":memory:",
      POINTS_POLL_MS: "60000",
      POINTS_LOG_RANGE: "10",
      POINTS_ENABLED: "true",
      POINTS_READ_RATE_PER_MINUTE: "1",
    };
    await withFallback(env, { fallbackNow: () => now }, async (origin) => {
      const url = `${origin}/v1/points/config`;
      assert.equal((await httpResult(url)).status, 503);
      const blocked = await httpResult(url);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.retry, "60");
      now += 20_000;
      const later = await httpResult(url);
      assert.equal(later.status, 429);
      assert.equal(later.retry, "40");
      now += 39_999;
      const edge = await httpResult(url);
      assert.equal(edge.status, 429);
      assert.equal(edge.retry, "1");
      now += 1;
      assert.equal((await httpResult(url)).status, 503);
    });
  });

  it("does not lock out a new fallback key after the window when the map is full", async () => {
    let now = 5_000_000;
    const env = {
      CHAIN_ID: "84532",
      POINTS_DB_PATH: ":memory:",
      POINTS_POLL_MS: "60000",
      POINTS_LOG_RANGE: "10",
      POINTS_ENABLED: "true",
      POINTS_READ_RATE_PER_MINUTE: "1",
      POINTS_TRUSTED_PROXY_HOPS: "1",
    };
    await withFallback(env, { fallbackNow: () => now }, async (origin, running) => {
      const url = `${origin}/v1/points/config`;
      await fillKeys(url, 0, DEFAULT_MAX_ENTRIES);
      const refused = await httpResult(url, { "x-forwarded-for": keyIp(DEFAULT_MAX_ENTRIES) });
      assert.equal(refused.status, 429);
      const resident = await httpResult(url, { "x-forwarded-for": keyIp(0) });
      assert.equal(resident.status, 429);
      now += 60_000;
      const admitted = await httpResult(url, { "x-forwarded-for": keyIp(DEFAULT_MAX_ENTRIES + 1) });
      assert.equal(admitted.status, 503);
      const health = await httpResult(running.healthUrl);
      assert.equal(health.status, 200);
    });
  });

  it("evicts the least recently seen under-limit fallback key and keeps one at its limit", () => {
    let now = 1_000;
    const limiter = createFallbackLimiter({
      clock: () => now,
      rate: () => 3,
    });
    assert.equal(limiter.allow(keyIp(0)).ok, true);
    assert.equal(limiter.allow(keyIp(1)).ok, true);
    assert.equal(limiter.allow(keyIp(1)).ok, true);
    assert.equal(limiter.allow(keyIp(1)).ok, true);
    assert.equal(limiter.allow(keyIp(1)).ok, false);
    for (let i = 2; i < DEFAULT_MAX_ENTRIES; i += 1) {
      assert.equal(limiter.allow(keyIp(i)).ok, true);
    }
    for (let i = 2; i < DEFAULT_MAX_ENTRIES; i += 1) {
      assert.equal(limiter.allow(keyIp(i)).ok, true);
    }
    assert.equal(limiter.size(), DEFAULT_MAX_ENTRIES);
    assert.equal(limiter.allow(keyIp(DEFAULT_MAX_ENTRIES)).ok, true);
    assert.equal(limiter.size(), DEFAULT_MAX_ENTRIES);
    assert.equal(limiter.allow(keyIp(1)).ok, false);
    assert.equal(limiter.allow(keyIp(0)).ok, true);
    assert.equal(limiter.allow(keyIp(0)).ok, true);
    assert.equal(limiter.allow(keyIp(0)).ok, true);
    assert.equal(limiter.allow(keyIp(0)).ok, false);
  });

  it("keeps the fallback map at the cap while evicting", () => {
    let now = 1_000;
    const limiter = createFallbackLimiter({
      clock: () => now,
      rate: () => 2,
    });
    for (let i = 0; i < DEFAULT_MAX_ENTRIES; i += 1) {
      assert.equal(limiter.allow(keyIp(i)).ok, true);
    }
    for (let i = 0; i < DEFAULT_MAX_ENTRIES; i += 1) {
      assert.equal(limiter.allow(keyIp(DEFAULT_MAX_ENTRIES + i)).ok, true);
      assert.ok(limiter.size() <= DEFAULT_MAX_ENTRIES, `size ${limiter.size()}`);
    }
  });

  it("keeps the fallback map at the cap after keys expire and the map refills", () => {
    let now = 1_000;
    const limiter = createFallbackLimiter({
      clock: () => now,
      rate: () => 2,
    });
    for (let i = 0; i < DEFAULT_MAX_ENTRIES; i += 1) {
      assert.equal(limiter.allow(keyIp(i)).ok, true);
    }
    now += 60_000;
    const extra = DEFAULT_MAX_ENTRIES + 8192;
    for (let i = 0; i < extra; i += 1) {
      assert.equal(limiter.allow(keyIp(DEFAULT_MAX_ENTRIES + i)).ok, true);
      assert.ok(limiter.size() <= DEFAULT_MAX_ENTRIES, `size ${limiter.size()}`);
    }
  });

  it("admits a new fallback key when an at-limit key is the oldest idle entry", () => {
    const capFirst = createFallbackLimiter({
      clock: () => 1_000,
      rate: () => 3,
    });
    assert.equal(capFirst.allow(keyIp(0)).ok, true);
    assert.equal(capFirst.allow(keyIp(0)).ok, true);
    assert.equal(capFirst.allow(keyIp(0)).ok, true);
    for (let i = 1; i < DEFAULT_MAX_ENTRIES; i += 1) {
      assert.equal(capFirst.allow(keyIp(i)).ok, true);
    }
    assert.equal(capFirst.size(), DEFAULT_MAX_ENTRIES);
    assert.equal(capFirst.allow(keyIp(DEFAULT_MAX_ENTRIES)).ok, true);
    assert.equal(capFirst.size(), DEFAULT_MAX_ENTRIES);
    assert.equal(capFirst.allow(keyIp(0)).ok, false);

    const refused = createFallbackLimiter({
      clock: () => 1_000,
      rate: () => 3,
    });
    for (let i = 0; i < DEFAULT_MAX_ENTRIES; i += 1) {
      assert.equal(refused.allow(keyIp(i)).ok, true);
    }
    assert.equal(refused.allow(keyIp(0)).ok, true);
    assert.equal(refused.allow(keyIp(0)).ok, true);
    assert.equal(refused.allow(keyIp(0)).ok, false);
    for (let i = 1; i < DEFAULT_MAX_ENTRIES; i += 1) {
      assert.equal(refused.allow(keyIp(i)).ok, true);
    }
    assert.equal(refused.size(), DEFAULT_MAX_ENTRIES);
    assert.equal(refused.allow(keyIp(DEFAULT_MAX_ENTRIES)).ok, true);
    assert.equal(refused.size(), DEFAULT_MAX_ENTRIES);
    assert.equal(refused.allow(keyIp(0)).ok, false);
  });

  it("sweeps a full map of under-limit fallback keys once when they expire and not again after the refill", () => {
    let now = 10_000;
    const limiter = createFallbackLimiter({
      clock: () => now,
      rate: () => 2,
    });
    for (let i = 0; i < DEFAULT_MAX_ENTRIES; i += 1) {
      assert.equal(limiter.allow(keyIp(i)).ok, true);
    }
    const before = limiter.sweeps();
    const extra = 48;
    for (let i = 0; i < extra; i += 1) {
      assert.equal(limiter.allow(keyIp(DEFAULT_MAX_ENTRIES + i)).ok, true);
    }
    assert.ok(limiter.sweeps() - before <= 1, `sweeps ${limiter.sweeps() - before}`);
    assert.ok(limiter.size() <= DEFAULT_MAX_ENTRIES, `size ${limiter.size()}`);
    now += 60_000;
    const mid = limiter.sweeps();
    for (let i = 0; i < extra; i += 1) {
      assert.equal(limiter.allow(keyIp(DEFAULT_MAX_ENTRIES + extra + i)).ok, true);
    }
    assert.ok(limiter.sweeps() - mid <= 1, `sweeps ${limiter.sweeps() - mid}`);
    assert.equal(limiter.size(), extra);
    const swept = limiter.sweeps();
    const refillStart = DEFAULT_MAX_ENTRIES + extra * 2;
    const refill = DEFAULT_MAX_ENTRIES - extra;
    for (let i = 0; i < refill; i += 1) {
      assert.equal(limiter.allow(keyIp(refillStart + i)).ok, true);
    }
    assert.equal(limiter.size(), DEFAULT_MAX_ENTRIES);
    assert.equal(limiter.sweeps(), swept);
    for (let i = 0; i < extra; i += 1) {
      assert.equal(limiter.allow(keyIp(refillStart + refill + i)).ok, true);
      assert.ok(limiter.size() <= DEFAULT_MAX_ENTRIES, `size ${limiter.size()}`);
    }
    assert.equal(limiter.sweeps(), swept);
  });

  it("admits a new fallback key after an at-limit map expires, refills, and one more window elapses", () => {
    let now = 1_000_000;
    const limiter = createFallbackLimiter({
      clock: () => now,
      rate: () => 1,
    });
    for (let i = 0; i < DEFAULT_MAX_ENTRIES; i += 1) {
      assert.equal(limiter.allow(keyIp(i)).ok, true);
    }
    assert.equal(limiter.size(), DEFAULT_MAX_ENTRIES);
    now += 60_000;
    for (let i = 0; i < DEFAULT_MAX_ENTRIES; i += 1) {
      assert.equal(limiter.allow(keyIp(DEFAULT_MAX_ENTRIES + i)).ok, true);
    }
    assert.equal(limiter.size(), DEFAULT_MAX_ENTRIES);
    now += 60_000;
    assert.equal(limiter.allow(keyIp(DEFAULT_MAX_ENTRIES * 2)).ok, true);
  });

  it("sweeps a full at-limit fallback map at most once for many new keys in that window", () => {
    const limiter = createFallbackLimiter({
      clock: () => 2_000_000,
      rate: () => 1,
    });
    for (let i = 0; i < DEFAULT_MAX_ENTRIES; i += 1) {
      assert.equal(limiter.allow(keyIp(i)).ok, true);
    }
    assert.equal(limiter.size(), DEFAULT_MAX_ENTRIES);
    const before = limiter.sweeps();
    const extra = 256;
    for (let i = 0; i < extra; i += 1) {
      assert.equal(limiter.allow(keyIp(DEFAULT_MAX_ENTRIES + i)).ok, false);
    }
    assert.ok(limiter.sweeps() - before <= 1, `sweeps ${limiter.sweeps() - before}`);
    assert.equal(limiter.size(), DEFAULT_MAX_ENTRIES);
  });

  it("does not sweep again before the next expiry after a sweep that leaves fallback keys live", () => {
    let now = 3_000_000;
    const limiter = createFallbackLimiter({
      clock: () => now,
      rate: () => 1,
    });
    const early = 8;
    for (let i = 0; i < early; i += 1) {
      assert.equal(limiter.allow(keyIp(i)).ok, true);
    }
    now += 30_000;
    for (let i = early; i < DEFAULT_MAX_ENTRIES; i += 1) {
      assert.equal(limiter.allow(keyIp(i)).ok, true);
    }
    assert.equal(limiter.size(), DEFAULT_MAX_ENTRIES);
    now += 30_000;
    const opened = limiter.sweeps();
    assert.equal(limiter.allow(keyIp(DEFAULT_MAX_ENTRIES)).ok, true);
    const afterSweep = limiter.sweeps();
    assert.equal(afterSweep, opened + 1);
    for (let i = 1; i < early; i += 1) {
      assert.equal(limiter.allow(keyIp(DEFAULT_MAX_ENTRIES + i)).ok, true);
    }
    assert.equal(limiter.size(), DEFAULT_MAX_ENTRIES);
    assert.equal(limiter.sweeps(), afterSweep);
    const extra = 32;
    for (let i = 0; i < extra; i += 1) {
      assert.equal(limiter.allow(keyIp(DEFAULT_MAX_ENTRIES + early + i)).ok, false);
    }
    assert.equal(limiter.sweeps(), afterSweep);
    assert.equal(limiter.allow(keyIp(early)).ok, false);
  });

  it("rejects a non-https origin, a tailed origin, and accepts one trailing slash", async () => {
    const samples = [
      ["http://app.invalid", { ok: false }],
      ["ftp://app.invalid", { ok: false }],
      ["javascript://app.invalid", { ok: false }],
      ["https://app.invalid/path", { ok: false }],
      ["https://app.invalid?x=1", { ok: false }],
      ["https://app.invalid#frag", { ok: false }],
      ["https://app.invalid/", { ok: true, origin: "https://app.invalid" }],
    ];
    for (const [raw, expected] of samples) {
      assert.deepEqual(edgeOrigin(raw), expected);
      assert.deepEqual(parseExactHttpsOrigin(raw), expected);
    }
    const env = {
      CHAIN_ID: "84532",
      POINTS_DB_PATH: ":memory:",
      POINTS_POLL_MS: "60000",
      POINTS_LOG_RANGE: "10",
      POINTS_ENABLED: "true",
      POINTS_CORS_ORIGINS: "https://app.invalid",
      POINTS_READ_RATE_PER_MINUTE: "20",
    };
    await withFallback(env, {}, async (origin) => {
      const url = `${origin}/v1/points/config`;
      for (const [raw, expected] of samples) {
        const row = await httpResult(url, { origin: raw });
        assert.equal(row.status, 503);
        assert.equal(row.acao, expected.ok ? "https://app.invalid" : null);
      }
    });
  });

  it("keys a failed read-module load by the hop count and ignores X-Forwarded-For at hop 0", async () => {
    const base = {
      CHAIN_ID: "84532",
      POINTS_DB_PATH: ":memory:",
      POINTS_POLL_MS: "60000",
      POINTS_LOG_RANGE: "10",
      POINTS_ENABLED: "true",
      POINTS_READ_RATE_PER_MINUTE: "1",
    };
    await withFallback({ ...base, POINTS_TRUSTED_PROXY_HOPS: "0" }, {}, async (origin) => {
      const url = `${origin}/v1/points/config`;
      const first = await httpResult(url, { "x-forwarded-for": "127.0.0.5" });
      const second = await httpResult(url, { "x-forwarded-for": "127.0.0.6" });
      assert.equal(first.status, 503);
      assert.equal(second.status, 429);
    });
    await withFallback({ ...base, POINTS_TRUSTED_PROXY_HOPS: "1" }, {}, async (origin) => {
      const url = `${origin}/v1/points/config`;
      const first = await httpResult(url, { "x-forwarded-for": "127.0.0.5" });
      const second = await httpResult(url, { "x-forwarded-for": "127.0.0.6" });
      const again = await httpResult(url, { "x-forwarded-for": "127.0.0.5" });
      assert.equal(first.status, 503);
      assert.equal(second.status, 503);
      assert.equal(again.status, 429);
    });
    await withFallback({ ...base, POINTS_CLOUDFLARE_INGRESS: "true" }, {}, async (origin) => {
      const url = `${origin}/v1/points/config`;
      const first = await httpResult(url, { "cf-connecting-ip": "127.0.0.9" });
      const second = await httpResult(url, { "cf-connecting-ip": "127.0.0.10" });
      const again = await httpResult(url, { "cf-connecting-ip": "127.0.0.9" });
      assert.equal(first.status, 503);
      assert.equal(second.status, 503);
      assert.equal(again.status, 429);
    });
  });

  it("tells the operator to restart after a read module load failure", () => {
    const section = readFileSync(README_FILE, "utf8").split("## Read API")[1].split("## What it stores")[0];
    assert.match(section, /configFailed/);
    assert.match(section, /evaluation error/);
    assert.match(section, /GET \/health` stays `200/);
    assert.match(section, /until the process restarts/);
  });
});
