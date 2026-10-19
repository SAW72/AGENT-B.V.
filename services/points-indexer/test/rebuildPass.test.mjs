import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ESCROW_START_BLOCK } from "../src/constants.mjs";
import { openIndexer } from "../src/indexer.mjs";
import { start } from "../src/main.mjs";
import { createdLog, loadFixture } from "./support.mjs";

function withCode(rpc) {
  return {
    async chainId() {
      return 84532;
    },
    async getCode() {
      return "0x6001600055";
    },
    ...rpc,
  };
}

function env(extra = {}) {
  return {
    CHAIN_ID: "84532",
    POINTS_DB_PATH: ":memory:",
    POINTS_LOG_RANGE: "10",
    POINTS_POLL_MS: "60000",
    ...extra,
  };
}

function instantPace() {
  return {
    paceNow: () => 0,
    sleep: async () => {},
    now: () => 1,
  };
}

function spyLedger(indexer) {
  const events = [];
  const exec = indexer.db.exec.bind(indexer.db);
  indexer.db.exec = (sql) => {
    if (String(sql).includes("ledger_rows")) events.push(String(sql));
    return exec(sql);
  };
  const prepare = indexer.db.prepare.bind(indexer.db);
  indexer.db.prepare = (sql) => {
    const text = String(sql);
    const statement = prepare(sql);
    if (text.includes("ledger_rows")) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => {
        events.push(text);
        return run(...args);
      };
    }
    return statement;
  };
  return events;
}

function ledgerWrite(events, kind) {
  return events.some((sql) => sql.toLowerCase().includes(kind) && sql.includes("ledger_rows"));
}

