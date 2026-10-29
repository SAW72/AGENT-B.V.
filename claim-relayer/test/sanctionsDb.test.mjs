import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assertFileSanctionsDb, startServer } from "../server.mjs";
import { SANCTIONS_REFRESH_EVERY_MS, startSanctionsRefresh } from "../sanctionsRefresh.mjs";

describe("production sanctions database", () => {
  it("refuses to start without a file path", () => {
    assert.throws(() => assertFileSanctionsDb(""), /sanctions_db_path_required/);
    assert.throws(() => assertFileSanctionsDb(":memory:"), /sanctions_db_path_required/);
    assert.throws(() => assertFileSanctionsDb("file:mem?mode=memory"), /sanctions_db_path_required/);
    assert.throws(() => startServer({ SANCTIONS_DB_PATH: "" }), /sanctions_db_path_required/);
    assert.throws(() => startServer({}), /sanctions_db_path_required/);
  });

  it("refreshes at start and schedules the next refresh 12 hours later", async () => {
    const calls = [];
    const timers = [];
    const gate = {
      async refresh(fetchImpl) {
        calls.push(fetchImpl);
        return { refreshed: true };
      },
    };
    const refresh = startSanctionsRefresh(gate, {
      fetchImpl: async () => ({ ok: false }),
      setInterval(fn, ms) {
        timers.push({ fn, ms });
        return { unref() {} };
      },
      clearInterval() {},
    });
    await refresh.started;
    assert.equal(calls.length, 1);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, SANCTIONS_REFRESH_EVERY_MS);
    assert.equal(SANCTIONS_REFRESH_EVERY_MS, 12 * 60 * 60 * 1000);
    await timers[0].fn();
    assert.equal(calls.length, 2);
    refresh.stop();
  });

  it("startServer opens a file database and refreshes at boot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sanctions-db-"));
    const calls = [];
    const previous = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response("nope", { status: 503 });
    };
    const probe = net.createServer();
    const port = await new Promise((resolve, reject) => {
      probe.listen(0, "127.0.0.1", () => resolve(probe.address().port));
      probe.on("error", reject);
    });
    await new Promise((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
    let server;
    try {
      server = startServer({
        PORT: String(port),
        HOST: "127.0.0.1",
        SANCTIONS_DB_PATH: join(dir, "sanctions.sqlite"),
        CLAIM_LOG_PATH: join(dir, "claims.jsonl"),
        INTENT_NONCE_PATH: join(dir, "nonces.jsonl"),
        ABUSE_STATE_PATH: join(dir, "abuse.json"),
      });
      await once(server, "listening");
      await server.sanctionsRefreshStarted;
      assert.ok(calls.length >= 1);
      assert.equal(calls[0].includes("ofac.treas.gov"), true);
    } finally {
      globalThis.fetch = previous;
      if (server) {
        await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      }
    }
  });
});
