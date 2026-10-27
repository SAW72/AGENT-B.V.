import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  SANCTIONS_ELEMENT_MAX_BYTES,
  SANCTIONS_MATCH,
  SANCTIONS_MAX_BYTES,
  SANCTIONS_MAX_FEATURE_TYPES,
  SANCTIONS_MAX_TYPE_ID_CHARS,
  SANCTIONS_REFRESH_MS,
  SANCTIONS_RETAINED_MAX_BYTES,
  SANCTIONS_WINDOW_MAX_BYTES,
  SDN_ADVANCED_URL,
  cacheIsFresh,
  decideSanctions,
  eligibilityFromDecision,
  fetchSdnAdvancedXml,
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

function chunksOf(xml, size) {
  const parts = [];
  for (let i = 0; i < xml.length; i += size) parts.push(xml.slice(i, i + size));
  return parts;
}

function streamResponse(xml, headers = {}, chunkSize = xml.length) {
  const parts = chunksOf(xml, chunkSize);
  let index = 0;
  const lower = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  return {
    ok: true,
    headers: { get(name) { return lower[String(name).toLowerCase()] ?? null; } },
    async text() {
      throw new Error("text() must not buffer the SDN publication");
    },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= parts.length) return { done: true, value: undefined };
            const value = new TextEncoder().encode(parts[index]);
            index += 1;
            return { done: false, value };
          },
          async cancel() {
            index = parts.length;
          },
        };
      },
    },
  };
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

  it("streams the publication and does not retain other features", async () => {
    assert.ok(SANCTIONS_RETAINED_MAX_BYTES < 128 * 1024 * 1024);
    assert.equal(SANCTIONS_RETAINED_MAX_BYTES, 8_000_000);
    const noise = "N".repeat(2_000_000);
    const xml = sdnXml(["0x00000000000000000000000000000000000000A1"]).replace(
      "<VersionDetail>not-an-address</VersionDetail>",
      `<VersionDetail>${noise}</VersionDetail>`,
    );
    const sliced = await fetchSdnAdvancedXml(async () => streamResponse(xml, {}, 1024));
    assert.ok(sliced.length < 20_000);
    assert.equal(sliced.includes(noise.slice(0, 32)), false);
    assert.deepEqual(parseSdnAdvancedXml(sliced), parseSdnAdvancedXml(xml));
    const split = await fetchSdnAdvancedXml(async () => streamResponse(sdnXml(["0x00000000000000000000000000000000000000A1"]), {}, 5));
    assert.deepEqual(parseSdnAdvancedXml(split), parseSdnAdvancedXml(sdnXml(["0x00000000000000000000000000000000000000A1"])));
  });

  it("fails closed on a truncated stream, an undeclared feature type, and a read past the cap", async () => {
    const listed = sdnXml(["0x00000000000000000000000000000000000000A1"]);
    await assert.rejects(
      fetchSdnAdvancedXml(async () => streamResponse(listed.replace("</Sanctions>", ""), {}, 64)),
      /sanctions_xml_invalid/,
    );
    const undeclared = `<Sanctions><Feature FeatureTypeID="345"><FeatureVersion><VersionDetail>0x00000000000000000000000000000000000000a1</VersionDetail></FeatureVersion></Feature><FeatureType ID="345">Digital Currency Address - ETH</FeatureType></Sanctions>`;
    await assert.rejects(
      fetchSdnAdvancedXml(async () => streamResponse(undeclared, {}, 32)),
      /sanctions_xml_invalid/,
    );
    await assert.rejects(
      fetchSdnAdvancedXml(async () => streamResponse(listed, {}, 64), SDN_ADVANCED_URL, 128),
      /sanctions_too_large/,
    );
    await assert.rejects(
      fetchSdnAdvancedXml(async () => streamResponse("", {}, 1)),
      /sanctions_xml_empty/,
    );
  });

  it("fails closed when a retained extract, a feature type id, or one element exceeds its cap", async () => {
    assert.equal(SANCTIONS_MAX_FEATURE_TYPES, 1024);
    assert.equal(SANCTIONS_MAX_TYPE_ID_CHARS, 32);
    assert.equal(SANCTIONS_ELEMENT_MAX_BYTES, 256 * 1024);
    assert.equal(SANCTIONS_WINDOW_MAX_BYTES, 64 * 1024);
    assert.ok(SANCTIONS_WINDOW_MAX_BYTES < SANCTIONS_ELEMENT_MAX_BYTES);
    assert.ok(SANCTIONS_ELEMENT_MAX_BYTES < SANCTIONS_RETAINED_MAX_BYTES);

    const address = "0x00000000000000000000000000000000000000a1";
    const atCap = [];
    for (let id = 1; id <= SANCTIONS_MAX_FEATURE_TYPES; id += 1) {
      atCap.push(`<FeatureType ID="${id}">Digital Currency Address - ETH</FeatureType>`);
    }
    atCap.push(`<Feature FeatureTypeID="1"><FeatureVersion><VersionDetail>${address}</VersionDetail></FeatureVersion></Feature>`);
    const accepted = await fetchSdnAdvancedXml(async () => streamResponse(wrapSdn(atCap.join("")), {}, 1024));
    assert.equal(parseSdnAdvancedXml(accepted).addresses.includes(address), true);

    const overTypes = atCap.slice();
    overTypes.splice(1, 0, `<FeatureType ID="${SANCTIONS_MAX_FEATURE_TYPES + 1}">Passport</FeatureType>`);
    await assert.rejects(
      fetchSdnAdvancedXml(async () => streamResponse(wrapSdn(overTypes.join("")), {}, 512)),
      /sanctions_too_large/,
    );

    const longId = "9".repeat(SANCTIONS_MAX_TYPE_ID_CHARS + 1);
    await assert.rejects(
      fetchSdnAdvancedXml(async () => streamResponse(
        wrapSdn(`<FeatureType ID="${longId}">Digital Currency Address - ETH</FeatureType>`),
        {},
        64,
      )),
      /sanctions_too_large/,
    );

    const open = "<DateOfIssue>";
    const close = "</DateOfIssue>";
    const exact = "z".repeat(SANCTIONS_ELEMENT_MAX_BYTES - open.length - close.length);
    const bounded = await fetchSdnAdvancedXml(async () => streamResponse(
      `<Sanctions>${open}${exact}${close}${atCap.slice(0, 1).join("")}<Feature FeatureTypeID="1"><FeatureVersion><VersionDetail>${address}</VersionDetail></FeatureVersion></Feature></Sanctions>`,
      {},
      4096,
    ));
    assert.equal(parseSdnAdvancedXml(bounded).addresses.includes(address), true);
    await assert.rejects(
      fetchSdnAdvancedXml(async () => streamResponse(
        `<Sanctions>${open}${exact}z${close}</Sanctions>`,
        {},
        SANCTIONS_WINDOW_MAX_BYTES,
      )),
      /sanctions_too_large/,
    );
    await assert.rejects(
      fetchSdnAdvancedXml(async () => streamResponse(`<Sanctions><DateOfIssue>${"y".repeat(SANCTIONS_ELEMENT_MAX_BYTES + 1)}`, {}, 8192)),
      /sanctions_too_large/,
    );

    const wideOpen = `<Feature ${"A".repeat(SANCTIONS_ELEMENT_MAX_BYTES)} FeatureTypeID="1"></Feature>`;
    await assert.rejects(
      fetchSdnAdvancedXml(async () => streamResponse(
        wrapSdn(`${atCap[0]}${wideOpen}`),
        {},
        1024,
      )),
      /sanctions_too_large/,
    );

    let bulky = `<FeatureType ID="345">Digital Currency Address - ETH</FeatureType>`;
    const filler = "a".repeat(200_000);
    let count = 0;
    while (bulky.length <= SANCTIONS_RETAINED_MAX_BYTES) {
      bulky += `<Feature FeatureTypeID="345"><FeatureVersion><VersionDetail>${filler}${count}</VersionDetail></FeatureVersion></Feature>`;
      count += 1;
    }
    await assert.rejects(
      fetchSdnAdvancedXml(async () => streamResponse(wrapSdn(bulky), {}, SANCTIONS_WINDOW_MAX_BYTES)),
      /sanctions_too_large/,
    );

    const noise = "Q".repeat(SANCTIONS_WINDOW_MAX_BYTES * 3);
    const listed = sdnXml([address]).replace("<DistinctParties>", `<DistinctParties>${noise}`);
    const oneChunk = await fetchSdnAdvancedXml(async () => streamResponse(listed, {}, listed.length));
    const tinyChunks = await fetchSdnAdvancedXml(async () => streamResponse(listed, {}, 3));
    assert.equal(oneChunk.includes(noise.slice(0, 32)), false);
    assert.equal(oneChunk.length < SANCTIONS_WINDOW_MAX_BYTES, true);
    assert.equal(oneChunk, tinyChunks);
    assert.deepEqual(parseSdnAdvancedXml(oneChunk), parseSdnAdvancedXml(listed));
  });
});

