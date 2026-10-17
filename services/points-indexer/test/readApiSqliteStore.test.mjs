import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ESCROW, ESCROW_START_BLOCK } from "../src/constants.mjs";
import { openIndexer } from "../src/indexer.mjs";
import { createReadApi } from "../src/readApi.mjs";
import { createReadApiSqliteStore } from "../src/readApiSqliteStore.mjs";
import { account, createdLog, creditCandidate } from "./support.mjs";

const POINTS_FILE = fileURLToPath(new URL("../config/points.json", import.meta.url));
const ADAPTER_SOURCE = fileURLToPath(new URL("../src/readApiSqliteStore.mjs", import.meta.url));
const ADDRESS = "0x1111111111111111111111111111111111111111";
const PAGE_WALLET = "0x00000000000000000000000000000000000000a1";

const FORBIDDEN_KEYS = new Set([
  "identity_anchor",
  "behavioral_signals",
  "model_version",
  "entries_json",
  "signature",
  "nonce",
  "raw_logs",
  "source_tx_hash",
  "source_action",
  "source_log_index",
  "seq",
  "wallet",
  "chain_id",
  "eligibility_status",
]);

function sourceFrom(indexer, passCompleted = true) {
  return {
    db: () => indexer?.db ?? null,
    lastScannedBlock: () => (indexer ? indexer.lastScannedBlock() : null),
    finalizedBlock: () => (indexer ? indexer.finalizedBlock : null),
    passCompleted: () => passCompleted,
  };
}

