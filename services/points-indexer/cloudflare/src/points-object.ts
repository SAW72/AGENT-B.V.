import { DurableObject } from "cloudflare:workers";
import { CHAIN_ID } from "../../src/constants.mjs";
import {
  ensureSchema,
  finalizedBlock,
  lastScannedBlock,
  metaGet,
  metaInt,
  refreshBundled,
  storedConfig,
} from "./ledger";
import { createReadApi, parseCorsList, pointsEnabled, type ReadInput } from "./read-api";
import { blocksBehind, healthDecision, runAlarm } from "./scan";

export class PointsObject extends DurableObject<Env> {
  #api: ReturnType<typeof createReadApi> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      if (!pointsEnabled(env)) return;
      ensureSchema(ctx.storage.sql);
      refreshBundled(ctx.storage.sql);
      const existing = await ctx.storage.getAlarm();
      if (existing == null) await ctx.storage.setAlarm(Date.now() + 1_000);
    });
  }

  async alarm() {
    if (!pointsEnabled(this.env)) return;
    const env = this.env;
    await runAlarm({
      storage: this.ctx.storage,
      env: {
        CHAIN_ID: env.CHAIN_ID,
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
      allow: () => ({ ok: true }),
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
          const actionOrder = `CASE action
                 WHEN 'fund' THEN 1
                 WHEN 'release_or_refund' THEN 2
                 WHEN 'dispute_open_or_vote' THEN 3
                 WHEN 'first_activity' THEN 4
                 WHEN 'return_day' THEN 5
                 ELSE 9
               END`;
          const after = query.after;
          const rows = after
            ? sql.exec(
              `SELECT * FROM ledger_rows
               WHERE wallet = ? AND chain_id = ?
                 AND (
                   block_number > ?
                   OR (block_number = ? AND log_index > ?)
                   OR (block_number = ? AND log_index = ? AND (${actionOrder}) > ?)
                   OR (block_number = ? AND log_index = ? AND (${actionOrder}) = ? AND utc_day > ?)
                 )
               ORDER BY block_number ASC, log_index ASC, ${actionOrder} ASC, utc_day ASC
               LIMIT ?`,
              address,
              CHAIN_ID,
              after.block_number,
              after.block_number,
              after.log_index,
              after.block_number,
              after.log_index,
              orderOf(after.action),
              after.block_number,
              after.log_index,
              orderOf(after.action),
              after.utc_day,
              query.limit,
            ).toArray()
            : sql.exec(
              `SELECT * FROM ledger_rows
               WHERE wallet = ? AND chain_id = ?
               ORDER BY block_number ASC, log_index ASC, ${actionOrder} ASC, utc_day ASC
               LIMIT ?`,
              address,
              CHAIN_ID,
              query.limit,
            ).toArray();
          return rows.map((row) => ({
            ...row,
            block_number: Number(row.block_number),
            log_index: Number(row.log_index),
            utc_day: Number(row.utc_day),
            points: Number(row.points),
            points_withheld: Number(row.points_withheld),
            action: String(row.action),
          }));
        },
        getConfig: () => storedConfig(sql),
      },
    });
    return this.#api;
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

function rpcUrl(env: Env) {
  return (env as Env & { BASE_SEPOLIA_RPC_URL?: string }).BASE_SEPOLIA_RPC_URL;
}