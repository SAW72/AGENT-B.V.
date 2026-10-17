import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ESCROW, ESCROW_START_BLOCK } from "../src/constants.mjs";
import { openIndexer } from "../src/indexer.mjs";
import { loadConfig, start } from "../src/main.mjs";
import {
  bucketClientAddress,
  createRateLimiter,
  createReadApi,
  readApiEnabled,
} from "../src/readApi.mjs";
import { account, createdLog, creditCandidate } from "./support.mjs";

const POINTS_FILE = fileURLToPath(new URL("../config/points.json", import.meta.url));
const READ_SOURCE = fileURLToPath(new URL("../src/readApi.mjs", import.meta.url));
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

function storeFrom(indexer, passCompleted = true) {
  return {
    db: () => indexer.db,
    lastScannedBlock: () => indexer.lastScannedBlock(),
    finalizedBlock: () => indexer.finalizedBlock,
    passCompleted: () => passCompleted,
  };
}

function nullStore() {
  return {
    db: () => null,
    lastScannedBlock: () => null,
    finalizedBlock: () => null,
    passCompleted: () => false,
  };
}

async function withServer(options, fn) {
  const api = createReadApi({
    store: options.store ?? nullStore(),
    config: options.config,
    now: options.now,
    enabled: options.enabled,
  });
  const server = createServer(api);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
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

/**
 * Direct inserts. The public link path rewrites ledger_rows on each rebuild
 * and rowFrom stores points 0, so a 101-row page and a non-zero points sum
 * cannot be produced through that path without the writer replacing them.
 */
function insertPage(db, wallet, count) {
  const insert = db.prepare(
    `INSERT INTO ledger_rows(
       seq, chain_id, contract, tx_hash, log_index, block_number, block_timestamp, utc_day,
       wallet, action, escrow_id, points, eligibility_status, eligibility_reason, points_withheld,
       rule_weight, counts_for_return_day, register_status, dispute_id, support,
       source_action, source_tx_hash, source_log_index
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let index = 1; index <= count; index += 1) {
    insert.run(
      index,
      84532,
      ESCROW,
      txHash(index),
      index,
      ESCROW_START_BLOCK + index,
      1_700_000_000 + index,
      19000 + index,
      wallet,
      "fund",
      `0x${"11".repeat(32)}`,
      0,
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
  }
}

async function committedLedger() {
  const payer = account();
  const payee = account();
  const indexer = openIndexer({ path: ":memory:", finalizedBlock: 100_000_000 });
  const timestamp = 20_000 * 86400;
  const log = createdLog({
    escrowId: `0x${"ab".repeat(32)}`,
    payer: payer.address,
    payee: payee.address,
    expiresAt: timestamp + 10_000,
    blockNumber: 50_000_000,
    logIndex: 4,
    txHash: `0x${"cd".repeat(32)}`,
    timestamp,
  });
  indexer.ingestLogs([log]);
  const wallet = payer.address.toLowerCase();
  const candidate = indexer.attribute().candidates.find((item) => item.wallet === wallet && item.action === "fund");
  assert.ok(candidate, "public attribute path produced a fund candidate");
  const result = await creditCandidate(indexer, payer, candidate);
  assert.equal(result.link?.ok, true, result.link?.reason || result.issued?.reason);
  indexer.commitScanWindow([], indexer.finalizedBlock);
  const rows = indexer.ledger().filter((row) => row.wallet === wallet).sort((left, right) => left.seq - right.seq);
  assert.equal(rows.length, 2);
  const setPoints = indexer.db.prepare("UPDATE ledger_rows SET points = ? WHERE seq = ?");
  setPoints.run(3, rows[0].seq);
  setPoints.run(5, rows[1].seq);
  indexer.db.prepare("UPDATE ledger_rows SET source_tx_hash = ? WHERE seq = ?").run("sentinel-source-77ab", rows[0].seq);
  indexer.db.prepare("UPDATE origins SET model_version = ?").run("sentinel-model-9c2e");
  indexer.db.prepare("UPDATE chains SET entries_json = entries_json || ?").run("sentinel-chain-b31d");
  indexer.db.prepare("UPDATE raw_logs SET block_hash = ?").run("sentinel-rawlog-4e8b");
  indexer.db.prepare("UPDATE links SET signature = signature || ?").run("sentinel-link-55d0");
  return { indexer, wallet, payer };
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
    assert.equal(config.readApiEnabled, false);
    assert.equal(config.ratePerMinute, 60);
    assert.equal(config.trustedProxyHops, 1);
    assert.deepEqual(config.corsOrigins, ["https://agent-bv.pages.dev"]);
    assert.equal(readApiEnabled({}), false);
    assert.equal(readApiEnabled({ POINTS_READ_API_ENABLED: "1" }), true);
    assert.equal(readApiEnabled({ POINTS_READ_API_ENABLED: "true" }), true);
    assert.equal(readApiEnabled({ POINTS_READ_API_ENABLED: "0" }), false);
    assert.equal(loadConfig({ POINTS_TRUSTED_PROXY_HOPS: "0" }).trustedProxyHops, 0);
    assert.equal(loadConfig({ POINTS_TRUSTED_PROXY_HOPS: "2" }).trustedProxyHops, 2);
    assert.equal(loadConfig({ POINTS_TRUSTED_PROXY_HOPS: "nope" }).trustedProxyHops, 1);
    assert.equal(loadConfig({ POINTS_READ_RATE_PER_MINUTE: "15" }).ratePerMinute, 15);
    assert.equal(loadConfig({ POINTS_READ_RATE_PER_MINUTE: "0" }).ratePerMinute, 60);
    assert.deepEqual(
      loadConfig({ POINTS_CORS_ORIGINS: "*,https://agent-bv.pages.dev/,https://example.com" }).corsOrigins,
      ["https://agent-bv.pages.dev", "https://example.com"],
    );
  });

  it("returns 404 for points routes when the read API flag is off", async () => {
    let on = false;
    await withServer({ enabled: () => on, config: { ratePerMinute: 1 } }, async (base) => {
      const hidden = await request(base, "/v1/points/config");
      assert.equal(hidden.response.status, 404);
      assert.deepEqual(hidden.json, { ok: false, error: "not_found" });
      assertJsonNoStore(hidden.response);
      const posted = await request(base, "/v1/points/config", { method: "POST" });
      assert.equal(posted.response.status, 404);
      on = true;
      const shown = await request(base, "/v1/points/config");
      assert.equal(shown.response.status, 200);
    });
    await withServer({ config: { ratePerMinute: 10 } }, async (base) => {
      const hidden = await request(base, `/v1/points/${ADDRESS}`);
      assert.equal(hidden.response.status, 404);
      assert.equal(hidden.json.error, "not_found");
    });
  });

  it("returns draft config for chain 84532 and rejects every other chain id", async () => {
    const file = JSON.parse(readFileSync(POINTS_FILE, "utf8"));
    await withServer({ enabled: () => true, config: { ratePerMinute: 100 } }, async (base) => {
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
    const ctx = await committedLedger();
    try {
      await withServer({
        enabled: () => true,
        store: storeFrom(ctx.indexer, true),
        config: { ratePerMinute: 20 },
      }, async (base) => {
        const mixed = ctx.payer.address.slice(0, 2) + ctx.payer.address.slice(2).toUpperCase();
        const body = await request(base, `/v1/points/${mixed}?chainId=84532`);
        assert.equal(body.response.status, 200);
        assert.equal(body.json.address, ctx.wallet);
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
        const history = await request(base, `/v1/points/${ctx.wallet}/history?chainId=84532`);
        const expected = ctx.indexer.ledger()
          .filter((row) => row.wallet === ctx.wallet)
          .sort((left, right) => left.seq - right.seq)
          .map(expectedItem);
        assert.deepEqual(history.json.items, expected);
        assert.equal(history.json.items.reduce((sum, item) => sum + item.points, 0), 8);
        assert.equal(history.json.next_cursor, null);
      });
    } finally {
      ctx.indexer.close();
    }
  });

  it("private fields never appear in a read response", async () => {
    const ctx = await committedLedger();
    try {
      const signature = ctx.indexer.db.prepare("SELECT signature FROM links").get().signature;
      const nonce = ctx.indexer.db.prepare("SELECT nonce FROM nonces").get().nonce;
      const sentinels = [
        "sentinel-source-77ab",
        "sentinel-model-9c2e",
        "sentinel-chain-b31d",
        "sentinel-rawlog-4e8b",
        "sentinel-link-55d0",
        signature,
        nonce,
      ];
      await withServer({
        enabled: () => true,
        store: storeFrom(ctx.indexer, true),
        config: { ratePerMinute: 20 },
      }, async (base) => {
        const bodies = [];
        for (const path of [
          "/v1/points/config?chainId=84532",
          `/v1/points/${ctx.wallet}?chainId=84532`,
          `/v1/points/${ctx.wallet}/history?chainId=84532&limit=25`,
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
    } finally {
      ctx.indexer.close();
    }
  });

  it("clamps a limit above 100 and rejects 0, negative, and non-numeric limits", async () => {
    const indexer = openIndexer({ path: ":memory:", finalizedBlock: ESCROW_START_BLOCK + 200 });
    insertPage(indexer.db, PAGE_WALLET, 101);
    try {
      await withServer({
        enabled: () => true,
        store: storeFrom(indexer, true),
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
    } finally {
      indexer.close();
    }
  });

  it("indexed_to_block follows the scan cursor", async () => {
    const behind = openIndexer({ path: ":memory:", finalizedBlock: ESCROW_START_BLOCK + 1000 });
    behind.commitScanWindow([], ESCROW_START_BLOCK + 25);
    const idle = openIndexer({ path: ":memory:", finalizedBlock: 10 });
    try {
      await withServer({
        enabled: () => true,
        store: storeFrom(behind, true),
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
        store: storeFrom(idle, false),
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
        store: storeFrom(idle, true),
        config: { ratePerMinute: 10 },
      }, async (base) => {
        const body = await request(base, `/v1/points/${ADDRESS}`);
        assert.equal(body.json.syncing, false);
        assert.equal(body.json.behind, 0);
        assert.equal(body.json.indexed_to_block, null);
      });
      await withServer({
        enabled: () => true,
        store: nullStore(),
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
    } finally {
      behind.close();
      idle.close();
    }
  });

  it("returns 500 from an injected failing store without the thrown detail", async () => {
    const secret = "SECRET https://evil.example/x /tmp/ledger.sqlite";
    const store = {
      db() {
        const error = new Error(secret);
        error.stack = `Error: ${secret}\n    at Object.prepare (/tmp/ledger.sqlite:10:1)`;
        throw error;
      },
      lastScannedBlock() {
        return 4;
      },
      finalizedBlock() {
        return 9;
      },
      passCompleted() {
        return true;
      },
    };
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

  it("does not query raw logs from the read module", () => {
    const source = readFileSync(READ_SOURCE, "utf8");
    assert.equal(source.includes("raw_logs"), false);
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
      const hidden = await request(origin, "/v1/points/config");
      assert.equal(hidden.response.status, 404);
      assert.deepEqual(hidden.json, { ok: false, error: "not_found" });
      env.POINTS_READ_API_ENABLED = "1";
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
      const config = await request(origin, "/v1/points/config?chainId=84532");
      assert.equal(config.response.status, 200);
      assert.equal(config.json.status, "draft");
      assert.equal(config.json.chainId, 84532);
      const caughtUp = await request(origin, `/v1/points/${ADDRESS}?chainId=84532`);
      assert.equal(caughtUp.json.syncing, false);
      assert.equal(caughtUp.json.behind, 0);
      assert.equal(caughtUp.json.indexed_to_block, null);
      assert.equal(caughtUp.json.finalized_block, ESCROW_START_BLOCK - 1);
      const missing = await request(origin, "/nope");
      assert.equal(missing.response.status, 404);
      assert.equal(missing.response.headers.get("content-type"), "text/plain");
      assert.equal(missing.text, "not found");
      env.POINTS_READ_API_ENABLED = "0";
      const off = await request(origin, "/v1/points/config");
      assert.equal(off.response.status, 404);
      assert.equal(off.json.error, "not_found");
      const stillHealthy = await request(origin, "/health");
      assert.deepEqual(stillHealthy.json, { ok: true, chainId: 84532 });
      env.POINTS_READ_API_ENABLED = "1";
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
