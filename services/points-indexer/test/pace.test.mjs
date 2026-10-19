import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { HttpRequestError, RpcRequestError } from "viem";
import { baseSepolia } from "viem/chains";
import { ESCROW_START_BLOCK } from "../src/constants.mjs";
import {
  DEFAULT_ESCROW_ADDRESS,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  createDefaultRpc,
  createPointsHttpTransport,
  errorCode,
  isRangeError,
  loadPaceSettings,
  start,
} from "../src/main.mjs";
import {
  GETLOGS_MIN_GAP_MS,
  MAX_RETRY_AFTER_MS,
  MAX_SCAN_RETRIES,
  RETRY_BACKOFF_MS,
  createRateLimiter,
  jitterMs,
  parseRetryAfter,
  retryWaitMs,
  scanErrorClass,
} from "../src/pace.mjs";
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
      assert.deepEqual(stamps, [1_800, 2_000, 2_200]);
      assert.deepEqual(clock.sleeps, [200, 200, 200, 200, 200, 200]);
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
        // Startup reads and the first window each take the 200 ms gap, so the
        // failing call lands 1000 ms after the start. HTTP-date has no milliseconds.
        start: origin - 1_000,
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
        wallNow: clock.now,
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
      assert.deepEqual(clock.sleeps.filter((ms) => ms >= 1_000), [1_000, 2_000, 4_000]);
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

  it("keeps the pace defaults and falls back when an env value is invalid", () => {
    const pace = loadPaceSettings({});
    assert.equal(pace.minGapMs, GETLOGS_MIN_GAP_MS);
    assert.equal(pace.minGapMs, 200);
    assert.deepEqual(pace.backoffMs, [...RETRY_BACKOFF_MS]);
    assert.deepEqual(pace.backoffMs, [1_000, 2_000, 4_000]);
    assert.equal(pace.maxRetries, MAX_SCAN_RETRIES);
    assert.equal(pace.maxRetries, 3);
    assert.equal(pace.maxRetryAfterMs, MAX_RETRY_AFTER_MS);
    assert.equal(pace.maxRetryAfterMs, 30_000);
    assert.equal(pace.gapJitterMs, 0);
    assert.equal(pace.backoffJitterMs, 0);
    assert.equal(pace.httpTimeoutMs, DEFAULT_HTTP_TIMEOUT_MS);
    assert.equal(pace.httpTimeoutMs, 10_000);
    assert.equal(pace.freshnessPolls, 3);
    assert.equal(pace.maxWindowsPerRun, null);
    assert.equal(pace.userAgent, DEFAULT_USER_AGENT);

    const bad = loadPaceSettings({
      POINTS_GETLOGS_MIN_GAP_MS: "nope",
      POINTS_RETRY_BACKOFF_MS: "1,x,3",
      POINTS_MAX_SCAN_RETRIES: "0",
      POINTS_MAX_RETRY_AFTER_MS: "-5",
      POINTS_GETLOGS_GAP_JITTER_MS: "abc",
      POINTS_RETRY_BACKOFF_JITTER_MS: "-1",
      POINTS_HTTP_TIMEOUT_MS: "10.5",
      POINTS_HEALTH_FRESHNESS_POLLS: "0",
      POINTS_MAX_WINDOWS_PER_RUN: "nope",
      POINTS_USER_AGENT: "   ",
    });
    assert.equal(bad.minGapMs, 200);
    assert.deepEqual(bad.backoffMs, [1_000, 2_000, 4_000]);
    assert.equal(bad.maxRetries, 3);
    assert.equal(bad.maxRetryAfterMs, 30_000);
    assert.equal(bad.gapJitterMs, 0);
    assert.equal(bad.backoffJitterMs, 0);
    assert.equal(bad.httpTimeoutMs, 10_000);
    assert.equal(bad.freshnessPolls, 3);
    assert.equal(bad.maxWindowsPerRun, null);
    assert.equal(bad.userAgent, DEFAULT_USER_AGENT);

    const custom = loadPaceSettings({
      POINTS_GETLOGS_MIN_GAP_MS: "200",
      POINTS_RETRY_BACKOFF_MS: "1000,2000,4000",
      POINTS_MAX_SCAN_RETRIES: "3",
      POINTS_MAX_RETRY_AFTER_MS: "30000",
      POINTS_HTTP_TIMEOUT_MS: "10000",
      POINTS_HEALTH_FRESHNESS_POLLS: "3",
      POINTS_MAX_WINDOWS_PER_RUN: "40",
    });
    assert.equal(custom.minGapMs, 200);
    assert.deepEqual(custom.backoffMs, [1_000, 2_000, 4_000]);
    assert.equal(custom.maxRetries, 3);
    assert.equal(custom.maxRetryAfterMs, 30_000);
    assert.equal(custom.httpTimeoutMs, 10_000);
    assert.equal(custom.freshnessPolls, 3);
    assert.equal(custom.maxWindowsPerRun, 40);
  });

  it("uses the gap from POINTS_GETLOGS_MIN_GAP_MS", async () => {
    const clock = fakeClock(0);
    const running = await start({
      once: true,
      paceNow: clock.now,
      sleep: clock.sleep,
      now: () => 1,
      env: env({ POINTS_GETLOGS_MIN_GAP_MS: "50", POINTS_LOG_RANGE: "10" }),
      rpc: withCode({
        async finalizedBlockNumber() {
          return ESCROW_START_BLOCK + 9;
        },
        async getLogs() {
          return [];
        },
      }),
    });
    try {
      assert.deepEqual(clock.sleeps, [50, 50, 50, 50]);
      assert.equal(running.ingested.endedEarly, false);
    } finally {
      await running.stop();
    }
  });

  it("adds jitter on top of the gap and the schedule, not on Retry-After", async () => {
    assert.equal(jitterMs(0, () => 0.9), 0);
    assert.equal(jitterMs(10, () => 0), 0);
    assert.equal(jitterMs(10, () => 0.5), 5);
    const clock = fakeClock(0);
    const limiter = createRateLimiter({
      now: clock.now,
      sleep: clock.sleep,
      minGapMs: 200,
      gapJitterMs: 10,
      random: () => 0.5,
    });
    await limiter.wait();
    await limiter.wait();
    assert.deepEqual(clock.sleeps, [205]);
    const paced = httpError(429, { retryAfter: "7" });
    assert.equal(retryWaitMs(paced, 0, 0, { backoffJitterMs: 50, random: () => 0.9 }), 7_000);
    const bare = httpError(500, {});
    assert.equal(retryWaitMs(bare, 0, 0, { backoffJitterMs: 50, random: () => 0.5 }), 1_025);
    assert.equal(retryWaitMs(bare, 1, 0, {}), 2_000);
  });

  it("retries -32005 request rate exceeded without shrinking the window", async () => {
    const coded = new RpcRequestError({
      body: { method: "eth_getLogs" },
      error: { code: -32005, message: "request rate exceeded" },
      url: "http://127.0.0.1",
    });
    assert.match(String(coded.details), /rate exceeded/);
    assert.equal(isRangeError(coded), false);
    assert.equal(scanErrorClass(coded), "rate_limited");
    assert.equal(errorCode(coded), "rate_limited");
    for (const details of ["compute units exhausted", "over capacity"]) {
      const error = new Error("slow");
      error.details = details;
      assert.equal(isRangeError(error), false, details);
      assert.equal(scanErrorClass(error), "rate_limited", details);
    }

    const clock = fakeClock(0);
    const spans = [];
    let failed = false;
    const running = await start({
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
          if (!failed) {
            failed = true;
            throw coded;
          }
          return [];
        },
      }),
    });
    try {
      assert.deepEqual(spans, [8, 8]);
      assert.equal(running.ingested.endedEarly, false);
      assert.equal(running.indexer.lastScannedBlock(), ESCROW_START_BLOCK + 7);
    } finally {
      await running.stop();
    }
  });

  it("waits on -32602 beyond the current head and does not shrink the window", async () => {
    const lag = new RpcRequestError({
      body: { method: "eth_getLogs" },
      error: { code: -32602, message: "block range extends beyond current head block" },
      url: "http://127.0.0.1",
    });
    assert.equal(isRangeError(lag), false);
    assert.equal(scanErrorClass(lag), "head_lag");
    assert.equal(errorCode(lag), "head_lag");
    const tooLarge = new RpcRequestError({
      body: { method: "eth_getLogs" },
      error: { code: -32602, message: "block range is too large" },
      url: "http://127.0.0.1",
    });
    assert.equal(isRangeError(tooLarge), true);
    assert.equal(scanErrorClass(tooLarge), null);

    const clock = fakeClock(0);
    const spans = [];
    let failed = false;
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
            if (!failed) {
              failed = true;
              throw lag;
            }
            return [];
          },
        }),
      });
      assert.deepEqual(spans, [8, 8]);
      assert.equal(running.ingested.endedEarly, false);
      assert.deepEqual(clock.sleeps.filter((ms) => ms >= 1_000), [1_000]);
      assert.equal(running.indexer.lastScannedBlock(), ESCROW_START_BLOCK + 7);
    } finally {
      console.error = original;
      if (running) await running.stop();
    }
  });

  it("retries one 429 from chainId and from getCode without stopping", async () => {
    const clock = fakeClock(0);
    let chains = 0;
    let codes = 0;
    const running = await start({
      once: true,
      paceNow: clock.now,
      sleep: clock.sleep,
      now: () => 1,
      env: env({ POINTS_LOG_RANGE: "10" }),
      rpc: withCode({
        async chainId() {
          chains += 1;
          if (chains === 1) throw httpError(429, { details: "slow down" });
          return 84532;
        },
        async getCode() {
          codes += 1;
          if (codes === 1) throw httpError(429, { details: "slow down" });
          return "0x6001600055";
        },
        async finalizedBlockNumber() {
          return ESCROW_START_BLOCK - 1;
        },
        async getLogs() {
          throw new Error("logs should not be read");
        },
      }),
    });
    try {
      assert.equal(chains, 2);
      assert.equal(codes, 3);
      assert.equal(running.ingested.endedEarly, false);
      assert.deepEqual(clock.sleeps.filter((ms) => ms >= 1_000), [1_000, 1_000]);
    } finally {
      await running.stop();
    }
  });

  it("ends the pass when the finalized head stays rate limited", async () => {
    const clock = fakeClock(0);
    let heads = 0;
    let logs = 0;
    const original = console.error;
    console.error = () => {};
    let running;
    try {
      running = await start({
        once: true,
        paceNow: clock.now,
        sleep: clock.sleep,
        now: () => 1,
        env: env(),
        rpc: withCode({
          async finalizedBlockNumber() {
            heads += 1;
            throw httpError(429, { details: "slow down" });
          },
          async getLogs() {
            logs += 1;
            return [];
          },
        }),
      });
      assert.equal(running.ingested.ok, true);
      assert.equal(running.ingested.endedEarly, true);
      assert.equal(running.ingested.reason, "rate_limited");
      assert.equal(heads, 4);
      assert.equal(logs, 0);
      assert.equal(running.indexer, null);
      assert.equal(running.ingested.scannedThrough, null);
      assert.deepEqual(clock.sleeps.filter((ms) => ms >= 1_000), [1_000, 2_000, 4_000]);
    } finally {
      console.error = original;
      if (running) await running.stop();
    }
  });

  it("keeps the getLogs gap when the wall clock jumps", async () => {
    let mono = 5_000;
    let wall = Date.parse("2026-01-15T00:00:00.000Z");
    const sleeps = [];
    const stamps = [];
    const paceNow = () => mono;
    const wallNow = () => wall;
    const sleep = async (ms) => {
      sleeps.push(ms);
      mono += ms;
    };
    const head = ESCROW_START_BLOCK + 29;
    const running = await start({
      once: true,
      paceNow,
      wallNow,
      sleep,
      now: () => mono,
      env: env(),
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs() {
          wall += 86_400_000;
          stamps.push(mono);
          return [];
        },
      }),
    });
    try {
      assert.deepEqual(stamps, [5_800, 6_000, 6_200]);
      assert.deepEqual(sleeps, [200, 200, 200, 200, 200, 200]);
      assert.equal(running.ingested.endedEarly, false);
    } finally {
      await running.stop();
    }
  });

  it("sends a User-Agent and keeps status on a non-JSON 429 or 502 body", async () => {
    let mode = "429";
    const agents = [];
    const server = createServer(async (req, res) => {
      agents.push(req.headers["user-agent"]);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const send = (payload) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, ...payload }));
      };
      if (body.method === "eth_chainId") return send({ result: "0x14a34" });
      if (body.method === "eth_getCode") return send({ result: "0x60016000" });
      if (body.method === "eth_blockNumber") return send({ result: `0x${(ESCROW_START_BLOCK + 4).toString(16)}` });
      if (body.method === "eth_getLogs") {
        if (mode === "429") {
          res.writeHead(429, { "content-type": "text/plain", "retry-after": "3" });
          res.end("request rate exceeded but not json");
          return;
        }
        if (mode === "502") {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end("bad gateway");
          return;
        }
        return send({ result: [] });
      }
      send({ error: { code: -32601, message: "unhandled" } });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}`;
    const clock = fakeClock(0);
    let running;
    try {
      const rpc = createDefaultRpc(url);
      const limited = await rpc.getLogs({
        fromBlock: ESCROW_START_BLOCK,
        toBlock: ESCROW_START_BLOCK,
        address: DEFAULT_ESCROW_ADDRESS,
      }).then(() => null, (caught) => caught);
      assert.equal(limited.status, 429);
      assert.equal(limited.details, "request rate exceeded but not json");
      assert.equal(isRangeError(limited), false);
      assert.equal(scanErrorClass(limited), "rate_limited");
      assert.equal(errorCode(limited), "rate_limited");
      mode = "502";
      const unavailable = await rpc.getLogs({
        fromBlock: ESCROW_START_BLOCK,
        toBlock: ESCROW_START_BLOCK,
        address: DEFAULT_ESCROW_ADDRESS,
      }).then(() => null, (caught) => caught);
      assert.equal(unavailable.status, 502);
      assert.equal(unavailable.details, "bad gateway");
      assert.equal(scanErrorClass(unavailable), "server_error");
      assert.ok(agents.length >= 2);
      assert.ok(agents.every((agent) => agent === DEFAULT_USER_AGENT));

      let logs = 0;
      const flaky = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        const send = (payload) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, ...payload }));
        };
        if (body.method === "eth_chainId") return send({ result: "0x14a34" });
        if (body.method === "eth_getCode") return send({ result: "0x60016000" });
        if (body.method === "eth_blockNumber") return send({ result: `0x${(ESCROW_START_BLOCK + 4).toString(16)}` });
        if (body.method === "eth_getLogs") {
          logs += 1;
          if (logs === 1) {
            res.writeHead(429, { "content-type": "text/plain" });
            res.end("nope not json");
            return;
          }
          if (logs === 2) {
            res.writeHead(502, { "content-type": "text/plain" });
            res.end("still not json");
            return;
          }
          return send({ result: [] });
        }
        send({ error: { code: -32601, message: "unhandled" } });
      });
      await new Promise((resolve) => flaky.listen(0, "127.0.0.1", resolve));
      const flakyUrl = `http://127.0.0.1:${flaky.address().port}`;
      try {
        running = await start({
          once: true,
          paceNow: clock.now,
          wallNow: clock.now,
          sleep: clock.sleep,
          now: () => 1,
          env: env({ BASE_SEPOLIA_RPC_URL: flakyUrl, POINTS_LOG_RANGE: "10" }),
        });
        assert.equal(running.ingested.endedEarly, false);
        assert.equal(logs, 3);
        assert.equal(running.indexer.lastScannedBlock(), ESCROW_START_BLOCK + 4);
        assert.equal(clock.sleeps.includes(1_000), true);
        assert.equal(clock.sleeps.includes(2_000), true);
      } finally {
        await new Promise((resolve) => flaky.close(resolve));
      }
    } finally {
      if (running) await running.stop();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("stops further windows after POINTS_MAX_WINDOWS_PER_RUN in the same process", async () => {
    const clock = fakeClock(0);
    const head = ESCROW_START_BLOCK + 99;
    let calls = 0;
    const running = await start({
      once: true,
      paceNow: clock.now,
      sleep: clock.sleep,
      now: () => 1,
      env: env({ POINTS_MAX_WINDOWS_PER_RUN: "2", POINTS_LOG_RANGE: "10" }),
      rpc: withCode({
        async finalizedBlockNumber() {
          return head;
        },
        async getLogs() {
          calls += 1;
          return [];
        },
      }),
    });
    try {
      assert.equal(calls, 2);
      assert.equal(running.ingested.endedEarly, false);
      assert.equal(running.indexer.lastScannedBlock(), ESCROW_START_BLOCK + 19);
      const again = await running.pass();
      assert.equal(again.endedEarly, false);
      assert.equal(again.ranges.length, 0);
      assert.equal(calls, 2);
      assert.equal(running.indexer.lastScannedBlock(), ESCROW_START_BLOCK + 19);
    } finally {
      await running.stop();
    }
  });

  it("leaves the HTTP timeout at 10000 unless the transport is told otherwise", () => {
    const built = createPointsHttpTransport("http://127.0.0.1:9")({
      chain: baseSepolia,
    });
    assert.equal(built.config.retryCount, 0);
    assert.equal(built.config.timeout, 10_000);
  });
});
