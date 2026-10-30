import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handle } from "../src/index.mjs";
import { MIGRATION_NAME, handleSanctions, runBatch } from "../src/sanctionsApi.mjs";

const SECRET = "test-relayer-data-auth";

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function nonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hmac(method, path, ts, nonceValue, body) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const bodyHash = hex(new Uint8Array(digest));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${method}\n${path}\n${ts}\n${nonceValue}\n${bodyHash}`),
  );
  return hex(new Uint8Array(sigBuf));
}

async function call(op, body, extra = {}) {
  const path = `/internal/sanctions/${op}`;
  const payload = JSON.stringify(body ?? {});
  const ts = String(extra.ts ?? Date.now());
  const nonceValue = extra.nonce ?? nonce();
  const method = extra.method ?? "POST";
  const signedMethod = extra.signedMethod ?? method;
  const signedPath = extra.signedPath ?? path;
  const signedBody = extra.signedBody ?? payload;
  const sig = extra.sig ?? await hmac(signedMethod, signedPath, ts, nonceValue, signedBody);
  const requestPath = extra.requestPath ?? path;
  const request = new Request(`https://edge.test${requestPath}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-relayer-ts": extra.omitTs ? "" : ts,
      "x-relayer-nonce": nonceValue,
      "x-relayer-data-sig": sig,
    },
    body: payload,
  });
  if (extra.omitTs) request.headers.delete("x-relayer-ts");
  const rawPath = new URL(request.url).pathname;
  const response = await handleSanctions(
    request,
    extra.env ?? env,
    rawPath,
    extra.normalized ?? rawPath,
    extra.now ?? Number(ts),
  );
  return { status: response.status, json: await response.json(), headers: response.headers, nonce: nonceValue };
}

function check(hash, result = "clear") {
  return {
    walletHash: hash,
    result,
    reason: result,
    checkedAt: 10,
    listVersion: "v",
    listSha256: null,
    source: "test",
    persisted: 0,
    chainId: 84532,
    decisionPoint: "signup",
  };
}

