import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createFileIntentNonceStore, createMemoryIntentNonceStore } from "../intentNonceStore.mjs";

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
});
