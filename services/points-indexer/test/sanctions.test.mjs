import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  SANCTIONS_ELEMENT_MAX_BYTES,
  SANCTIONS_FETCH_TIMEOUT_MS,
  SANCTIONS_MATCH,
  SANCTIONS_MAX_ADDRESS_CHARS,
  SANCTIONS_MAX_ADDRESSES,
  SANCTIONS_MAX_AGE_MS,
  SANCTIONS_MAX_BYTES,
  SANCTIONS_MAX_FEATURE_TYPES,
  SANCTIONS_MAX_TYPE_ID_CHARS,
  SANCTIONS_MAX_TYPE_LABEL_CHARS,
  SANCTIONS_MEMORY_MAX_BYTES,
  SANCTIONS_MIN_ADDRESSES,
  SANCTIONS_MIN_KEEP_DENOMINATOR,
  SANCTIONS_MIN_KEEP_NUMERATOR,
  SANCTIONS_REFRESH_MS,
  SANCTIONS_RETAINED_MAX_BYTES,
  SANCTIONS_WINDOW_MAX_BYTES,
  SDN_ADVANCED_URL,
  SDN_HOST,
  cacheIsFresh,
  decideSanctions,
  eligibilityFromDecision,
  fetchSdnAdvancedXml,
  listWithinMaxAge,
  normalizeSanctionsAddress,
  parseSdnAdvancedXml,
  screenFromStored,
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

function parseFixture(xml, options = {}) {
  return parseSdnAdvancedXml(xml, { minAddresses: 1, ...options });
}

function xmlOfCount(count) {
  const eth = [];
  for (let n = 1; n < count; n += 1) eth.push(`0x${n.toString(16).padStart(40, "0")}`);
  return sdnXml(eth);
}

