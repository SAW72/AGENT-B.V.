import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { openWallet } from "../accountScreen.mjs";
import { createClaimLog } from "../claimLog.mjs";
import { loadConfig } from "../config.mjs";
import { createClaimRelayer } from "../app.mjs";
import { createKillSwitch } from "../killSwitch.mjs";
import { createNonceStore } from "../nonceStore.mjs";
import { createRateLimiter } from "../reputation/rateLimit.mjs";
import { createSanctionsGate } from "../sanctionsGate.mjs";
import { screenFromAddressList, walletHashHex } from "../sanctions.mjs";
import { walletAesKey, walletHmacKey } from "../sha256.mjs";
import { TEST_PEPPER } from "./clearGate.mjs";
import { postScreen, screenSigner } from "./screenSession.mjs";

function request(port, method, path, body, headers = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
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
        resolve({ status: res.statusCode, json, raw, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function boot(sanctions, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "screen-auth-"));
  const config = loadConfig({
    CLAIM_LOG_PATH: join(dir, "claims.jsonl"),
    ...extra.env,
  });
  const server = createClaimRelayer({
    config,
    killSwitch: createKillSwitch({ initial: false }),
    nonceStore: createNonceStore(),
    claimLog: createClaimLog({ filePath: join(dir, "claims.jsonl") }),
    broadcaster: null,
    sanctions,
    edgeCountry: "US",
    ...extra.deps,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe("screen session and wallet proof", () => {
  it("change passes the pepper and binds the seal to the account and the hash", async () => {
    const now = 1_800_000_000_000;
    const open = createSanctionsGate({
      pepper: TEST_PEPPER,
      now: () => now,
      screen: screenFromAddressList(["0x3333333333333333333333333333333333333333"], now, { minAddresses: 1 }),
    });
    const first = "0x5555555555555555555555555555555555555555";
    const next = "0x7777777777777777777777777777777777777777";
    assert.equal((await open.signup({ accountId: "acct-c", wallet: first, proven: true })).http, 200);
    const changed = await open.change({ accountId: "acct-c", nextWallet: next, proven: true });
    assert.equal(changed.http, 200);
    const hash = walletHashHex(TEST_PEPPER, next);
    const row = open.db.prepare(
      "SELECT wallet_sealed FROM sanctions_account_wallets WHERE account_id = ? AND wallet_hash = ?",
    ).get("acct-c", hash);
    assert.equal(await openWallet(TEST_PEPPER, row.wallet_sealed, { accountId: "acct-c", walletHash: hash }), next);
    await assert.rejects(
      () => openWallet(TEST_PEPPER, row.wallet_sealed, { accountId: "other", walletHash: hash }),
    );
    assert.equal(Buffer.from(walletHmacKey(TEST_PEPPER)).equals(Buffer.from(walletAesKey(TEST_PEPPER))), false);
    assert.equal((await open.change({ accountId: "acct-c", nextWallet: next })).http, 401);
  });

  it("refuses to tie a victim wallet to an SDN address on someone else's account", async () => {
    const attacker = screenSigner();
    const victim = screenSigner();
    const listed = screenSigner();
    const now = Date.now();
    const sanctions = createSanctionsGate({
      pepper: TEST_PEPPER,
      now: () => now,
      screen: screenFromAddressList([listed.address], now, { minAddresses: 1, listVersion: "attack" }),
    });
    const ctx = await boot(sanctions);
    try {
      const unsigned = await request(ctx.port, "POST", "/v1/screen/link", {
        accountId: "victim",
        wallet: victim.address,
      });
      assert.equal(unsigned.status, 401);
      const signup = await postScreen(request, ctx.port, "signup", attacker, "attacker");
      assert.equal(signup.status, 200);
      assert.equal(typeof signup.json.session, "string");
      const ownListed = await postScreen(request, ctx.port, "link", listed, "attacker", {}, {
        session: signup.json.session,
      });
      assert.equal(ownListed.status, 403);
      const spoofWallet = await postScreen(request, ctx.port, "link", listed, "attacker", {}, {
        session: signup.json.session,
        wallet: victim.address,
      });
      assert.equal(spoofWallet.status, 403);
      const spoofAccount = await postScreen(request, ctx.port, "link", listed, "victim", {}, {
        session: signup.json.session,
        accountId: "victim",
      });
      assert.equal(spoofAccount.status, 401);
      const victimHash = walletHashHex(TEST_PEPPER, victim.address.toLowerCase());
      const rows = sanctions.db.prepare("SELECT account_id, wallet_hash FROM sanctions_account_wallets").all();
      assert.equal(rows.some((row) => row.wallet_hash === victimHash), false);
      assert.equal(rows.some((row) => row.account_id === "victim"), false);
      assert.equal(sanctions.blocks(victim.address), false);
      assert.equal(rows.some((row) => row.account_id === "attacker"), true);
    } finally {
      await ctx.close();
    }
  });

  it("drops a tie from an audited admin route and rate limits screen routes", async () => {
    const owner = screenSigner();
    const now = Date.now();
    const sanctions = createSanctionsGate({
      pepper: TEST_PEPPER,
      now: () => now,
      screen: screenFromAddressList(["0x3333333333333333333333333333333333333333"], now, { minAddresses: 1 }),
    });
    const secret = "untie-admin-secret";
    const admins = JSON.stringify({ "ops-1": createHash("sha256").update(secret, "utf8").digest("hex") });
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000, clock: () => 5_000 });
    const ctx = await boot(sanctions, {
      env: { SANCTIONS_RELEASE_ADMINS: admins },
      deps: { screenRateLimit: limiter },
    });
    try {
      const signup = await postScreen(request, ctx.port, "signup", owner, "acct-drop");
      assert.equal(signup.status, 200);
      const hash = walletHashHex(TEST_PEPPER, owner.address.toLowerCase());
      const before = sanctions.db.prepare(
        "SELECT 1 AS hit FROM sanctions_account_wallets WHERE account_id = ? AND wallet_hash = ?",
      ).get("acct-drop", hash);
      assert.ok(before);
      const denied = await request(ctx.port, "POST", "/v1/admin/sanctions/untie", {
        accountId: "acct-drop",
        wallet: owner.address,
      });
      assert.equal(denied.status, 401);
      const dropped = await request(ctx.port, "POST", "/v1/admin/sanctions/untie", {
        accountId: "acct-drop",
        wallet: owner.address,
      }, { "x-sanctions-actor": "ops-1", "x-admin-secret": secret });
      assert.equal(dropped.status, 200);
      const after = sanctions.db.prepare(
        "SELECT 1 AS hit FROM sanctions_account_wallets WHERE account_id = ?",
      ).get("acct-drop");
      assert.equal(after, undefined);
      const audit = sanctions.db.prepare("SELECT outcome, actor FROM sanctions_tie_audit").get();
      assert.equal(audit.outcome, "untied");
      assert.equal(audit.actor, "ops-1");
      assert.throws(
        () => sanctions.db.prepare("DELETE FROM sanctions_tie_audit WHERE id = 1").run(),
        /append-only/,
      );
      const limited = await request(ctx.port, "POST", "/v1/screen/nonce", {});
      assert.equal(limited.status, 429);
      assert.equal(limited.json.error, "rate_limited");
    } finally {
      await ctx.close();
    }
  });

  it("refuses signup onto a victim account id with the attacker's own listed wallet", async () => {
    const victim = screenSigner();
    const attacker = screenSigner();
    const listed = screenSigner();
    const now = Date.now();
    const sanctions = createSanctionsGate({
      pepper: TEST_PEPPER,
      now: () => now,
      screen: screenFromAddressList([listed.address], now, { minAddresses: 1, listVersion: "signup-takeover" }),
    });
    const ctx = await boot(sanctions);
    try {
      const signup = await postScreen(request, ctx.port, "signup", victim, "victim-acct");
      assert.equal(signup.status, 200);
      const listedAttack = await postScreen(request, ctx.port, "signup", listed, "victim-acct");
      assert.equal(listedAttack.status, 401);
      assert.equal(listedAttack.json.error, "unproven");
      const clearAttack = await postScreen(request, ctx.port, "signup", attacker, "victim-acct");
      assert.equal(clearAttack.status, 401);
      const listedHash = walletHashHex(TEST_PEPPER, listed.address.toLowerCase());
      const attackerHash = walletHashHex(TEST_PEPPER, attacker.address.toLowerCase());
      const rows = sanctions.db.prepare(
        "SELECT wallet_hash FROM sanctions_account_wallets WHERE account_id = ?",
      ).all("victim-acct");
      assert.equal(rows.some((row) => row.wallet_hash === listedHash), false);
      assert.equal(rows.some((row) => row.wallet_hash === attackerHash), false);
      assert.equal(rows.length, 1);
      const second = await postScreen(request, ctx.port, "signup", attacker, "victim-acct", {}, {
        session: signup.json.session,
      });
      assert.equal(second.status, 200);
    } finally {
      await ctx.close();
    }
  });

  it("deletes expired screen nonces and sessions when a nonce is written", () => {
    const now = 5_000_000;
    const sanctions = createSanctionsGate({
      pepper: TEST_PEPPER,
      now: () => now,
      screen: screenFromAddressList(["0x3333333333333333333333333333333333333333"], now, { minAddresses: 1 }),
    });
    sanctions.db.prepare(
      "INSERT INTO screen_nonces(nonce, expires_at, used_at) VALUES('old-nonce', ?, NULL)",
    ).run(now - 1);
    sanctions.db.prepare(
      "INSERT INTO screen_nonces(nonce, expires_at, used_at) VALUES('live-nonce', ?, NULL)",
    ).run(now + 60_000);
    sanctions.db.prepare(
      "INSERT INTO screen_sessions(token_hash, account_id, wallet_hash, expires_at) VALUES('old-session', 'acct', 'hash', ?)",
    ).run(now - 1);
    sanctions.db.prepare(
      "INSERT INTO screen_sessions(token_hash, account_id, wallet_hash, expires_at) VALUES('live-session', 'acct', 'hash', ?)",
    ).run(now + 60_000);
    sanctions.issueNonce();
    const nonces = sanctions.db.prepare("SELECT nonce FROM screen_nonces").all().map((row) => row.nonce);
    const sessions = sanctions.db.prepare("SELECT token_hash FROM screen_sessions").all().map((row) => row.token_hash);
    assert.equal(nonces.includes("old-nonce"), false);
    assert.equal(nonces.includes("live-nonce"), true);
    assert.equal(sessions.includes("old-session"), false);
    assert.equal(sessions.includes("live-session"), true);
  });

  it("revokes an account session from an audited admin route", async () => {
    const owner = screenSigner();
    const now = Date.now();
    const sanctions = createSanctionsGate({
      pepper: TEST_PEPPER,
      now: () => now,
      screen: screenFromAddressList(["0x3333333333333333333333333333333333333333"], now, { minAddresses: 1 }),
    });
    const secret = "revoke-admin-secret";
    const admins = JSON.stringify({ "ops-1": createHash("sha256").update(secret, "utf8").digest("hex") });
    const ctx = await boot(sanctions, { env: { SANCTIONS_RELEASE_ADMINS: admins } });
    try {
      const signup = await postScreen(request, ctx.port, "signup", owner, "acct-revoke");
      assert.equal(signup.status, 200);
      const denied = await request(ctx.port, "POST", "/v1/admin/sanctions/revoke-session", {
        accountId: "acct-revoke",
      });
      assert.equal(denied.status, 401);
      const revoked = await request(ctx.port, "POST", "/v1/admin/sanctions/revoke-session", {
        accountId: "acct-revoke",
      }, { "x-sanctions-actor": "ops-1", "x-admin-secret": secret });
      assert.equal(revoked.status, 200);
      assert.equal(revoked.json.removed, 1);
      const left = sanctions.db.prepare(
        "SELECT 1 AS hit FROM screen_sessions WHERE account_id = ?",
      ).get("acct-revoke");
      assert.equal(left, undefined);
      const again = await postScreen(request, ctx.port, "link", owner, "acct-revoke", {}, {
        session: signup.json.session,
      });
      assert.equal(again.status, 401);
      const audit = sanctions.db.prepare(
        "SELECT outcome, actor, removed FROM sanctions_session_audit",
      ).get();
      assert.equal(audit.outcome, "revoked");
      assert.equal(audit.actor, "ops-1");
      assert.equal(Number(audit.removed), 1);
      const miss = await request(ctx.port, "POST", "/v1/admin/sanctions/revoke-session", {
        accountId: "acct-revoke",
      }, { "x-sanctions-actor": "ops-1", "x-admin-secret": secret });
      assert.equal(miss.status, 404);
      assert.equal(miss.json.error, "revoke_absent");
      assert.throws(
        () => sanctions.db.prepare("DELETE FROM sanctions_session_audit WHERE id = 1").run(),
        /append-only/,
      );
    } finally {
      await ctx.close();
    }
  });
});
