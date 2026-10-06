import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backoffMs, isTransientClaimError, withClaimRetry } from "../retry.mjs";

describe("claim retry bounds", () => {
  it("classifies RPC and nonce races as transient, and claim or chain errors as permanent", () => {
    assert.equal(isTransientClaimError(new Error("HTTP 429 too many requests")), true);
    assert.equal(isTransientClaimError({ shortMessage: "replacement transaction underpriced" }), true);
    assert.equal(isTransientClaimError({ message: "nonce too low" }), true);
    assert.equal(isTransientClaimError(new Error("fetch failed")), true);
    assert.equal(isTransientClaimError(new Error("InvalidSignature")), false);
    assert.equal(isTransientClaimError(new Error("live_submit_blocked")), false);
    assert.equal(isTransientClaimError(new Error("mainnet_refused")), false);
    assert.equal(isTransientClaimError(new Error("wrong_chain")), false);
    assert.equal(isTransientClaimError(new Error("simulation_failed")), false);
    assert.equal(isTransientClaimError(new Error("kill_switch")), false);
    assert.equal(isTransientClaimError(new Error("HTTP 502 Bad Gateway")), true);
    assert.equal(isTransientClaimError(new Error("503 Service Unavailable")), true);
    assert.equal(isTransientClaimError(new Error("status 504")), true);
    assert.equal(isTransientClaimError(new Error("bad gateway")), true);
    assert.equal(isTransientClaimError(new Error("service unavailable")), true);
    assert.equal(isTransientClaimError(new Error("gateway timeout")), true);
    assert.equal(
      isTransientClaimError(
        new Error("execution reverted to 0x3d660502d75f1e97b08c110255921b437a3c4c42"),
      ),
      false,
    );
  });

  it("uses bounded exponential backoff", () => {
    assert.equal(backoffMs(1, 200), 200);
    assert.equal(backoffMs(2, 200), 400);
    assert.equal(backoffMs(3, 200), 800);
  });

  it("retries transient failures then succeeds", async () => {
    const delays = [];
    let n = 0;
    const logs = [];
    const result = await withClaimRetry(
      async () => {
        n += 1;
        if (n < 3) throw new Error("timeout connecting to rpc");
        return "0xabc";
      },
      {
        maxAttempts: 4,
        baseDelayMs: 10,
        sleep: async (ms) => {
          delays.push(ms);
        },
        log: (info) => logs.push(info),
      },
    );
    assert.equal(result, "0xabc");
    assert.equal(n, 3);
    assert.deepEqual(delays, [10, 20]);
    assert.equal(logs.length, 2);
    assert.equal(logs[0].transient, true);
    assert.equal(logs[0].event, "claim_retry");
  });

  it("does not retry permanent errors", async () => {
    let n = 0;
    await assert.rejects(
      () =>
        withClaimRetry(
          async () => {
            n += 1;
            throw new Error("live_submit_blocked");
          },
          { maxAttempts: 5, sleep: async () => assert.fail("should not sleep") },
        ),
      /live_submit_blocked/,
    );
    assert.equal(n, 1);
  });

  it("stops after maxAttempts on persistent transient errors", async () => {
    let n = 0;
    await assert.rejects(
      () =>
        withClaimRetry(
          async () => {
            n += 1;
            throw Object.assign(new Error("503"), { code: "ETIMEDOUT" });
          },
          { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
        ),
      /503/,
    );
    assert.equal(n, 3);
  });
});