function xmlWithMinimum(required = []) {
  const eth = [...required];
  const seen = new Set(eth.map((item) => String(item).toLowerCase()));
  let n = 1_000_000;
  while (eth.length + 1 < SANCTIONS_MIN_ADDRESSES) {
    const address = `0x${n.toString(16).padStart(40, "0")}`;
    n += 1;
    if (seen.has(address)) continue;
    seen.add(address);
    eth.push(address);
  }
  return sdnXml(eth);
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
    const parsed = parseFixture(sdnXml(["0x00000000000000000000000000000000000000A1"]));
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
    assert.deepEqual(parseFixture(sliced), parseFixture(xml));
    const split = await fetchSdnAdvancedXml(async () => streamResponse(sdnXml(["0x00000000000000000000000000000000000000A1"]), {}, 5));
    assert.deepEqual(parseFixture(split), parseFixture(sdnXml(["0x00000000000000000000000000000000000000A1"])));
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
    assert.equal(parseFixture(accepted).addresses.includes(address), true);

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
    assert.equal(parseFixture(bounded).addresses.includes(address), true);
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
    assert.deepEqual(parseFixture(oneChunk), parseFixture(listed));
  });

  it("rejects an empty or undersized address list as unavailable", () => {
    assert.equal(SANCTIONS_MIN_ADDRESSES, 100);
    assert.equal(SANCTIONS_MIN_KEEP_NUMERATOR, 1);
    assert.equal(SANCTIONS_MIN_KEEP_DENOMINATOR, 2);
    const empty = sdnXml().replace(/<DistinctParties>[\s\S]*<\/DistinctParties>/, "<DistinctParties></DistinctParties>");
    assert.throws(() => parseSdnAdvancedXml(empty), /sanctions_unavailable/);
    assert.throws(() => parseSdnAdvancedXml(sdnXml()), /sanctions_unavailable/);
    assert.throws(() => parseSdnAdvancedXml(xmlOfCount(99)), /sanctions_unavailable/);
    assert.equal(parseSdnAdvancedXml(xmlOfCount(100)).addresses.length, 100);
    assert.throws(() => parseSdnAdvancedXml(sdnXml(), { minAddresses: 2 }), /sanctions_unavailable/);
    const one = parseSdnAdvancedXml(sdnXml(), { minAddresses: 1 });
    assert.equal(one.addresses.length, 1);
    assert.throws(() => parseSdnAdvancedXml(sdnXml(), { minAddresses: -1 }), /sanctions_unavailable/);
    const smallCache = {
      fetched_at: 10_000,
      source: SDN_ADVANCED_URL,
      list_version: "2026-10-21",
      addresses_json: JSON.stringify([BTC]),
    };
    assert.equal(screenFromStored(smallCache, [], 10_000).listReady, false);
    const readyCache = {
      ...smallCache,
      addresses_json: JSON.stringify(parseSdnAdvancedXml(xmlOfCount(100)).addresses),
    };
    assert.equal(screenFromStored(readyCache, [], 10_000).listReady, true);
  });

  it("rejects a list that drops below half the last good list and keeps that cache", async () => {
    const ctx = tempIndexer();
    try {
      const now = 50_000_000;
      const first = await ctx.indexer.refreshSanctions({
        fetch: () => xmlResponse(xmlOfCount(400)),
        now,
      });
      assert.equal(first.refreshed, true);
      assert.equal(first.failed, false);
      assert.equal(first.count, 400);
      const opened = tempIndexer();
      try {
        const fresh = await opened.indexer.refreshSanctions({
          fetch: () => xmlResponse(xmlOfCount(100)),
          now,
        });
        assert.equal(fresh.refreshed, true);
        assert.equal(fresh.count, 100);
      } finally {
        opened.close();
      }
      const almost = await ctx.indexer.refreshSanctions({
        fetch: () => xmlResponse(xmlOfCount(199)),
        now: now + SANCTIONS_REFRESH_MS,
      });
      assert.equal(almost.failed, true);
      assert.equal(almost.refreshed, false);
      const atFloor = await ctx.indexer.refreshSanctions({
        fetch: () => xmlResponse(xmlOfCount(100)),
        now: now + SANCTIONS_REFRESH_MS * 2,
      });
      assert.equal(atFloor.failed, true);
      assert.equal(atFloor.refreshed, false);
      const kept = ctx.indexer.db.prepare("SELECT addresses_json FROM sanctions_cache WHERE id = 1").get();
      assert.equal(JSON.parse(kept.addresses_json).length, 400);
      const half = await ctx.indexer.refreshSanctions({
        fetch: () => xmlResponse(xmlOfCount(200)),
        now: now + SANCTIONS_REFRESH_MS * 3,
      });
      assert.equal(half.failed, false);
      assert.equal(half.refreshed, true);
      assert.equal(half.count, 200);
      const replaced = ctx.indexer.db.prepare("SELECT addresses_json FROM sanctions_cache WHERE id = 1").get();
      assert.equal(JSON.parse(replaced.addresses_json).length, 200);
    } finally {
      ctx.close();
    }
  });

  it("does not let feature padding or chunk size change the retained extract", async () => {
    const address = "0x00000000000000000000000000000000000000a1";
    const small = "c".repeat(32);
    const large = "c".repeat(100_000);
    function withComment(comment) {
      return sdnXml([address]).replace(
        `<VersionDetail>${address}</VersionDetail>`,
        `<Comment>${comment}</Comment><VersionDetail>${address}</VersionDetail>`,
      );
    }
    const shortXml = withComment(small);
    const longXml = withComment(large);
    const shortOne = await fetchSdnAdvancedXml(async () => streamResponse(shortXml, {}, shortXml.length));
    const shortTiny = await fetchSdnAdvancedXml(async () => streamResponse(shortXml, {}, 3));
    const longOne = await fetchSdnAdvancedXml(async () => streamResponse(longXml, {}, longXml.length));
    const longTiny = await fetchSdnAdvancedXml(async () => streamResponse(longXml, {}, 3));
    assert.equal(shortOne, shortTiny);
    assert.equal(longOne, longTiny);
    assert.equal(shortOne, longOne);
    assert.equal(shortOne.includes(small), false);
    assert.equal(longOne.includes(large.slice(0, 32)), false);
    assert.equal(shortOne.length < SANCTIONS_WINDOW_MAX_BYTES, true);
    assert.deepEqual(parseFixture(shortOne), parseFixture(shortXml));
    assert.deepEqual(parseFixture(longOne), parseFixture(longXml));
  });

  it("fails closed when address text or the retained extract passes its ceiling", async () => {
    assert.equal(SANCTIONS_MEMORY_MAX_BYTES, 8_000_000);
    assert.equal(SANCTIONS_MEMORY_MAX_BYTES, SANCTIONS_RETAINED_MAX_BYTES);
    assert.equal(SANCTIONS_MAX_ADDRESS_CHARS, 256);
    assert.equal(SANCTIONS_MAX_ADDRESSES, 100_000);
    assert.equal(SANCTIONS_MAX_TYPE_LABEL_CHARS, 128);
    const huge = "a".repeat(SANCTIONS_MAX_ADDRESS_CHARS + 1);
    await assert.rejects(
      fetchSdnAdvancedXml(async () => streamResponse(wrapSdn(
        `<FeatureType ID="345">Digital Currency Address - ETH</FeatureType><Feature FeatureTypeID="345"><VersionDetail>${huge}</VersionDetail></Feature>`,
      ), {}, 1024)),
      /sanctions_too_large/,
    );
    const longLabel = `Digital Currency Address - ${"E".repeat(SANCTIONS_MAX_TYPE_LABEL_CHARS)}`;
    await assert.rejects(
      fetchSdnAdvancedXml(async () => streamResponse(wrapSdn(
        `<FeatureType ID="345">${longLabel}</FeatureType>`,
      ), {}, 128)),
      /sanctions_too_large/,
    );
    const address = "b".repeat(SANCTIONS_MAX_ADDRESS_CHARS);
    const record = `<Feature FeatureTypeID="345"><VersionDetail>${address}</VersionDetail></Feature>`;
    const count = Math.floor(SANCTIONS_MEMORY_MAX_BYTES / record.length) + 2;
    assert.ok(count > 1_000);
    assert.ok(count < SANCTIONS_MAX_ADDRESSES);
    const features = [`<FeatureType ID="345">Digital Currency Address - ETH</FeatureType>`];
    for (let i = 0; i < count; i += 1) {
      features.push(`<Feature FeatureTypeID="345"><FeatureVersion><VersionDetail>${address}</VersionDetail></FeatureVersion></Feature>`);
    }
    const xml = wrapSdn(features.join(""));
    await assert.rejects(
      fetchSdnAdvancedXml(async () => streamResponse(xml, {}, xml.length)),
      /sanctions_too_large/,
    );
    await assert.rejects(
      fetchSdnAdvancedXml(async () => streamResponse(xml, {}, 4096)),
      /sanctions_too_large/,
    );
  });

  it("parses a Feature tag the same way the stream filter keeps it", async () => {
    const address = "0x00000000000000000000000000000000000000A1";
    const xml = sdnXml([address])
      .replace("<Feature ID=\"96530\" FeatureTypeID=\"345\">", "<Feature\nID=\"96530\" FeatureTypeID=\"345\">")
      .replace("<Feature FeatureTypeID=\"344\">", "<Feature\tFeatureTypeID=\"344\">");
    const parsed = parseFixture(xml);
    assert.deepEqual(parsed.addresses, [address.toLowerCase(), BTC]);
    const sliced = await fetchSdnAdvancedXml(async () => streamResponse(xml, {}, 7));
    assert.deepEqual(parseFixture(sliced), parsed);
    const spaced = parseFixture(sdnXml([address]));
    assert.deepEqual(parsed.addresses, spaced.addresses);
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

  it("treats a stale list as unavailable and does not grant points", () => {
    assert.equal(SANCTIONS_MAX_AGE_MS, 48 * 60 * 60 * 1000);
    const fetchedAt = 10_000;
    const row = {
      fetched_at: fetchedAt,
      source: SDN_ADVANCED_URL,
      list_version: "2026-10-21",
      addresses_json: JSON.stringify([wallet, BTC]),
    };
    const ready = screenFromStored(row, [], fetchedAt + SANCTIONS_MAX_AGE_MS, { minAddresses: 1 });
    assert.equal(ready.listReady, true);
    assert.equal(listWithinMaxAge(fetchedAt, fetchedAt + SANCTIONS_MAX_AGE_MS), true);
    assert.equal(listWithinMaxAge(fetchedAt, fetchedAt + SANCTIONS_MAX_AGE_MS + 1), false);
    const stale = screenFromStored(row, [], fetchedAt + SANCTIONS_MAX_AGE_MS + 1, { minAddresses: 1 });
    assert.equal(stale.listReady, false);
    assert.equal(stale.addresses.size, 0);
    const decision = decideSanctions(OTHER, stale);
    assert.equal(decision.result, "unavailable");
    assert.equal(decision.reason, "ofac_unconfigured");
    assert.deepEqual(eligibilityFromDecision(decision), {
      points: 0,
      eligibility_status: "unverified",
      eligibility_reason: "ofac_unconfigured",
      points_withheld: 1,
    });
    const kept = decideSanctions(wallet, { addresses: stale.addresses, persisted, listReady: stale.listReady });
    assert.deepEqual(kept, { result: "match", reason: SANCTIONS_MATCH, persisted: true });
    const custom = screenFromStored(row, [], fetchedAt + 1_000, { maxAgeMs: 500, minAddresses: 1 });
    assert.equal(custom.listReady, false);
    const now = fetchedAt;
    const futureAt = now + 60_000;
    assert.equal(listWithinMaxAge(futureAt, now), false);
    const future = screenFromStored({ ...row, fetched_at: futureAt }, [], now, { minAddresses: 1 });
    assert.equal(future.listReady, false);
    assert.equal(future.addresses.size, 0);
    const futureDecision = decideSanctions(OTHER, future);
    assert.equal(futureDecision.result, "unavailable");
    assert.equal(eligibilityFromDecision(futureDecision).eligibility_status, "unverified");
    const mixedCase = "0x00000000000000000000000000000000000000A1";
    const lowercase = "0x00000000000000000000000000000000000000a1";
    assert.equal(normalizeSanctionsAddress(" \n" + mixedCase + "\t"), lowercase);
  });

  it("treats an empty cached list as unavailable", () => {
    const row = {
      fetched_at: 10_000,
      source: SDN_ADVANCED_URL,
      list_version: "2026-10-21",
      addresses_json: "[]",
    };
    const screen = screenFromStored(row, [], 10_000);
    assert.equal(screen.listReady, false);
    const decision = decideSanctions(OTHER, screen);
    assert.equal(decision.result, "unavailable");
    assert.equal(eligibilityFromDecision(decision).points, 0);
    assert.equal(eligibilityFromDecision(decision).points_withheld, 1);
    const raised = screenFromStored({
      ...row,
      addresses_json: JSON.stringify([wallet]),
    }, [], 10_000, { minAddresses: 2 });
    assert.equal(raised.listReady, false);
    assert.equal(decideSanctions(wallet, raised).result, "unavailable");
  });
});

