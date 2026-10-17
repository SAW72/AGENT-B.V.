import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { HttpRequestError, RpcRequestError } from "viem";
import { baseSepolia } from "viem/chains";
import { ESCROW_START_BLOCK } from "../src/constants.mjs";
import {
  DEFAULT_ESCROW_ADDRESS,
  createDefaultRpc,
  createPointsHttpTransport,
  isRangeError,
  start,
} from "../src/main.mjs";
import { parseRetryAfter } from "../src/pace.mjs";
import { createdLog } from "./support.mjs";

function fakeClock(start = 0) {
  let current = start;
  const sleeps = [];
  return {
    now() {
      return current;
    },
    sleeps,
    async sleep(ms) {
      sleeps.push(ms);
      current += ms;
    },
  };
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

function httpError(status, { details = "", retryAfter } = {}) {
  const headers = new Headers();
  if (retryAfter != null) headers.set("retry-after", String(retryAfter));
  return new HttpRequestError({
    body: { method: "eth_getLogs" },
    details,
    headers,
    status,
    url: "https://sepolia.base.org",
  });
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

function logAt(blockNumber, txHash) {
  return createdLog({
    escrowId: `0x${"11".repeat(32)}`,
    payer: "0x1111111111111111111111111111111111111111",
    payee: "0x2222222222222222222222222222222222222222",
    expiresAt: 10,
    blockNumber,
    logIndex: 1,
    txHash,
    timestamp: 20_000 * 86400,
  });
}

describe("getLogs pace", () => {
  it("waits 200 ms between getLogs calls on a fake clock", async () => {
    const clock = fakeClock(1_000);
    const stamps = [];
    const head = ESCROW_START_BLOCK + 29;
    const running = await start({
      once: true,
      paceNow: clock.now,
      sleep: clock.sleep,
      now: () => 0,
      env: env(),
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs() {
          stamps.push(clock.now());
          return [];
        },
      }),
    });
    try {
      assert.deepEqual(stamps, [1_000, 1_200, 1_400]);
      assert.deepEqual(clock.sleeps, [200, 200]);
      assert.equal(running.ingested.endedEarly, false);
      assert.equal(running.indexer.lastScannedBlock(), head);
    } finally {
      await running.stop();
    }
  });

  it("honors Retry-After seconds and an HTTP-date, capped at 30 seconds", async () => {
    const origin = Date.parse("2026-01-15T00:00:00.000Z");
    assert.equal(parseRetryAfter("7", origin), 7_000);
    assert.equal(parseRetryAfter("0", origin), 0);
    assert.equal(parseRetryAfter("90", origin), 30_000);
    assert.equal(parseRetryAfter(new Date(origin + 12_000).toUTCString(), origin), 12_000);
    assert.equal(parseRetryAfter(new Date(origin + 45_000).toUTCString(), origin), 30_000);
    assert.equal(parseRetryAfter(new Date(origin - 5_000).toUTCString(), origin), 0);
    assert.equal(parseRetryAfter("soon", origin), null);

    const cases = [
      {
        label: "seconds",
        header: () => "7",
        expectWait: 7_000,
      },
      {
        label: "http-date",
        // The first window waits out the 200 ms gap, so start 200 ms early and
        // fail on a whole second. HTTP-date has no milliseconds.
        start: origin - 200,
        header: (now) => new Date(now + 12_000).toUTCString(),
        expectWait: 12_000,
      },
      {
        label: "cap",
        header: () => "90",
        expectWait: 30_000,
      },
      {
        label: "past-date",
        header: (now) => new Date(now - 5_000).toUTCString(),
        expectWait: 0,
      },
      {
        label: "5xx",
        status: 503,
        header: () => "6",
        expectWait: 6_000,
      },
    ];
    for (const item of cases) {
      const clock = fakeClock(item.start ?? origin);
      let failed = false;
      const running = await start({
        once: true,
        paceNow: clock.now,
        sleep: clock.sleep,
        now: () => 5_000_000,
        env: env(),
        rpc: withCode({
          async finalizedBlockNumber() {
            return ESCROW_START_BLOCK + 19;
          },
          async getLogs(args) {
            if (args.fromBlock === ESCROW_START_BLOCK + 10 && !failed) {
              failed = true;
              throw httpError(item.status ?? 429, {
                details: "slow down",
                retryAfter: item.header(clock.now()),
              });
            }
            return [];
          },
        }),
      });
      try {
        assert.equal(running.ingested.endedEarly, false, item.label);
        assert.equal(running.indexer.lastScannedBlock(), ESCROW_START_BLOCK + 19, item.label);
        if (item.expectWait === 0) {
          assert.equal(clock.sleeps.includes(1_000), false, item.label);
          assert.equal(clock.sleeps.includes(7_000), false, item.label);
        } else {
          assert.equal(clock.sleeps.includes(item.expectWait), true, item.label);
          assert.equal(clock.sleeps.includes(1_000), false, item.label);
          assert.equal(clock.sleeps.includes(90_000), false, item.label);
        }
      } finally {
        await running.stop();
      }
    }
  });

  it("backs off 1 s, 2 s, and 4 s for three 429 retries then ends at the last committed window", async () => {
    const clock = fakeClock(0);
    const first = logAt(ESCROW_START_BLOCK, `0x${"a1".repeat(32)}`);
    let fails = 0;
    const original = console.error;
    console.error = () => {};
    let running;
    try {
      running = await start({
        once: true,
        serve: true,
        port: 0,
        paceNow: clock.now,
        sleep: clock.sleep,
        now: () => 5_000_000,
        env: env(),
        rpc: withCode({
          async finalizedBlockNumber() {
            return ESCROW_START_BLOCK + 19;
          },
          async getLogs(args) {
            if (args.fromBlock === ESCROW_START_BLOCK) return [first];
            fails += 1;
            if (fails > 4) throw new Error("unbounded");
            throw httpError(429, { details: "slow down" });
          },
        }),
      });
      assert.equal(running.ingested.ok, true);
      assert.equal(running.ingested.endedEarly, true);
      assert.equal(running.ingested.reason, "rate_limited");
      assert.equal(fails, 4);
      assert.deepEqual(clock.sleeps.filter((ms) => ms >= 1_000), [1_000, 2_000, 4_000]);
      assert.equal(running.indexer.lastScannedBlock(), ESCROW_START_BLOCK + 9);
      assert.equal(running.indexer.rawCount(), 1);
      const stored = running.indexer.db.prepare("SELECT tx_hash FROM raw_logs").all();
      assert.deepEqual(stored.map((row) => row.tx_hash), [first.transactionHash]);
      const response = await fetch(running.healthUrl);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.error, "rate_limited");
      assert.equal(body.chainId, 84532);
      assert.equal(body.behind, 10);
      assert.deepEqual(Object.keys(body).sort(), ["behind", "chainId", "error", "ok"]);
    } finally {
      console.error = original;
      if (running) await running.stop();
    }
  });

  it("backs off the same way on HTTP 5xx and ends the pass early", async () => {
    const clock = fakeClock(0);
    const statuses = [503, 500, 502, 504];
    let fails = 0;
    const original = console.error;
    console.error = () => {};
    let running;
    try {
      running = await start({
        once: true,
        serve: true,
        port: 0,
        paceNow: clock.now,
        sleep: clock.sleep,
        now: () => 5_000_000,
        env: env(),
        rpc: withCode({
          async finalizedBlockNumber() {
            return ESCROW_START_BLOCK + 9;
          },
          async getLogs() {
            fails += 1;
            if (fails > 4) throw new Error("unbounded");
            throw httpError(statuses[fails - 1] ?? 500, { details: "unavailable" });
          },
        }),
      });
      assert.equal(running.ingested.endedEarly, true);
      assert.equal(running.ingested.reason, "server_error");
      assert.equal(fails, 4);
      assert.deepEqual(clock.sleeps, [1_000, 2_000, 4_000]);
      assert.equal(running.indexer.lastScannedBlock(), null);
      assert.equal(running.indexer.rawCount(), 0);
      const response = await fetch(running.healthUrl);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.error, "server_error");
      assert.deepEqual(Object.keys(body).sort(), ["chainId", "error", "ok"]);
    } finally {
      console.error = original;
      if (running) await running.stop();
    }
  });

  it("commits windows before a mid-pass 429 and 5xx and resumes on the next pass", async () => {
    const clock = fakeClock(0);
    const head = ESCROW_START_BLOCK + 39;
    const failFrom = ESCROW_START_BLOCK + 20;
    const first = logAt(ESCROW_START_BLOCK, `0x${"a1".repeat(32)}`);
    const later = logAt(failFrom, `0x${"b2".repeat(32)}`);
    let phase = "burst";
    const calls = [];
    const original = console.error;
    console.error = () => {};
    let running;
    try {
      running = await start({
        once: true,
        serve: true,
        port: 0,
        paceNow: clock.now,
        sleep: clock.sleep,
        now: () => 5_000_000,
        env: env(),
        rpc: withCode({
          async finalizedBlockNumber() {
            return head;
          },
          async getLogs(args) {
            calls.push(args.fromBlock);
            if (phase === "burst" && args.fromBlock > failFrom) throw new Error("scanned past the failed window");
            if (phase === "burst" && args.fromBlock === failFrom) {
              const n = calls.filter((from) => from === failFrom).length;
              if (n === 1) throw httpError(429, { details: "rate limit exceeded" });
              if (n === 2) throw httpError(503, { details: "unavailable" });
              if (n === 3) throw httpError(500, { details: "unavailable" });
              if (n === 4) throw httpError(502, { details: "unavailable" });
              throw new Error("unbounded");
            }
            if (args.fromBlock === ESCROW_START_BLOCK) return [first];
            if (args.fromBlock === failFrom) return [later];
            return [];
          },
        }),
      });
      assert.equal(running.ingested.ok, true);
      assert.equal(running.ingested.endedEarly, true);
      assert.equal(running.ingested.reason, "server_error");
      assert.deepEqual(running.ingested.ranges, [
        { fromBlock: ESCROW_START_BLOCK, toBlock: ESCROW_START_BLOCK + 9 },
        { fromBlock: ESCROW_START_BLOCK + 10, toBlock: ESCROW_START_BLOCK + 19 },
      ]);
      assert.equal(calls.filter((from) => from === failFrom).length, 4);
      assert.equal(calls.some((from) => from > failFrom), false);
      assert.equal(running.indexer.lastScannedBlock(), ESCROW_START_BLOCK + 19);
      assert.deepEqual(
        running.indexer.db.prepare("SELECT tx_hash FROM raw_logs").all().map((row) => row.tx_hash),
        [first.transactionHash],
      );
      const early = await fetch(running.healthUrl);
      assert.equal(early.status, 200);
      const earlyBody = await early.json();
      assert.equal(earlyBody.error, "server_error");
      assert.equal(earlyBody.ok, true);
      assert.deepEqual(clock.sleeps.filter((ms) => ms >= 1_000), [1_000, 2_000, 4_000]);

      phase = "resume";
      const again = await running.pass();
      assert.equal(again.endedEarly, false);
      assert.equal(again.ok, true);
      assert.equal(again.ranges[0].fromBlock, failFrom);
      assert.equal(running.indexer.lastScannedBlock(), head);
      const hashes = running.indexer.db.prepare("SELECT tx_hash FROM raw_logs ORDER BY block_number").all()
        .map((row) => row.tx_hash);
      assert.deepEqual(hashes, [first.transactionHash, later.transactionHash]);
      const fresh = await fetch(running.healthUrl);
      assert.equal(fresh.status, 200);
      const freshBody = await fresh.json();
      assert.equal(freshBody.error, undefined);
      assert.equal(freshBody.ok, true);
    } finally {
      console.error = original;
      if (running) await running.stop();
    }
  });

  it("the poll loop runs the next pass after an early end", async () => {
    const clock = fakeClock(0);
    let fail = true;
    let calls = 0;
    const original = console.error;
    console.error = () => {};
    let running;
    try {
      running = await start({
        serve: true,
        port: 0,
        paceNow: clock.now,
        sleep: clock.sleep,
        now: () => 8_000_000,
        env: env({ POINTS_POLL_MS: "40", POINTS_LOG_RANGE: "10" }),
        rpc: withCode({
          async finalizedBlockNumber() {
            return ESCROW_START_BLOCK + 4;
          },
          async getLogs() {
            calls += 1;
            if (fail) {
              if (calls > 12) throw new Error("unbounded");
              throw httpError(429, { retryAfter: "0" });
            }
            return [];
          },
        }),
      });
      assert.equal(running.ingested.endedEarly, true);
      assert.equal(running.ingested.reason, "rate_limited");
      assert.equal(running.indexer.lastScannedBlock(), null);
      const earlyCalls = calls;
      fail = false;
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if (running.indexer.lastScannedBlock() === ESCROW_START_BLOCK + 4) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(running.indexer.lastScannedBlock(), ESCROW_START_BLOCK + 4);
      assert.ok(calls > earlyCalls);
      const response = await fetch(running.healthUrl);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.error, undefined);
    } finally {
      console.error = original;
      if (running) await running.stop();
    }
  });

  it("does not treat a 429 or rate-limit text as a range error", async () => {
    const exceeded = httpError(429, { details: "You have exceeded the rate limit" });
    assert.equal(isRangeError(exceeded), false);
    const cap = httpError(429, { details: "query exceeded the cap" });
    assert.equal(isRangeError(cap), false);
    const coded = new RpcRequestError({
      body: { method: "eth_getLogs" },
      error: { code: -32005, message: "rate limit exceeded" },
      url: "https://sepolia.base.org",
    });
    assert.match(String(coded.details), /exceed/);
    assert.equal(isRangeError(coded), false);
    const requests = new Error("slow");
    requests.details = "too many requests";
    assert.equal(isRangeError(requests), false);

    const clock = fakeClock(0);
    const spans = [];
    const original = console.error;
    console.error = () => {};
    let running;
    try {
      running = await start({
        once: true,
        paceNow: clock.now,
        sleep: clock.sleep,
        now: () => 1,
        env: env({ POINTS_LOG_RANGE: "8" }),
        rpc: withCode({
          async finalizedBlockNumber() {
            return ESCROW_START_BLOCK + 7;
          },
          async getLogs(args) {
            spans.push(args.toBlock - args.fromBlock + 1);
            if (spans.length > 4) throw new Error("unbounded");
            throw httpError(429, { details: "You have exceeded the rate limit" });
          },
        }),
      });
      assert.deepEqual(spans, [8, 8, 8, 8]);
      assert.equal(running.ingested.endedEarly, true);
      assert.equal(running.ingested.reason, "rate_limited");
      assert.equal(running.indexer.lastScannedBlock(), null);
    } finally {
      console.error = original;
      if (running) await running.stop();
    }
  });

  it("still treats a real range error as a range error", async () => {
    const exceeded = new RpcRequestError({
      body: { method: "eth_getLogs" },
      error: { code: -32602, message: "block range exceeded" },
      url: "https://sepolia.base.org",
    });
    assert.equal(isRangeError(exceeded), true);
    const onlyExceed = new Error("wide");
    onlyExceed.details = "query exceeded the cap";
    assert.equal(isRangeError(onlyExceed), true);
    const payload = new HttpRequestError({
      status: 413,
      details: "Payload Too Large",
      url: "https://sepolia.base.org",
      body: {},
    });
    assert.equal(isRangeError(payload), true);
    const coded = new RpcRequestError({
      body: { method: "eth_getLogs" },
      error: { code: -32614, message: "eth_getLogs is limited to a 2 range" },
      url: "https://sepolia.base.org",
    });
    assert.equal(isRangeError(coded), true);

    const clock = fakeClock(0);
    const spans = [];
    const running = await start({
      once: true,
      paceNow: clock.now,
      sleep: clock.sleep,
      now: () => 1,
      env: env({ POINTS_LOG_RANGE: "4" }),
      rpc: withCode({
        async finalizedBlockNumber() {
          return ESCROW_START_BLOCK + 3;
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
      assert.equal(running.ingested.endedEarly, false);
      assert.equal(running.indexer.lastScannedBlock(), ESCROW_START_BLOCK + 3);
    } finally {
      await running.stop();
    }
  });

  it("builds the points HTTP transport with retryCount 0", () => {
    const built = createPointsHttpTransport("https://sepolia.base.org")({
      chain: baseSepolia,
    });
    assert.equal(built.config.retryCount, 0);
  });

  it("preserves HTTP 429 status and Retry-After on the points transport", async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      req.resume();
      hits += 1;
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "9",
      });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32005, message: "rate limit exceeded" },
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const rpc = createDefaultRpc(url);
      const error = await rpc.getLogs({
        fromBlock: ESCROW_START_BLOCK,
        toBlock: ESCROW_START_BLOCK,
        address: DEFAULT_ESCROW_ADDRESS,
      }).then(() => null, (caught) => caught);
      assert.equal(error.status, 429);
      assert.equal(error.headers.get("retry-after"), "9");
      assert.equal(isRangeError(error), false);
      assert.equal(hits, 1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