function wrapSdn(body) {
  return `<Sanctions><DateOfIssue CalendarTypeID="1"><Year>2026</Year><Month>10</Month><Day>21</Day></DateOfIssue>${body}</Sanctions>`;
}

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

// Real SDN advanced documents put <Profile>, <Comment />, and <Country> on every
// party. Those names are eight characters, the same length as <Feature.
function ofacShapedPublication(count = 150) {
  const addresses = [];
  for (let index = 1; index <= count; index += 1) {
    addresses.push(`0x${index.toString(16).padStart(40, "0")}`);
  }
  const window = SANCTIONS_WINDOW_MAX_BYTES;
  let xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<Sanctions xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML">
<DateOfIssue CalendarTypeID="1"><Year>2026</Year><Month>10</Month><Day>20</Day></DateOfIssue>
<ReferenceValueSets><FeatureTypeValues>
<FeatureType ID="345" FeatureTypeGroupID="1">Digital Currency Address - ETH</FeatureType>
<FeatureType ID="344" FeatureTypeGroupID="1">Digital Currency Address - XBT</FeatureType>
<FeatureType ID="9" FeatureTypeGroupID="2">Passport</FeatureType>
</FeatureTypeValues></ReferenceValueSets>
`;
  xml += "x".repeat(window - 4 - xml.length);
  const commentAt = xml.length;
  xml += "<Comment />";
  const profile = `<Profile ID="900000" PartySubTypeID="4">`;
  const profileAt = window + 64;
  xml += "x".repeat(profileAt - xml.length);
  xml += `${profile}</Profile><Country ID="900000" ISO2="US" CountryRoleID="1"/>`;
  const partyHead = `<DistinctParties><DistinctParty FixedRef="1"><Comment /><Profile ID="1" PartySubTypeID="4">`;
  const featureAt = window * 2 - 3;
  xml += "x".repeat(featureAt - (xml.length + partyHead.length));
  const parties = addresses.map((address, index) => {
    const id = index + 1;
    return `<DistinctParty FixedRef="${id}"><Comment /><Profile ID="${id}" PartySubTypeID="4"><Feature ID="${id}" FeatureTypeID="345"><FeatureVersion ID="${id}" ReliabilityID="91479"><Comment /><VersionDetail DetailTypeID="1432">${address}</VersionDetail></FeatureVersion></Feature><Feature FeatureTypeID="9"><FeatureVersion><Comment /><VersionDetail DetailTypeID="1432">not-an-address</VersionDetail></FeatureVersion></Feature></Profile><Country ID="${id}" ISO2="US" CountryRoleID="1"/></DistinctParty>`;
  }).join("");
  xml += `<DistinctParties>${parties}</DistinctParties></Sanctions>`;
  return {
    xml,
    addresses: addresses.map((address) => address.toLowerCase()).sort(),
    commentAt,
    profileAt,
    featureAt,
  };
}

describe("OFAC-shaped publication", () => {
  it("keeps every digital-currency address when profile, comment, and country tags straddle the window", async () => {
    const fixture = ofacShapedPublication();
    const window = SANCTIONS_WINDOW_MAX_BYTES;
    assert.ok(fixture.xml.length > window * 2);
    assert.ok(fixture.commentAt < window);
    assert.ok(fixture.commentAt + "<Comment ".length > window);
    assert.ok(fixture.profileAt > window);
    assert.ok(fixture.profileAt + `<Profile ID="900000" PartySubTypeID="4">`.length < window * 2);
    assert.equal(fixture.xml.indexOf("<Feature ", fixture.featureAt), fixture.featureAt);
    assert.ok(fixture.featureAt < window * 2);
    assert.ok(fixture.featureAt + "<Feature ".length > window * 2);
    assert.equal(fixture.xml.includes("<DistinctParty "), true);
    const direct = parseSdnAdvancedXml(fixture.xml);
    assert.equal(direct.listVersion, "2026-10-20");
    assert.deepEqual(direct.addresses, fixture.addresses);
    const sizes = [fixture.xml.length, window * 2, window, 1024, 8, 3];
    for (const size of sizes) {
      const sliced = await fetchSdnAdvancedXml(async () => streamResponse(fixture.xml, {}, size));
      assert.equal(sliced.includes("x".repeat(64)), false, `padding retained at chunk ${size}`);
      assert.ok(sliced.length < window, `extract grew at chunk ${size}: ${sliced.length}`);
      const parsed = parseSdnAdvancedXml(sliced);
      assert.equal(parsed.listVersion, "2026-10-20", `chunk ${size}`);
      assert.deepEqual(parsed.addresses, fixture.addresses, `chunk ${size}`);
    }
  });
});
