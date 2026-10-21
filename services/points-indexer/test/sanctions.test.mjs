import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  SANCTIONS_MATCH,
  SANCTIONS_MAX_BYTES,
  SANCTIONS_REFRESH_MS,
  cacheIsFresh,
  decideSanctions,
  eligibilityFromDecision,
  parseSdnAdvancedXml,
} from "../src/sanctions.mjs";
import { ACTION } from "../src/constants.mjs";
import { account, createdLog, creditCandidate, rows, tempIndexer } from "./support.mjs";

const BTC = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const OTHER = "0x00000000000000000000000000000000000000b2";

function sdnXml(eth = []) {
  const features = [
    ...eth.map((address) =>
      `<Feature ID="96530" FeatureTypeID="345"><FeatureVersion ID="94109" ReliabilityID="91479"><Comment /><VersionDetail DetailTypeID="1432">${address}</VersionDetail></FeatureVersion></Feature>`,
    ),
    `<Feature FeatureTypeID="344"><FeatureVersion><VersionDetail>${BTC}</VersionDetail></FeatureVersion></Feature>`,
    `<Feature FeatureTypeID="9"><FeatureVersion><VersionDetail>not-an-address</VersionDetail></FeatureVersion></Feature>`,
  ].join("");
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<Sanctions xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML">
  <DateOfIssue CalendarTypeID="1"><Year>2026</Year><Month>10</Month><Day>21</Day></DateOfIssue>
  <ReferenceValueSets>
    <FeatureTypeValues>
      <FeatureType ID="345" FeatureTypeGroupID="1">Digital Currency Address - ETH</FeatureType>
      <FeatureType ID="344" FeatureTypeGroupID="1">Digital Currency Address - XBT</FeatureType>
      <FeatureType ID="9" FeatureTypeGroupID="2">Passport</FeatureType>
    </FeatureTypeValues>
  </ReferenceValueSets>
  <DistinctParties>${features}</DistinctParties>
</Sanctions>`;
}

function xmlResponse(xml, status = 200, headers = {}) {
  const lower = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  return {
    ok: status >= 200 && status < 300,
    headers: { get(name) { return lower[String(name).toLowerCase()] ?? null; } },
    async text() { return xml; },
    body: null,
  };
}

async function fund(indexer, payer, payee) {
  const timestamp = 21_000 * 86400 + 100;
  const log = createdLog({
    escrowId: `0x${"aa".repeat(32)}`,
    payer: payer.address,
    payee: payee.address,
    expiresAt: timestamp + 1000,
    blockNumber: 49_000_010,
    logIndex: 7,
    txHash: `0x${"bb".repeat(32)}`,
    timestamp,
  });
  indexer.ingestLogs([log]);
  const candidate = indexer.attribute().candidates[0];
  const result = await creditCandidate(indexer, payer, candidate);
  assert.equal(result.link?.ok, true, result.link?.reason);
  return rows(indexer);
}

describe("OFAC SDN parser", () => {
  it("keeps ETH addresses lowercase, keeps non-EVM text, and ignores other features", () => {
    const parsed = parseSdnAdvancedXml(sdnXml(["0x00000000000000000000000000000000000000A1"]));
    assert.equal(parsed.listVersion, "2026-10-21");
    assert.deepEqual(parsed.addresses, [
      "0x00000000000000000000000000000000000000a1",
      BTC,
    ]);
    assert.equal(parsed.addresses.includes(BTC.toLowerCase()), false);
    assert.equal(parsed.addresses.includes("not-an-address"), false);
  });

  it("rejects an empty file, a file with no digital-currency types, and a truncated file", () => {
    assert.throws(() => parseSdnAdvancedXml(""), /sanctions_xml_empty/);
    assert.throws(() => parseSdnAdvancedXml("   "), /sanctions_xml_empty/);
    const withoutTypes = sdnXml().replace(/Digital Currency Address - /g, "Other ");
    assert.throws(() => parseSdnAdvancedXml(withoutTypes), /sanctions_xml_invalid/);
    assert.throws(() => parseSdnAdvancedXml(sdnXml().replace("</Sanctions>", "")), /sanctions_xml_invalid/);
  });
});

describe("sanctions decision", () => {
  const wallet = "0x00000000000000000000000000000000000000a1";
  const listed = new Set([wallet]);
  const persisted = new Set([wallet]);

  it("matches a listed address and keeps points at zero", () => {
    const decision = decideSanctions(wallet.toUpperCase().replace("0X", "0x"), {
      addresses: listed,
      persisted: new Set(),
      listReady: true,
    });
    assert.deepEqual(decision, { result: "match", reason: SANCTIONS_MATCH, persisted: false });
    assert.deepEqual(eligibilityFromDecision(decision), {
      points: 0,
      eligibility_status: "ineligible",
      eligibility_reason: SANCTIONS_MATCH,
      points_withheld: 1,
    });
  });

  it("leaves a clear wallet unverified", () => {
    const decision = decideSanctions(OTHER, { addresses: listed, persisted: new Set(), listReady: true });
    assert.equal(decision.result, "clear");
    assert.deepEqual(eligibilityFromDecision(decision), {
      points: 0,
      eligibility_status: "unverified",
      eligibility_reason: "ofac_unconfigured",
      points_withheld: 1,
    });
  });

  it("does not treat a missing list as a clear, and a stored match still matches", () => {
    const missing = decideSanctions(OTHER, { addresses: new Set(), persisted: new Set(), listReady: false });
    assert.equal(missing.result, "unavailable");
    assert.equal(missing.reason, "ofac_unconfigured");
    const kept = decideSanctions(wallet, { addresses: new Set(), persisted, listReady: false });
    assert.deepEqual(kept, { result: "match", reason: SANCTIONS_MATCH, persisted: true });
    assert.equal(cacheIsFresh(1_000, 1_000 + SANCTIONS_REFRESH_MS - 1), true);
    assert.equal(cacheIsFresh(1_000, 1_000 + SANCTIONS_REFRESH_MS), false);
  });
});

describe("sanctions screen on the indexer", () => {
  it("marks a listed wallet ineligible, keeps that status after the list drops it, and audits once per rebuild", async () => {
    const payer = account();
    const payee = account();
    const ctx = tempIndexer();
    const calls = [];
    try {
      const refreshed = await ctx.indexer.refreshSanctions({
        fetch: (url) => {
          calls.push(url);
          return xmlResponse(sdnXml([payer.address]));
        },
        now: 1_000,
      });
      assert.equal(refreshed.refreshed, true);
      assert.equal(refreshed.listVersion, "2026-10-21");
      const ledger = await fund(ctx.indexer, payer, payee);
      assert.ok(ledger.length >= 2);
      assert.ok(ledger.every((row) => row.points === 0));
      assert.ok(ledger.every((row) => row.points_withheld === 1));
      assert.ok(ledger.every((row) => row.eligibility_status === "ineligible"));
      assert.ok(ledger.every((row) => row.eligibility_reason === SANCTIONS_MATCH));
      const wallet = payer.address.toLowerCase();
      const stored = ctx.indexer.db.prepare("SELECT reason FROM sanctions_wallets WHERE wallet = ?").get(wallet);
      assert.equal(stored.reason, SANCTIONS_MATCH);
      const before = ctx.indexer.db.prepare("SELECT COUNT(*) AS n FROM sanctions_checks WHERE wallet = ?").get(wallet).n;
      ctx.indexer.rebuild();
      const after = ctx.indexer.db.prepare("SELECT COUNT(*) AS n FROM sanctions_checks WHERE wallet = ?").get(wallet).n;
      assert.equal(after, before + 1);
      const dropped = await ctx.indexer.refreshSanctions({
        fetch: (url) => {
          calls.push(url);
          return xmlResponse(sdnXml([OTHER]));
        },
        now: 1_000 + SANCTIONS_REFRESH_MS,
      });
      assert.equal(dropped.refreshed, true);
      ctx.indexer.rebuild();
      const again = rows(ctx.indexer);
      assert.ok(again.every((row) => row.eligibility_reason === SANCTIONS_MATCH));
      assert.ok(again.every((row) => row.eligibility_status === "ineligible"));
      assert.ok(again.every((row) => row.points === 0));
      const latest = ctx.indexer.db.prepare(
        "SELECT result, persisted FROM sanctions_checks WHERE wallet = ? ORDER BY id DESC LIMIT 1",
      ).get(wallet);
      assert.equal(latest.result, "match");
      assert.equal(latest.persisted, 1);
      assert.equal(calls.length, 2);
    } finally {
      ctx.close();
    }
  });

  it("leaves a wallet off the list unverified and does not approve it", async () => {
    const payer = account();
    const payee = account();
    const ctx = tempIndexer();
    try {
      await ctx.indexer.refreshSanctions({
        fetch: () => xmlResponse(sdnXml([OTHER])),
        now: 5_000,
      });
      const ledger = await fund(ctx.indexer, payer, payee);
      assert.ok(ledger.some((row) => row.action === ACTION.fund));
      assert.ok(ledger.every((row) => row.points === 0));
      assert.ok(ledger.every((row) => row.points_withheld === 1));
      assert.ok(ledger.every((row) => row.eligibility_status === "unverified"));
      assert.ok(ledger.every((row) => row.eligibility_reason === "ofac_unconfigured"));
      const wallet = payer.address.toLowerCase();
      const checks = ctx.indexer.db.prepare("SELECT result, reason FROM sanctions_checks WHERE wallet = ?").all(wallet);
      assert.ok(checks.length >= 1);
      assert.ok(checks.every((row) => row.result === "clear"));
      assert.ok(checks.every((row) => row.reason === "clear"));
      const stored = ctx.indexer.db.prepare("SELECT wallet FROM sanctions_wallets WHERE wallet = ?").get(wallet);
      assert.equal(stored, undefined);
    } finally {
      ctx.close();
    }
  });

  it("stays fail-closed when no list is cached and records unavailable", async () => {
    const payer = account();
    const payee = account();
    const ctx = tempIndexer();
    try {
      const ledger = await fund(ctx.indexer, payer, payee);
      assert.ok(ledger.every((row) => row.eligibility_reason === "ofac_unconfigured"));
      assert.ok(ledger.every((row) => row.points === 0));
      const wallet = payer.address.toLowerCase();
      const checks = ctx.indexer.db.prepare("SELECT result FROM sanctions_checks WHERE wallet = ?").all(wallet);
      assert.ok(checks.length >= 1);
      assert.ok(checks.every((row) => row.result === "unavailable"));
    } finally {
      ctx.close();
    }
  });

  it("refreshes on the interval, keeps the old cache when the fetch fails, and does not log the URL", async () => {
    const ctx = tempIndexer();
    const secret = "list-token-test-only";
    const errors = [];
    const logged = mock.method(console, "error", (...args) => {
      errors.push(args.map(String).join(" "));
    });
    let calls = 0;
    try {
      const first = await ctx.indexer.refreshSanctions({
        fetch: () => {
          calls += 1;
          return xmlResponse(sdnXml([OTHER]));
        },
        now: 10_000,
      });
      assert.equal(first.refreshed, true);
      assert.equal(calls, 1);
      const skipped = await ctx.indexer.refreshSanctions({
        fetch: () => {
          calls += 1;
          return xmlResponse(sdnXml(["0x00000000000000000000000000000000000000c3"]));
        },
        now: 10_000 + 60_000,
      });
      assert.equal(skipped.refreshed, false);
      assert.equal(skipped.failed, false);
      assert.equal(calls, 1);
      const failed = await ctx.indexer.refreshSanctions({
        fetch: () => {
          calls += 1;
          throw new Error(`https://example.invalid/sdn?token=${secret}`);
        },
        now: 10_000 + SANCTIONS_REFRESH_MS,
      });
      assert.equal(failed.failed, true);
      assert.equal(failed.refreshed, false);
      const cache = ctx.indexer.db.prepare("SELECT addresses_json, list_version FROM sanctions_cache WHERE id = 1").get();
      assert.equal(cache.list_version, "2026-10-21");
      assert.equal(cache.addresses_json.includes(OTHER), true);
      assert.equal(errors.some((line) => line.includes(secret)), false);
      assert.equal(errors.some((line) => line.includes("https://")), false);
      assert.equal(errors.some((line) => line.includes("sanctions_refresh_failed")), true);
      const oversized = await ctx.indexer.refreshSanctions({
        fetch: () => xmlResponse("too-big", 200, { "content-length": String(SANCTIONS_MAX_BYTES + 1) }),
        now: 10_000 + SANCTIONS_REFRESH_MS * 3,
      });
      assert.equal(oversized.failed, true);
      assert.equal(oversized.refreshed, false);
      const kept = ctx.indexer.db.prepare("SELECT addresses_json FROM sanctions_cache WHERE id = 1").get();
      assert.equal(kept.addresses_json.includes(OTHER), true);
    } finally {
      logged.mock.restore();
      ctx.close();
    }
  });
});