describe("ledger rebuild on a pass", () => {
  it("does not rebuild an empty window and does rebuild a window that inserted logs", async () => {
    let events = [];
    const block = ESCROW_START_BLOCK + 4;
    let head = ESCROW_START_BLOCK + 2;
    let includeLog = false;
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
    const running = await start({
      once: true,
      ...instantPace(),
      env: env(),
      onIndexer(indexer) {
        events = spyLedger(indexer);
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs(args) {
          if (includeLog && args.fromBlock <= block && args.toBlock >= block) return [log];
          return [];
        },
      }),
    });
    try {
      assert.equal(running.ingested.rebuilds, 0);
      assert.equal(running.ingested.ranges.length, 1);
      assert.equal(ledgerWrite(events, "delete"), false);
      assert.equal(ledgerWrite(events, "insert"), false);
      events.length = 0;
      includeLog = true;
      head = ESCROW_START_BLOCK + 9;
      const again = await running.pass();
      assert.equal(again.rebuilds, 1);
      assert.equal(again.inserted, 1);
      assert.equal(ledgerWrite(events, "delete"), true);
      for (const row of running.indexer.ledger()) {
        assert.equal(row.points, 0);
        assert.equal(row.rule_weight, null);
      }
    } finally {
      await running.stop();
    }
  });

  it("rebuilds when the finalized head crosses a previously withheld log", async () => {
    let events = [];
    const logBlock = ESCROW_START_BLOCK + 30;
    const log = createdLog({
      escrowId: `0x${"55".repeat(32)}`,
      payer: "0x1111111111111111111111111111111111111111",
      payee: "0x2222222222222222222222222222222222222222",
      expiresAt: 100,
      blockNumber: logBlock,
      logIndex: 2,
      txHash: `0x${"d4".repeat(32)}`,
      timestamp: 21_200 * 86400,
    });
    let head = ESCROW_START_BLOCK + 5;
    const running = await start({
      once: true,
      ...instantPace(),
      env: env({ POINTS_LOG_RANGE: "10" }),
      onIndexer(indexer) {
        events = spyLedger(indexer);
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs() {
          return [];
        },
      }),
    });
    try {
      assert.equal(running.ingested.rebuilds, 0);
      running.indexer.commitScanWindow([log], logBlock, { chainId: 84532 });
      const before = running.indexer.attribute();
      assert.ok(before.withheld.some((row) => row.reason === "not_finalized" && row.blockNumber === logBlock));
      events.length = 0;
      head = logBlock;
      const crossed = await running.pass();
      assert.equal(crossed.ranges.length, 0);
      assert.equal(crossed.inserted, 0);
      assert.equal(crossed.rebuilds, 1);
      assert.equal(ledgerWrite(events, "delete"), true);
      const after = running.indexer.attribute();
      assert.equal(after.withheld.some((row) => row.blockNumber === logBlock), false);
      assert.ok(after.candidates.some((row) => row.blockNumber === logBlock));
      const reference = openIndexer({ path: ":memory:", finalizedBlock: logBlock, chainId: 84532 });
      try {
        reference.ingestLogs([log]);
        assert.equal(running.indexer.canonical(), reference.canonical());
        for (const row of running.indexer.ledger()) {
          assert.equal(row.points, 0);
          assert.equal(row.rule_weight, null);
        }
      } finally {
        reference.close();
      }
    } finally {
      await running.stop();
    }
  });

  it("matches a full rebuild of the captured logs, including an empty follow-up window", async () => {
    const fixture = loadFixture();
    const head = fixture.captured_finalized_block;
    const visible = fixture.logs.filter((log) => {
      const block = Number(BigInt(log.blockNumber));
      return block >= ESCROW_START_BLOCK && block <= head;
    });
    let events = [];
    const running = await start({
      once: true,
      ...instantPace(),
      env: env({ POINTS_LOG_RANGE: "400000" }),
      onIndexer(indexer) {
        events = spyLedger(indexer);
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs(args) {
          return visible.filter((log) => {
            const block = Number(BigInt(log.blockNumber));
            return block >= args.fromBlock && block <= args.toBlock;
          });
        },
      }),
    });
    const reference = openIndexer({ path: ":memory:", finalizedBlock: head, chainId: 84532 });
    try {
      reference.ingestLogs(visible);
      assert.equal(running.indexer.rawCount(), reference.rawCount());
      assert.equal(running.indexer.canonical(), reference.canonical());
      assert.equal(running.ingested.rebuilds, 1);
      for (const row of running.indexer.ledger()) {
        assert.equal(row.points, 0);
        assert.equal(row.rule_weight, null);
        assert.equal(row.eligibility_status, "unverified");
        assert.equal(row.points_withheld, 1);
      }
      const before = running.indexer.canonical();
      events.length = 0;
      const quiet = await running.pass();
      assert.equal(quiet.ranges.length, 0);
      assert.equal(quiet.rebuilds, 0);
      assert.equal(ledgerWrite(events, "delete"), false);
      assert.equal(ledgerWrite(events, "insert"), false);
      assert.equal(running.indexer.canonical(), before);
      running.indexer.rebuild();
      assert.equal(running.indexer.canonical(), reference.canonical());
    } finally {
      reference.close();
      await running.stop();
    }
  });

  it("retries a rebuild that throws after an insert and keeps /health stale until it finishes", async () => {
    const block = ESCROW_START_BLOCK + 4;
    let head = ESCROW_START_BLOCK - 1;
    let failRebuild = true;
    const log = createdLog({
      escrowId: `0x${"66".repeat(32)}`,
      payer: "0x1111111111111111111111111111111111111111",
      payee: "0x2222222222222222222222222222222222222222",
      expiresAt: 100,
      blockNumber: block,
      logIndex: 1,
      txHash: `0x${"e5".repeat(32)}`,
      timestamp: 21_300 * 86400,
    });
    const running = await start({
      once: true,
      serve: true,
      port: 0,
      ...instantPace(),
      now: () => 5_000_000,
      env: env({ POINTS_LOG_RANGE: "10" }),
      onIndexer(indexer) {
        const original = indexer.rebuild.bind(indexer);
        indexer.rebuild = () => {
          if (failRebuild) throw new Error("rebuild failed");
          return original();
        };
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs(args) {
          if (args.fromBlock <= block && args.toBlock >= block) return [log];
          return [];
        },
      }),
    });
    try {
      assert.equal(running.ingested.rebuilds, 0);
      head = block;
      await assert.rejects(() => running.pass(), /rebuild failed/);
      assert.equal(running.indexer.rawCount(), 1);
      assert.equal(running.indexer.finalizedBlock, block);
      let response = await fetch(running.healthUrl);
      assert.equal(response.status, 503);
      let body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.error, "rebuild_error");
      head = block + 9;
      await assert.rejects(() => running.pass(), /rebuild failed/);
      assert.equal(running.indexer.lastScannedBlock(), block + 9);
      response = await fetch(running.healthUrl);
      body = await response.json();
      assert.equal(response.status, 503);
      assert.equal(body.ok, false);
      assert.equal(body.error, "rebuild_error");
      failRebuild = false;
      const healed = await running.pass();
      assert.equal(healed.rebuilds, 1);
      response = await fetch(running.healthUrl);
      body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.error, undefined);
      const reference = openIndexer({ path: ":memory:", finalizedBlock: head, chainId: 84532 });
      try {
        reference.ingestLogs([log]);
        assert.equal(running.indexer.canonical(), reference.canonical());
      } finally {
        reference.close();
      }
    } finally {
      await running.stop();
    }
  });

  it("does not store the new head when the crossing query throws, then rebuilds on the next pass", async () => {
    const logBlock = ESCROW_START_BLOCK + 30;
    const log = createdLog({
      escrowId: `0x${"77".repeat(32)}`,
      payer: "0x1111111111111111111111111111111111111111",
      payee: "0x2222222222222222222222222222222222222222",
      expiresAt: 100,
      blockNumber: logBlock,
      logIndex: 2,
      txHash: `0x${"f6".repeat(32)}`,
      timestamp: 21_400 * 86400,
    });
    let head = ESCROW_START_BLOCK + 5;
    let throwOnce = false;
    const running = await start({
      once: true,
      ...instantPace(),
      env: env({ POINTS_LOG_RANGE: "10" }),
      onIndexer(indexer) {
        const prepare = indexer.db.prepare.bind(indexer.db);
        indexer.db.prepare = (sql) => {
          const text = String(sql);
          if (throwOnce && text.includes("block_number >")) {
            throwOnce = false;
            throw new Error("crossed query failed");
          }
          return prepare(sql);
        };
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs() {
          return [];
        },
      }),
    });
    try {
      assert.equal(running.indexer.finalizedBlock, ESCROW_START_BLOCK + 5);
      running.indexer.commitScanWindow([log], logBlock, { chainId: 84532 });
      throwOnce = true;
      head = logBlock;
      await assert.rejects(() => running.pass(), /crossed query failed/);
      assert.equal(running.indexer.finalizedBlock, ESCROW_START_BLOCK + 5);
      const healed = await running.pass();
      assert.equal(healed.rebuilds, 1);
      assert.equal(running.indexer.finalizedBlock, logBlock);
      const reference = openIndexer({ path: ":memory:", finalizedBlock: logBlock, chainId: 84532 });
      try {
        reference.ingestLogs([log]);
        assert.equal(running.indexer.canonical(), reference.canonical());
      } finally {
        reference.close();
      }
    } finally {
      await running.stop();
    }
  });

  it("rolls back a window when the process crashes before that commit, then scans it again", async () => {
    const block = ESCROW_START_BLOCK + 4;
    const log = createdLog({
      escrowId: `0x${"88".repeat(32)}`,
      payer: "0x1111111111111111111111111111111111111111",
      payee: "0x2222222222222222222222222222222222222222",
      expiresAt: 100,
      blockNumber: block,
      logIndex: 3,
      txHash: `0x${"a7".repeat(32)}`,
      timestamp: 21_500 * 86400,
    });
    let head = ESCROW_START_BLOCK - 1;
    let crash = true;
    const running = await start({
      once: true,
      ...instantPace(),
      env: env({ POINTS_LOG_RANGE: "10" }),
      onIndexer(indexer) {
        const original = indexer.commitScanWindow.bind(indexer);
        indexer.commitScanWindow = (logs, scannedThrough, options) => {
          if (crash && logs.length > 0) {
            crash = false;
            return original(logs, scannedThrough, {
              ...options,
              beforeCommit() {
                throw new Error("crash before commit");
              },
            });
          }
          return original(logs, scannedThrough, options);
        };
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs() {
          return [log];
        },
      }),
    });
    try {
      assert.equal(running.ingested.rebuilds, 0);
      head = block;
      await assert.rejects(() => running.pass(), /crash before commit/);
      assert.equal(running.indexer.rawCount(), 0);
      assert.equal(running.indexer.lastScannedBlock(), null);
      const again = await running.pass();
      assert.equal(again.inserted, 1);
      assert.equal(again.rebuilds, 1);
      assert.equal(running.indexer.rawCount(), 1);
      assert.equal(running.indexer.lastScannedBlock(), block);
    } finally {
      await running.stop();
    }
  });

  it("rebuilds a committed window on restart when the process died before rebuild", async () => {
    const dir = mkdtempSync(join(tmpdir(), "points-rebuild-"));
    const path = join(dir, "ledger.sqlite");
    const block = ESCROW_START_BLOCK + 4;
    const log = createdLog({
      escrowId: `0x${"99".repeat(32)}`,
      payer: "0x1111111111111111111111111111111111111111",
      payee: "0x2222222222222222222222222222222222222222",
      expiresAt: 100,
      blockNumber: block,
      logIndex: 4,
      txHash: `0x${"b8".repeat(32)}`,
      timestamp: 21_600 * 86400,
    });
    let head = ESCROW_START_BLOCK - 1;
    let crash = true;
    const first = await start({
      once: true,
      ...instantPace(),
      env: env({ POINTS_DB_PATH: path, POINTS_LOG_RANGE: "10" }),
      onIndexer(indexer) {
        const original = indexer.rebuild.bind(indexer);
        indexer.rebuild = () => {
          if (crash) throw new Error("crash after commit");
          return original();
        };
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs() {
          return head >= block ? [log] : [];
        },
      }),
    });
    try {
      assert.equal(first.ingested.rebuilds, 0);
      head = block;
      await assert.rejects(() => first.pass(), /crash after commit/);
      assert.equal(first.indexer.rawCount(), 1);
      assert.equal(first.indexer.finalizedBlock, block);
    } finally {
      await first.stop();
    }
    const second = await start({
      once: true,
      ...instantPace(),
      env: env({ POINTS_DB_PATH: path, POINTS_LOG_RANGE: "10" }),
      rpc: withCode({
        async finalizedBlockNumber() {
          return block;
        },
        async getLogs() {
          return [];
        },
      }),
    });
    const reference = openIndexer({ path: ":memory:", finalizedBlock: block, chainId: 84532 });
    try {
      reference.ingestLogs([log]);
      assert.equal(second.indexer.rawCount(), 1);
      assert.equal(second.indexer.canonical(), reference.canonical());
      assert.equal(second.ingested.rebuilds, 0);
    } finally {
      reference.close();
      await second.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
