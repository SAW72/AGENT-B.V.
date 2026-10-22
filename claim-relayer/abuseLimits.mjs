/**
 * Abuse limits that sit on top of signature auth.
 * These limits are not authentication.
 * When filePath is set, events and token buckets are written to that file
 * and loaded again when a new process starts. One process. One file.
 */

import { readFileSync } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { httpError } from "./config.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function keyAddress(value) {
  return String(value || "").toLowerCase();
}

function corrupt() {
  return Object.assign(new Error("abuse_state_corrupt"), { error: "abuse_state_corrupt" });
}

function parseState(raw) {
  if (!raw.trim()) return { events: [], buckets: new Map() };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corrupt();
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.events) || !Array.isArray(parsed.buckets)) {
    throw corrupt();
  }
  const events = [];
  for (const event of parsed.events) {
    if (!event || typeof event.atMs !== "number" || !Number.isFinite(event.atMs)) throw corrupt();
    if (typeof event.sender !== "string" || typeof event.ip !== "string" || typeof event.escrowId !== "string") {
      throw corrupt();
    }
    if (typeof event.gasWei !== "string" || !/^[0-9]+$/.test(event.gasWei)) throw corrupt();
    events.push({
      atMs: event.atMs,
      sender: keyAddress(event.sender),
      ip: event.ip,
      escrowId: keyAddress(event.escrowId),
      gasWei: BigInt(event.gasWei),
    });
  }
  const buckets = new Map();
  for (const bucket of parsed.buckets) {
    if (!bucket || typeof bucket.key !== "string" || bucket.key.length < 1) throw corrupt();
    if (typeof bucket.tokens !== "number" || !Number.isFinite(bucket.tokens)) throw corrupt();
    if (typeof bucket.atMs !== "number" || !Number.isFinite(bucket.atMs)) throw corrupt();
    buckets.set(bucket.key, { tokens: bucket.tokens, atMs: bucket.atMs });
  }
  return { events, buckets };
}

function loadState(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { events: [], buckets: new Map() };
    throw err;
  }
  return parseState(raw);
}

async function writeAtomic(filePath, text) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, filePath);
}

/**
 * @param {object} limits
 * @param {number} limits.senderLimit
 * @param {number} limits.ipLimit
 * @param {number} limits.globalLimit
 * @param {number} limits.windowMs
 * @param {number} limits.escrowCap
 * @param {number} limits.escrowWindowMs
 * @param {bigint | string} limits.dailyGasBudgetWei
 * @param {() => number} [opts.now]
 * @param {string} [opts.filePath]
 */
