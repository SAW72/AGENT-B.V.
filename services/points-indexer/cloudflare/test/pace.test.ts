import { describe, expect, it } from "vitest";
import { RpcError } from "../src/rpc";
import {
  GETLOGS_MIN_GAP_MS,
  MAX_RETRY_AFTER_MS,
  MAX_SCAN_RETRIES,
  RETRY_BACKOFF_MS,
  RPC_TIMEOUT_MS,
  createRateLimiter,
  createScanPacer,
  jitterMs,
  retryWaitMs,
} from "../src/pace";

describe("getLogs pacing", () => {
  it("keeps the Node pace numbers", () => {
    expect(GETLOGS_MIN_GAP_MS).toBe(200);
    expect([...RETRY_BACKOFF_MS]).toEqual([1_000, 2_000, 4_000]);
    expect(MAX_SCAN_RETRIES).toBe(3);
    expect(MAX_RETRY_AFTER_MS).toBe(30_000);
    expect(RPC_TIMEOUT_MS).toBe(15_000);
  });

  it("waits 1s, then 2s, then 4s, and stops after 3 retries", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const pacer = createScanPacer({
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      jitter: () => 0,
    });
    let attempts = 0;
    const result = await pacer.run(async () => {
      attempts += 1;
      throw new RpcError("rpc_http", { status: 429 });
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("rate_limited");
    expect(attempts).toBe(4);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  it("clamps Retry-After to 30s", () => {
    const error = new RpcError("rpc_http", {
      status: 429,
      headers: new Headers({ "retry-after": "60" }),
    });
    expect(retryWaitMs(error, 0, 0)).toBe(30_000);
  });

  it("keeps at least the 200ms gap and adds jitter on top", async () => {
    let clock = 0;
    const gaps: number[] = [];
    const limiter = createRateLimiter({
      now: () => clock,
      sleep: async (ms) => {
        gaps.push(ms);
        clock += ms;
      },
    });
    await limiter.wait();
    await limiter.wait();
    await limiter.wait();
    expect(gaps.length).toBe(2);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(200);
      expect(gap).toBeLessThan(400);
    }
  });

  it("draws jitter with crypto.getRandomValues", () => {
    const seen = new Set<number>();
    for (let index = 0; index < 24; index += 1) {
      const value = jitterMs();
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(200);
      seen.add(value);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