describe("D1 sanctions migration", () => {
  it("records 0001 and rejects update and delete on each audit table", async () => {
    const names = await env.SANCTIONS_DB.prepare("SELECT name FROM d1_migrations").all();
    const stored = (names.results || []).map((row) => row.name);
    expect(stored).toContain(MIGRATION_NAME);
    const health = await call("health", {});
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ ok: true, result: { applied: true, name: MIGRATION_NAME } });
    expect(health.headers.get("access-control-allow-origin")).toBeNull();

    await env.SANCTIONS_DB.prepare(
      "INSERT INTO sanctions_release_audit(wallet_hash, outcome, released_at, actor) VALUES(?, ?, ?, ?)",
    ).bind("hash", "released", 1, "ops").run();
    await env.SANCTIONS_DB.prepare(
      "INSERT INTO sanctions_session_audit(account_id, outcome, acted_at, actor, removed) VALUES(?, ?, ?, ?, ?)",
    ).bind("acct", "revoked", 1, "ops", 1).run();
    await env.SANCTIONS_DB.prepare(
      "INSERT INTO sanctions_tie_audit(account_id, wallet_hash, outcome, acted_at, actor) VALUES(?, ?, ?, ?, ?)",
    ).bind("acct", "hash", "untied", 1, "ops").run();

    const tables = ["sanctions_release_audit", "sanctions_session_audit", "sanctions_tie_audit"];
    for (const table of tables) {
      await expect(env.SANCTIONS_DB.prepare(`UPDATE ${table} SET actor = ? WHERE id = 1`).bind("tampered").run())
        .rejects.toThrow(/append-only/);
      await expect(env.SANCTIONS_DB.prepare(`DELETE FROM ${table} WHERE id = 1`).run())
        .rejects.toThrow(/append-only/);
    }
  });

  it("rejects a bad signature, a stale timestamp, a replay, a missing secret, and a tampered request", async () => {
    const badSig = await call("health", {}, { sig: "ab".repeat(32) });
    expect(badSig.status).toBe(401);
    expect(badSig.json.error).toBe("unauthorized");

    const now = Date.now();
    const stale = await call("health", {}, { ts: now - 61_000, now });
    expect(stale.status).toBe(401);
    const future = await call("health", {}, { ts: now + 61_000, now });
    expect(future.status).toBe(401);

    const missing = await call("health", {}, { env: { ...env, RELAYER_DATA_AUTH: "" } });
    expect(missing.status).toBe(503);
    expect(missing.json.error).toBe("unavailable");

    const body = await call("health", { extra: true }, { signedBody: "{}" });
    expect(body.status).toBe(401);
    const path = await call("health", {}, { signedPath: "/internal/sanctions/other" });
    expect(path.status).toBe(401);
    const method = await call("health", {}, { signedMethod: "GET" });
    expect(method.status).toBe(401);
    const query = await call("health", {}, { requestPath: "/internal/sanctions/health?x=1" });
    expect(query.status).toBe(401);

    const shared = nonce();
    const first = await call("health", {}, { nonce: shared });
    expect(first.status).toBe(200);
    const replay = await call("health", {}, { nonce: shared });
    expect(replay.status).toBe(409);
    expect(replay.json.error).toBe("replay");
    expect(replay.json.message).toBeUndefined();

    const unknownNonce = nonce();
    const unknown = await call("not-an-op", {}, { nonce: unknownNonce });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("access-control-allow-origin")).toBeNull();
    const stored = await env.SANCTIONS_DB.prepare("SELECT nonce FROM relayer_data_nonces WHERE nonce = ?").bind(unknownNonce).first();
    expect(stored).toBeNull();

    let proxied = 0;
    const handleNonce = nonce();
    const signed = await hmac("POST", "/internal/sanctions/health", String(now), handleNonce, "{}");
    const request = new Request("https://edge.test/internal/sanctions/health", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-relayer-ts": String(now),
        "x-relayer-nonce": handleNonce,
        "x-relayer-data-sig": signed,
      },
      body: "{}",
    });
    const viaHandle = await handle(request, env, async () => {
      proxied += 1;
      return new Response("proxied", { status: 599 });
    });
    expect(proxied).toBe(0);
    expect(viaHandle.status).not.toBe(599);
  });

  it("rolls back a batch when a later statement fails", async () => {
    const marker = `atom-${nonce()}`;
    const before = await env.SANCTIONS_DB.prepare("SELECT COUNT(*) AS n FROM sanctions_checks").first();
    const outcome = await runBatch(env.SANCTIONS_DB, [
      {
        sql: "INSERT INTO sanctions_checks(wallet_hash, result, reason, checked_at, persisted) VALUES(?, ?, ?, ?, ?)",
        params: ["pepper_missing", "clear", marker, 1, 0],
      },
      {
        sql: "INSERT INTO sanctions_checks(wallet_hash, result, reason, checked_at, persisted) VALUES(?, ?, ?, ?, ?)",
        params: [null, "clear", marker, 1, 0],
      },
    ], { nonce: marker, now: Date.now() });
    expect(outcome.error).toBe("unavailable");
    expect(outcome.status).toBe(500);
    const after = await env.SANCTIONS_DB.prepare("SELECT COUNT(*) AS n FROM sanctions_checks WHERE reason = ?").bind(marker).first();
    expect(Number(after.n)).toBe(0);
    expect(Number(before.n)).toBeGreaterThanOrEqual(0);
    const stored = await env.SANCTIONS_DB.prepare("SELECT nonce FROM relayer_data_nonces WHERE nonce = ?").bind(marker).first();
    expect(stored).toBeNull();
  });

  it("links a clear signup, skips a blocked signup, and stores a match wallet without a link", async () => {
    const hash = "ab".repeat(32);
    const clearId = `clear-${nonce()}`;
    const clear = await call("account.signup", {
      accountId: clearId,
      check: check(hash),
      link: { walletHash: hash, walletSealed: "v1.sealed-clear", linkedAt: 10 },
    });
    expect(clear.status).toBe(200);
    expect(clear.json.result.blocked).toBe(false);
    const linked = await env.SANCTIONS_DB.prepare(
      "SELECT wallet_sealed FROM sanctions_account_wallets WHERE account_id = ?",
    ).bind(clearId).first();
    expect(linked.wallet_sealed).toBe("v1.sealed-clear");

    const blockedId = `blocked-${nonce()}`;
    const inserted = await call("blocks.insert", {
      blocks: [{ accountId: blockedId, walletHash: "unreadable", reason: "sanctions_unavailable", blockedAt: 10 }],
    });
    expect(inserted.status).toBe(200);
    const skipped = await call("account.signup", {
      accountId: blockedId,
      check: check("cd".repeat(32)),
      link: { walletHash: "cd".repeat(32), walletSealed: "v1.should-not-link", linkedAt: 11 },
    });
    expect(skipped.status).toBe(200);
    expect(skipped.json.result.blocked).toBe(true);
    const noLink = await env.SANCTIONS_DB.prepare(
      "SELECT wallet_sealed FROM sanctions_account_wallets WHERE account_id = ?",
    ).bind(blockedId).first();
    expect(noLink).toBeNull();

    const matchHash = "ef".repeat(32);
    const wallet = `0x${"44".repeat(20)}`;
    const matched = await call("account.signup", {
      accountId: `match-${nonce()}`,
      check: check(matchHash, "match"),
      wallet: { wallet, walletHash: matchHash, reason: "sanctions_match", checkedAt: 12, listVersion: "v" },
    });
    expect(matched.status).toBe(200);
    const storedWallet = await env.SANCTIONS_DB.prepare("SELECT wallet FROM sanctions_wallets WHERE wallet = ?").bind(wallet).first();
    expect(storedWallet.wallet).toBe(wallet);
  });

  it("stores only the sha and count when addresses_json is over the statement budget", async () => {
    const sha = "12".repeat(32);
    const raw = "34".repeat(32);
    const swapped = await call("cache.swap", {
      fetchedAt: 20,
      source: "test",
      listVersion: "big",
      addressesJson: "x".repeat(80_001),
      addressesSha256: sha,
      rawSha256: raw,
    });
    expect(swapped.status).toBe(200);
    expect(swapped.json.result.stored).toBe("sha");
    const row = await env.SANCTIONS_DB.prepare(
      "SELECT addresses_json, addresses_sha256 FROM sanctions_cache WHERE id = 1",
    ).first();
    expect(row.addresses_json).toBe(JSON.stringify({ count: 0, omitted: true }));
    expect(row.addresses_sha256).toBe(sha);
  });

  it("purges old checks and keeps an audit row and a row exactly at the cutoff", async () => {
    const now = 3_000_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    const clearKeep = now - (90 * day);
    const clearDrop = clearKeep - 1;
    await env.SANCTIONS_DB.prepare(
      "INSERT INTO sanctions_checks(wallet_hash, result, reason, checked_at, persisted) VALUES(?, ?, ?, ?, 0)",
    ).bind("keep", "clear", "clear", clearKeep).run();
    await env.SANCTIONS_DB.prepare(
      "INSERT INTO sanctions_checks(wallet_hash, result, reason, checked_at, persisted) VALUES(?, ?, ?, ?, 0)",
    ).bind("drop", "clear", "clear", clearDrop).run();
    const beforeAudit = await env.SANCTIONS_DB.prepare("SELECT COUNT(*) AS n FROM sanctions_release_audit").first();
    const purged = await call("retention.purge", {
      clearBefore: now - (90 * day),
      matchBefore: now - (10 * 365 * day),
    });
    expect(purged.status).toBe(200);
    expect(purged.json.result.cleared).toBeGreaterThanOrEqual(1);
    const kept = await env.SANCTIONS_DB.prepare(
      "SELECT wallet_hash FROM sanctions_checks WHERE wallet_hash = ?",
    ).bind("keep").first();
    const dropped = await env.SANCTIONS_DB.prepare(
      "SELECT wallet_hash FROM sanctions_checks WHERE wallet_hash = ?",
    ).bind("drop").first();
    expect(kept.wallet_hash).toBe("keep");
    expect(dropped).toBeNull();
    const afterAudit = await env.SANCTIONS_DB.prepare("SELECT COUNT(*) AS n FROM sanctions_release_audit").first();
    expect(Number(afterAudit.n)).toBe(Number(beforeAudit.n));
  });

  it("returns the tie and revoke outcomes from the same batch", async () => {
    const hash = "56".repeat(32);
    const accountId = `tie-${nonce()}`;
    await env.SANCTIONS_DB.prepare(
      "INSERT INTO sanctions_account_wallets(account_id, wallet_hash, wallet_sealed, linked_at) VALUES(?, ?, ?, ?)",
    ).bind(accountId, hash, "v1.tied", 30).run();
    const dropped = await call("tie.drop", { accountId, walletHash: hash, at: 31, actor: "ops-1" });
    expect(dropped.status).toBe(200);
    expect(dropped.json.result.outcome).toBe("untied");
    const gone = await env.SANCTIONS_DB.prepare(
      "SELECT account_id FROM sanctions_account_wallets WHERE account_id = ?",
    ).bind(accountId).first();
    expect(gone).toBeNull();
    const absent = await call("tie.drop", { accountId, walletHash: hash, at: 32, actor: "ops-1" });
    expect(absent.json.result.outcome).toBe("untie_absent");

    const sessionAccount = `sess-${nonce()}`;
    const tokenHash = "78".repeat(32);
    const created = await call("session.create", {
      tokenHash,
      accountId: sessionAccount,
      walletHash: hash,
      expiresAt: Date.now() + 60_000,
      now: Date.now(),
    });
    expect(created.status).toBe(200);
    const revoked = await call("sessions.revoke", { accountId: sessionAccount, actor: "ops-1", at: Date.now(), refused: false });
    expect(revoked.status).toBe(200);
    expect(revoked.json.result.outcome).toBe("revoked");
    expect(revoked.json.result.removed).toBe(1);
    const left = await env.SANCTIONS_DB.prepare(
      "SELECT token_hash FROM screen_sessions WHERE account_id = ?",
    ).bind(sessionAccount).first();
    expect(left).toBeNull();
  });
});