async function withServer(store, fn) {
  const api = createReadApi({
    store,
    enabled: () => true,
    config: { ratePerMinute: 50 },
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

async function request(base, path) {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  return { response, text, json: text ? JSON.parse(text) : null };
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
  return { indexer, wallet };
}

/**
 * Same direct INSERT as insertPage. Points are non-zero on purpose.
 * The public credit path rebuilds ledger_rows and rowFrom stores 0, so
 * this seed does not go through that writer.
 */
function insertCommitted(db, row) {
  db.prepare(
    `INSERT INTO ledger_rows(
       seq, chain_id, contract, tx_hash, log_index, block_number, block_timestamp, utc_day,
       wallet, action, escrow_id, points, eligibility_status, eligibility_reason, points_withheld,
       rule_weight, counts_for_return_day, register_status, dispute_id, support,
       source_action, source_tx_hash, source_log_index
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.seq,
    84532,
    ESCROW,
    row.txHash,
    row.seq,
    ESCROW_START_BLOCK + row.seq,
    1_700_000_000 + row.seq,
    row.utcDay,
    row.wallet,
    row.action,
    `0x${"11".repeat(32)}`,
    row.points,
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

describe("points read sqlite adapter", { concurrency: false }, () => {
  it("reads draft config from the points file", () => {
    const file = JSON.parse(readFileSync(POINTS_FILE, "utf8"));
    const store = createReadApiSqliteStore({ db: () => null });
    const config = store.getConfig();
    assert.equal(config.rule_version, null);
    assert.deepEqual(config.weights, file.weights);
    assert.deepEqual(config.gates, file.gates);
    assert.ok(Object.values(config.weights).every((value) => value === null));
    assert.ok(Object.values(config.gates).every((value) => value === null));
  });

  it("returns empty reads when the database handle is missing", () => {
    const store = createReadApiSqliteStore({ db: () => null });
    assert.deepEqual(store.getCursor(), {
      last_scanned_block: null,
      finalized_block: null,
      pass_completed: false,
    });
    assert.deepEqual(store.getLedgerSummary(ADDRESS), {
      points_total: 0,
      rows_count: 0,
      first_activity_utc_day: null,
    });
    assert.deepEqual(store.listLedgerRows(ADDRESS, { limit: 25, afterSeq: 0 }), []);
  });

  it("sums committed points and keeps private columns out of the response", async () => {
    const ctx = await committedLedger();
    try {
      const store = createReadApiSqliteStore(sourceFrom(ctx.indexer, true));
      const summary = store.getLedgerSummary(ctx.wallet);
      assert.equal(summary.points_total, 8);
      assert.equal(summary.rows_count, 2);
      assert.equal(summary.first_activity_utc_day, 20_000);
      const stored = store.listLedgerRows(ctx.wallet, { limit: 10, afterSeq: 0 });
      assert.equal(stored.length, 2);
      assert.equal(stored[0].source_tx_hash, "sentinel-source-77ab");
      const signature = ctx.indexer.db.prepare("SELECT signature FROM links").get().signature;
      const nonce = ctx.indexer.db.prepare("SELECT nonce FROM nonces").get().nonce;
      await withServer(store, async (base) => {
        const body = await request(base, `/v1/points/${ctx.wallet}?chainId=84532`);
        assert.equal(body.response.status, 200);
        assert.equal(body.json.points_total, 8);
        assert.equal(body.json.rows_count, 2);
        assert.equal(body.json.points_withheld, true);
        assert.equal(body.json.indexed_to_block, 100_000_000);
        const history = await request(base, `/v1/points/${ctx.wallet}/history?chainId=84532`);
        assert.equal(history.json.items.length, 2);
        assert.equal(history.json.items[0].points_withheld, true);
        assert.equal(history.json.items.reduce((sum, item) => sum + item.points, 0), 8);
        const found = [];
        walkKeys(body.json, found);
        walkKeys(history.json, found);
        assert.deepEqual(found, []);
        const joined = `${body.text}\n${history.text}`;
        for (const sentinel of [
          "sentinel-source-77ab",
          "sentinel-model-9c2e",
          "sentinel-chain-b31d",
          "sentinel-rawlog-4e8b",
          "sentinel-link-55d0",
          signature,
          nonce,
        ]) {
          assert.equal(joined.includes(sentinel), false, sentinel);
        }
      });
    } finally {
      ctx.indexer.close();
    }
  });

  it("pages ledger rows with a keyset cursor", async () => {
    const indexer = openIndexer({ path: ":memory:", finalizedBlock: ESCROW_START_BLOCK + 200 });
    insertPage(indexer.db, PAGE_WALLET, 101);
    try {
      const store = createReadApiSqliteStore(sourceFrom(indexer, true));
      const page = store.listLedgerRows(PAGE_WALLET, { limit: 100, afterSeq: 0 });
      assert.equal(page.length, 100);
      assert.equal(page[99].seq, 100);
      const rest = store.listLedgerRows(PAGE_WALLET, { limit: 25, afterSeq: 100 });
      assert.equal(rest.length, 1);
      assert.equal(rest[0].tx_hash, txHash(101));
      await withServer(store, async (base) => {
        const clamped = await request(base, `/v1/points/${PAGE_WALLET}/history?chainId=84532&limit=101`);
        assert.equal(clamped.response.status, 200);
        assert.equal(clamped.json.items.length, 100);
        assert.equal(clamped.json.next_cursor, "100");
        const next = await request(base, `/v1/points/${PAGE_WALLET}/history?chainId=84532&cursor=100`);
        assert.equal(next.json.items.length, 1);
        assert.equal(next.json.items[0].tx_hash, txHash(101));
        assert.equal(next.json.next_cursor, null);
      });
    } finally {
      indexer.close();
    }
  });

  it("reports the scan cursor separately from the finalized head", () => {
    const indexer = openIndexer({ path: ":memory:", finalizedBlock: ESCROW_START_BLOCK + 1000 });
    try {
      indexer.commitScanWindow([], ESCROW_START_BLOCK + 25);
      const store = createReadApiSqliteStore(sourceFrom(indexer, true));
      assert.deepEqual(store.getCursor(), {
        last_scanned_block: ESCROW_START_BLOCK + 25,
        finalized_block: ESCROW_START_BLOCK + 1000,
        pass_completed: true,
      });
    } finally {
      indexer.close();
    }
  });

  it("keeps one wallet's points, first activity, and history off the other wallet", async () => {
    const walletA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const walletB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const indexer = openIndexer({ path: ":memory:", finalizedBlock: ESCROW_START_BLOCK + 200 });
    const rows = [
      { seq: 1, wallet: walletA, action: "fund", points: 3, utcDay: 20_001, txHash: txHash(1) },
      { seq: 2, wallet: walletA, action: "first_activity", points: 5, utcDay: 20_002, txHash: txHash(2) },
      { seq: 3, wallet: walletB, action: "fund", points: 7, utcDay: 20_010, txHash: txHash(3) },
      { seq: 4, wallet: walletB, action: "first_activity", points: 11, utcDay: 20_011, txHash: txHash(4) },
    ];
    for (const row of rows) insertCommitted(indexer.db, row);
    try {
      const store = createReadApiSqliteStore(sourceFrom(indexer, true));
      const summaryA = store.getLedgerSummary(walletA);
      const summaryB = store.getLedgerSummary(walletB);
      assert.equal(summaryA.points_total, 8);
      assert.equal(summaryA.rows_count, 2);
      assert.equal(summaryA.first_activity_utc_day, 20_002);
      assert.equal(summaryB.points_total, 18);
      assert.equal(summaryB.rows_count, 2);
      assert.equal(summaryB.first_activity_utc_day, 20_011);
      const historyA = store.listLedgerRows(walletA, { limit: 25, afterSeq: 0 }).map((row) => row.tx_hash);
      const historyB = store.listLedgerRows(walletB, { limit: 25, afterSeq: 0 }).map((row) => row.tx_hash);
      assert.deepEqual(historyA, [txHash(1), txHash(2)]);
      assert.deepEqual(historyB, [txHash(3), txHash(4)]);
      await withServer(store, async (base) => {
        const bodyA = await request(base, `/v1/points/${walletA}?chainId=84532`);
        const bodyB = await request(base, `/v1/points/${walletB}?chainId=84532`);
        assert.equal(bodyA.json.points_total, 8);
        assert.equal(bodyA.json.rows_count, 2);
        assert.equal(bodyA.json.first_activity_utc_day, 20_002);
        assert.equal(bodyB.json.points_total, 18);
        assert.equal(bodyB.json.rows_count, 2);
        assert.equal(bodyB.json.first_activity_utc_day, 20_011);
        const pageA = await request(base, `/v1/points/${walletA}/history?chainId=84532`);
        const pageB = await request(base, `/v1/points/${walletB}/history?chainId=84532`);
        assert.deepEqual(pageA.json.items.map((item) => item.tx_hash), [txHash(1), txHash(2)]);
        assert.deepEqual(pageB.json.items.map((item) => item.tx_hash), [txHash(3), txHash(4)]);
      });
    } finally {
      indexer.close();
    }
  });

  it("keeps the sql in the adapter and out of the other tables", () => {
    const source = readFileSync(ADAPTER_SOURCE, "utf8");
    assert.equal(source.includes("node:sqlite"), false);
    assert.equal(source.includes("SELECT"), true);
    assert.equal(source.includes(".prepare"), true);
    assert.equal(source.includes("raw_logs"), false);
    assert.equal(source.includes("RELAYER_PRIVATE_KEY"), false);
    assert.equal(source.includes("privateKey"), false);
    assert.equal(source.includes("signer"), false);
    assert.equal(source.includes("process.env"), false);
  });
});
