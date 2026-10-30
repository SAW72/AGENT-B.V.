import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { createClaimLog } from "../claimLog.mjs";
import { loadConfig } from "../config.mjs";
import { adminAuthorized, authorizeReleaseAdmin, createClaimRelayer, secretsEqual } from "../app.mjs";
import { decideGeoblock, geoInputFromHeaders, geoLog, PROGRAM_NOTE } from "../geoblock.mjs";
import { createMemorySanctionsData } from "../sanctionsMemory.mjs";
import { createRateLimiter } from "../reputation/rateLimit.mjs";
import { createKillSwitch } from "../killSwitch.mjs";
import { createNonceStore } from "../nonceStore.mjs";
import { createSanctionsGate } from "../sanctionsGate.mjs";
import { postScreen, screenSigner } from "./screenSession.mjs";
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
        resolve({ status: res.statusCode, json, raw, headers: res.headers });
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
    edgeCountry: "US",
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

  it("names the program list confirmed on 2026-10-27 and denies owner-policy countries", () => {
    assert.match(PROGRAM_NOTE, /2026-10-27/);
    for (const country of ["CU", "IR", "KP", "SY", "RU", "VE"]) {
      assert.equal(decideGeoblock({ country, edge: true, at }).decision, "deny");
    }
    for (const country of ["US", "DE"]) {
      assert.equal(decideGeoblock({ country, edge: true, at }).decision, "allow");
    }
    assert.equal(decideGeoblock({ country: "UA", edge: true, at }).decision, "deny");
    assert.equal(decideGeoblock({ country: "UA", regionCode: "", region: "", edge: true, at }).decision, "deny");
    assert.equal(decideGeoblock({ country: "UA", regionCode: " ", region: " ", edge: true, at }).decision, "deny");
    assert.equal(decideGeoblock({ country: "UA", regionCode: "43", edge: true, at }).country, "UA-43");
    assert.equal(decideGeoblock({ country: "UA", regionCode: "14", edge: true, at }).decision, "deny");
    assert.equal(decideGeoblock({ country: "UA", regionCode: "40", edge: true, at }).country, "UA-40");
    assert.equal(decideGeoblock({ country: "UA", regionCode: "40", edge: true, at }).decision, "deny");
    assert.equal(decideGeoblock({ country: "UA", regionCode: "UA-40", region: "Kyiv", edge: true, at }).country, "UA-40");
    assert.equal(decideGeoblock({ country: "UA", regionCode: "30", region: "Sevastopol", edge: true, at }).country, "UA-40");
    assert.equal(decideGeoblock({ country: "UA", region: " SEVASTOPOL ", edge: true, at }).decision, "deny");
    assert.equal(decideGeoblock({ country: "UA", region: "Sevastopol City", edge: true, at }).country, "UA-40");
    assert.equal(decideGeoblock({ country: "UA", region: "Luhansk", edge: true, at }).country, "UA-09");
    assert.equal(decideGeoblock({ country: "UA", region: "Kyiv", edge: true, at }).decision, "allow");
    assert.equal(decideGeoblock({ country: "", edge: true, at }).decision, "deny");
    assert.equal(decideGeoblock({ country: "XX", edge: true, at }).decision, "deny");
    assert.equal(decideGeoblock({ country: "T1", edge: false, at }).decision, "deny");
    assert.equal(decideGeoblock({ country: "", edge: false, at }).decision, "deny");
    assert.equal(decideGeoblock({ country: "US", edge: false, publicRoute: true, at }).decision, "deny");
    assert.equal(decideGeoblock({ country: "SY", edge: false, publicRoute: true, at }).decision, "deny");
    assert.equal(decideGeoblock({ country: "US", edge: true, publicRoute: true, at }).decision, "allow");
    const clientHeaders = {
      get(name) {
        if (name === "CF-IPCountry") return "SY";
        if (name === "CF-Region-Code") return "43";
        return "";
      },
    };
    const fromCf = geoInputFromHeaders(clientHeaders, { country: "US", regionCode: "", region: "" }, true);
    assert.equal(fromCf.country, "US");
    assert.equal(fromCf.regionCode, "");
    assert.equal(decideGeoblock({ ...fromCf, publicRoute: true, at }).decision, "allow");
    const blockedCf = geoInputFromHeaders(clientHeaders, { country: "SY" }, true);
    assert.equal(blockedCf.country, "SY");
    assert.equal(decideGeoblock({ ...blockedCf, publicRoute: true, at }).decision, "deny");
    const ignored = geoInputFromHeaders(clientHeaders, undefined, true);
    assert.equal(ignored.country, "");
    assert.equal(ignored.edge, false);
    assert.equal(decideGeoblock({ ...ignored, publicRoute: true, at }).decision, "deny");
    assert.equal(decideGeoblock({ country: "", edge: false, at }).decision === "skip", false);
    const log = geoLog(decideGeoblock({ country: "CU", edge: true, at }));
    assert.deepEqual(Object.keys(log).sort(), ["at", "country", "decision", "message"]);
    assert.equal(JSON.stringify(log).includes("."), false);
  });
});

