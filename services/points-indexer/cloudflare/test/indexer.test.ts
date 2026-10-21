import { env, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { ESCROW } from "../../src/constants.mjs";
import { isRangeError } from "../src/scan";
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
    expect(Number(await meta("finalized_block"))).toBe(ESCROW_START_BLOCK + MAX_WINDOWS * WINDOW - 1);
    expect(Number(await meta("chain_head"))).toBe(head);
    expect(methods(rpc.calls).filter((method) => method === "eth_getLogs")).toHaveLength(MAX_WINDOWS);
    expect(methods(rpc.calls).filter((method) => method === "eth_chainId")).toHaveLength(1);
    expect(await meta("rebuild_count")).toBe("0");

    const healthWhileBehind = await SELF.fetch("https://points.test/health", {
      headers: { "CF-Connecting-IP": "203.0.113.40" },
    });
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
    expect(methods(rpc.calls).filter((method) => method === "eth_chainId")).toHaveLength(2);
    expect(await meta("rebuild_count")).toBe("0");

    const health = await SELF.fetch("https://points.test/health", {
      headers: { "CF-Connecting-IP": "203.0.113.41" },
    });
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
    expect(scores.filter((row) => Number(row.points) !== 0)).toEqual([]);

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

  it("does not advance the cursor when the finalized head lags the stored head", async () => {
    const firstSpan = MAX_WINDOWS * WINDOW;
    const highHead = ESCROW_START_BLOCK + firstSpan + 500;
    const early = await escrowLog(ESCROW_START_BLOCK + 10, 0, 1_700_000_000);
    const lateBlock = ESCROW_START_BLOCK + firstSpan + 150;
    const late = await escrowLog(lateBlock, 1, 1_700_000_100);
    let viewHead = highHead;
    const rpc = installRpc(chainHandler({ head: () => viewHead, logs: [early, late] }));
    restore = rpc.restore;

    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const cursorAfterFirst = Number(await meta("last_scanned_block"));
    expect(cursorAfterFirst).toBe(ESCROW_START_BLOCK + firstSpan - 1);
    expect(await meta("finalized_block")).toBe(String(cursorAfterFirst));
    expect(await meta("chain_head")).toBe(String(highHead));
    expect(await count("raw_logs")).toBe(1);

    const lagHead = cursorAfterFirst + 100;
    expect(lateBlock).toBeGreaterThan(lagHead);
    expect(lateBlock).toBeLessThan(highHead);
    viewHead = lagHead;
    const marked = rpc.calls.length;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const cursorDuringLag = Number(await meta("last_scanned_block"));
    expect(cursorDuringLag).toBeLessThanOrEqual(lagHead);
    expect(cursorDuringLag).toBe(lagHead);
    expect(await meta("finalized_lag")).toBe("1");
    expect(await meta("chain_head")).toBe(String(highHead));
    expect(await meta("finalized_block")).toBe(String(lagHead));
    const lagRanges = rpc.calls.slice(marked).filter((call) => call.method === "eth_getLogs").map((call) => {
      const params = call.params[0] as { fromBlock: string };
      return Number(params.fromBlock);
    });
    expect(lagRanges.some((from) => from > lagHead)).toBe(false);
    const during = await runInDurableObject(stub(), async (_instance, state) => {
      return state.storage.sql.exec("SELECT tx_hash FROM raw_logs").toArray().map((row) => String(row.tx_hash));
    });
    expect(during).not.toContain(late.transactionHash);

    viewHead = highHead;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const after = await runInDurableObject(stub(), async (_instance, state) => {
      return state.storage.sql.exec("SELECT tx_hash FROM raw_logs").toArray().map((row) => String(row.tx_hash));
    });
    expect(after).toContain(early.transactionHash);
    expect(after).toContain(late.transactionHash);
    expect(Number(await meta("last_scanned_block"))).toBeGreaterThanOrEqual(lateBlock);
    expect(Number(await meta("last_scanned_block"))).toBeLessThanOrEqual(highHead);
  });

  it("rebuilds on the next alarm when a rebuild throws after an insert", async () => {
    const log = await escrowLog(ESCROW_START_BLOCK, 0, 1_700_000_000);
    const rpc = installRpc(chainHandler({ head: ESCROW_START_BLOCK, logs: [log] }));
    restore = rpc.restore;
    await runInDurableObject(stub(), async (instance, state) => {
      const sql = state.storage.sql;
      const original = sql.exec.bind(sql);
      let armed = true;
      sql.exec = ((query: string, ...bindings: unknown[]) => {
        if (armed && String(query).includes("DELETE FROM ledger_rows")) {
          armed = false;
          throw new Error("sqlite forced");
        }
        return original(query, ...bindings);
      }) as typeof sql.exec;
      await instance.alarm();
      sql.exec = original as typeof sql.exec;
    });
    expect(await count("raw_logs")).toBe(1);
    expect(await meta("dirty")).toBe("1");
    expect(await meta("rebuild_count")).toBe("0");
    expect(await meta("last_error")).toBe("ledger_error");

    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await meta("dirty")).toBe("0");
    expect(await meta("rebuild_count")).toBe("1");
    expect(await meta("last_error")).toBe("");
  });

  it("keeps a removed log below the RPC finalized head on a normal scan", async () => {
    const log = await escrowLog(ESCROW_START_BLOCK, 3, 1_700_000_000);
    const head = ESCROW_START_BLOCK + 40;
    expect(log.blockNumber).toBeLessThan(head);
    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO raw_logs(
           chain_id, contract, tx_hash, log_index, block_number, block_hash, block_timestamp,
           topics_json, data, removed, tx_from
         ) VALUES(84532, ?, ?, ?, ?, ?, ?, ?, '0x', 0, null)`,
        log.address,
        log.transactionHash,
        log.logIndex,
        log.blockNumber,
        log.blockHash,
        1_700_000_000,
        JSON.stringify(log.topics),
      );
    });
    expect(await meta("last_scanned_block")).toBeNull();
    log.removed = true;
    const rpc = installRpc(chainHandler({ head, logs: [log] }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await count("raw_logs")).toBe(1);
    const stored = await runInDurableObject(stub(), async (_instance, state) => {
      return state.storage.sql.exec(
        "SELECT tx_hash, removed, block_number FROM raw_logs",
      ).toArray()[0];
    });
    expect(String(stored.tx_hash)).toBe(log.transactionHash);
    expect(Number(stored.removed)).toBe(0);
    expect(Number(stored.block_number)).toBe(log.blockNumber);
    expect(await meta("removed_finalized")).toBe("1");
    expect(Number(await meta("last_scanned_block"))).toBeGreaterThanOrEqual(log.blockNumber);
    const health = await SELF.fetch("https://points.test/health", {
      headers: { "CF-Connecting-IP": "203.0.113.78" },
    });
    expect(health.status).toBe(200);
    const body = await health.json() as { removed_finalized?: number };
    expect(body.removed_finalized).toBe(1);
  });

  it("keeps a log when the same response also contains its removed twin", async () => {
    const live = await escrowLog(ESCROW_START_BLOCK, 4, 1_700_000_000);
    const head = ESCROW_START_BLOCK + 25;
    expect(live.blockNumber).toBeLessThan(head);
    const removed = { ...live, removed: true };
    const rpc = installRpc(chainHandler({ head, logs: [live, removed] }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await count("raw_logs")).toBe(1);
    const stored = await runInDurableObject(stub(), async (_instance, state) => {
      return state.storage.sql.exec(
        "SELECT tx_hash, removed, block_number FROM raw_logs",
      ).toArray()[0];
    });
    expect(String(stored.tx_hash)).toBe(live.transactionHash);
    expect(Number(stored.removed)).toBe(0);
    expect(Number(stored.block_number)).toBe(live.blockNumber);
    expect(await meta("removed_finalized")).toBe("1");
  });

  it("keeps the stored credit row when a removed log is strictly below the RPC head", async () => {
    const log = await escrowLog(ESCROW_START_BLOCK, 5, 1_700_000_000);
    const head = log.blockNumber + 40;
    expect(log.blockNumber).toBeLessThan(head);
    const wallet = `0x${"11".repeat(20)}`;
    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO raw_logs(
           chain_id, contract, tx_hash, log_index, block_number, block_hash, block_timestamp,
           topics_json, data, removed, tx_from
         ) VALUES(84532, ?, ?, ?, ?, ?, ?, ?, '0x', 0, null)`,
        log.address,
        log.transactionHash,
        log.logIndex,
        log.blockNumber,
        log.blockHash,
        1_700_000_000,
        JSON.stringify(log.topics),
      );
      state.storage.sql.exec(
        `INSERT INTO ledger_rows(
           seq, chain_id, contract, tx_hash, log_index, block_number, block_timestamp, utc_day,
           wallet, action, escrow_id, points, eligibility_status, eligibility_reason, points_withheld,
           rule_weight, counts_for_return_day
         ) VALUES(1, 84532, ?, ?, ?, ?, 1, 1, ?, 'fund', ?, 5, 'unverified', 'ofac_unconfigured', 1, null, 0)`,
        log.address,
        log.transactionHash,
        log.logIndex,
        log.blockNumber,
        wallet,
        "0xdef",
      );
    });
    expect(await meta("last_scanned_block")).toBeNull();
    log.removed = true;
    const rpc = installRpc(chainHandler({ head, logs: [log] }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await meta("removed_finalized")).toBe("1");
    expect(await meta("dirty")).toBe("0");
    const credit = await runInDurableObject(stub(), async (_instance, state) => {
      return state.storage.sql.exec(
        "SELECT wallet, action, points, tx_hash, block_number FROM ledger_rows",
      ).toArray();
    });
    expect(credit).toEqual([{
      wallet,
      action: "fund",
      points: 5,
      tx_hash: log.transactionHash,
      block_number: log.blockNumber,
    }]);
    const raw = await runInDurableObject(stub(), async (_instance, state) => {
      return state.storage.sql.exec(
        "SELECT tx_hash, removed, block_number FROM raw_logs",
      ).toArray()[0];
    });
    expect(String(raw.tx_hash)).toBe(log.transactionHash);
    expect(Number(raw.removed)).toBe(0);
    expect(Number(raw.block_number)).toBe(log.blockNumber);
  });

  it("scans forward when the stored cursor is 0", async () => {
    const head = ESCROW_START_BLOCK + 10;
    const rpc = installRpc(chainHandler({ head, logs: [] }));
    restore = rpc.restore;
    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO meta(key, value) VALUES('last_scanned_block', '0')");
    });
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const cursor = await meta("last_scanned_block");
    expect(cursor).not.toBe("0");
    expect(Number(cursor)).toBeGreaterThanOrEqual(ESCROW_START_BLOCK);
    expect(await meta("error_backoff_ms")).toBeNull();
    const firstLogs = rpc.calls.find((call) => call.method === "eth_getLogs");
    const fromBlock = Number((firstLogs?.params[0] as { fromBlock: string }).fromBlock);
    expect(fromBlock).toBe(ESCROW_START_BLOCK);
  });

  it("keeps a removed log exactly at the RPC head", async () => {
    const head = ESCROW_START_BLOCK;
    const log = await escrowLog(head, 6, 1_700_000_000);
    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO raw_logs(
           chain_id, contract, tx_hash, log_index, block_number, block_hash, block_timestamp,
           topics_json, data, removed, tx_from
         ) VALUES(84532, ?, ?, ?, ?, ?, ?, ?, '0x', 0, null)`,
        log.address,
        log.transactionHash,
        log.logIndex,
        log.blockNumber,
        log.blockHash,
        1_700_000_000,
        JSON.stringify(log.topics),
      );
    });
    log.removed = true;
    const rpc = installRpc(chainHandler({ head, logs: [log] }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await count("raw_logs")).toBe(1);
    expect(await meta("removed_finalized")).toBe("1");
    const health = await SELF.fetch("https://points.test/health", {
      headers: { "CF-Connecting-IP": "203.0.113.82" },
    });
    const body = await health.json() as { removed_finalized?: number };
    expect(body.removed_finalized).toBe(1);
  });

  it("rejects a removed log one block above the RPC head", async () => {
    const head = ESCROW_START_BLOCK + 10;
    const kept = await escrowLog(ESCROW_START_BLOCK, 7, 1_700_000_000);
    const removed = await escrowLog(head + 1, 8, 1_700_000_100);
    removed.removed = true;
    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO raw_logs(
           chain_id, contract, tx_hash, log_index, block_number, block_hash, block_timestamp,
           topics_json, data, removed, tx_from
         ) VALUES(84532, ?, ?, ?, ?, ?, ?, ?, '0x', 0, null)`,
        kept.address,
        kept.transactionHash,
        kept.logIndex,
        kept.blockNumber,
        kept.blockHash,
        1_700_000_000,
        JSON.stringify(kept.topics),
      );
    });
    const rpc = installRpc(chainHandler({ head, logs: [removed], keepOutside: true }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await meta("last_error")).toBe("log_outside_request");
    expect(await meta("last_scanned_block")).toBeNull();
    expect(await count("raw_logs")).toBe(1);
    const stored = await runInDurableObject(stub(), async (_instance, state) => {
      return state.storage.sql.exec("SELECT tx_hash FROM raw_logs").toArray()[0];
    });
    expect(String(stored.tx_hash)).toBe(kept.transactionHash);
  });

  it("throws instead of deleting a removed log above the passed head", async () => {
    const log = await escrowLog(ESCROW_START_BLOCK + 5, 9, 1_700_000_000);
    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO raw_logs(
           chain_id, contract, tx_hash, log_index, block_number, block_hash, block_timestamp,
           topics_json, data, removed, tx_from
         ) VALUES(84532, ?, ?, ?, ?, ?, ?, ?, '0x', 0, null)`,
        log.address,
        log.transactionHash,
        log.logIndex,
        log.blockNumber,
        log.blockHash,
        1_700_000_000,
        JSON.stringify(log.topics),
      );
      log.removed = true;
      const { commitScanWindow } = await import("../src/ledger");
      expect(() => commitScanWindow(state.storage, [log], ESCROW_START_BLOCK + 5, 84532, ESCROW_START_BLOCK)).toThrow();
      const row = state.storage.sql.exec("SELECT tx_hash FROM raw_logs").toArray()[0];
      expect(String(row.tx_hash)).toBe(log.transactionHash);
      const cursor = state.storage.sql.exec("SELECT value FROM meta WHERE key = 'last_scanned_block'").toArray()[0];
      expect(cursor).toBeUndefined();
    });
  });

  it("does not advance the cursor when a block timestamp cannot be read", async () => {
    const log = await escrowLog(ESCROW_START_BLOCK, 0);
    const rpc = installRpc(chainHandler({
      head: ESCROW_START_BLOCK,
      logs: [log],
      omitTimestamp: true,
    }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await meta("last_scanned_block")).toBeNull();
    expect(await count("raw_logs")).toBe(0);
    expect(await meta("last_error")).toBe("unverifiable_log");
  });

  it("stops the alarm before the 50 subrequest cap, counting retries", async () => {
    const head = ESCROW_START_BLOCK + (MAX_WINDOWS * WINDOW);
    const logs = [];
    for (let index = 0; index < 30; index += 1) {
      logs.push(await escrowLog(ESCROW_START_BLOCK + index * WINDOW, index));
    }
    const rpc = installRpc(chainHandler({
      head,
      logs,
      getLogsStatus: (_from, _to, seen) => (seen === 1 ? { status: 429, retryAfter: "1" } : null),
    }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(rpc.liveSignals.length).toBeLessThanOrEqual(45);
    expect(Number(await meta("last_scanned_block"))).toBeLessThan(head);
    expect(await meta("early_reason")).toBe("subrequest_budget");
    expect(await meta("stale")).toBe("0");
  });

  it("stops the alarm when wall time exceeds the per-run cap", async () => {
    const head = ESCROW_START_BLOCK + 10_000;
    const rpc = installRpc(chainHandler({ head, logs: [] }));
    restore = rpc.restore;
    await runInDurableObject(stub(), async (_instance, state) => {
      const { runAlarm } = await import("../src/scan");
      const start = Date.now();
      let ticks = 0;
      const result = await runAlarm({
        storage: state.storage,
        now: () => {
          ticks += 1;
          return ticks < 8 ? start : start + 21_000;
        },
        env: {
          CHAIN_ID: "84532",
          BASE_SEPOLIA_RPC_URL: "http://rpc.test/base",
          POINTS_FAST_PACE: "1",
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.reason).toBe("wall_time");
    });
    expect(Number(await meta("last_scanned_block"))).toBeLessThan(head);
    expect(await meta("early_reason")).toBe("wall_time");
    expect(rpc.liveSignals.length).toBeLessThanOrEqual(45);
  });

  it("schedules the full Retry-After when it is longer than 30s", async () => {
    const rpc = installRpc(chainHandler({
      head: ESCROW_START_BLOCK + 1_000,
      logs: [],
      getLogsStatus: () => ({ status: 429, retryAfter: "120" }),
    }));
    restore = rpc.restore;
    const before = Date.now();
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const after = Date.now();
    expect(methods(rpc.calls).filter((method) => method === "eth_getLogs")).toHaveLength(1);
    expect(await meta("last_scanned_block")).toBeNull();
    expect(await meta("last_error")).toBe("rate_limited");
    const scheduled = await alarmAt();
    expect(scheduled as number).toBeGreaterThanOrEqual(before + 120_000);
    expect(scheduled as number).toBeLessThanOrEqual(after + 120_000);
  });

  it("does not treat a rate-limit body as a range error or grow the window back", async () => {
    let ranged = false;
    const rpc = installRpc(chainHandler({
      head: ESCROW_START_BLOCK + 1_000,
      logs: [],
      getLogsStatus: (from, to, seen) => {
        if (seen === 1) return { status: 200, rpcError: { code: -32005, message: "rate limit exceeded" } };
        if (!ranged && seen > 1) {
          ranged = true;
          expect(to - from + 1).toBe(200);
          return { status: 413 };
        }
        return null;
      },
    }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await meta("last_error")).toBe("");
    expect(await meta("learned_window")).toBe("200");
    const spans = rpc.calls.filter((call) => call.method === "eth_getLogs").map((call) => {
      const params = call.params[0] as { fromBlock: string; toBlock: string };
      return Number(params.toBlock) - Number(params.fromBlock) + 1;
    });
    expect(spans[0]).toBe(200);
    expect(spans[1]).toBe(200);
    expect(spans[2]).toBe(100);
    expect(spans.slice(3).some((span) => span > 100)).toBe(true);
    expect(spans.every((span) => span <= 200)).toBe(true);
  });

  it("retries a timeout as its own error and records timeout", async () => {
    const rpc = installRpc(chainHandler({
      head: ESCROW_START_BLOCK,
      logs: [],
      getLogsStatus: () => ({ status: 200, throwName: "TimeoutError" }),
    }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(methods(rpc.calls).filter((method) => method === "eth_getLogs")).toHaveLength(4);
    expect(await meta("last_error")).toBe("timeout");
    expect(await meta("last_scanned_block")).toBeNull();
  });

  it("reschedules on a bad number and on the wrong chain id", async () => {
    const rpc = installRpc(chainHandler({ head: ESCROW_START_BLOCK, logs: [] }));
    restore = rpc.restore;
    await runInDurableObject(stub(), async (_instance, state) => {
      const { runAlarm } = await import("../src/scan");
      const before = Date.now();
      const badNumber = await runAlarm({
        storage: state.storage,
        env: {
          CHAIN_ID: "84532",
          BASE_SEPOLIA_RPC_URL: "http://rpc.test/base",
          POINTS_POLL_MS: "nope",
          POINTS_FAST_PACE: "1",
        },
      });
      const after = Date.now();
      expect(badNumber).toEqual({ ok: false, error: "config_error" });
      const scheduled = await state.storage.getAlarm();
      expect(scheduled as number).toBeGreaterThanOrEqual(before + 15_000);
      expect(scheduled as number).toBeLessThanOrEqual(after + 15_000);
      const badChain = await runAlarm({
        storage: state.storage,
        env: {
          CHAIN_ID: "1",
          BASE_SEPOLIA_RPC_URL: "http://rpc.test/base",
          POINTS_FAST_PACE: "1",
        },
      });
      expect(badChain).toEqual({ ok: false, error: "config_error" });
    });
    expect(await meta("last_error")).toBe("config_error");
    expect(await meta("error_backoff_ms")).toBeNull();
    expect(rpc.calls).toHaveLength(0);
  });

  it("uses POINTS_POLL_MS for the caught-up alarm", async () => {
    const rpc = installRpc(chainHandler({ head: ESCROW_START_BLOCK, logs: [] }));
    restore = rpc.restore;
    const before = Date.now();
    await runInDurableObject(stub(), async (_instance, state) => {
      const { runAlarm } = await import("../src/scan");
      const result = await runAlarm({
        storage: state.storage,
        env: {
          CHAIN_ID: "84532",
          BASE_SEPOLIA_RPC_URL: "http://rpc.test/base",
          POINTS_POLL_MS: "25000",
          POINTS_FAST_PACE: "1",
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.behind).toBe(0);
    });
    const after = Date.now();
    const scheduled = await alarmAt();
    expect(scheduled as number).toBeGreaterThanOrEqual(before + 25_000);
    expect(scheduled as number).toBeLessThanOrEqual(after + 25_000);
  });

  it("rejects empty contract code and still reschedules", async () => {
    const rpc = installRpc(chainHandler({ head: ESCROW_START_BLOCK, logs: [], code: "0x" }));
    restore = rpc.restore;
    const before = Date.now();
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const after = Date.now();
    expect(await meta("last_error")).toBe("config_error");
    expect(await meta("last_scanned_block")).toBeNull();
    expect(methods(rpc.calls)).toContain("eth_chainId");
    expect(methods(rpc.calls)).toContain("eth_getCode");
    expect(methods(rpc.calls)).not.toContain("eth_getLogs");
    const scheduled = await alarmAt();
    expect(scheduled as number).toBeGreaterThanOrEqual(before + 15_000);
    expect(scheduled as number).toBeLessThanOrEqual(after + 15_000);
  });

  it("caps a carried Retry-After at 15 minutes", async () => {
    const rpc = installRpc(chainHandler({
      head: ESCROW_START_BLOCK + 1_000,
      logs: [],
      getLogsStatus: () => ({ status: 429, retryAfter: "7200" }),
    }));
    restore = rpc.restore;
    const before = Date.now();
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const after = Date.now();
    expect(methods(rpc.calls).filter((method) => method === "eth_getLogs")).toHaveLength(1);
    const scheduled = await alarmAt();
    expect(scheduled as number).toBeGreaterThanOrEqual(before + 15 * 60 * 1000);
    expect(scheduled as number).toBeLessThanOrEqual(after + 15 * 60 * 1000);
    expect((scheduled as number) - before).toBeLessThan(7_200_000);
  });

  it("grows the window back to a stated ceiling and not past it", async () => {
    let narrowed = false;
    const rpc = installRpc(chainHandler({
      head: ESCROW_START_BLOCK + 1_000,
      logs: [],
      getLogsStatus: (_from, _to, seen) => {
        if (seen === 1) return { status: 200, rpcError: { code: -32005, message: "limited to a 50 range" } };
        if (!narrowed && seen >= 4) {
          narrowed = true;
          return { status: 200, rpcError: { code: -32602, message: "block range extends beyond current head block" } };
        }
        return null;
      },
    }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await meta("window_ceiling")).toBe("50");
    expect(await meta("learned_window")).toBe("50");
    const spans = rpc.calls.filter((call) => call.method === "eth_getLogs").map((call) => {
      const params = call.params[0] as { fromBlock: string; toBlock: string };
      return Number(params.toBlock) - Number(params.fromBlock) + 1;
    });
    expect(spans.some((span) => span === 25)).toBe(true);
    expect(spans.every((span) => span <= 200)).toBe(true);
    expect(spans.filter((span) => span > 50)).toEqual([200]);
  });

  it("does not advance when finalized is above latest", async () => {
    const rpc = installRpc(chainHandler({
      head: ESCROW_START_BLOCK + 10,
      latest: ESCROW_START_BLOCK,
      logs: [],
    }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await meta("last_scanned_block")).toBeNull();
    expect(await meta("finalized_block")).toBeNull();
    expect(await meta("chain_head")).toBeNull();
    expect(await meta("last_error")).toBe("rpc_error");
    expect(methods(rpc.calls)).not.toContain("eth_getLogs");
  });

  it("rejects a log outside the requested range or address", async () => {
    const outside = await escrowLog(ESCROW_START_BLOCK + 50_000, 0, 1_700_000_000);
    const ranged = installRpc(chainHandler({
      head: ESCROW_START_BLOCK,
      logs: [outside],
      keepOutside: true,
    }));
    restore = ranged.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await meta("last_scanned_block")).toBeNull();
    expect(await count("raw_logs")).toBe(0);
    expect(await meta("last_error")).toBe("log_outside_request");

    const wrong = await escrowLog(ESCROW_START_BLOCK, 1, 1_700_000_000);
    wrong.address = "0x0000000000000000000000000000000000000001";
    ranged.restore();
    const addressed = installRpc(chainHandler({ head: ESCROW_START_BLOCK, logs: [wrong] }));
    restore = addressed.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await meta("last_scanned_block")).toBeNull();
    expect(await count("raw_logs")).toBe(0);
  });

  it("stops a rebuild once stored logs pass the cap and keeps existing rows", async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const { REBUILD_MAX_LOGS, rebuild } = await import("../src/ledger");
      state.storage.sql.exec(
        "INSERT INTO meta(key, value) VALUES('finalized_block', '10') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      state.storage.sql.exec(
        `INSERT INTO ledger_rows(
           seq, chain_id, contract, tx_hash, log_index, block_number, block_timestamp, utc_day,
           wallet, action, escrow_id, points, eligibility_status, eligibility_reason, points_withheld,
           rule_weight, counts_for_return_day
         ) VALUES(1, 84532, '0xabc', '0xabc', 0, 1, 1, 1, '0xabc', 'fund', '0xabc', 0, 'unverified', 'ofac_unconfigured', 1, null, 0)`,
      );
      for (let index = 0; index < REBUILD_MAX_LOGS + 1; index += 1) {
        state.storage.sql.exec(
          `INSERT INTO raw_logs(
             chain_id, contract, tx_hash, log_index, block_number, block_hash, block_timestamp,
             topics_json, data, removed, tx_from
           ) VALUES(84532, '0xabc', ?, 0, 1, '0x1', 1, '[]', '0x', 0, null)`,
          `tx-${index}`,
        );
      }
      rebuild({ sql: state.storage.sql, transactionSync: state.storage.transactionSync.bind(state.storage) });
      const capped = state.storage.sql.exec("SELECT value FROM meta WHERE key = 'rebuild_capped'").toArray()[0];
      const dirty = state.storage.sql.exec("SELECT value FROM meta WHERE key = 'dirty'").toArray()[0];
      const kept = state.storage.sql.exec("SELECT COUNT(*) AS n FROM ledger_rows").toArray()[0];
      expect(String(capped.value)).toBe("1");
      expect(String(dirty.value)).toBe("1");
      expect(Number(kept.n)).toBe(1);
    });
  });

  it("marks the ledger dirty when the bundled config changes", async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const { refreshBundled } = await import("../src/ledger");
      state.storage.sql.exec(
        "INSERT INTO meta(key, value) VALUES('bundle_hash', 'stale') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      refreshBundled(state.storage.sql);
      const dirty = state.storage.sql.exec("SELECT value FROM meta WHERE key = 'dirty'").toArray()[0];
      const hash = state.storage.sql.exec("SELECT value FROM meta WHERE key = 'bundle_hash'").toArray()[0];
      expect(String(dirty.value)).toBe("1");
      expect(String(hash.value)).not.toBe("stale");
    });
  });

  it("stores zero when the inserted score is non-zero and skips a unique conflict", async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const { insertLedgerRow } = await import("../src/ledger");
      const wallet = "0x1111111111111111111111111111111111111111";
      const row = {
        seq: 1,
        chain_id: 84532,
        contract: wallet,
        tx_hash: wallet,
        log_index: 0,
        block_number: 1,
        block_timestamp: 1,
        utc_day: 1,
        wallet,
        action: "fund",
        escrow_id: wallet,
        points: 5,
        eligibility_status: "eligible",
        eligibility_reason: "ok",
        points_withheld: 0,
        rule_weight: null,
        counts_for_return_day: 0,
      };
      expect(insertLedgerRow(state.storage.sql, row)).toBe(true);
      const stored = state.storage.sql.exec(
        "SELECT points, points_withheld, eligibility_status, eligibility_reason FROM ledger_rows",
      ).toArray()[0];
      expect(Number(stored.points)).toBe(0);
      expect(Number(stored.points_withheld)).toBe(1);
      expect(String(stored.eligibility_status)).toBe("unverified");
      expect(String(stored.eligibility_reason)).toBe("ofac_unconfigured");
      expect(insertLedgerRow(state.storage.sql, { ...row, seq: 2 })).toBe(false);
      const countRow = state.storage.sql.exec("SELECT COUNT(*) AS n FROM ledger_rows").toArray()[0];
      expect(Number(countRow.n)).toBe(1);
      const index = state.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'rate_hits_ts'",
      ).toArray();
      expect(index).toHaveLength(0);
    });
  });

  it("backs off a persistent RPC failure instead of alarming once a second", async () => {
    const rpc = installRpc(() => ({ status: 500, body: null }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await meta("last_error")).toBe("server_error");
    expect(await meta("error_backoff_ms")).toBe("1000");
    const health = await SELF.fetch("https://points.test/health", {
      headers: { "CF-Connecting-IP": "203.0.113.79" },
    });
    const healthBody = await health.json() as { error_backoff_ms?: number };
    expect(healthBody.error_backoff_ms).toBe(1000);

    const day = 24 * 60 * 60 * 1000;
    let runs = 1;
    let covered = 0;
    while (covered < day && runs < 1_000) {
      const scheduled = await alarmAt();
      const delay = (scheduled as number) - Date.now();
      expect(delay).toBeGreaterThan(0);
      covered += delay;
      expect(await runDurableObjectAlarm(stub())).toBe(true);
      runs += 1;
    }
    expect(covered).toBeGreaterThanOrEqual(day);
    expect(runs).toBeGreaterThan(30);
    expect(runs).toBeLessThan(200);
    expect(Number(await meta("error_backoff_ms"))).toBe(15 * 60 * 1000);
  });

  it("treats -32602 as a range error only when it is the numeric code", () => {
    // isRangeError matches the JSON-RPC code. A message that only contains these digits is not a match.
    expect(isRangeError({ code: -32602, details: "invalid params" })).toBe(true);
    expect(isRangeError({ code: -32000, details: "invalid params -32602" })).toBe(false);
    expect(isRangeError({ code: -32000, message: "-32602" })).toBe(false);
  });

  it("checks rate-limit text before the -32602 code", () => {
    expect(isRangeError({ code: -32602, details: "invalid params" })).toBe(true);
    expect(isRangeError({ code: -32602, details: "rate limit" })).toBe(false);
  });

  it("ramps the wait when getLogs keeps failing", async () => {
    const rpc = installRpc(chainHandler({
      head: ESCROW_START_BLOCK + 10,
      logs: [],
      getLogsStatus: () => ({ status: 503 }),
    }));
    restore = rpc.restore;
    for (const wait of [1_000, 2_000, 4_000]) {
      const before = Date.now();
      expect(await runDurableObjectAlarm(stub())).toBe(true);
      const after = Date.now();
      const scheduled = await alarmAt() as number;
      expect(scheduled).toBeGreaterThanOrEqual(before + wait);
      expect(scheduled).toBeLessThanOrEqual(after + wait);
      expect(await meta("error_backoff_ms")).toBe(String(wait));
      expect(await meta("last_error")).toBe("server_error");
    }
  });

  it("ramps the wait when rebuild keeps failing", async () => {
    const log = await escrowLog(ESCROW_START_BLOCK, 0, 1_700_000_000);
    const rpc = installRpc(chainHandler({ head: ESCROW_START_BLOCK, logs: [log] }));
    restore = rpc.restore;
    await runInDurableObject(stub(), async (instance, state) => {
      const sql = state.storage.sql;
      const original = sql.exec.bind(sql);
      sql.exec = ((query: string, ...bindings: unknown[]) => {
        if (String(query).includes("DELETE FROM ledger_rows")) throw new Error("sqlite forced");
        return original(query, ...bindings);
      }) as typeof sql.exec;
      const read = (key: string) => {
        const row = sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
        return row ? String(row.value) : null;
      };
      for (const wait of [1_000, 2_000, 4_000]) {
        const before = Date.now();
        await instance.alarm();
        const after = Date.now();
        const scheduled = await state.storage.getAlarm() as number;
        expect(scheduled).toBeGreaterThanOrEqual(before + wait);
        expect(scheduled).toBeLessThanOrEqual(after + wait);
        expect(read("error_backoff_ms")).toBe(String(wait));
        expect(read("last_error")).toBe("ledger_error");
      }
    });
  });

  it("shows the poll wait during config_error and starts the next RPC failure at 1s", async () => {
    const rpc = installRpc(() => ({ status: 500, body: null }));
    restore = rpc.restore;
    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO meta(key, value) VALUES('error_backoff_ms', '8000')");
      const { runAlarm } = await import("../src/scan");
      const before = Date.now();
      const result = await runAlarm({
        storage: state.storage,
        env: {
          CHAIN_ID: "1",
          POINTS_FAST_PACE: "1",
        },
      });
      const after = Date.now();
      expect(result).toEqual({ ok: false, error: "config_error" });
      const scheduled = await state.storage.getAlarm() as number;
      expect(scheduled).toBeGreaterThanOrEqual(before + 15_000);
      expect(scheduled).toBeLessThanOrEqual(after + 15_000);
    });
    expect(await meta("error_backoff_ms")).toBe("0");
    expect(await meta("config_wait_ms")).toBe("15000");
    const health = await SELF.fetch("https://points.test/health", {
      headers: { "CF-Connecting-IP": "203.0.113.90", Origin: "https://agent-bv.pages.dev" },
    });
    const healthBody = await health.json() as { error_backoff_ms?: number; error?: string };
    expect(healthBody.error).toBe("config_error");
    expect(healthBody.error_backoff_ms).toBe(15_000);

    const before = Date.now();
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const after = Date.now();
    expect(await meta("last_error")).toBe("server_error");
    expect(await meta("error_backoff_ms")).toBe("1000");
    const scheduled = await alarmAt() as number;
    expect(scheduled).toBeGreaterThanOrEqual(before + 1_000);
    expect(scheduled).toBeLessThanOrEqual(after + 1_000);
  });

  it("does not advance the cursor when eth_getLogs is not an array", async () => {
    const rpc = installRpc(chainHandler({
      head: ESCROW_START_BLOCK,
      logs: [],
      nonArrayLogs: true,
    }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await meta("last_scanned_block")).toBeNull();
    expect(await count("raw_logs")).toBe(0);
    expect(await meta("last_error")).toBe("unverifiable_log");
  });

  it("holds the window when receipts have a log the scan omitted", async () => {
    const kept = await escrowLog(ESCROW_START_BLOCK, 0, 1_700_000_000);
    const omitted = await escrowLog(ESCROW_START_BLOCK, 1, 1_700_000_000);
    omitted.blockHash = kept.blockHash;
    const rpc = installRpc(chainHandler({
      head: ESCROW_START_BLOCK,
      logs: [kept, omitted],
      scanFilter: (log) => log.logIndex !== omitted.logIndex,
    }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await meta("last_scanned_block")).toBeNull();
    expect(await count("raw_logs")).toBe(0);
    expect(await meta("last_error")).toBe("logs_incomplete");
  });

  it("advances a bloom-positive block when receipts have no watched logs", async () => {
    const rpc = installRpc(chainHandler({
      head: ESCROW_START_BLOCK,
      logs: [],
      bloomAddresses: [ESCROW],
    }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(Number(await meta("last_scanned_block"))).toBe(ESCROW_START_BLOCK);
    expect(await count("raw_logs")).toBe(0);
    expect(await meta("last_error")).toBe("");
  });

  it("holds the window when the header hash disagrees with the scanned log", async () => {
    const log = await escrowLog(ESCROW_START_BLOCK, 0, 1_700_000_000);
    const rpc = installRpc(chainHandler({
      head: ESCROW_START_BLOCK,
      logs: [log],
      headerHashFor: () => `0x${"11".repeat(32)}`,
    }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await meta("last_scanned_block")).toBeNull();
    expect(await count("raw_logs")).toBe(0);
    expect(await meta("last_error")).toBe("logs_unverified");
  });

  it("holds the window when a bloom-positive block has no receipts", async () => {
    const log = await escrowLog(ESCROW_START_BLOCK, 0, 1_700_000_000);
    const rpc = installRpc(chainHandler({
      head: ESCROW_START_BLOCK,
      logs: [log],
      omitReceipts: true,
    }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await meta("last_scanned_block")).toBeNull();
    expect(await count("raw_logs")).toBe(0);
    expect(await meta("last_error")).toBe("logs_unverified");
  });

  it("uses per-transaction receipts when eth_getBlockReceipts is missing", async () => {
    const log = await escrowLog(ESCROW_START_BLOCK, 0, 1_700_000_000);
    const rpc = installRpc(chainHandler({
      head: ESCROW_START_BLOCK,
      logs: [log],
      receiptMethodMissing: true,
    }));
    restore = rpc.restore;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(Number(await meta("last_scanned_block"))).toBe(ESCROW_START_BLOCK);
    expect(await count("raw_logs")).toBe(1);
    expect(methods(rpc.calls)).toContain("eth_getTransactionReceipt");
  });
});
