import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { HttpRequestError, RpcRequestError } from "viem";
import { ESCROW_START_BLOCK, PANEL } from "../src/constants.mjs";
import { PointsError } from "../src/hex.mjs";
import {
  DEFAULT_DB_PATH,
  DEFAULT_ESCROW_ADDRESS,
  DEFAULT_LOG_RANGE,
  DEFAULT_MAX_WINDOWS,
  DEFAULT_POLL_MS,
  DEFAULT_RPC_URL,
  createDefaultRpc,
  isRangeError,
  loadConfig,
  redact,
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
  for (let i = 0; i < 200; i += 1) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
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
    assert.equal(config.logRange, 200);
    assert.equal(config.maxWindows, DEFAULT_MAX_WINDOWS);
    assert.equal(config.maxWindows, 500);
  });

  it("overrides rpc, database path, poll interval, and log range from env", () => {
    const config = loadConfig({
      CHAIN_ID: "84532",
      BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org/example",
      ESCROW_ADDRESS: "0x3d660502D75f1e97b08c110255921b437A3C4C42",
      POINTS_DB_PATH: "/tmp/points-indexer/ledger.sqlite",
      POINTS_POLL_MS: "2500",
      POINTS_LOG_RANGE: "250",
      POINTS_MAX_WINDOWS_PER_PASS: "12",
    });
    assert.equal(config.rpcUrl, "https://sepolia.base.org/example");
    assert.equal(config.dbPath, "/tmp/points-indexer/ledger.sqlite");
    assert.equal(config.pollMs, 2500);
    assert.equal(config.logRange, 250);
    assert.equal(config.maxWindows, 12);
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
    for (const cap of ["0", "-1", "1.5", "abc"]) {
      assert.throws(
        () => loadConfig({ POINTS_MAX_WINDOWS_PER_PASS: cap }),
        /POINTS_MAX_WINDOWS_PER_PASS must be a positive integer/,
      );
    }
  });

  it("refuses a poll interval that is not a positive integer", () => {
    for (const poll of ["0", "-1", "1.5", "abc", "1e3"]) {
      assert.throws(() => loadConfig({ POINTS_POLL_MS: poll }), /POINTS_POLL_MS must be a positive integer/);
    }
    assert.equal(loadConfig({ POINTS_POLL_MS: "" }).pollMs, DEFAULT_POLL_MS);
    assert.equal(loadConfig({ POINTS_POLL_MS: "   " }).pollMs, DEFAULT_POLL_MS);
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
            throw new RpcRequestError({
              body: { method: "eth_getLogs" },
              error: { code: -32614, message: "eth_getLogs is limited to a 2 range" },
              url: "https://sepolia.base.org",
            });
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
    let calls = 0;
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
          calls += 1;
          if (calls > 5) throw new Error("stuck");
          throw new HttpRequestError({
            body: { method: "eth_getLogs" },
            details: "Payload Too Large",
            status: 413,
            url: "https://sepolia.base.org",
          });
        },
      }),
    });
    try {
      assert.equal(running.indexer.lastScannedBlock(), null);
      head = ESCROW_START_BLOCK;
      await assert.rejects(() => running.pass(), /Payload Too Large/);
      assert.equal(calls, 1);
      assert.equal(running.indexer.lastScannedBlock(), null);
      assert.equal(running.indexer.rawCount(), 0);
    } finally {
      await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [label, makeError] of [
    ["-32614 with no number in the text", () => new RpcRequestError({
      body: { method: "eth_getLogs" },
      error: { code: -32614, message: "range too wide" },
      url: "https://sepolia.base.org",
    })],
    ["HTTP 413 without a JSON-RPC body", () => new HttpRequestError({
      body: { method: "eth_getLogs" },
      details: "Payload Too Large",
      status: 413,
      url: "https://sepolia.base.org",
    })],
  ]) {
    it(`halves the window step by step on ${label}`, async () => {
      const dir = dbDir();
      const head = ESCROW_START_BLOCK + 7;
      const spans = [];
      let running;
      try {
        running = await start({
          once: true,
          env: { CHAIN_ID: "84532", POINTS_DB_PATH: join(dir, "ledger.sqlite"), POINTS_LOG_RANGE: "8" },
          rpc: withCode({
            async finalizedBlockNumber() {
              return head;
            },
            async getLogs(args) {
              const span = args.toBlock - args.fromBlock + 1;
              spans.push(span);
              if (spans.length > 40) throw new Error("stuck: window is not shrinking");
              if (span > 2) throw makeError();
              return [];
            },
          }),
        });
        assert.deepEqual(spans.slice(0, 3), [8, 4, 2]);
        assert.equal(running.indexer.lastScannedBlock(), head);
      } finally {
        if (running) await running.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

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

  it("writes the cursor in the same transaction as the raw logs", () => {
    const ctx = tempIndexer();
    const log = createdLog({
      escrowId: `0x${"33".repeat(32)}`,
      payer: "0x1111111111111111111111111111111111111111",
      payee: "0x2222222222222222222222222222222222222222",
      expiresAt: 10,
      blockNumber: ESCROW_START_BLOCK,
      logIndex: 7,
      txHash: `0x${"c7".repeat(32)}`,
      timestamp: 20_000 * 86400,
    });
    try {
      ctx.indexer.db.exec(`
        CREATE TRIGGER block_cursor_insert BEFORE INSERT ON meta
        WHEN NEW.key = 'last_scanned_block'
        BEGIN
          SELECT RAISE(ABORT, 'cursor blocked');
        END
      `);
      ctx.indexer.db.exec(`
        CREATE TRIGGER block_cursor_update BEFORE UPDATE ON meta
        WHEN NEW.key = 'last_scanned_block'
        BEGIN
          SELECT RAISE(ABORT, 'cursor blocked');
        END
      `);
      assert.throws(
        () => ctx.indexer.commitScanWindow([log], ESCROW_START_BLOCK),
        /cursor blocked/,
      );
      assert.equal(ctx.indexer.rawCount(), 0);
      assert.equal(ctx.indexer.lastScannedBlock(), null);
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
      await until(() => typeof release === "function");
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
    const original = console.error;
    console.error = () => {};
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
      console.error = original;
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
      await until(() => health && typeof release === "function");
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

  it("keeps /health at 200 while a multi-window pass is still running", async () => {
    const dir = dbDir();
    const head = ESCROW_START_BLOCK + 39;
    let clock = 0;
    let calls = 0;
    let healthUrl;
    const mid = [];
    const running = await start({
      once: true,
      serve: true,
      port: 0,
      now: () => clock,
      onListening(info) {
        healthUrl = info.url;
      },
      env: {
        CHAIN_ID: "84532",
        POINTS_DB_PATH: join(dir, "ledger.sqlite"),
        POINTS_POLL_MS: "1000",
        POINTS_LOG_RANGE: "10",
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs() {
          clock += 2000;
          calls += 1;
          if (calls >= 2) {
            const response = await fetch(healthUrl);
            mid.push(response.status);
            await response.text();
          }
          return [];
        },
      }),
    });
    try {
      assert.equal(calls, 4);
      assert.ok(clock > 3000);
      assert.deepEqual(mid, [200, 200, 200]);
      assert.equal(running.ingested.ok, true);
    } finally {
      await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies viem range errors without treating a hex 413 as a range limit", () => {
    const limited = new RpcRequestError({
      body: { method: "eth_getLogs" },
      error: { code: -32614, message: "eth_getLogs is limited to a 200 range" },
      url: "https://sepolia.base.org",
    });
    assert.equal(limited.status, undefined);
    assert.equal(isRangeError(limited), true);
    assert.match(limited.details, /limited to a 200 range/);

    const hexBlock = new RpcRequestError({
      body: { method: "eth_getLogs", params: [{ fromBlock: "0x413000", toBlock: "0x4130c8" }] },
      error: { code: -32000, message: "header not found" },
      url: "https://sepolia.base.org",
    });
    assert.match(hexBlock.message, /413/);
    assert.equal(isRangeError(hexBlock), false);

    const rows = [
      [new HttpRequestError({ status: 413, url: "https://sepolia.base.org", body: {} }), true],
      [new HttpRequestError({ status: 502, url: "https://sepolia.base.org", body: {} }), false],
      [Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), false],
      [new HttpRequestError({ status: 429, url: "https://sepolia.base.org", body: {} }), false],
      [new RpcRequestError({
        body: { method: "eth_getLogs" },
        error: { code: -32602, message: "block range is too large" },
        url: "https://sepolia.base.org",
      }), true],
      [new RpcRequestError({
        body: { method: "eth_getLogs" },
        error: { code: -32602, message: "missing required field" },
        url: "https://sepolia.base.org",
      }), false],
      [new RpcRequestError({
        body: { method: "eth_getLogs" },
        error: { code: -32602, message: "block range extends beyond current head block" },
        url: "https://sepolia.base.org",
      }), false],
      [new RpcRequestError({
        body: { method: "eth_getLogs" },
        error: { code: -32005, message: "too many results" },
        url: "https://sepolia.base.org",
      }), true],
      [new RpcRequestError({
        body: { method: "eth_getLogs" },
        error: { code: -32614, message: "range too wide" },
        url: "https://sepolia.base.org",
      }), true],
    ];
    for (const [error, expected] of rows) assert.equal(isRangeError(error), expected);
  });

  it("completes a pass when a real viem client receives the 200-block HTTP 413", async () => {
    const dir = dbDir();
    const head = ESCROW_START_BLOCK + 399;
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, ...payload }));
      };
      if (body.method === "eth_chainId") return send(200, { result: "0x14a34" });
      if (body.method === "eth_getCode") return send(200, { result: "0x60016000" });
      if (body.method === "eth_getBlockByNumber") {
        return send(200, { result: { number: `0x${head.toString(16)}` } });
      }
      if (body.method === "eth_getLogs") {
        const params = body.params?.[0] ?? {};
        const from = Number(BigInt(params.fromBlock));
        const to = Number(BigInt(params.toBlock));
        if (to - from > 200) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? 1,
            error: { code: -32614, message: "eth_getLogs is limited to a 200 range" },
          }));
          return;
        }
        return send(200, { result: [] });
      }
      send(200, { error: { code: -32601, message: `unhandled ${body.method}` } });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}`;
    let running;
    try {
      const probe = createDefaultRpc(url);
      const sample = await probe.getLogs({
        fromBlock: ESCROW_START_BLOCK,
        toBlock: ESCROW_START_BLOCK + 2000,
        address: [DEFAULT_ESCROW_ADDRESS],
      }).then(() => null, (error) => error);
      assert.equal(sample.code, -32614);
      assert.equal(sample.status, undefined);
      assert.equal(isRangeError(sample), true);
      running = await start({
        once: true,
        env: {
          CHAIN_ID: "84532",
          POINTS_DB_PATH: join(dir, "ledger.sqlite"),
          POINTS_LOG_RANGE: "1000",
          BASE_SEPOLIA_RPC_URL: url,
        },
      });
      assert.equal(running.ingested.ok, true);
      assert.equal(running.indexer.lastScannedBlock(), head);
      assert.equal(running.ingested.ranges[0].toBlock - running.ingested.ranges[0].fromBlock, 199);
      assert.ok(running.ingested.ranges.every((range) => range.toBlock - range.fromBlock <= 199));
    } finally {
      if (running) await running.stop();
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a keyed RPC URL out of /health and out of console.error", async () => {
    const dir = dbDir();
    const keyUrl = "https://base-sepolia.rpc.invalid/v2/FAKE_SECRET_KEY_abc123";
    const logged = [];
    const original = console.error;
    console.error = (...args) => {
      logged.push(args.map((part) => String(part)).join(" "));
    };
    let running;
    try {
      const leaked = redact(
        `RPC Request failed.\n\nURL: ${keyUrl}\nRequest body: {"method":"eth_getLogs"}`,
        keyUrl,
      );
      assert.equal(leaked.includes("FAKE_SECRET_KEY_abc123"), false);
      assert.equal(leaked.includes(keyUrl), false);
      assert.equal(leaked.includes("https://"), false);
      const wss = redact("dial wss://base-sepolia.rpc.invalid/v2/WSSKEY1234567890", keyUrl);
      assert.equal(wss.includes("wss://"), false);
      assert.equal(wss.includes("WSSKEY1234567890"), false);
      const encoded = redact("see https%3A%2F%2Fbase-sepolia.rpc.invalid%2Fv2%2FENC_SECRET_KEY", keyUrl);
      assert.equal(encoded.includes("ENC_SECRET_KEY"), false);
      assert.equal(encoded.includes("%3A%2F%2F"), false);
      const segment = redact("path /v2/FAKE_SECRET_KEY_abc123 end", "");
      assert.equal(segment.includes("FAKE_SECRET_KEY_abc123"), false);
      const query = redact("https://rpc.invalid/v2?apikey=QUERYSECRET123456", "");
      assert.equal(query.includes("QUERYSECRET123456"), false);
      const assigned = redact("apikey=QUERYSECRET123456", "");
      assert.equal(assigned.includes("QUERYSECRET123456"), false);
      const jsonKey = redact('{"apiKey":"QUERYSECRET123456"}', "");
      assert.equal(jsonKey.includes("QUERYSECRET123456"), false);
      const bearer = redact("Authorization: Bearer QUERYSECRET123456", "");
      assert.equal(bearer.includes("QUERYSECRET123456"), false);
      const userinfo = redact("user:QUERYSECRET123456@rpc.invalid/v2", "");
      assert.equal(userinfo.includes("QUERYSECRET123456"), false);
      const doubled = redact("see https%253A%252F%252Frpc.invalid%252Fv2%252FENC_SECRET_KEY", "");
      assert.equal(doubled.includes("ENC_SECRET_KEY"), false);
      const authValue = "auth".repeat(2) + "91";
      const authLine = redact(`header ?auth=${authValue} next`, "");
      assert.equal(authLine.includes(authValue), false);
      assert.match(authLine, /\?auth=\[redacted\]/);
      const bareKey = "bare".repeat(3) + "91".repeat(2);
      const bareLine = redact(`invalid api key ${bareKey} end`, "");
      assert.equal(bareLine.includes(bareKey), false);
      assert.match(bareLine, /invalid api key \[redacted\] end/);
      const hexKey = "ab12".repeat(8);
      const hexLine = redact(`project ${hexKey} end`, "");
      assert.equal(hexKey.length, 32);
      assert.equal(hexLine.includes(hexKey), false);
      assert.match(hexLine, /project \[redacted\] end/);
      const shortKey = "k7" + "m9".repeat(3);
      const shortLine = redact(`path /v2/${shortKey} end`, "");
      assert.equal(shortKey.length, 8);
      assert.equal(shortLine.includes(shortKey), false);
      assert.match(shortLine, /path \/v2\/\[redacted\] end/);
      const dotted = redact(`path /v2/${shortKey}.tail end`, "");
      assert.equal(dotted.includes(shortKey), false);
      assert.equal(dotted.includes(".tail"), false);
      const pathKey = "split".repeat(2) + "12";
      const spaced = redact(`see https://rpc.invalid /v2/${pathKey} end`, "");
      assert.equal(spaced.includes(pathKey), false);
      assert.equal(spaced.includes("https://"), false);
      assert.match(spaced, /see \[redacted-url\] end/);
      const kept = redact("path /v2/ethereum end", "");
      assert.equal(kept.includes("ethereum"), true);
      running = await start({
        serve: true,
        port: 0,
        env: {
          CHAIN_ID: "84532",
          POINTS_DB_PATH: join(dir, "ledger.sqlite"),
          POINTS_POLL_MS: "60000",
          POINTS_LOG_RANGE: "10",
          BASE_SEPOLIA_RPC_URL: keyUrl,
        },
        rpc: withCode({
          async finalizedBlockNumber() {
            return ESCROW_START_BLOCK + 4;
          },
          async getLogs() {
            throw new RpcRequestError({
              body: { method: "eth_getLogs" },
              error: { code: -32000, message: "header not found" },
              url: keyUrl,
            });
          },
        }),
      });
      const response = await fetch(running.healthUrl);
      assert.equal(response.status, 503);
      const text = await response.text();
      assert.equal(text.includes("FAKE_SECRET_KEY_abc123"), false);
      assert.equal(text.includes(keyUrl), false);
      assert.equal(text.includes("rpc.invalid"), false);
      const body = JSON.parse(text);
      assert.equal(body.error, "rpc_error");
      assert.equal(body.ok, false);
      const joined = logged.join("\n");
      assert.match(joined, /rpc_error/);
      assert.equal(joined.includes("FAKE_SECRET_KEY_abc123"), false);
      assert.equal(joined.includes(keyUrl), false);
      assert.equal(joined.includes("rpc.invalid"), false);
      assert.equal(joined.includes("https://"), false);
    } finally {
      console.error = original;
      if (running) await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not print error messages or alternate URL forms from logFailure", async () => {
    const dir = dbDir();
    const keyUrl = "https://base-sepolia.rpc.invalid/v2/FAKE_SECRET_KEY_abc123";
    const wssUrl = "wss://base-sepolia.rpc.invalid/v2/WSS_SECRET_KEY";
    const encodedUrl = "https%3A%2F%2Fbase-sepolia.rpc.invalid%2Fv2%2FENC_SECRET_KEY";
    const bareUrl = "base-sepolia.rpc.invalid/v2/BARE_SECRET_KEY";
    const secretText = `${keyUrl} ${wssUrl} ${encodedUrl} ${bareUrl}`;
    const failure = new Error(`provider down ${secretText}`);
    failure.details = `details ${secretText}`;
    failure.stack = `stack ${secretText}`;
    failure.shortMessage = "header not found";
    const logged = [];
    const original = console.error;
    console.error = (...args) => {
      logged.push(args.map((part) => String(part)).join(" "));
    };
    let running;
    try {
      running = await start({
        serve: true,
        port: 0,
        env: {
          CHAIN_ID: "84532",
          POINTS_DB_PATH: join(dir, "ledger.sqlite"),
          POINTS_POLL_MS: "60000",
          POINTS_LOG_RANGE: "10",
          BASE_SEPOLIA_RPC_URL: keyUrl,
        },
        rpc: withCode({
          async finalizedBlockNumber() {
            return ESCROW_START_BLOCK;
          },
          async getLogs() {
            throw failure;
          },
        }),
      });
      assert.equal(running.ingested.ok, false);
      const response = await fetch(running.healthUrl);
      const bodyText = await response.text();
      const joined = logged.join("\n");
      assert.match(joined, /rpc_error/);
      assert.match(joined, /header not found/);
      for (const secret of [keyUrl, wssUrl, encodedUrl, bareUrl, "FAKE_SECRET_KEY_abc123", "WSS_SECRET_KEY", "ENC_SECRET_KEY", "BARE_SECRET_KEY", "wss://", "https%3A", "provider down", "details "]) {
        assert.equal(joined.includes(secret), false, secret);
        assert.equal(bodyText.includes(secret), false, secret);
      }
    } finally {
      console.error = original;
      if (running) await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumes at cursor + 1 after the database is closed and opened again", async () => {
    const dir = dbDir();
    const path = join(dir, "ledger.sqlite");
    const head = ESCROW_START_BLOCK + 40;
    const env = {
      CHAIN_ID: "84532",
      POINTS_DB_PATH: path,
      POINTS_LOG_RANGE: "10",
      POINTS_MAX_WINDOWS_PER_PASS: "1",
    };
    const calls = [];
    const first = await start({
      once: true,
      env,
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs(args) {
          calls.push(args.fromBlock);
          return [];
        },
      }),
    });
    const cursor = first.indexer.lastScannedBlock();
    assert.equal(cursor, ESCROW_START_BLOCK + 9);
    await first.stop();
    calls.length = 0;
    const second = await start({
      once: true,
      env: { ...env, POINTS_MAX_WINDOWS_PER_PASS: "2" },
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs(args) {
          calls.push(args.fromBlock);
          return [];
        },
      }),
    });
    try {
      assert.equal(calls[0], cursor + 1);
      for (const from of calls) assert.ok(from > cursor);
      assert.equal(second.indexer.lastScannedBlock(), cursor + 20);
    } finally {
      await second.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ends a network-error pass early and runs the next pass", async () => {
    const dir = dbDir();
    let mode = "idle";
    let current = 0;
    const sleeps = [];
    const paceNow = () => current;
    const sleep = async (ms) => {
      sleeps.push(ms);
      current += ms;
    };
    const original = console.error;
    console.error = () => {};
    let running;
    try {
      running = await start({
        once: true,
        paceNow,
        sleep,
        env: {
          CHAIN_ID: "84532",
          POINTS_DB_PATH: join(dir, "ledger.sqlite"),
          POINTS_LOG_RANGE: "5",
        },
        rpc: withCode({
          async finalizedBlockNumber() {
            if (mode === "idle") return ESCROW_START_BLOCK - 1;
            return ESCROW_START_BLOCK + 4;
          },
          async getLogs() {
            if (mode === "fail") {
              const error = new Error("read ECONNRESET");
              error.code = "ECONNRESET";
              throw error;
            }
            return [];
          },
        }),
      });
      mode = "fail";
      const failed = await running.pass();
      assert.equal(failed.endedEarly, true);
      assert.equal(failed.reason, "network_error");
      assert.equal(failed.ok, true);
      assert.equal(running.indexer.lastScannedBlock(), null);
      assert.deepEqual(sleeps.filter((ms) => ms >= 1000), [1000, 2000, 4000]);
      mode = "ok";
      const again = await running.pass();
      assert.equal(again.skipped, false);
      assert.equal(again.endedEarly, false);
      assert.equal(again.ok, true);
      assert.equal(running.indexer.lastScannedBlock(), ESCROW_START_BLOCK + 4);
    } finally {
      console.error = original;
      if (running) await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebuilds once per pass and retries a rebuild that failed after commit", async () => {
    const dir = dbDir();
    let head = ESCROW_START_BLOCK - 1;
    let rebuilds = 0;
    let failRebuild = false;
    const running = await start({
      once: true,
      onIndexer(indexer) {
        const original = indexer.rebuild.bind(indexer);
        indexer.rebuild = () => {
          rebuilds += 1;
          if (failRebuild) {
            failRebuild = false;
            throw new Error("rebuild failed");
          }
          return original();
        };
      },
      env: {
        CHAIN_ID: "84532",
        POINTS_DB_PATH: join(dir, "ledger.sqlite"),
        POINTS_LOG_RANGE: "10",
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
      assert.equal(rebuilds, 0);
      head = ESCROW_START_BLOCK + 2;
      const scanned = await running.pass();
      assert.equal(scanned.ranges.length, 1);
      assert.equal(rebuilds, 1);
      const idle = await running.pass();
      assert.equal(idle.ranges.length, 0);
      assert.equal(rebuilds, 1);
      failRebuild = true;
      head = ESCROW_START_BLOCK + 4;
      await assert.rejects(() => running.pass(), /rebuild failed/);
      assert.equal(running.indexer.lastScannedBlock(), ESCROW_START_BLOCK + 4);
      assert.equal(rebuilds, 2);
      const retried = await running.pass();
      assert.equal(retried.ranges.length, 0);
      assert.equal(retried.rebuilds, 1);
      assert.equal(rebuilds, 3);
      const quiet = await running.pass();
      assert.equal(quiet.rebuilds, 0);
      assert.equal(rebuilds, 3);
    } finally {
      await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the learned window across passes and grows it after each success", async () => {
    const dir = dbDir();
    const head = ESCROW_START_BLOCK + 5_000;
    let strict = true;
    const spans = [];
    const running = await start({
      once: true,
      env: {
        CHAIN_ID: "84532",
        POINTS_DB_PATH: join(dir, "ledger.sqlite"),
        POINTS_LOG_RANGE: "800",
        POINTS_MAX_WINDOWS_PER_PASS: "1",
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs(args) {
          const span = args.toBlock - args.fromBlock + 1;
          spans.push(span);
          if (strict && span > 150) {
            throw new RpcRequestError({
              body: { method: "eth_getLogs" },
              error: { code: -32614, message: "eth_getLogs is limited to a 150 range" },
              url: "https://sepolia.base.org",
            });
          }
          return [];
        },
      }),
    });
    try {
      assert.deepEqual(spans, [800, 150]);
      strict = false;
      spans.length = 0;
      await running.pass();
      assert.equal(spans[0], 300);
      spans.length = 0;
      await running.pass();
      assert.equal(spans[0], 600);
      spans.length = 0;
      await running.pass();
      assert.equal(spans[0], 800);
    } finally {
      await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps windows in one pass and reports catching up on /health", async () => {
    const dir = dbDir();
    const head = ESCROW_START_BLOCK + 100;
    let clock = 1_000_000;
    let calls = 0;
    const running = await start({
      once: true,
      serve: true,
      port: 0,
      now: () => clock,
      env: {
        CHAIN_ID: "84532",
        POINTS_DB_PATH: join(dir, "ledger.sqlite"),
        POINTS_LOG_RANGE: "10",
        POINTS_MAX_WINDOWS_PER_PASS: "2",
        POINTS_POLL_MS: "1000",
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs(args) {
          calls += 1;
          assert.equal(args.toBlock - args.fromBlock + 1, 10);
          return [];
        },
      }),
    });
    try {
      assert.equal(calls, 2);
      assert.equal(running.indexer.lastScannedBlock(), ESCROW_START_BLOCK + 19);
      const response = await fetch(running.healthUrl);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.behind, head - (ESCROW_START_BLOCK + 19));
      assert.equal(JSON.stringify(body).includes("http"), false);
      assert.equal(body.error, undefined);
      const again = await running.pass();
      assert.equal(again.ranges[0].fromBlock, ESCROW_START_BLOCK + 20);
      assert.equal(calls, 4);
    } finally {
      await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps serving 503 when the first pass fails and does not reject start", async () => {
    const dir = dbDir();
    let running;
    try {
      running = await start({
        serve: true,
        port: 0,
        env: {
          CHAIN_ID: "84532",
          POINTS_DB_PATH: join(dir, "ledger.sqlite"),
          POINTS_POLL_MS: "60000",
          POINTS_LOG_RANGE: "10",
        },
        rpc: withCode({
          async finalizedBlockNumber() {
            return ESCROW_START_BLOCK + 5;
          },
          async getLogs() {
            throw new Error("boom");
          },
        }),
      });
      assert.equal(running.ingested.ok, false);
      assert.equal(running.ingested.error, "rpc_error");
      const response = await fetch(running.healthUrl);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.error, "rpc_error");
      assert.equal(JSON.stringify(body).includes("boom"), false);
    } finally {
      if (running) await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports ledger_error, config_error, and range_error on /health", async () => {
    const cases = [
      {
        code: "ledger_error",
        range: "10",
        makeError: () => new PointsError("bad_log"),
      },
      {
        code: "config_error",
        range: "10",
        makeError: () => new Error("POINTS_LOG_RANGE must be a positive integer"),
      },
      {
        code: "range_error",
        range: "1",
        makeError: () => new HttpRequestError({
          body: { method: "eth_getLogs" },
          details: "Payload Too Large",
          status: 413,
          url: "https://sepolia.base.org",
        }),
      },
    ];
    for (const item of cases) {
      const dir = dbDir();
      const original = console.error;
      console.error = () => {};
      let calls = 0;
      let running;
      try {
        running = await start({
          serve: true,
          port: 0,
          env: {
            CHAIN_ID: "84532",
            POINTS_DB_PATH: join(dir, "ledger.sqlite"),
            POINTS_POLL_MS: "60000",
            POINTS_LOG_RANGE: item.range,
          },
          rpc: withCode({
            async finalizedBlockNumber() {
              return ESCROW_START_BLOCK;
            },
            async getLogs() {
              calls += 1;
              if (calls > 3) throw new Error("stuck");
              throw item.makeError();
            },
          }),
        });
        assert.equal(running.ingested.ok, false);
        assert.equal(running.ingested.error, item.code);
        const response = await fetch(running.healthUrl);
        assert.equal(response.status, 503);
        const body = await response.json();
        assert.equal(body.ok, false);
        assert.equal(body.error, item.code);
        assert.deepEqual(Object.keys(body).sort(), ["chainId", "error", "ok"]);
      } finally {
        console.error = original;
        if (running) await running.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("poll timer retries after a failed pass and recovers", async () => {
    const dir = dbDir();
    let calls = 0;
    const original = console.error;
    console.error = () => {};
    let running;
    try {
      running = await start({
        serve: true,
        port: 0,
        now: () => 1_000_000,
        env: {
          CHAIN_ID: "84532",
          POINTS_DB_PATH: join(dir, "ledger.sqlite"),
          POINTS_POLL_MS: "20",
          POINTS_LOG_RANGE: "10",
        },
        rpc: withCode({
          async finalizedBlockNumber() {
            return ESCROW_START_BLOCK;
          },
          async getLogs() {
            calls += 1;
            if (calls < 3) throw new Error("transient");
            return [];
          },
        }),
      });
      assert.equal(running.ingested.ok, false);
      const deadline = Date.now() + 2000;
      let status = 0;
      while (Date.now() < deadline) {
        const response = await fetch(running.healthUrl);
        status = response.status;
        await response.text();
        if (status === 200 && calls >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(status, 200);
      assert.ok(calls >= 3);
    } finally {
      console.error = original;
      if (running) await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
