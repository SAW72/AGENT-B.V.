import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createAbuseGuard } from "../abuseLimits.mjs";
import { createClaimRelayer } from "../app.mjs";
import { createClaimLog } from "../claimLog.mjs";
import { loadConfig } from "../config.mjs";
import { TEST_EDGE_AUTH, edgeRequestHeaders } from "./edgeHeader.mjs";
import { createFileIntentNonceStore, createMemoryIntentNonceStore } from "../intentNonceStore.mjs";
import { createKillSwitch } from "../killSwitch.mjs";
import { createNonceStore } from "../nonceStore.mjs";
import { clearSanctionsGate } from "./clearGate.mjs";
import { NOW_MS, deadlineAt, signedLiveBody, testAccounts, trackingChain } from "./liveIntent.mjs";

function request(port, method, path, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...edgeRequestHeaders(),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, raw });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("intent nonce store", () => {
  it("returns a stored result for a replay and does not mint a second fresh claim", async () => {
    const store = createMemoryIntentNonceStore({ now: () => 1_000 });
    const first = await store.claim({ key: "0xabc:1", ttlMs: 300_000, atMs: 1_000 });
    assert.equal(first.kind, "fresh");
    const pending = await store.claim({ key: "0xabc:1", ttlMs: 300_000, atMs: 1_100 });
    assert.equal(pending.kind, "pending");
    await store.commit("0xabc:1", { status: 200, body: { ok: true, txHash: "0x" + "ab".repeat(32) } });
    const replay = await store.claim({ key: "0xabc:1", ttlMs: 300_000, atMs: 1_200 });
    assert.equal(replay.kind, "replay");
    assert.equal(replay.result.body.txHash, "0x" + "ab".repeat(32));
  });

  it("reloads a file-backed result after a new store is opened", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intent-nonce-"));
    const filePath = join(dir, "nonces.jsonl");
    const first = createFileIntentNonceStore({ filePath, now: () => 5_000 });
    await first.ready();
    const claimed = await first.claim({ key: "0xdef:9", ttlMs: 300_000, atMs: 5_000 });
    assert.equal(claimed.kind, "fresh");
    await first.commit("0xdef:9", { status: 200, body: { txHash: "0x" + "cd".repeat(32) } });

    const second = createFileIntentNonceStore({ filePath, now: () => 6_000 });
    await second.ready();
    const replay = await second.claim({ key: "0xdef:9", ttlMs: 300_000, atMs: 6_000 });
    assert.equal(replay.kind, "replay");
    assert.equal(replay.result.status, 200);
    assert.equal(replay.result.body.txHash, "0x" + "cd".repeat(32));
  });

  it("reloads a pending nonce so a restart cannot broadcast it twice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intent-nonce-pending-"));
    const filePath = join(dir, "nonces.jsonl");
    const first = createFileIntentNonceStore({ filePath, now: () => 5_000 });
    await first.ready();
    const claimed = await first.claim({ key: "0xdef:4", ttlMs: 300_000, atMs: 5_000 });
    assert.equal(claimed.kind, "fresh");

    const second = createFileIntentNonceStore({ filePath, now: () => 6_000 });
    await second.ready();
    const pending = await second.claim({ key: "0xdef:4", ttlMs: 300_000, atMs: 6_000 });
    assert.equal(pending.kind, "pending");
  });

  it("fails closed when the nonce file cannot be written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intent-nonce-blocked-"));
    const filePath = join(dir, "nonces.jsonl");
    const store = createFileIntentNonceStore({ filePath, now: () => NOW_MS });
    await store.ready();
    await mkdir(filePath);

    const accounts = testAccounts();
    let broadcasts = 0;
    const broadcaster = {
      async send() {
        broadcasts += 1;
        return { txHash: "0x" + "ab".repeat(32) };
      },
    };
    const config = loadConfig({
      CLAIM_LOG_PATH: join(dir, "claims.jsonl"),
      LIVE_SUBMIT: "1",
      SPENCER_RUN_AUTH: "1",
      RELAYER_EDGE_AUTH: TEST_EDGE_AUTH,
    });
    const server = createClaimRelayer({
      config,
      killSwitch: createKillSwitch({ initial: false }),
      nonceStore: createNonceStore(),
      intentNonces: store,
      abuse: createAbuseGuard(config.abuse, { now: () => NOW_MS }),
      chain: trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address }),
      claimLog: createClaimLog({ filePath: join(dir, "claims.jsonl") }),
      broadcaster,
      now: () => NOW_MS,
      sanctions: clearSanctionsGate(NOW_MS),
      edgeCountry: "US",
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const body = await signedLiveBody({
        account: accounts.payer,
        action: "refund",
        escrowId: "0x" + "11".repeat(32),
        nonce: "7",
        deadline: deadlineAt(120),
      });
      const first = await request(server.address().port, "POST", "/v1/claims", body);
      assert.equal(first.status, 500);
      assert.equal(first.json.error, "request_failed");
      assert.equal(broadcasts, 0);

      const second = await request(server.address().port, "POST", "/v1/claims", body);
      assert.equal(second.status, 409);
      assert.equal(second.json.error, "nonce_in_flight");
      assert.equal(broadcasts, 0);
    } finally {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
