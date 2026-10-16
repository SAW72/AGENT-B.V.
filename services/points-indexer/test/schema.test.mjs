import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import { account, createdLog, tempIndexer } from "./support.mjs";

describe("ledger schema", () => {
  it("keeps log_index and block_number non-null and uses the partial unique keys", () => {
    const ctx = tempIndexer();
    try {
      const columns = ctx.indexer.db.prepare("PRAGMA table_info(ledger_rows)").all();
      for (const name of ["log_index", "block_number", "chain_id", "contract", "tx_hash", "wallet", "action"]) {
        const column = columns.find((row) => row.name === name);
        assert.equal(column.notnull, 1, name);
      }
      const indexes = ctx.indexer.db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
      ).all();
      const logKey = indexes.find((row) => row.name === "ledger_log_key");
      const first = indexes.find((row) => row.name === "ledger_first_activity");
      const back = indexes.find((row) => row.name === "ledger_return_day");
      const day = indexes.find((row) => row.name === "ledger_wallet_action_day");
      const open = indexes.find((row) => row.name === "nonces_one_open");
      assert.match(logKey.sql, /WHERE action IN \('fund', 'release_or_refund', 'dispute_open_or_vote'\)/);
      assert.match(first.sql, /WHERE action = 'first_activity'/);
      assert.match(back.sql, /WHERE action = 'return_day'/);
      assert.match(day.sql, /wallet, action, utc_day/);
      assert.match(open.sql, /CREATE UNIQUE INDEX/);
      assert.match(open.sql, /WHERE status = 'open'/);
    } finally {
      ctx.close();
    }
  });

  it("rejects a second open nonce for the same key inside the database", () => {
    const payer = account();
    const payee = account();
    const log = createdLog({
      escrowId: `0x${"46".repeat(32)}`,
      payer: payer.address,
      payee: payee.address,
      expiresAt: 100,
      blockNumber: 49_100_010,
      logIndex: 4,
      txHash: `0x${"47".repeat(32)}`,
      timestamp: 21_110 * 86400,
    });
    const ctx = tempIndexer();
    try {
      ctx.indexer.ingestLogs([log]);
      const issued = ctx.indexer.issueNonce({
        txHash: log.transactionHash,
        logIndex: 4,
        wallet: payer.address,
        issueTime: 21_110 * 86400 + 5,
      });
      assert.equal(issued.ok, true);
      assert.throws(() => {
        ctx.indexer.db.prepare(
          `INSERT INTO nonces(nonce, tx_hash, log_index, wallet, block_timestamp, issue_time, status, seq)
           VALUES(?, ?, ?, ?, ?, ?, 'open', ?)`,
        ).run("2", issued.txHash, issued.logIndex, issued.wallet, 21_110 * 86400, 21_110 * 86400 + 6, 2);
      }, (error) => {
        assert.match(String(error.message), /UNIQUE/);
        return true;
      });
      assert.equal(ctx.indexer.nonceCount(), 1);
    } finally {
      ctx.close();
    }
  });

  it("lets two processes open only one nonce for a log", async () => {
    const payer = account();
    const payee = account();
    const log = createdLog({
      escrowId: `0x${"44".repeat(32)}`,
      payer: payer.address,
      payee: payee.address,
      expiresAt: 100,
      blockNumber: 49_100_001,
      logIndex: 3,
      txHash: `0x${"45".repeat(32)}`,
      timestamp: 21_100 * 86400,
    });
    const ctx = tempIndexer();
    try {
      ctx.indexer.ingestLogs([log]);
      ctx.indexer.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const path = `${ctx.dir}/ledger.sqlite`;
      const request = {
        txHash: log.transactionHash,
        logIndex: 3,
        wallet: payer.address,
        issueTime: 21_100 * 86400 + 5,
      };
      const workers = [0, 1].map(() => new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./issue-worker.mjs", import.meta.url), { workerData: { path, request } });
        worker.on("message", resolve);
        worker.on("error", reject);
      }));
      const results = await Promise.all(workers);
      const opened = results.filter((result) => result.ok);
      const refused = results.filter((result) => result.reason === "nonce_open");
      assert.equal(opened.length, 1);
      assert.equal(refused.length, 1);
      assert.equal(ctx.indexer.nonceCount(), 1);
    } finally {
      ctx.close();
    }
  });
});
