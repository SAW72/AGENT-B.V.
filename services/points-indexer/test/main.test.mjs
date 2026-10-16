import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ESCROW_START_BLOCK, PANEL } from "../src/constants.mjs";
import {
  DEFAULT_DB_PATH,
  DEFAULT_ESCROW_ADDRESS,
  DEFAULT_LOG_RANGE,
  DEFAULT_POLL_MS,
  DEFAULT_RPC_URL,
  loadConfig,
  start,
} from "../src/main.mjs";
import { account, createdLog, creditCandidate, loadFixture, tempIndexer } from "./support.mjs";

const CONFIG_FILES = ["../render.yaml", "../Dockerfile"].map((name) =>
  fileURLToPath(new URL(name, import.meta.url)),
);
const PANEL_ADDRESS = PANEL;

function dbDir() {
  return mkdtempSync(join(tmpdir(), "abv-entry-"));
}

function withCode(rpc, code = "0x6001600055") {
  return {
    async chainId() {
      return 84532;
    },
    async getCode() {
      return code;
    },
    ...rpc,
  };
}

function blockOf(log) {
  return Number(BigInt(log.blockNumber));
}

async function until(pred) {
  for (let i = 0; i < 100; i += 1) {
    if (pred()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out");
}

describe("process entry", () => {
  it("loads Base Sepolia defaults when env is empty", () => {
    const config = loadConfig({});
    assert.equal(config.chainId, 84532);
    assert.equal(config.rpcUrl, DEFAULT_RPC_URL);
    assert.equal(config.rpcUrl, "https://sepolia.base.org");
    assert.equal(config.escrowAddress, DEFAULT_ESCROW_ADDRESS);
    assert.equal(config.escrowAddress, "0x3d660502D75f1e97b08c110255921b437A3C4C42");
    assert.equal(config.dbPath, DEFAULT_DB_PATH);
    assert.equal(config.pollMs, DEFAULT_POLL_MS);
    assert.equal(config.logRange, DEFAULT_LOG_RANGE);
    assert.equal(config.logRange, 2000);
  });

  it("overrides rpc, database path, poll interval, and log range from env", () => {
    const config = loadConfig({
      CHAIN_ID: "84532",
      BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org/example",
      ESCROW_ADDRESS: "0x3d660502D75f1e97b08c110255921b437A3C4C42",
      POINTS_DB_PATH: "/tmp/points-indexer/ledger.sqlite",
      POINTS_POLL_MS: "2500",
      POINTS_LOG_RANGE: "250",
    });
    assert.equal(config.rpcUrl, "https://sepolia.base.org/example");
    assert.equal(config.dbPath, "/tmp/points-indexer/ledger.sqlite");
    assert.equal(config.pollMs, 2500);
    assert.equal(config.logRange, 250);
    const fromUrl = loadConfig({ DATABASE_URL: "/var/tmp/ledger.sqlite" });
    assert.equal(fromUrl.dbPath, "/var/tmp/ledger.sqlite");
  });

  it("refuses a chain id other than 84532", () => {
    for (const chainId of ["1", "8453", "84531", "0", "abc"]) {
      assert.throws(() => loadConfig({ CHAIN_ID: chainId }), /CHAIN_ID must be 84532/);
    }
  });

  it("refuses a log range that is not a positive integer", () => {
    for (const range of ["0", "-1", "1.5", "abc"]) {
      assert.throws(() => loadConfig({ POINTS_LOG_RANGE: range }), /POINTS_LOG_RANGE must be a positive integer/);
    }
  });

  it("refuses a missing, zero, or malformed escrow address", () => {
    assert.throws(() => loadConfig({ ESCROW_ADDRESS: "" }), /ESCROW_ADDRESS is missing/);
    assert.throws(() => loadConfig({ ESCROW_ADDRESS: "   " }), /ESCROW_ADDRESS is missing/);
    assert.throws(
      () => loadConfig({ ESCROW_ADDRESS: "0x0000000000000000000000000000000000000000" }),
      /zero address/,
    );
    assert.throws(() => loadConfig({ ESCROW_ADDRESS: "0x1234" }), /malformed/);
    assert.throws(() => loadConfig({ ESCROW_ADDRESS: "not-an-address" }), /malformed/);
    assert.throws(
      () => loadConfig({ ESCROW_ADDRESS: "0x1111111111111111111111111111111111111111" }),
      /ESCROW_ADDRESS must be 0x3d660502D75f1e97b08c110255921b437A3C4C42/,
    );
  });

  it("refuses an RPC chain id other than 84532 before reading logs", async () => {
    let logsCalled = false;
    const dir = dbDir();
    try {
      await assert.rejects(
        () => start({
          once: true,
          env: { CHAIN_ID: "84532", POINTS_DB_PATH: join(dir, "ledger.sqlite") },
          rpc: {
            async chainId() {
              return 8453;
            },
            async getCode() {
              return "0x6001";
            },
            async finalizedBlockNumber() {
              return 1;
            },
            async getLogs() {
              logsCalled = true;
              return [];
            },
          },
        }),
        /RPC chain id is 8453, expected 84532/,
      );
      assert.equal(logsCalled, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses empty contract code for the escrow and the panel before getLogs", async () => {
    const dir = dbDir();
    const path = join(dir, "ledger.sqlite");
    try {
      let logsCalled = false;
      await assert.rejects(
        () => start({
          once: true,
          config: loadConfig({ CHAIN_ID: "84532", POINTS_DB_PATH: path }),
          rpc: withCode({
            async getCode() {
              return "0x";
            },
            async getLogs() {
              logsCalled = true;
              return [];
            },
            async finalizedBlockNumber() {
              return ESCROW_START_BLOCK;
            },
          }),
        }),
        /escrow contract code is empty/,
      );
      assert.equal(logsCalled, false);

      const seen = [];
      logsCalled = false;
      await assert.rejects(
        () => start({
          once: true,
          config: loadConfig({ CHAIN_ID: "84532", POINTS_DB_PATH: path }),
          rpc: {
            async chainId() {
              return 84532;
            },
            async getCode({ address }) {
              seen.push(String(address).toLowerCase());
              if (String(address).toLowerCase() === PANEL_ADDRESS) return "0x";
              return "0x6001";
            },
            async getLogs() {
              logsCalled = true;
              return [];
            },
            async finalizedBlockNumber() {
              return ESCROW_START_BLOCK;
            },
          },
        }),
        /panel contract code is empty/,
      );
      assert.equal(logsCalled, false);
      assert.ok(seen.includes(PANEL_ADDRESS));
      assert.ok(seen.includes(DEFAULT_ESCROW_ADDRESS.toLowerCase()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a bad escrow on start({ config }) before any RPC", async () => {
    let chainCalled = false;
    let codeCalled = false;
    let logsCalled = false;
    const config = loadConfig({});
    await assert.rejects(
      () => start({
        once: true,
        config: { ...config, escrowAddress: "0x1111111111111111111111111111111111111111" },
        rpc: {
          async chainId() {
            chainCalled = true;
            return 84532;
          },
          async getCode() {
            codeCalled = true;
            return "0x6001";
          },
          async getLogs() {
            logsCalled = true;
            return [];
          },
        },
      }),
      /ESCROW_ADDRESS must be 0x3d660502D75f1e97b08c110255921b437A3C4C42/,
    );
    assert.equal(chainCalled, false);
    assert.equal(codeCalled, false);
    assert.equal(logsCalled, false);
  });

  it("keeps signing material out of the reference config", () => {
    const text = CONFIG_FILES.map((file) => readFileSync(file, "utf8")).join("\n");
    assert.doesNotMatch(text, /0x[0-9a-fA-F]{64}/);
    assert.doesNotMatch(text, /PRIVATE_KEY\s*[:=]\s*\S+/);
    assert.doesNotMatch(text, /API_KEY\s*[:=]\s*\S+/);
    const yaml = readFileSync(CONFIG_FILES[0], "utf8");
    assert.match(yaml, /BASE_SEPOLIA_RPC_URL[\s\S]*?sync:\s*false/);
    assert.doesNotMatch(yaml, /BASE_SEPOLIA_RPC_URL[\s\S]{0,120}\bvalue\s*:/);
  });

  it("scans in windows no larger than POINTS_LOG_RANGE and resumes after the cursor", async () => {
    const fixture = loadFixture();
    const head = fixture.captured_finalized_block;
    const range = 200_000;
    const dir = dbDir();
    const calls = [];
    const running = await start({
      once: true,
      env: {
        CHAIN_ID: "84532",
        POINTS_DB_PATH: join(dir, "nested", "ledger.sqlite"),
        POINTS_LOG_RANGE: String(range),
        BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org",
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs(args) {
          const span = args.toBlock - args.fromBlock + 1;
          assert.ok(span <= range);
          assert.equal(args.address[0].toLowerCase(), "0x3d660502d75f1e97b08c110255921b437a3c4c42");
          assert.equal(args.address[1].toLowerCase(), PANEL_ADDRESS);
          calls.push({ fromBlock: args.fromBlock, toBlock: args.toBlock });
          return fixture.logs.filter((log) => {
            const block = blockOf(log);
            return block >= args.fromBlock && block <= args.toBlock;
          });
        },
      }),
    });
    try {
      assert.ok(calls.length > 1);
      assert.equal(calls[0].fromBlock, ESCROW_START_BLOCK);
      for (let i = 1; i < calls.length; i += 1) {
        assert.equal(calls[i].fromBlock, calls[i - 1].toBlock + 1);
      }
      assert.equal(calls.at(-1).toBlock, head);
      const inRange = fixture.logs.filter((log) => {
        const block = blockOf(log);
        return block >= ESCROW_START_BLOCK && block <= head;
      });
      assert.equal(running.ingested.inserted, inRange.length);
      assert.equal(running.ingested.rebuilds, 1);
      assert.equal(running.indexer.lastScannedBlock(), head);
      const stored = running.indexer.db.prepare("SELECT COUNT(*) AS n FROM raw_logs").get();
      assert.equal(stored.n, inRange.length);
      const again = await running.pass();
      assert.equal(again.ranges.length, 0);
      assert.equal(again.rebuilds, 0);
      assert.equal(calls.length, running.ingested.ranges.length);
      await running.stop();
    } finally {
      await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("halves the window after a range error and does not move the cursor past a failed block", async () => {
    const dir = dbDir();
    const head = ESCROW_START_BLOCK + 3;
    const spans = [];
    const running = await start({
      once: true,
      env: {
        CHAIN_ID: "84532",
        POINTS_DB_PATH: join(dir, "ledger.sqlite"),
        POINTS_LOG_RANGE: "4",
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs(args) {
          const span = args.toBlock - args.fromBlock + 1;
          spans.push(span);
          if (span > 2) {
            const error = new Error("too many results");
            error.status = 413;
            throw error;
          }
          return [];
        },
      }),
    });
    try {
      assert.deepEqual(spans, [4, 2, 2]);
      assert.equal(running.indexer.lastScannedBlock(), head);
      await running.stop();
    } finally {
      await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a one-block range failure and leaves the cursor unmoved", async () => {
    const dir = dbDir();
    let head = ESCROW_START_BLOCK - 1;
    let fail = false;
    const running = await start({
      once: true,
      env: {
        CHAIN_ID: "84532",
        POINTS_DB_PATH: join(dir, "ledger.sqlite"),
        POINTS_LOG_RANGE: "1",
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs() {
          const error = new Error("Payload Too Large");
          error.status = 413;
          throw error;
        },
      }),
    });
    try {
      assert.equal(running.indexer.lastScannedBlock(), null);
      fail = true;
      head = ESCROW_START_BLOCK;
      await assert.rejects(() => running.pass(), /Payload Too Large/);
      assert.equal(fail, true);
      assert.equal(running.indexer.lastScannedBlock(), null);
      assert.equal(running.indexer.rawCount(), 0);
    } finally {
      await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back the cursor and the raw logs together when a window commit fails", () => {
    const ctx = tempIndexer();
    const first = createdLog({
      escrowId: `0x${"11".repeat(32)}`,
      payer: "0x1111111111111111111111111111111111111111",
      payee: "0x2222222222222222222222222222222222222222",
      expiresAt: 10,
      blockNumber: ESCROW_START_BLOCK,
      logIndex: 1,
      txHash: `0x${"a1".repeat(32)}`,
      timestamp: 20_000 * 86400,
    });
    const second = createdLog({
      escrowId: `0x${"22".repeat(32)}`,
      payer: "0x1111111111111111111111111111111111111111",
      payee: "0x2222222222222222222222222222222222222222",
      expiresAt: 10,
      blockNumber: ESCROW_START_BLOCK + 1,
      logIndex: 2,
      txHash: `0x${"b2".repeat(32)}`,
      timestamp: 20_000 * 86400 + 10,
    });
    try {
      ctx.indexer.commitScanWindow([first], ESCROW_START_BLOCK);
      assert.equal(ctx.indexer.lastScannedBlock(), ESCROW_START_BLOCK);
      assert.equal(ctx.indexer.rawCount(), 1);
      assert.throws(
        () => ctx.indexer.commitScanWindow([second], ESCROW_START_BLOCK + 5, {
          beforeCommit() {
            throw new Error("mid-transaction");
          },
        }),
        /mid-transaction/,
      );
      assert.equal(ctx.indexer.lastScannedBlock(), ESCROW_START_BLOCK);
      assert.equal(ctx.indexer.rawCount(), 1);
      const stored = ctx.indexer.db.prepare("SELECT tx_hash FROM raw_logs").all();
      assert.deepEqual(stored.map((row) => row.tx_hash), [first.transactionHash]);
    } finally {
      ctx.close();
    }
  });

  it("skips a tick that overlaps a pass still in flight", async () => {
    const dir = dbDir();
    let calls = 0;
    let release;
    const running = await start({
      once: true,
      env: {
        CHAIN_ID: "84532",
        POINTS_DB_PATH: join(dir, "ledger.sqlite"),
        POINTS_LOG_RANGE: "10",
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          calls += 1;
          if (calls > 1) await new Promise((resolve) => { release = resolve; });
          return ESCROW_START_BLOCK - 1;
        },
        async getLogs() {
          throw new Error("unexpected getLogs");
        },
      }),
    });
    try {
      const pending = running.pass();
      const skipped = await running.pass();
      assert.equal(skipped.skipped, true);
      assert.equal(running.skippedTicks, 1);
      release();
      const finished = await pending;
      assert.equal(finished.skipped, false);
    } finally {
      await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps committed rows when a later finalized head is older", async () => {
    const payer = account();
    const payee = account();
    const block = ESCROW_START_BLOCK + 4;
    const log = createdLog({
      escrowId: `0x${"44".repeat(32)}`,
      payer: payer.address,
      payee: payee.address,
      expiresAt: 100,
      blockNumber: block,
      logIndex: 3,
      txHash: `0x${"c3".repeat(32)}`,
      timestamp: 21_100 * 86400,
    });
    const dir = dbDir();
    let head = block;
    const running = await start({
      once: true,
      env: {
        CHAIN_ID: "84532",
        POINTS_DB_PATH: join(dir, "ledger.sqlite"),
        POINTS_LOG_RANGE: "100",
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs(args) {
          assert.ok(args.toBlock - args.fromBlock + 1 <= 100);
          return args.fromBlock <= block && args.toBlock >= block ? [log] : [];
        },
      }),
    });
    try {
      const candidate = running.indexer.attribute().candidates.find((item) => item.wallet === payer.address.toLowerCase());
      assert.ok(candidate);
      await creditCandidate(running.indexer, payer, candidate);
      const before = running.indexer.canonical();
      assert.ok(running.indexer.ledger().length > 0);
      head = block - 50;
      const again = await running.pass();
      assert.equal(again.rebuilds, 0);
      assert.equal(running.indexer.finalizedBlock, block);
      assert.equal(running.indexer.canonical(), before);
    } finally {
      await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves 503 until a pass succeeds and again after three poll intervals", async () => {
    const dir = dbDir();
    let clock = 5_000_000;
    let release;
    let health;
    const pending = start({
      once: true,
      serve: true,
      port: 0,
      now: () => clock,
      onListening(info) {
        health = info;
      },
      env: {
        CHAIN_ID: "84532",
        POINTS_DB_PATH: join(dir, "ledger.sqlite"),
        POINTS_POLL_MS: "1000",
        POINTS_LOG_RANGE: "10",
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          if (!release) await new Promise((resolve) => { release = resolve; });
          return ESCROW_START_BLOCK - 1;
        },
        async getLogs() {
          throw new Error("unexpected getLogs");
        },
      }),
    });
    let running;
    try {
      await until(() => health);
      const early = await fetch(health.url);
      assert.equal(early.status, 503);
      const earlyBody = await early.json();
      assert.equal(earlyBody.ok, false);
      assert.equal(earlyBody.chainId, 84532);
      release();
      running = await pending;
      const fresh = await fetch(running.healthUrl);
      assert.equal(fresh.status, 200);
      const freshBody = await fresh.json();
      assert.equal(freshBody.ok, true);
      assert.equal(JSON.stringify(freshBody).includes("sepolia.base.org"), false);
      clock += 3000;
      const edge = await fetch(running.healthUrl);
      assert.equal(edge.status, 200);
      clock += 1;
      const stale = await fetch(running.healthUrl);
      assert.equal(stale.status, 503);
      const staleBody = await stale.json();
      assert.equal(staleBody.ok, false);
    } finally {
      if (running) await running.stop();
      else if (health) await health.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
