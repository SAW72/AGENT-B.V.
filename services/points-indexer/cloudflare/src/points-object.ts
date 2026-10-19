import { DurableObject } from "cloudflare:workers";
import { CHAIN_ID } from "../../src/constants.mjs";
import {
  ensureSchema,
  finalizedBlock,
  lastScannedBlock,
  metaGet,
  metaInt,
  publicConfig,
} from "./ledger";
import { DEFAULT_RATE_PER_MINUTE, createReadApi, parseCorsList, type ReadInput } from "./read-api";
import { blocksBehind, healthDecision, runAlarm } from "./scan";

const WINDOW_MS = 60_000;

export class PointsObject extends DurableObject<Env> {
  #api: ReturnType<typeof createReadApi> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ensureSchema(ctx.storage.sql);
      const existing = await ctx.storage.getAlarm();
      if (existing == null) await ctx.storage.setAlarm(Date.now() + 1_000);
    });
  }

  async alarm() {
    const env = this.env;
    await runAlarm({
      storage: this.ctx.storage,
      env: {
        BASE_SEPOLIA_RPC_URL: rpcUrl(env),
        POINTS_POLL_MS: env.POINTS_POLL_MS,
        POINTS_LOG_RANGE: env.POINTS_LOG_RANGE,
        POINTS_MAX_WINDOWS_PER_RUN: env.POINTS_MAX_WINDOWS_PER_RUN,
        POINTS_FAST_PACE: env.POINTS_FAST_PACE,
      },
    });
  }

  async health() {
    ensureSchema(this.ctx.storage.sql);
    const pollMs = Number(this.env.POINTS_POLL_MS || 15_000);
    const head = finalizedBlock(this.ctx.storage.sql);
    const cursor = lastScannedBlock(this.ctx.storage.sql);
    const behind = head == null ? 0 : blocksBehind(head, cursor);
    const decision = healthDecision({
      lastPassAt: metaInt(this.ctx.storage.sql, "last_pass_at"),
      pollMs: Number.isInteger(pollMs) && pollMs > 0 ? pollMs : 15_000,
      now: Date.now(),
      behind,
    });
    const body: Record<string, unknown> = { ok: decision.ok, chainId: CHAIN_ID };
    if (decision.ok && decision.behind > 0) body.behind = decision.behind;
    const lastError = metaGet(this.ctx.storage.sql, "last_error");
    const early = metaGet(this.ctx.storage.sql, "early_reason");
    if (!decision.ok && lastError) body.error = lastError;
    else if (decision.ok && early) body.error = early;
    return { status: decision.statusCode, body };
  }

  async read(input: ReadInput) {
    ensureSchema(this.ctx.storage.sql);
    return this.api().handle(input);
  }

  api() {
    if (this.#api) return this.#api;
    const sql = this.ctx.storage.sql;
    this.#api = createReadApi({
      corsOrigins: parseCorsList(this.env.POINTS_CORS_ORIGINS),
      allow: (ip) => this.allow(ip),
      store: {
        getCursor: () => ({
          last_scanned_block: lastScannedBlock(sql),
          finalized_block: finalizedBlock(sql),
          pass_completed: metaGet(sql, "pass_completed") === "1",
          stale: metaGet(sql, "stale") === "1",
        }),
        getLedgerSummary: (address) => {
          const totals = sql.exec(
            "SELECT COUNT(*) AS rows_count FROM ledger_rows WHERE wallet = ? AND chain_id = ?",
            address,
            CHAIN_ID,
          ).toArray()[0];
          const first = sql.exec(
            "SELECT utc_day FROM ledger_rows WHERE wallet = ? AND chain_id = ? AND action = 'first_activity' LIMIT 1",
            address,
            CHAIN_ID,
          ).toArray()[0];
          return {
            rows_count: Number(totals?.rows_count ?? 0),
            first_activity_utc_day: first ? Number(first.utc_day) : null,
          };
        },
        listLedgerRows: (address, query) => {
          const rows = sql.exec(
            `SELECT * FROM ledger_rows
             WHERE wallet = ? AND chain_id = ?
             ORDER BY block_number ASC, log_index ASC,
               CASE action
                 WHEN 'fund' THEN 1
                 WHEN 'release_or_refund' THEN 2
                 WHEN 'dispute_open_or_vote' THEN 3
                 WHEN 'first_activity' THEN 4
                 WHEN 'return_day' THEN 5
                 ELSE 9
               END ASC,
               utc_day ASC`,
            address,
            CHAIN_ID,
          ).toArray();
          const after = query.after;
          const filtered = after
            ? rows.filter((row) => {
              const key = [Number(row.block_number), Number(row.log_index), orderOf(String(row.action)), Number(row.utc_day)];
              const bound = [after.block_number, after.log_index, orderOf(after.action), after.utc_day];
              for (let index = 0; index < key.length; index += 1) {
                if (key[index] > bound[index]) return true;
                if (key[index] < bound[index]) return false;
              }
              return false;
            })
            : rows;
          return filtered.slice(0, query.limit).map((row) => ({
            ...row,
            block_number: Number(row.block_number),
            log_index: Number(row.log_index),
            utc_day: Number(row.utc_day),
            points: Number(row.points),
            points_withheld: Number(row.points_withheld),
            action: String(row.action),
          }));
        },
        getConfig: () => publicConfig(),
      },
    });
    return this.#api;
  }

  allow(ip: string) {
    const max = positiveRate(this.env.POINTS_READ_RATE_PER_MINUTE);
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM rate_hits WHERE ts < ?", now - WINDOW_MS);
      const row = this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM rate_hits WHERE ip = ?",
        ip,
      ).toArray()[0];
      const count = Number(row?.n ?? 0);
      if (count >= max) {
        const oldest = Number(row?.oldest ?? now);
        const retryAfterMs = Math.max(0, oldest + WINDOW_MS - now);
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      }
      this.ctx.storage.sql.exec("INSERT INTO rate_hits(ip, ts) VALUES(?, ?)", ip, now);
      return { ok: true };
    });
  }
}

function orderOf(action: string) {
  if (action === "fund") return 1;
  if (action === "release_or_refund") return 2;
  if (action === "dispute_open_or_vote") return 3;
  if (action === "first_activity") return 4;
  if (action === "return_day") return 5;
  return 9;
}

function positiveRate(value: string | undefined) {
  const text = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(text)) return DEFAULT_RATE_PER_MINUTE;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : DEFAULT_RATE_PER_MINUTE;
}

function rpcUrl(env: Env) {
  return (env as Env & { BASE_SEPOLIA_RPC_URL?: string }).BASE_SEPOLIA_RPC_URL;
}