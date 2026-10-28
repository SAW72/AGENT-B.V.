/**
 * Single-use (sender, nonce) store for signed claim intents.
 *
 * claim() is the atomic check-and-set. A completed entry is a replay and
 * returns the stored HTTP result. A pending entry means a request already
 * passed this point and must not broadcast again.
 *
 * Production uses the file implementation (same append-only style as the
 * claim JSONL log). Tests use the memory implementation. Both share this
 * interface: claim, commit, release.
 */

import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

function httpError(status, error) {
  return Object.assign(new Error(error), { status, error });
}

function createLockedStore(opts, persist) {
  const now = opts.now || Date.now;
  /** @type {Map<string, { expiresAtMs: number, pending: boolean, result: object | null }>} */
  const entries = new Map();
  let chain = Promise.resolve();

  function withLock(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function prune(atMs) {
    for (const [key, rec] of entries) {
      if (rec.expiresAtMs <= atMs) entries.delete(key);
    }
  }

  function snapshot(key) {
    const rec = entries.get(key);
    if (!rec) return { kind: "absent" };
    if (rec.result) return { kind: "replay", result: rec.result };
    if (rec.pending) return { kind: "pending" };
    return { kind: "absent" };
  }

  return {
    async load(records) {
      for (const record of records || []) {
        if (!record || typeof record.key !== "string") continue;
        const current = entries.get(record.key);
        if (record.op === "begin") {
          entries.set(record.key, {
            expiresAtMs: Number(record.expiresAtMs),
            pending: true,
            result: current?.result ?? null,
          });
        } else if (record.op === "commit" && record.result && typeof record.result === "object") {
          entries.set(record.key, {
            expiresAtMs: Number(record.expiresAtMs ?? current?.expiresAtMs ?? 0),
            pending: false,
            result: record.result,
          });
        } else if (record.op === "release") {
          const rec = entries.get(record.key);
          if (rec && !rec.result) entries.delete(record.key);
        }
      }
    },

    /**
     * @param {{ key: string, ttlMs: number, atMs?: number }} input
     * @returns {Promise<{ kind: 'fresh', expiresAtMs: number } | { kind: 'replay', result: object } | { kind: 'pending' }>}
     */
    claim(input) {
      const key = String(input.key || "");
      const ttlMs = Number(input.ttlMs);
      return withLock(async () => {
        if (!key) throw httpError(400, "invalid_nonce");
        if (!Number.isFinite(ttlMs) || ttlMs < 1) throw httpError(400, "invalid_nonce");
        const atMs = input.atMs ?? now();
        prune(atMs);
        const seen = snapshot(key);
        if (seen.kind !== "absent") return seen;
        const expiresAtMs = atMs + ttlMs;
        entries.set(key, { expiresAtMs, pending: true, result: null });
        if (persist) await persist({ op: "begin", key, expiresAtMs });
        return { kind: "fresh", expiresAtMs };
      });
    },

    commit(key, result) {
      return withLock(async () => {
        const rec = entries.get(String(key));
        if (!rec) return false;
        rec.pending = false;
        rec.result = result;
        if (persist) await persist({ op: "commit", key: String(key), expiresAtMs: rec.expiresAtMs, result });
        return true;
      });
    },

    /** Drop a pending key that never broadcast. Completed results stay. */
    release(key) {
      return withLock(async () => {
        const id = String(key);
        const rec = entries.get(id);
        if (!rec || rec.result) return false;
        entries.delete(id);
        if (persist) await persist({ op: "release", key: id });
        return true;
      });
    },

    peek(key) {
      return withLock(async () => {
        prune(now());
        return snapshot(String(key));
      });
    },
  };
}

export function createMemoryIntentNonceStore(opts = {}) {
  return createLockedStore(opts, null);
}

/**
 * Append-only JSONL. A restart reloads begin/commit/release lines.
 * @param {{ filePath?: string, now?: () => number }} [opts]
 */
export function createFileIntentNonceStore(opts = {}) {
  const filePath = opts.filePath || "./data/intent-nonces.jsonl";
  let ready = null;

  async function ensureDir() {
    if (!ready) ready = mkdir(dirname(filePath), { recursive: true });
    await ready;
  }

  async function persist(record) {
    await ensureDir();
    const handle = await open(filePath, "a", 0o600);
    try {
      await handle.appendFile(`${JSON.stringify(record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  const store = createLockedStore(opts, persist);
  const loading = (async () => {
    let raw = "";
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") return;
      throw err;
    }
    const records = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        /* skip a torn last line */
      }
    }
    await store.load(records);
  })();

  return {
    filePath,
    ready: () => loading,
    claim: async (input) => {
      await loading;
      return store.claim(input);
    },
    commit: async (key, result) => {
      await loading;
      return store.commit(key, result);
    },
    release: async (key) => {
      await loading;
      return store.release(key);
    },
    peek: async (key) => {
      await loading;
      return store.peek(key);
    },
  };
}