describe("account wallet screen", () => {
  const now = 1_800_000_000_000;

  function gate(addresses = [LISTED]) {
    const open = createSanctionsGate({
      pepper: TEST_PEPPER,
      data: createMemorySanctionsData(),
      now: () => now,
      screen: screenFromAddressList(addresses, now, { minAddresses: 1, listVersion: "acct" }),
    });
    const signup = open.signup.bind(open);
    const link = open.link.bind(open);
    const change = open.change.bind(open);
    const unlink = open.unlink.bind(open);
    return Object.assign(open, {
      signup: (body) => signup({ ...body, proven: true }),
      link: (body) => link({ ...body, proven: true }),
      change: (body) => change({ ...body, proven: true }),
      unlink: (body) => unlink({ ...body, proven: true }),
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
    assert.equal(await open.blocks(CLEAR), true);
    const fresh = gate();
    assert.equal((await fresh.signup({ accountId: "acct-4", wallet: CLEAR })).http, 200);
    await fresh.link({ accountId: "acct-4", wallet: LISTED });
    const removed = await fresh.unlink({ accountId: "acct-4", wallet: LISTED });
    assert.equal(removed.http, 403);
    const unlinkChecks = fresh.data.state.checks.filter((row) => row.decision_point === "unlink");
    assert.equal(unlinkChecks.length, 1);
    assert.equal(unlinkChecks[0].result, "match");
    assert.equal((await fresh.signup({ accountId: "acct-4", wallet: "0x6666666666666666666666666666666666666666" })).http, 403);
  });

  it("fails closed when the list is down and still denies a stored match", async () => {
    const open = createSanctionsGate({ pepper: TEST_PEPPER, data: createMemorySanctionsData(), now: () => now });
    const down = await open.signup({ accountId: "acct-5", wallet: CLEAR, proven: true });
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
  it("keeps 90 days of clears, purges day 91, and keeps matches for 10 years", async () => {
    const now = 2_000_000_000_000;
    const open = clearSanctionsGate(now);
    const insert = (result, age) => {
      open.data.state.checks.push({
        wallet_hash: "abc",
        result,
        reason: result,
        checked_at: now - age,
        persisted: 0,
      });
    };
    insert("clear", 89 * DAY);
    insert("clear", 90 * DAY);
    insert("clear", 91 * DAY);
    insert("unavailable", 91 * DAY);
    insert("match", 91 * DAY);
    insert("match", SANCTIONS_MATCH_RETENTION_MS + DAY);
    open.data.state.wallets.push({
      wallet: CLEAR,
      wallet_hash: "abc",
      reason: "sanctions_match",
      checked_at: now - (91 * DAY),
      list_version: "t",
    });
    const first = await open.purgeRetention(now);
    assert.equal(first.cleared, 1);
    assert.equal(first.unavailable, 1);
    assert.equal(first.matches, 1);
    assert.equal(open.data.state.checks.length, 3);
    assert.equal(open.data.state.wallets[0]?.wallet, CLEAR);
    const second = await open.purgeRetention(now);
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

});

describe("claim relayer refuses a screened wallet before broadcast", () => {
  it("returns the exact denial and does not call the broadcaster", async () => {
    const now = Date.now();
    const sanctions = createSanctionsGate({
      pepper: TEST_PEPPER,
      data: createMemorySanctionsData(),
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
      edgeCountry: "US",
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
      const signed = await postScreen(request, server.address().port, "signup", screenSigner(), "person-1");
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
      assert.equal(response.status, 401);
      assert.equal(response.json.error, "unproven");
    } finally {
      await ctx.close();
    }
  });
});

describe("public routes deny when location is unknown or off-edge", () => {
  it("ignores a client country header when the process is off-edge", async () => {
    const sanctions = clearSanctionsGate();
    const dir = await mkdtemp(join(tmpdir(), "ofac-off-edge-"));
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
    try {
      const response = await request(server.address().port, "POST", "/v1/screen/signup", {
        accountId: "off-edge",
        wallet: CLEAR,
      }, { "cf-ipcountry": "US", "x-edge-country": "US" });
      assert.equal(response.status, 403);
      assert.equal(response.json.message, PUBLIC_DENIAL_MESSAGE);
      assert.equal(response.raw.toLowerCase().includes("sanction"), false);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("denies a server-side owner-policy country on a public route", async () => {
    const sanctions = clearSanctionsGate();
    const dir = await mkdtemp(join(tmpdir(), "ofac-sy-"));
    const config = loadConfig({ CLAIM_LOG_PATH: join(dir, "claims.jsonl") });
    const server = createClaimRelayer({
      config,
      killSwitch: createKillSwitch({ initial: false }),
      nonceStore: createNonceStore(),
      claimLog: createClaimLog({ filePath: join(dir, "claims.jsonl") }),
      broadcaster: null,
      sanctions,
      edgeCountry: "RU",
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const response = await request(server.address().port, "POST", "/v1/screen/signup", {
        accountId: "owner-policy",
        wallet: CLEAR,
      });
      assert.equal(response.status, 403);
      assert.equal(response.json.message, PUBLIC_DENIAL_MESSAGE);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("false-positive release", () => {
  const now = 1_900_000_000_000;
  const opsSecret = "ops-release-secret";
  const reviewSecret = "review-release-secret";
  const adminsJson = JSON.stringify({
    "ops-1": sha256Hex(opsSecret),
    "review-2": sha256Hex(reviewSecret),
  });

  it("keeps a true match blocked, releases a false positive, and keeps the audit row", async () => {
    const open = createSanctionsGate({
      pepper: TEST_PEPPER,
      data: createMemorySanctionsData(),
      now: () => now,
      screen: screenFromAddressList([LISTED], now, { minAddresses: 1, listVersion: "live" }),
    });
    await open.signup({ accountId: "acct-fp", wallet: LISTED, proven: true });
    assert.equal((await open.release(LISTED, "ops-1")).error, "release_refused");
    assert.equal(await open.blocks(LISTED), true);
    open.replace(screenFromAddressList([], now, { minAddresses: 1, listVersion: "down" }));
    assert.equal((await open.release(LISTED, "ops-1")).error, "release_refused");
    assert.equal(await open.blocks(LISTED), true);
    open.replace(screenFromAddressList([CLEAR], now, { minAddresses: 1, listVersion: "next" }));
    assert.equal((await open.release(LISTED, "review-2")).ok, true);
    assert.equal(await open.blocks(LISTED), false);
    const rows = open.data.state.releaseAudit;
    assert.deepEqual(rows.map((row) => ({ outcome: row.outcome, actor: row.actor })), [
      { outcome: "refused_match", actor: "ops-1" },
      { outcome: "refused_unavailable", actor: "ops-1" },
      { outcome: "released", actor: "review-2" },
    ]);
    assert.equal(rows[0].actor, "ops-1");
    assert.equal(JSON.stringify(rows).includes(LISTED), false);
    await open.purgeRetention(now + SANCTIONS_MATCH_RETENTION_MS + DAY);
    assert.equal(open.data.state.releaseAudit.length, 3);
  });

  it("requires the env secret and does not echo it", async () => {
    const sanctions = createSanctionsGate({
      pepper: TEST_PEPPER,
      data: createMemorySanctionsData(),
      now: () => now,
      screen: screenFromAddressList([LISTED], now, { minAddresses: 1, listVersion: "live" }),
    });
    const dir = await mkdtemp(join(tmpdir(), "ofac-release-"));
    const config = loadConfig({
      CLAIM_LOG_PATH: join(dir, "claims.jsonl"),
      SANCTIONS_RELEASE_ADMINS: adminsJson,
    });
    const server = createClaimRelayer({
      config,
      killSwitch: createKillSwitch({ initial: false }),
      nonceStore: createNonceStore(),
      claimLog: createClaimLog({ filePath: join(dir, "claims.jsonl") }),
      broadcaster: null,
      sanctions,
      now: () => now,
      edgeCountry: "US",
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    try {
      await sanctions.signup({ accountId: "acct-http", wallet: LISTED, proven: true });
      const missing = await request(port, "POST", "/v1/admin/sanctions/release", { wallet: LISTED, actor: "ops-1" });
      assert.equal(missing.status, 401);
      assert.equal(missing.json.error, "unauthorized");
      const wrong = await request(port, "POST", "/v1/admin/sanctions/release", { wallet: LISTED }, {
        "x-sanctions-actor": "ops-1",
        "x-admin-secret": "not-the-secret",
      });
      assert.equal(wrong.status, 401);
      const otherAdmin = await request(port, "POST", "/v1/admin/sanctions/release", { wallet: LISTED }, {
        "x-sanctions-actor": "review-2",
        "x-admin-secret": opsSecret,
      });
      assert.equal(otherAdmin.status, 401);
      assert.equal(await sanctions.blocks(LISTED), true);
      const refused = await request(port, "POST", "/v1/admin/sanctions/release", { wallet: LISTED, actor: "spoofed" }, {
        "x-sanctions-actor": "ops-1",
        "x-admin-secret": opsSecret,
      });
      assert.equal(refused.status, 403);
      assert.equal(refused.json.error, "release_refused");
      assert.equal(JSON.stringify(refused.json).includes(opsSecret), false);
      const refusedRow = sanctions.data.state.releaseAudit[sanctions.data.state.releaseAudit.length - 1];
      assert.equal(refusedRow.actor, "ops-1");
      assert.equal(refusedRow.outcome, "refused_match");
      sanctions.replace(screenFromAddressList([CLEAR], now, { minAddresses: 1, listVersion: "next" }));
      const released = await request(port, "POST", "/v1/admin/sanctions/release", { wallet: LISTED, actor: "spoofed" }, {
        "x-sanctions-actor": "review-2",
        authorization: `Bearer ${reviewSecret}`,
      });
      assert.equal(released.status, 200);
      assert.equal(released.json.ok, true);
      assert.equal(JSON.stringify(released.json).includes(reviewSecret), false);
      assert.equal(await sanctions.blocks(LISTED), false);
      const releasedRow = sanctions.data.state.releaseAudit[sanctions.data.state.releaseAudit.length - 1];
      assert.equal(releasedRow.actor, "review-2");
      assert.equal(releasedRow.outcome, "released");
      const health = await request(port, "GET", "/health");
      assert.equal(JSON.stringify(health.json).includes(opsSecret), false);
      assert.equal(JSON.stringify(health.json).includes(reviewSecret), false);
      assert.equal(JSON.stringify(health.json).includes(sha256Hex(opsSecret)), false);
      const closedDir = await mkdtemp(join(tmpdir(), "ofac-release-closed-"));
      const closedConfig = loadConfig({ CLAIM_LOG_PATH: join(closedDir, "claims.jsonl") });
      const closed = createClaimRelayer({
        config: closedConfig,
        killSwitch: createKillSwitch({ initial: false }),
        nonceStore: createNonceStore(),
        claimLog: createClaimLog({ filePath: join(closedDir, "claims.jsonl") }),
        broadcaster: null,
        sanctions,
        now: () => now,
        edgeCountry: "US",
      });
      closed.listen(0, "127.0.0.1");
      await once(closed, "listening");
      try {
        const refusedClosed = await request(closed.address().port, "POST", "/v1/admin/sanctions/release", {
          wallet: CLEAR,
        }, { "x-sanctions-actor": "ops-1", "x-admin-secret": opsSecret });
        assert.equal(refusedClosed.status, 401);
      } finally {
        await new Promise((resolve, reject) => closed.close((err) => (err ? reject(err) : resolve())));
      }
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

const EDGE_AUTH = "edge-proxy-test-secret";

async function bootPublic(env = {}, extra = {}) {
  const sanctions = extra.sanctions || clearSanctionsGate();
  const dir = await mkdtemp(join(tmpdir(), "ofac-edge-auth-"));
  const config = loadConfig({
    CLAIM_LOG_PATH: join(dir, "claims.jsonl"),
    ...env,
  });
  const server = createClaimRelayer({
    config,
    killSwitch: createKillSwitch({ initial: false }),
    nonceStore: createNonceStore(),
    claimLog: createClaimLog({ filePath: join(dir, "claims.jsonl") }),
    broadcaster: null,
    sanctions,
    ...extra.deps,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe("authenticated edge country", () => {
  it("allows an authenticated US header, denies SY, and ignores a forged or client-only country", async () => {
    const ctx = await bootPublic({ RELAYER_EDGE_AUTH: EDGE_AUTH }, {
      deps: { edgeCountry: "US" },
    });
    try {
      const allowed = await postScreen(request, ctx.port, "signup", screenSigner(), "edge-us", {
        "x-relayer-edge-auth": EDGE_AUTH,
        "X-Edge-Country": "US",
        "cf-ipcountry": "SY",
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.json.status, "unverified");
      const syria = await request(ctx.port, "POST", "/v1/screen/signup", {
        accountId: "edge-sy",
        wallet: CLEAR,
      }, {
        "x-relayer-edge-auth": EDGE_AUTH,
        "x-edge-country": "SY",
        "cf-ipcountry": "US",
      });
      assert.equal(syria.status, 403);
      assert.equal(syria.json.message, PUBLIC_DENIAL_MESSAGE);
      const crimea = await request(ctx.port, "POST", "/v1/screen/signup", {
        accountId: "edge-crimea",
        wallet: CLEAR,
      }, {
        "x-relayer-edge-auth": EDGE_AUTH,
        "x-edge-country": "UA",
        "x-edge-region-code": "43",
      });
      assert.equal(crimea.status, 403);
      const sevastopolCode = await request(ctx.port, "POST", "/v1/screen/signup", {
        accountId: "edge-sevastopol-code",
        wallet: CLEAR,
      }, {
        "x-relayer-edge-auth": EDGE_AUTH,
        "x-edge-country": "UA",
        "x-edge-region-code": "40",
      });
      assert.equal(sevastopolCode.status, 403);
      const sevastopolName = await request(ctx.port, "POST", "/v1/screen/signup", {
        accountId: "edge-sevastopol-name",
        wallet: CLEAR,
      }, {
        "x-relayer-edge-auth": EDGE_AUTH,
        "x-edge-country": "UA",
        "x-edge-region": "Sevastopol",
      });
      assert.equal(sevastopolName.status, 403);
      const legacyNames = await request(ctx.port, "POST", "/v1/screen/signup", {
        accountId: "edge-legacy-names",
        wallet: CLEAR,
      }, {
        "x-relayer-edge-auth": EDGE_AUTH,
        "cf-ipcountry": "US",
        "cf-region-code": "CA",
        "cf-region": "California",
      });
      assert.equal(legacyNames.status, 403);
      const forged = await request(ctx.port, "POST", "/v1/screen/signup", {
        accountId: "edge-forged",
        wallet: CLEAR,
      }, {
        "x-relayer-edge-auth": "not-the-proxy",
        "x-edge-country": "US",
        "cf-ipcountry": "US",
      });
      assert.equal(forged.status, 403);
      const missing = await request(ctx.port, "POST", "/v1/screen/signup", {
        accountId: "edge-missing",
        wallet: CLEAR,
      }, { "x-edge-country": "US", "cf-ipcountry": "US" });
      assert.equal(missing.status, 403);
      assert.equal(missing.json.message, PUBLIC_DENIAL_MESSAGE);
    } finally {
      await ctx.close();
    }
  });

  it("keeps an empty edge secret off-edge even when the client sends a US country", async () => {
    const ctx = await bootPublic({ RELAYER_EDGE_AUTH: "" });
    try {
      const response = await request(ctx.port, "POST", "/v1/screen/signup", {
        accountId: "no-secret",
        wallet: CLEAR,
      }, {
        "x-relayer-edge-auth": EDGE_AUTH,
        "x-edge-country": "US",
        "cf-ipcountry": "US",
      });
      assert.equal(response.status, 403);
    } finally {
      await ctx.close();
    }
  });
});

describe("admin compare and rate limit", () => {
  it("compares secrets of different lengths and names only the matching release admin", () => {
    assert.equal(secretsEqual("short", "much-longer-admin-secret"), false);
    assert.equal(secretsEqual("much-longer-admin-secret", "much-longer-admin-secret"), true);
    assert.equal(secretsEqual("", "much-longer-admin-secret"), false);
    assert.equal(secretsEqual("much-longer-admin-secret", ""), false);
    assert.equal(adminAuthorized({ headers: { "x-admin-secret": "much-longer-admin-secret" } }, "much-longer-admin-secret"), true);
    assert.equal(adminAuthorized({ headers: { "x-admin-secret": "short" } }, "much-longer-admin-secret"), false);
    assert.equal(adminAuthorized({ headers: { authorization: "Bearer much-longer-admin-secret" } }, "much-longer-admin-secret"), true);
    assert.equal(adminAuthorized({ headers: {} }, ""), false);
    const hash = sha256Hex("ops-compare-secret");
    const admins = { "ops-1": hash };
    assert.deepEqual(authorizeReleaseAdmin({
      headers: { "x-sanctions-actor": "ops-1", "x-admin-secret": "ops-compare-secret" },
    }, admins), { ok: true, actor: "ops-1" });
    assert.equal(authorizeReleaseAdmin({
      headers: { "x-sanctions-actor": "missing", "x-admin-secret": "ops-compare-secret" },
    }, admins).ok, false);
    assert.deepEqual(loadConfig({}).sanctionsReleaseAdmins, {});
    assert.equal(loadConfig({ RELAYER_EDGE_AUTH: "  " }).relayerEdgeAuth, "");
    assert.deepEqual(loadConfig({ SANCTIONS_RELEASE_ADMINS: "{" }).sanctionsReleaseAdmins, {});
    assert.deepEqual(loadConfig({
      SANCTIONS_RELEASE_ADMINS: JSON.stringify({ "ops-1": hash, nope: "short", "": hash }),
    }).sanctionsReleaseAdmins, { "ops-1": hash });
    assert.equal(Object.hasOwn(loadConfig({ SANCTIONS_RELEASE_SECRET: "legacy" }), "sanctionsReleaseSecret"), false);
  });

  it("rate limits every /v1/admin route", async () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000, clock: () => 5_000 });
    const ctx = await bootPublic({}, { deps: { adminRateLimit: limiter, edgeCountry: "US" } });
    try {
      const first = await request(ctx.port, "POST", "/v1/admin/pause", {});
      assert.equal(first.status, 200);
      const second = await request(ctx.port, "POST", "/v1/admin/unpause", {});
      assert.equal(second.status, 200);
      const third = await request(ctx.port, "POST", "/v1/admin/sanctions/release", { wallet: CLEAR });
      assert.equal(third.status, 429);
      assert.equal(third.json.error, "rate_limited");
      assert.equal(third.headers["retry-after"], "60");
      const health = await request(ctx.port, "GET", "/health");
      assert.equal(health.status, 200);
    } finally {
      await ctx.close();
    }
  });

  it("keys the screen limit on x-edge-client-ip only when edge auth matches", async () => {
    const clock = () => 5_000;
    const authed = createRateLimiter({ max: 1, windowMs: 60_000, clock });
    const ctx = await bootPublic({ RELAYER_EDGE_AUTH: EDGE_AUTH }, { deps: { screenRateLimit: authed } });
    try {
      const auth = { "x-relayer-edge-auth": EDGE_AUTH, "x-edge-country": "US" };
      const first = await request(ctx.port, "POST", "/v1/screen/nonce", {}, {
        ...auth,
        "x-edge-client-ip": "203.0.113.50",
        "cf-connecting-ip": "203.0.113.99",
        "x-forwarded-for": "1.1.1.1, 198.51.100.9",
      });
      assert.equal(first.status, 200);
      const sameEdgeIp = await request(ctx.port, "POST", "/v1/screen/nonce", {}, {
        ...auth,
        "x-edge-client-ip": "203.0.113.50",
        "cf-connecting-ip": "203.0.113.51",
        "x-forwarded-for": "9.9.9.9, 198.51.100.8",
      });
      assert.equal(sameEdgeIp.status, 429);
      assert.equal(sameEdgeIp.json.error, "rate_limited");
      const otherEdgeIp = await request(ctx.port, "POST", "/v1/screen/nonce", {}, {
        ...auth,
        "x-edge-client-ip": "203.0.113.51",
        "cf-connecting-ip": "203.0.113.50",
        "x-forwarded-for": "1.1.1.1, 198.51.100.9",
      });
      assert.equal(otherEdgeIp.status, 200);
    } finally {
      await ctx.close();
    }

    const open = createRateLimiter({ max: 1, windowMs: 60_000, clock });
    const plain = await bootPublic({ RELAYER_EDGE_AUTH: EDGE_AUTH }, {
      deps: { screenRateLimit: open, edgeCountry: "US" },
    });
    try {
      const forged = await request(plain.port, "POST", "/v1/screen/nonce", {}, {
        "x-relayer-edge-auth": "not-the-proxy",
        "x-edge-client-ip": "203.0.113.50",
        "cf-connecting-ip": "203.0.113.50",
        "x-forwarded-for": "198.51.100.9",
        "x-edge-country": "US",
        "cf-ipcountry": "US",
      });
      assert.equal(forged.status, 403);
      const otherHop = await request(plain.port, "POST", "/v1/screen/nonce", {}, {
        "x-edge-client-ip": "203.0.113.50",
        "cf-connecting-ip": "203.0.113.50",
        "x-forwarded-for": "198.51.100.10",
        "x-edge-country": "US",
        "cf-ipcountry": "US",
      });
      assert.equal(otherHop.status, 403);
      const sameHop = await request(plain.port, "POST", "/v1/screen/nonce", {}, {
        "x-edge-client-ip": "203.0.113.77",
        "cf-connecting-ip": "203.0.113.77",
        "x-forwarded-for": "1.1.1.1, 198.51.100.9",
        "x-edge-country": "US",
        "cf-ipcountry": "US",
      });
      assert.equal(sameHop.status, 429);
    } finally {
      await plain.close();
    }
  });

  it("uses edge-unknown when edge auth matches and x-edge-client-ip is empty", async () => {
    const clock = () => 5_000;
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, clock });
    const ctx = await bootPublic({ RELAYER_EDGE_AUTH: EDGE_AUTH }, { deps: { screenRateLimit: limiter } });
    try {
      const auth = { "x-relayer-edge-auth": EDGE_AUTH, "x-edge-country": "US" };
      const empty = await request(ctx.port, "POST", "/v1/screen/nonce", {}, {
        ...auth,
        "x-forwarded-for": "198.51.100.1",
      });
      assert.equal(empty.status, 200);
      const whitespace = await request(ctx.port, "POST", "/v1/screen/nonce", {}, {
        ...auth,
        "x-edge-client-ip": "   ",
        "x-forwarded-for": "198.51.100.2",
      });
      assert.equal(whitespace.status, 429);
      assert.equal(whitespace.json.error, "rate_limited");
      const named = await request(ctx.port, "POST", "/v1/screen/nonce", {}, {
        ...auth,
        "x-edge-client-ip": "203.0.113.50",
        "x-forwarded-for": "198.51.100.1",
      });
      assert.equal(named.status, 200);
    } finally {
      await ctx.close();
    }
  });
});