describe("sanctions screen on the indexer", () => {
  it("marks a listed wallet ineligible, keeps that status after the list drops it, and audits once per rebuild", async () => {
    const payer = account();
    const payee = account();
    const ctx = tempIndexer();
    const calls = [];
    try {
      const started = Date.now();
      const refreshed = await ctx.indexer.refreshSanctions({
        fetch: (url) => {
          calls.push(url);
          return xmlResponse(xmlWithMinimum([payer.address]));
        },
        now: started,
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
          return xmlResponse(xmlWithMinimum([OTHER]));
        },
        now: started + SANCTIONS_REFRESH_MS,
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
        fetch: () => xmlResponse(xmlWithMinimum([OTHER])),
        now: Date.now(),
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
          return xmlResponse(xmlWithMinimum([OTHER]));
        },
        now: 10_000,
      });
      assert.equal(first.refreshed, true);
      assert.equal(calls, 1);
      const skipped = await ctx.indexer.refreshSanctions({
        fetch: () => {
          calls += 1;
          return xmlResponse(xmlWithMinimum(["0x00000000000000000000000000000000000000c3"]));
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

  it("does not replace a good cache with an empty list", async () => {
    const ctx = tempIndexer();
    try {
      const now = Date.now();
      const first = await ctx.indexer.refreshSanctions({
        fetch: () => xmlResponse(xmlWithMinimum([OTHER])),
        now,
      });
      assert.equal(first.refreshed, true);
      const empty = sdnXml().replace(/<DistinctParties>[\s\S]*<\/DistinctParties>/, "<DistinctParties></DistinctParties>");
      const rejected = await ctx.indexer.refreshSanctions({
        fetch: () => xmlResponse(empty),
        now: now + SANCTIONS_REFRESH_MS,
      });
      assert.equal(rejected.failed, true);
      assert.equal(rejected.refreshed, false);
      const cache = ctx.indexer.db.prepare("SELECT addresses_json FROM sanctions_cache WHERE id = 1").get();
      assert.equal(cache.addresses_json.includes(OTHER), true);
    } finally {
      ctx.close();
    }
  });

  it("screens a stale cache as unavailable and keeps points at zero", async () => {
    const payer = account();
    const payee = account();
    const ctx = tempIndexer();
    try {
      const now = Date.now();
      await ctx.indexer.refreshSanctions({
        fetch: () => xmlResponse(xmlWithMinimum([payer.address])),
        now,
      });
      ctx.indexer.db.prepare("UPDATE sanctions_cache SET fetched_at = ? WHERE id = 1").run(now - SANCTIONS_MAX_AGE_MS - 1);
      const ledger = await fund(ctx.indexer, payer, payee);
      assert.ok(ledger.every((row) => row.points === 0));
      assert.ok(ledger.every((row) => row.points_withheld === 1));
      assert.ok(ledger.every((row) => row.eligibility_status === "unverified"));
      assert.ok(ledger.every((row) => row.eligibility_reason === "ofac_unconfigured"));
      const wallet = payer.address.toLowerCase();
      const checks = ctx.indexer.db.prepare("SELECT result, reason FROM sanctions_checks WHERE wallet = ?").all(wallet);
      assert.ok(checks.length >= 1);
      assert.ok(checks.every((row) => row.result === "unavailable"));
      assert.ok(checks.every((row) => row.reason === "ofac_unconfigured"));
    } finally {
      ctx.close();
    }
  });
});

describe("OFAC fetch guard", () => {
  it("times out a hung download", async () => {
    assert.equal(SANCTIONS_FETCH_TIMEOUT_MS, 60_000);
    const calls = [];
    await assert.rejects(
      fetchSdnAdvancedXml(async (url, init) => {
        calls.push({ url, redirect: init.redirect, timed: init.signal instanceof AbortSignal });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(undefined), 1_000);
          init.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            const error = new Error("The operation was aborted");
            error.name = "TimeoutError";
            reject(error);
          });
        });
      }, SDN_ADVANCED_URL, SANCTIONS_MAX_BYTES, { timeoutMs: 30 }),
      /sanctions_timeout/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, SDN_ADVANCED_URL);
    assert.equal(calls[0].redirect, "manual");
    assert.equal(calls[0].timed, true);
  });

  it("refuses a redirect to any host other than the OFAC list host", async () => {
    assert.equal(SDN_HOST, "sanctionslistservice.ofac.treas.gov");
    const calls = [];
    await assert.rejects(
      fetchSdnAdvancedXml(async (url) => {
        calls.push(url);
        return {
          ok: false,
          status: 302,
          headers: {
            get(name) {
              return String(name).toLowerCase() === "location" ? "https://evil.example/sdn.xml" : null;
            },
          },
          body: null,
          async text() {
            return "";
          },
        };
      }),
      /sanctions_http/,
    );
    assert.deepEqual(calls, [SDN_ADVANCED_URL]);

    const downgrade = [];
    await assert.rejects(
      fetchSdnAdvancedXml(async (url) => {
        downgrade.push(url);
        return {
          ok: false,
          status: 301,
          headers: {
            get(name) {
              return String(name).toLowerCase() === "location"
                ? "http://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ADVANCED.XML"
                : null;
            },
          },
          body: null,
        };
      }),
      /sanctions_http/,
    );
    assert.deepEqual(downgrade, [SDN_ADVANCED_URL]);

    const lookalike = [];
    await assert.rejects(
      fetchSdnAdvancedXml(async (url) => {
        lookalike.push(url);
        return {
          ok: false,
          status: 307,
          headers: {
            get(name) {
              return String(name).toLowerCase() === "location" ? "https://sanctionslistservice.ofac.treas.gov.evil.example/sdn.xml" : null;
            },
          },
          body: null,
        };
      }),
      /sanctions_http/,
    );
    assert.deepEqual(lookalike, [SDN_ADVANCED_URL]);
  });

  it("follows a same-host HTTPS redirect and then parses the list", async () => {
    const xml = sdnXml(["0x00000000000000000000000000000000000000A1"]);
    const seen = [];
    const sliced = await fetchSdnAdvancedXml(async (url) => {
      seen.push(url);
      if (seen.length === 1) {
        return {
          ok: false,
          status: 302,
          headers: {
            get(name) {
              return String(name).toLowerCase() === "location" ? "/api/PublicationPreview/exports/SDN_ADVANCED.XML?v=2" : null;
            },
          },
          body: null,
        };
      }
      return streamResponse(xml);
    });
    assert.equal(seen.length, 2);
    assert.equal(new URL(seen[1]).hostname, SDN_HOST);
    assert.equal(new URL(seen[1]).protocol, "https:");
    assert.deepEqual(parseFixture(sliced), parseFixture(xml));
  });

  const PUBLISHED_HOST = "wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com";
  const PUBLISHED_PATH = "/Published/c855675f-4385-4bb5-b89a-59ccb73a83e6/2026-10-20/4166a9f5-d268-432a-a70b-65bd16bcd16a/SDN_ADVANCED.XML";
  const SIGNED_QUERY = "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=test&X-Amz-Date=20261024T000000Z&X-Amz-Expires=60&X-Amz-SignedHeaders=host&X-Amz-Signature=test-signature";

  function publishedLocation({
    protocol = "https:",
    host = PUBLISHED_HOST,
    port = "",
    path = PUBLISHED_PATH,
    search = SIGNED_QUERY,
  } = {}) {
    const url = new URL("https://placeholder.invalid/Published/file");
    url.protocol = protocol;
    url.hostname = host;
    url.port = port;
    url.pathname = path;
    url.search = search;
    return url.href;
  }

  function redirectTo(location, status = 302) {
    return {
      ok: false,
      status,
      headers: {
        get(name) {
          return String(name).toLowerCase() === "location" ? location : null;
        },
      },
      body: null,
      async text() {
        return "";
      },
    };
  }

  async function assertFirstHopRejected(location) {
    const calls = [];
    const logged = [];
    const names = ["log", "info", "warn", "error", "debug"];
    const restore = names.map((name) => {
      const original = console[name];
      console[name] = (...args) => {
        logged.push(args.map((part) => String(part)).join(" "));
      };
      return () => {
        console[name] = original;
      };
    });
    try {
      await assert.rejects(
        fetchSdnAdvancedXml(async (url) => {
          calls.push(url);
          return redirectTo(location);
        }),
        (error) => {
          assert.equal(error.message, "sanctions_http");
          assert.equal(error.message.includes("X-Amz-Signature"), false);
          assert.equal(error.message.includes(SIGNED_QUERY), false);
          return true;
        },
      );
    } finally {
      restore.forEach((undo) => undo());
    }
    assert.deepEqual(calls, [SDN_ADVANCED_URL]);
    assert.equal(logged.join("\n").includes("X-Amz-Signature"), false);
    assert.equal(logged.join("\n").includes(SIGNED_QUERY), false);
  }

  it("follows one OFAC redirect to the public S3 publication and parses the list", async () => {
    const xml = sdnXml(["0x00000000000000000000000000000000000000A1"]);
    const location = publishedLocation();
    const seen = [];
    const logged = [];
    const names = ["log", "info", "warn", "error", "debug"];
    const restore = names.map((name) => {
      const original = console[name];
      console[name] = (...args) => {
        logged.push(args.map((part) => String(part)).join(" "));
      };
      return () => {
        console[name] = original;
      };
    });
    try {
      const sliced = await fetchSdnAdvancedXml(async (url, init) => {
        seen.push({ url, redirect: init.redirect, timed: init.signal instanceof AbortSignal });
        if (seen.length === 1) return redirectTo(location);
        return streamResponse(xml);
      });
      assert.equal(seen.length, 2);
      assert.equal(seen[0].url, SDN_ADVANCED_URL);
      assert.equal(seen[0].redirect, "manual");
      assert.equal(seen[0].timed, true);
      assert.equal(seen[1].redirect, "manual");
      assert.equal(seen[1].timed, true);
      const next = new URL(seen[1].url);
      assert.equal(next.protocol, "https:");
      assert.equal(next.hostname, PUBLISHED_HOST);
      assert.equal(next.port, "");
      assert.equal(next.pathname, PUBLISHED_PATH);
      assert.equal(next.search, `?${SIGNED_QUERY}`);
      assert.equal(next.username, "");
      assert.equal(next.password, "");
      assert.deepEqual(parseFixture(sliced), parseFixture(xml));
      const explicitPort = `https://${PUBLISHED_HOST}:443${PUBLISHED_PATH}?${SIGNED_QUERY}`;
      const portSeen = [];
      const portSliced = await fetchSdnAdvancedXml(async (url) => {
        portSeen.push(url);
        if (portSeen.length === 1) return redirectTo(explicitPort);
        return streamResponse(xml);
      });
      assert.equal(new URL(portSeen[1]).port, "");
      assert.equal(new URL(portSeen[1]).hostname, PUBLISHED_HOST);
      assert.deepEqual(parseFixture(portSliced), parseFixture(xml));
    } finally {
      restore.forEach((undo) => undo());
    }
    assert.equal(logged.join("\n").includes("X-Amz-Signature"), false);
    assert.equal(logged.join("\n").includes(SIGNED_QUERY), false);
  });

  it("refuses a publication redirect to another host, scheme, port, or path", async () => {
    await assertFirstHopRejected(publishedLocation({
      host: "other-bucket.s3.us-gov-west-1.amazonaws.com",
    }));
    await assertFirstHopRejected(publishedLocation({
      host: `${PUBLISHED_HOST}.evil.example`,
    }));
    await assertFirstHopRejected(publishedLocation({ protocol: "http:" }));
    await assertFirstHopRejected(publishedLocation({ port: "8443" }));
    await assertFirstHopRejected(publishedLocation({ path: "/exports/SDN_ADVANCED.XML" }));
    await assertFirstHopRejected(publishedLocation({ path: "/published/SDN_ADVANCED.XML" }));
    await assertFirstHopRejected(publishedLocation({ path: "/Published" }));
    await assertFirstHopRejected(`https://${PUBLISHED_HOST}/Published/../SDN_ADVANCED.XML?${SIGNED_QUERY}`);
  });

  it("refuses a second hop and a redirect from the publication host to another host", async () => {
    const xml = sdnXml(["0x00000000000000000000000000000000000000A1"]);
    const first = publishedLocation();
    const secondSameHost = publishedLocation({
      path: "/Published/other/SDN_ADVANCED.XML",
      search: "X-Amz-Signature=second-hop",
    });
    const calls = [];
    await assert.rejects(
      fetchSdnAdvancedXml(async (url) => {
        calls.push(url);
        if (calls.length === 1) return redirectTo(first);
        if (calls.length === 2) return redirectTo(secondSameHost);
        return streamResponse(xml);
      }),
      (error) => {
        assert.equal(error.message, "sanctions_http");
        assert.equal(error.message.includes("X-Amz-Signature"), false);
        return true;
      },
    );
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[1]).hostname, PUBLISHED_HOST);
    assert.equal(new URL(calls[1]).pathname, PUBLISHED_PATH);

    const backToOfac = [];
    await assert.rejects(
      fetchSdnAdvancedXml(async (url) => {
        backToOfac.push(url);
        if (backToOfac.length === 1) return redirectTo(first);
        return redirectTo(SDN_ADVANCED_URL);
      }),
      /sanctions_http/,
    );
    assert.equal(backToOfac.length, 2);

    const otherHost = [];
    await assert.rejects(
      fetchSdnAdvancedXml(async (url) => {
        otherHost.push(url);
        if (otherHost.length === 1) return redirectTo(first);
        return redirectTo("https://evil.example/Published/SDN_ADVANCED.XML");
      }),
      /sanctions_http/,
    );
    assert.equal(otherHost.length, 2);
    assert.equal(new URL(otherHost[1]).hostname, PUBLISHED_HOST);
  });

  it("times out a hung publication download on the same clock as the OFAC hop", async () => {
    const location = publishedLocation();
    const calls = [];
    await assert.rejects(
      fetchSdnAdvancedXml(async (url, init) => {
        calls.push(url);
        if (calls.length === 1) return redirectTo(location);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(undefined), 1_000);
          init.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            const error = new Error("The operation was aborted");
            error.name = "TimeoutError";
            reject(error);
          });
        });
      }, SDN_ADVANCED_URL, SANCTIONS_MAX_BYTES, { timeoutMs: 40 }),
      /sanctions_timeout/,
    );
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[1]).hostname, PUBLISHED_HOST);
    assert.equal(new URL(calls[1]).search.includes("X-Amz-Signature=test-signature"), true);
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
