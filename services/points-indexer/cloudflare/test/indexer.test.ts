import { env, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { ESCROW_START_BLOCK, chainHandler, escrowLog, installRpc } from "./helpers";

const WINDOW = 200;
const MAX_WINDOWS = 40;

function stub() {
  const id = env.POINTS.idFromName("base-sepolia");
  return env.POINTS.get(id);
}

async function meta(key: string) {
  return runInDurableObject(stub(), async (_instance, state) => {
    const row = state.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? String(row.value) : null;
  });
}

async function count(table: string) {
  return runInDurableObject(stub(), async (_instance, state) => {
    const row = state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0];
    return Number(row?.n ?? 0);
  });
}

async function alarmAt() {
  return runInDurableObject(stub(), async (_instance, state) => state.storage.getAlarm());
}

function methods(calls: Array<{ method: string }>) {
  return calls.map((call) => call.method);
}

describe("points alarm", () => {
  let restore = () => {};

  afterEach(async () => {
    restore();
    restore = () => {};
    await reset();
  });

  it("catches up across runs, caps a run at 40 windows, and reschedules 1s then 15s", async () => {
    const blocks = (MAX_WINDOWS + 10) * WINDOW;
    const head = ESCROW_START_BLOCK + blocks - 1;
    const rpc = installRpc(chainHandler({ head, logs: [] }));
    restore = rpc.restore;

    const beforeFirst = Date.now();
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const afterFirst = Date.now();
    const firstAlarm = await alarmAt();
    expect(firstAlarm).not.toBeNull();
    expect(firstAlarm as number).toBeGreaterThanOrEqual(beforeFirst + 1_000);
    expect(firstAlarm as number).toBeLessThanOrEqual(afterFirst + 1_000);
    expect(Number(await meta("last_scanned_block"))).toBe(ESCROW_START_BLOCK + MAX_WINDOWS * WINDOW - 1);
    expect(methods(rpc.calls).filter((method) => method === "eth_getLogs")).toHaveLength(MAX_WINDOWS);
    expect(methods(rpc.calls).filter((method) => method === "eth_chainId")).toHaveLength(1);
    expect(await meta("rebuild_count")).toBe("0");

    const healthWhileBehind = await SELF.fetch("https://points.test/health");
    expect(healthWhileBehind.status).toBe(200);
    const behindBody = await healthWhileBehind.json() as { ok: boolean; chainId: number; behind?: number };
    expect(behindBody.ok).toBe(true);
    expect(behindBody.chainId).toBe(84532);
    expect(behindBody.behind).toBeGreaterThan(0);

    const beforeSecond = Date.now();
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const afterSecond = Date.now();
    const secondAlarm = await alarmAt();
    expect(secondAlarm as number).toBeGreaterThanOrEqual(beforeSecond + 15_000);
    expect(secondAlarm as number).toBeLessThanOrEqual(afterSecond + 15_000);
    expect(Number(await meta("last_scanned_block"))).toBe(head);
    expect(methods(rpc.calls).filter((method) => method === "eth_getLogs")).toHaveLength(MAX_WINDOWS + 10);
    expect(methods(rpc.calls).filter((method) => method === "eth_chainId")).toHaveLength(1);
    expect(await meta("rebuild_count")).toBe("0");

    const health = await SELF.fetch("https://points.test/health");
    expect(health.status).toBe(200);
    const caughtUp = await health.json() as { ok: boolean; behind?: number };
    expect(caughtUp.ok).toBe(true);
    expect(caughtUp.behind).toBeUndefined();
    expect(rpc.liveSignals.length).toBeGreaterThan(0);
    expect(rpc.liveSignals.every(Boolean)).toBe(true);
  });

  it("does not rebuild ledger rows after an empty window", async () => {
    const rpc = installRpc(chainHandler({ head: ESCROW_START_BLOCK, logs: [] }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(Number(await meta("last_scanned_block"))).toBe(ESCROW_START_BLOCK);
    expect(await meta("rebuild_count")).toBe("0");
    expect(await count("raw_logs")).toBe(0);
    expect(await count("ledger_rows")).toBe(0);
    expect(methods(rpc.calls).filter((method) => method === "eth_getLogs")).toHaveLength(1);

    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await meta("rebuild_count")).toBe("0");
    expect(methods(rpc.calls).filter((method) => method === "eth_getLogs")).toHaveLength(1);
  });

  it("rebuilds when a log is inserted and not when the next window is empty", async () => {
    const log = await escrowLog(ESCROW_START_BLOCK, 0, 1_700_000_000);
    const rpc = installRpc(chainHandler({ head: ESCROW_START_BLOCK, logs: [log] }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await count("raw_logs")).toBe(1);
    expect(await meta("rebuild_count")).toBe("1");
    expect(await count("ledger_rows")).toBe(0);

    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO ledger_rows(
           seq, chain_id, contract, tx_hash, log_index, block_number, block_timestamp, utc_day,
           wallet, action, escrow_id, points, eligibility_status, eligibility_reason, points_withheld,
           rule_weight, counts_for_return_day
         ) VALUES(1, 84532, ?, ?, 0, ?, 1, 1, ?, 'fund', ?, 5, 'unverified', 'ofac_unconfigured', 1, null, 0)`,
        log.address,
        log.transactionHash,
        ESCROW_START_BLOCK,
        "0xabc",
        "0xdef",
      );
    });
    expect(await count("ledger_rows")).toBe(1);

    const later = await escrowLog(ESCROW_START_BLOCK + 1, 1, 1_700_000_100);
    rpc.restore();
    const next = installRpc(chainHandler({ head: ESCROW_START_BLOCK + 1, logs: [log, later] }));
    restore = next.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await count("raw_logs")).toBe(2);
    expect(await meta("rebuild_count")).toBe("2");
    const scores = await runInDurableObject(stub(), async (_instance, state) => {
      return state.storage.sql.exec("SELECT points, points_withheld, eligibility_reason FROM ledger_rows").toArray();
    });
    for (const row of scores) {
      expect(Number(row.points)).toBe(0);
      expect(Number(row.points_withheld)).toBe(1);
      expect(String(row.eligibility_reason)).toBe("ofac_unconfigured");
    }

    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await meta("rebuild_count")).toBe("2");
  });

  it("rebuilds when a stored log becomes final without a new insert", async () => {
    const seeded = await escrowLog(ESCROW_START_BLOCK + 10, 4, 1_700_000_000);
    const rpc = installRpc(chainHandler({ head: ESCROW_START_BLOCK + 10, logs: [] }));
    restore = rpc.restore;
    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO raw_logs(
           chain_id, contract, tx_hash, log_index, block_number, block_hash, block_timestamp,
           topics_json, data, removed, tx_from
         ) VALUES(84532, ?, ?, ?, ?, ?, ?, ?, '0x', 0, null)`,
        seeded.address,
        seeded.transactionHash,
        seeded.logIndex,
        seeded.blockNumber,
        seeded.blockHash,
        1_700_000_000,
        JSON.stringify(seeded.topics),
      );
      state.storage.sql.exec(
        "INSERT INTO meta(key, value) VALUES('last_scanned_block', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        String(ESCROW_START_BLOCK + 10),
      );
      state.storage.sql.exec(
        "INSERT INTO meta(key, value) VALUES('finalized_block', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        String(ESCROW_START_BLOCK),
      );
    });
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(methods(rpc.calls).filter((method) => method === "eth_getLogs")).toHaveLength(0);
    expect(await count("raw_logs")).toBe(1);
    expect(await meta("rebuild_count")).toBe("1");
    expect(await meta("finalized_block")).toBe(String(ESCROW_START_BLOCK + 10));
  });

  it("ends the run on 429 without throwing and leaves the cursor", async () => {
    const rpc = installRpc(chainHandler({
      head: ESCROW_START_BLOCK + 1_000,
      logs: [],
      getLogsStatus: () => ({ status: 429, retryAfter: "1" }),
    }));
    restore = rpc.restore;
    const before = Date.now();
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const after = Date.now();
    expect(methods(rpc.calls).filter((method) => method === "eth_getLogs")).toHaveLength(4);
    expect(await meta("last_scanned_block")).toBeNull();
    expect(await meta("last_error")).toBe("rate_limited");
    expect(await meta("rebuild_count")).toBe("0");
    const scheduled = await alarmAt();
    expect(scheduled as number).toBeGreaterThanOrEqual(before + 1_000);
    expect(scheduled as number).toBeLessThanOrEqual(after + 1_000);
  });

  it("ends the run on 503 without throwing", async () => {
    const rpc = installRpc(chainHandler({
      head: ESCROW_START_BLOCK + 1_000,
      logs: [],
      getLogsStatus: () => ({ status: 503 }),
    }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(methods(rpc.calls).filter((method) => method === "eth_getLogs")).toHaveLength(4);
    expect(await meta("last_error")).toBe("server_error");
    expect(await meta("last_scanned_block")).toBeNull();
  });
});