export function createAbuseGuard(limits, opts = {}) {
  const now = opts.now || Date.now;
  const filePath = opts.filePath ? String(opts.filePath) : "";
  const loaded = filePath ? loadState(filePath) : { events: [], buckets: new Map() };
  /** @type {{ atMs: number, sender: string, ip: string, escrowId: string, gasWei: bigint }[]} */
  const events = loaded.events;
  events.sort((left, right) => left.atMs - right.atMs);
  /** @type {Map<string, { tokens: number, atMs: number }>} */
  const buckets = loaded.buckets;
  let chain = Promise.resolve();

  function withLock(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function snapshot() {
    return JSON.stringify({
      version: 1,
      events: events.map((event) => ({
        atMs: event.atMs,
        sender: event.sender,
        ip: event.ip,
        escrowId: event.escrowId,
        gasWei: event.gasWei.toString(),
      })),
      buckets: [...buckets.entries()].map(([key, bucket]) => ({
        key,
        tokens: bucket.tokens,
        atMs: bucket.atMs,
      })),
    });
  }

  async function persist() {
    if (!filePath) return;
    await writeAtomic(filePath, snapshot());
  }

  function prune(atMs) {
    const keepAfter = atMs - Math.max(limits.windowMs, limits.escrowWindowMs, DAY_MS);
    while (events.length > 0 && events[0].atMs <= keepAfter) events.shift();
    for (const [key, bucket] of buckets) {
      if (key === "global") continue;
      if (atMs - bucket.atMs > limits.windowMs) buckets.delete(key);
    }
  }

  function assertWithin(input, atMs) {
    const sender = keyAddress(input.sender);
    const ip = String(input.ip || "unknown");
    const escrowId = keyAddress(input.escrowId);
    const gasWei = BigInt(input.gasWei ?? 0);
    const budget = BigInt(limits.dailyGasBudgetWei);
    let senderCount = 0;
    let ipCount = 0;
    let globalCount = 0;
    let escrowCount = 0;
    let gas = 0n;
    let oldestSender = null;
    let oldestIp = null;
    let oldestGlobal = null;
    let oldestEscrow = null;
    for (const event of events) {
      const age = atMs - event.atMs;
      if (age < limits.windowMs) {
        globalCount += 1;
        if (oldestGlobal === null || event.atMs < oldestGlobal) oldestGlobal = event.atMs;
        if (event.sender === sender) {
          senderCount += 1;
          if (oldestSender === null || event.atMs < oldestSender) oldestSender = event.atMs;
        }
        if (event.ip === ip) {
          ipCount += 1;
          if (oldestIp === null || event.atMs < oldestIp) oldestIp = event.atMs;
        }
      }
      if (age < limits.escrowWindowMs && event.escrowId === escrowId) {
        escrowCount += 1;
        if (oldestEscrow === null || event.atMs < oldestEscrow) oldestEscrow = event.atMs;
      }
      if (age < DAY_MS) gas += event.gasWei;
    }
    if (senderCount >= limits.senderLimit) {
      throw httpError(429, "rate_limited", { retryAfter: retryAfterWindow(atMs, limits.windowMs, oldestSender) });
    }
    if (ipCount >= limits.ipLimit) {
      throw httpError(429, "rate_limited", { retryAfter: retryAfterWindow(atMs, limits.windowMs, oldestIp) });
    }
    if (globalCount >= limits.globalLimit) {
      throw httpError(429, "rate_limited", { retryAfter: retryAfterWindow(atMs, limits.windowMs, oldestGlobal) });
    }
    if (escrowCount >= limits.escrowCap) {
      throw httpError(429, "escrow_cap", { retryAfter: retryAfterWindow(atMs, limits.escrowWindowMs, oldestEscrow) });
    }
    if (gas + gasWei > budget) throw httpError(429, "gas_budget_exhausted", { retryAfter: 1 });
  }

  function retryAfterWindow(atMs, windowMs, oldestAt) {
    if (oldestAt === null) return 1;
    return Math.max(1, Math.ceil((windowMs - (atMs - oldestAt)) / 1000));
  }

  function refill(key, capacity, nowMs) {
    const refillPerMs = capacity / limits.windowMs;
    const prev = buckets.get(key) || { tokens: capacity, atMs: nowMs };
    const elapsed = Math.max(0, nowMs - prev.atMs);
    return {
      tokens: Math.min(capacity, prev.tokens + elapsed * refillPerMs),
      atMs: nowMs,
      refillPerMs,
    };
  }

  function retryAfterTokens(bucket) {
    if (bucket.tokens >= 1) return 0;
    const need = 1 - bucket.tokens;
    return Math.max(1, Math.ceil(need / bucket.refillPerMs / 1000));
  }

  return {
    filePath: filePath || null,

    /**
     * Per-IP token bucket. Call this before the body is parsed.
     * Capacity is the IP limit. Tokens refill across the rate window.
     * @param {string} ip
     * @param {number} [atMs]
     */
    takeIp(ip, atMs) {
      return withLock(async () => {
        const nowMs = atMs ?? now();
        prune(nowMs);
        const ipKey = `ip:${String(ip || "unknown")}`;
        const ipBucket = refill(ipKey, limits.ipLimit, nowMs);
        const globalBucket = refill("global", limits.globalLimit, nowMs);
        buckets.set(ipKey, ipBucket);
        buckets.set("global", globalBucket);
        if (ipBucket.tokens < 1 || globalBucket.tokens < 1) {
          await persist();
          const wait = ipBucket.tokens < 1 ? ipBucket : globalBucket;
          throw httpError(429, "rate_limited", { retryAfter: retryAfterTokens(wait) });
        }
        ipBucket.tokens -= 1;
        globalBucket.tokens -= 1;
        buckets.set(ipKey, ipBucket);
        buckets.set("global", globalBucket);
        await persist();
      });
    },

    /**
     * Reject when this claim would pass a limit. Does not record it.
     * @param {{ sender: string, ip: string, escrowId: string, gasWei?: bigint, atMs?: number }} input
     */
    check(input) {
      return withLock(async () => {
        const atMs = input.atMs ?? now();
        prune(atMs);
        assertWithin(input, atMs);
      });
    },

    /**
     * Record a claim that is about to be simulated or broadcast.
     * @param {{ sender: string, ip: string, escrowId: string, gasWei: bigint, atMs?: number }} input
     */
    consume(input) {
      return withLock(async () => {
        const atMs = input.atMs ?? now();
        prune(atMs);
        assertWithin(input, atMs);
        events.push({
          atMs,
          sender: keyAddress(input.sender),
          ip: String(input.ip || "unknown"),
          escrowId: keyAddress(input.escrowId),
          gasWei: BigInt(input.gasWei ?? 0),
        });
        await persist();
      });
    },
  };
}
