import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { createClaimLog } from "../claimLog.mjs";
import { loadConfig } from "../config.mjs";
import { createClaimRelayer } from "../app.mjs";
import { nodeSql, purgeRetention } from "../accountScreen.mjs";
import { decideGeoblock, geoLog, PROGRAM_NOTE } from "../geoblock.mjs";
import { createKillSwitch } from "../killSwitch.mjs";
import { createNonceStore } from "../nonceStore.mjs";
import { createSanctionsGate } from "../sanctionsGate.mjs";
import {
  PUBLIC_DENIAL_MESSAGE,
  SANCTIONS_CLEAR_RETENTION_MS,
  SANCTIONS_MATCH_RETENTION_MS,
  SANCTIONS_MAX_AGE_MS,
  addressListSha256,
  listWithinMaxAge,
  normalizeSanctionsAddress,
  parseSdnAdvancedXml,
  screenFromAddressList,
  screenFromStored,
  swapSanctionsCache,
} from "../sanctions.mjs";
import { clearSanctionsGate, TEST_PEPPER } from "./clearGate.mjs";

const LISTED = "0x4444444444444444444444444444444444444444";
const CLEAR = "0x5555555555555555555555555555555555555555";
const KNOWN_SDN = "0x252a8bd2319d8a555b872990601221b3a2053bce";
const DAY = 24 * 60 * 60 * 1000;

function knownSdnXml(extra = []) {
  const addresses = [KNOWN_SDN, ...extra];
  const features = addresses.map((address) =>
    `<Feature FeatureTypeID="345"><FeatureVersion><VersionDetail>${address}</VersionDetail></FeatureVersion></Feature>`,
  ).join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<Sanctions>
  <DateOfIssue CalendarTypeID="1"><Year>2026</Year><Month>10</Month><Day>21</Day></DateOfIssue>
  <ReferenceValueSets><FeatureTypeValues>
    <FeatureType ID="345">Digital Currency Address - ETH</FeatureType>
  </FeatureTypeValues></ReferenceValueSets>
  <DistinctParties>${features}</DistinctParties>
</Sanctions>`;
}

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
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function boot(sanctions) {
  const dir = await mkdtemp(join(tmpdir(), "ofac-fixes-"));
  const config = loadConfig({ CLAIM_LOG_PATH: join(dir, "claims.jsonl") });
  const server = createClaimRelayer({
    config,
    killSwitch: createKillSwitch({ initial: false }),
    nonceStore: createNonceStore(),
    claimLog: createClaimLog({ filePath: join(dir, "claims.jsonl") }),
    broadcaster: null,
    sanctions,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe("edge geoblock", () => {
  const at = 1_700_000_000_000;

  it("names the program list confirmed on 2026-10-27 and blocks only that list", () => {
    assert.match(PROGRAM_NOTE, /2026-10-27/);
    for (const country of ["CU", "IR", "KP"]) {
      assert.equal(decideGeoblock({ country, edge: true, at }).decision, "deny");
    }
    for (const country of ["SY", "RU", "VE", "US", "DE"]) {
      assert.equal(decideGeoblock({ country, edge: true, at }).decision, "allow");
    }
    assert.equal(decideGeoblock({ country: "UA", edge: true, at }).decision, "allow");
    assert.equal(decideGeoblock({ country: "UA", regionCode: "43", edge: true, at }).country, "UA-43");
    assert.equal(decideGeoblock({ country: "UA", regionCode: "14", edge: true, at }).decision, "deny");
    assert.equal(decideGeoblock({ country: "UA", region: "Luhansk", edge: true, at }).country, "UA-09");
    assert.equal(decideGeoblock({ country: "UA", region: "Kyiv", edge: true, at }).decision, "allow");
    assert.equal(decideGeoblock({ country: "", edge: true, at }).decision, "deny");
    assert.equal(decideGeoblock({ country: "XX", edge: true, at }).decision, "deny");
    assert.equal(decideGeoblock({ country: "", edge: false, at }).decision, "skip");
    const log = geoLog(decideGeoblock({ country: "CU", edge: true, at }));
    assert.deepEqual(Object.keys(log).sort(), ["at", "country", "decision", "message"]);
    assert.equal(JSON.stringify(log).includes("."), false);
  });
});

describe("account wallet screen", () => {
  const now = 1_800_000_000_000;

  function gate(addresses = [LISTED]) {
    return createSanctionsGate({
      pepper: TEST_PEPPER,
      now: () => now,
      screen: screenFromAddressList(addresses, now, { minAddresses: 1, listVersion: "acct" }),
    });
  }

  it("signs up a clear wallet as unverified and denies a listed wallet with the exact sentence", async () => {
    const open = gate();
    const allowed = await open.signup({ accountId: "acct-1", wallet: CLEAR });
    assert.equal(allowed.http, 200);
    assert.deepEqual({ ok: allowed.ok, status: allowed.status }, { ok: true, status: "unverified" });
    const denied = await open.signup({ accountId: "acct-2", wallet: LISTED });
    assert.equal(denied.http, 403);
    assert.equal(denied.message, PUBLIC_DENIAL_MESSAGE);
    assert.equal(denied.message.toLowerCase().includes("sanction"), false);
    assert.equal(denied.message.includes("SDN"), false);
  });

  it("blocks every wallet on an account after one match, including after unlink", async () => {
    const open = gate();
    assert.equal((await open.link({ accountId: "acct-3", wallet: LISTED })).http, 403);
    const sibling = await open.link({ accountId: "acct-3", wallet: CLEAR });
    assert.equal(sibling.http, 403);
    assert.equal(open.blocks(CLEAR), true);
    const fresh = gate();
    assert.equal((await fresh.signup({ accountId: "acct-4", wallet: CLEAR })).http, 200);
    await fresh.link({ accountId: "acct-4", wallet: LISTED });
    const removed = await fresh.unlink({ accountId: "acct-4", wallet: LISTED });
    assert.equal(removed.http, 403);
    assert.equal((await fresh.signup({ accountId: "acct-4", wallet: "0x6666666666666666666666666666666666666666" })).http, 403);
  });

  it("fails closed when the list is down and still denies a stored match", async () => {
    const open = createSanctionsGate({ pepper: TEST_PEPPER, now: () => now });
    const down = await open.signup({ accountId: "acct-5", wallet: CLEAR });
    assert.equal(down.http, 403);
    assert.equal(down.decision.result, "unavailable");
    const remembered = gate();
    await remembered.signup({ accountId: "acct-6", wallet: LISTED });
    remembered.replace(screenFromAddressList([CLEAR], now, {
      minAddresses: 1,
      wallets: [{ wallet: LISTED }],
    }));
    const again = await remembered.link({ accountId: "acct-7", wallet: LISTED });
    assert.equal(again.decision.result, "match");
  });
});

describe("screening record retention", () => {
  it("keeps 90 days of clears, purges day 91, and keeps matches for 10 years", () => {
    const now = 2_000_000_000_000;
    const open = clearSanctionsGate(now);
    const sql = nodeSql(open.db);
    const insert = (result, age) => {
      sql.run(
        `INSERT INTO sanctions_checks(wallet_hash, result, reason, checked_at, persisted) VALUES(?, ?, ?, ?, 0)`,
        "abc",
        result,
        result,
        now - age,
      );
    };
    insert("clear", 89 * DAY);
    insert("clear", 90 * DAY);
    insert("clear", 91 * DAY);
    insert("unavailable", 91 * DAY);
    insert("match", 91 * DAY);
    insert("match", SANCTIONS_MATCH_RETENTION_MS + DAY);
    sql.run(
      `INSERT INTO sanctions_wallets(wallet, wallet_hash, reason, checked_at, list_version) VALUES(?, ?, ?, ?, ?)`,
      CLEAR,
      "abc",
      "sanctions_match",
      now - (91 * DAY),
      "t",
    );
    const first = purgeRetention(sql, now);
    assert.equal(first.cleared, 1);
    assert.equal(first.unavailable, 1);
    assert.equal(first.matches, 1);
    const left = sql.all("SELECT result, checked_at FROM sanctions_checks ORDER BY checked_at");
    assert.equal(left.length, 3);
    assert.equal(sql.get("SELECT wallet FROM sanctions_wallets")?.wallet, CLEAR);
    const second = purgeRetention(sql, now);
    assert.equal(second.cleared, 0);
    assert.equal(second.matches, 0);
    assert.equal(SANCTIONS_CLEAR_RETENTION_MS, 90 * DAY);
    assert.equal(SANCTIONS_MATCH_RETENTION_MS, 10 * 365 * DAY);
  });
});

describe("strict address and list integrity", () => {
  const now = 10_000;

  it("rejects bypass strings and non-EVM text", () => {
    const good = "0x00000000000000000000000000000000000000a1";
    assert.equal(normalizeSanctionsAddress(` \n0x${good.slice(2).toUpperCase()}\t`), good);
    for (const value of [
      `${good.slice(0, -1)}`,
      `${good}aa`,
      `0x ${good.slice(2)}`,
      `0X${good.slice(2)}`,
      `\u200b${good}`,
      `０x${good.slice(2)}`,
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    ]) {
      assert.equal(normalizeSanctionsAddress(value), "");
    }
  });

  it("parses the published ETH feature from the 2026-10-21 list excerpt", () => {
    const parsed = parseSdnAdvancedXml(knownSdnXml(), { minAddresses: 1 });
    assert.equal(parsed.listVersion, "2026-10-21");
    assert.equal(parsed.addresses.includes(KNOWN_SDN), true);
  });

  it("denies a hash mismatch, a future fetch time, and the 24 hour boundary", () => {
    const addresses = [CLEAR];
    const json = JSON.stringify(addresses);
    const row = {
      fetched_at: now,
      source: "test",
      list_version: "v",
      addresses_json: json,
      addresses_sha256: addressListSha256(addresses),
    };
    assert.equal(screenFromStored(row, [], now + SANCTIONS_MAX_AGE_MS, { minAddresses: 1 }).listReady, true);
    assert.equal(screenFromStored(row, [], now + SANCTIONS_MAX_AGE_MS + 1, { minAddresses: 1 }).listReady, false);
    assert.equal(listWithinMaxAge(now + 1, now), false);
    const mismatch = screenFromStored({ ...row, addresses_sha256: "0".repeat(64) }, [], now, { minAddresses: 1 });
    assert.equal(mismatch.listReady, false);
    const corrupt = screenFromStored({ ...row, addresses_json: "{" }, [], now, { minAddresses: 1 });
    assert.equal(corrupt.listReady, false);
  });

  it("rolls back a cache swap that throws and leaves the previous row", () => {
    const open = clearSanctionsGate(now);
    swapSanctionsCache(open.db, {
      fetchedAt: now,
      source: "test",
      listVersion: "good",
      addressesJson: JSON.stringify([CLEAR]),
      addressesSha256: addressListSha256([CLEAR]),
      rawSha256: "abc",
    });
    const before = open.db.prepare("SELECT addresses_json FROM sanctions_cache WHERE id = 1").get();
    const throwing = {
      exec(sql) {
        open.db.exec(sql);
      },
      prepare() {
        throw new Error("interrupted");
      },
    };
    assert.throws(() => swapSanctionsCache(throwing, {
      fetchedAt: now,
      source: "test",
      listVersion: "bad",
      addressesJson: "[\"0x1111111111111111111111111111111111111111\"]",
      addressesSha256: "abc",
      rawSha256: "def",
    }));
    const after = open.db.prepare("SELECT addresses_json, list_version FROM sanctions_cache WHERE id = 1").get();
    assert.equal(after.addresses_json, before?.addresses_json ?? null);
  });
});

describe("claim relayer refuses a screened wallet before broadcast", () => {
  it("returns the exact denial and does not call the broadcaster", async () => {
    const now = Date.now();
    const sanctions = createSanctionsGate({
      pepper: TEST_PEPPER,
      now: () => now,
      screen: screenFromAddressList([LISTED], now, { minAddresses: 1 }),
    });
    let broadcasts = 0;
    const dir = await mkdtemp(join(tmpdir(), "ofac-claim-"));
    const config = loadConfig({
      CLAIM_LOG_PATH: join(dir, "claims.jsonl"),
      LIVE_SUBMIT: "1",
      SPENCER_RUN_AUTH: "1",
    });
    const server = createClaimRelayer({
      config,
      killSwitch: createKillSwitch({ initial: false }),
      nonceStore: createNonceStore(),
      claimLog: createClaimLog({ filePath: join(dir, "claims.jsonl") }),
      broadcaster: { async send() { broadcasts += 1; return { txHash: "0x" + "ab".repeat(32) }; } },
      sanctions,
      now: () => now,
    });
    const logs = [];
    const logged = mock.method(console, "info", (...args) => logs.push(args.map(String).join(" ")));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const denied = await request(server.address().port, "POST", "/v1/claims", {
        payer: LISTED,
        payee: CLEAR,
        claimId: "listed",
        live: true,
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.message, PUBLIC_DENIAL_MESSAGE);
      assert.equal(denied.json.ok, false);
      assert.equal("error" in denied.json, false);
      assert.equal(denied.raw.toLowerCase().includes("sanction"), false);
      assert.equal(denied.raw.includes("SDN"), false);
      assert.equal(broadcasts, 0);
      const signed = await request(server.address().port, "POST", "/v1/screen/signup", {
        accountId: "person-1",
        wallet: CLEAR,
      });
      assert.equal(signed.status, 200);
      assert.equal(signed.json.status, "unverified");
      assert.equal(logs.join("\n").includes(CLEAR), false);
      assert.equal(logs.join("\n").includes(LISTED), false);
      assert.equal(/0x[0-9a-fA-F]{40}/.test(logs.join("\n")), false);
    } finally {
      logged.mock.restore();
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("serves the denial from the server when the client is not consulted", async () => {
    const sanctions = clearSanctionsGate();
    const ctx = await boot(sanctions);
    try {
      const response = await request(ctx.port, "POST", "/v1/screen/signup", {
        accountId: "bypass",
        wallet: "not-an-address",
      });
      assert.equal(response.status, 403);
      assert.equal(response.json.message, PUBLIC_DENIAL_MESSAGE);
    } finally {
      await ctx.close();
    }
  });
});
