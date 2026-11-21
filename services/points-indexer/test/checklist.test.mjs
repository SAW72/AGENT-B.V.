import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ACTION } from "../src/constants.mjs";
import {
  addressEligibility,
  publicEligibility,
  screenUnavailable,
  screenWithPersistedMatch,
} from "../src/eligibility.mjs";
import { POINTS_ENFORCER, createPointsEnforcer } from "../src/enforcer.mjs";
import { createReadApi } from "../src/readApi.mjs";
import { account, createdLog, creditCandidate, rows, tempIndexer } from "./support.mjs";

const POINTS_FILE = fileURLToPath(new URL("../config/points.json", import.meta.url));
const SEPOLIA_FILE = fileURLToPath(new URL("../../../config/reputation/sepolia.json", import.meta.url));
const WALLET = "0x1111111111111111111111111111111111111111";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("checklist #7 address eligibility", () => {
  it("fails closed unless the screen is an explicit clear or a match", () => {
    assert.deepEqual(publicEligibility(undefined), { status: "unverified", reason: "sanctions_unavailable" });
    assert.deepEqual(publicEligibility(""), { status: "unverified", reason: "sanctions_unavailable" });
    assert.deepEqual(publicEligibility("unavailable"), { status: "unverified", reason: "sanctions_unavailable" });
    assert.deepEqual(publicEligibility("ofac_unconfigured"), { status: "unverified", reason: "sanctions_unavailable" });
    assert.deepEqual(publicEligibility("sanctions_unavailable"), { status: "unverified", reason: "sanctions_unavailable" });
    assert.deepEqual(publicEligibility("unverified"), { status: "unverified", reason: "unverified" });
    assert.deepEqual(publicEligibility("sanctions_match"), { status: "ineligible", reason: "sanctions_match" });

    const down = addressEligibility(screenUnavailable(), WALLET);
    assert.equal(down.eligible, false);
    assert.equal(down.points_withheld, true);
    assert.equal(down.status, "unverified");
    assert.equal(down.reason, "sanctions_unavailable");

    const clear = addressEligibility({
      addresses: new Set(),
      persisted: new Set(),
      listReady: true,
    }, WALLET);
    assert.equal(clear.eligible, false);
    assert.equal(clear.points_withheld, true);
    assert.equal(clear.status, "unverified");
    assert.equal(clear.reason, "unverified");

    const persisted = addressEligibility(screenWithPersistedMatch({
      addresses: new Set(),
      persisted: new Set(),
      listReady: false,
    }, WALLET), WALLET);
    assert.equal(persisted.eligible, false);
    assert.equal(persisted.points_withheld, true);
    assert.equal(persisted.status, "ineligible");
    assert.equal(persisted.reason, "sanctions_match");
  });

  it("reports the screen reason on the address route and keeps points withheld", () => {
    const api = createReadApi({
      enabled: () => true,
      config: { ratePerMinute: 20 },
      store: {
        getCursor() {
          return { last_scanned_block: 1, finalized_block: 1, pass_completed: true, stale: false };
        },
        getLedgerSummary() {
          return { points_total: 4, rows_count: 1, first_activity_utc_day: 1, eligibility_reason: "unverified" };
        },
        listLedgerRows() {
          return [];
        },
        getConfig() {
          return { weights: {}, gates: {}, rule_version: null };
        },
      },
    });
    try {
      const body = api.handle({
        method: "GET",
        path: `/v1/points/${WALLET}`,
        query: {},
        headers: {},
        remoteAddress: "127.0.0.1",
      });
      assert.equal(body.status, 200);
      assert.equal(body.body.points_total, 0);
      assert.equal(body.body.points_withheld, true);
      assert.deepEqual(body.body.eligibility, { status: "unverified", reason: "unverified" });
    } finally {
      api.close();
    }
  });
});

describe("checklist #9 points enforcer", () => {
  it("keeps the owner TBD and records review-only flags", () => {
    const sepolia = readJson(SEPOLIA_FILE);
    assert.equal(POINTS_ENFORCER.owner, "TBD");
    assert.equal(POINTS_ENFORCER.auto_cancel, false);
    assert.equal(POINTS_ENFORCER.flags, "review_only");
    assert.notEqual(POINTS_ENFORCER.owner, sepolia.enforcer.owner);
    const enforcer = createPointsEnforcer();
    const recorded = enforcer.flag({ kind: "PAIR_CAP", wallet: WALLET, refs: ["0xabc", 2] });
    assert.deepEqual(recorded, { withhold_wallet: false, reason: "review_only" });
    enforcer.flag({ kind: "NOT_A_KIND", wallet: WALLET });
    const flags = enforcer.flags();
    assert.equal(flags[0].kind, "PAIR_CAP");
    assert.equal(flags[0].auto_cancel, false);
    assert.equal(flags[0].withhold_wallet, false);
    assert.deepEqual(flags[0].refs, ["0xabc", "2"]);
    assert.equal(flags[1].kind, "OTHER");
    assert.equal(enforcer.autoCancel, false);
  });

  it("records a pair-cap flag without cancelling the earlier row or writing negative points", async () => {
    const payer = account();
    const payee = account();
    const day = 20_800 * 86400 + 5;
    const logs = [1, 2].map((n) => createdLog({
      escrowId: `0x${String(n).repeat(64)}`,
      payer: payer.address,
      payee: payee.address,
      expiresAt: day + (n - 1) * 86400 + 100,
      blockNumber: 48_800_000 + n,
      logIndex: 1,
      txHash: `0x${String(n + 3).repeat(64)}`.slice(0, 66),
      timestamp: day + (n - 1) * 86400,
    }));
    const ctx = tempIndexer();
    try {
      ctx.indexer.ingestLogs(logs);
      for (const candidate of ctx.indexer.attribute().candidates) {
        assert.equal((await creditCandidate(ctx.indexer, payer, candidate)).link.ok, true);
      }
      assert.equal(rows(ctx.indexer, ACTION.fund).length, 2);
      assert.deepEqual(ctx.indexer.enforcerFlags, []);
      ctx.indexer.setGates({
        min_escrow_amount_wei: null,
        same_pair_lifetime: 1,
        same_pair_per_day: null,
        min_escrow_duration_seconds: null,
      });
      const funds = rows(ctx.indexer, ACTION.fund);
      assert.equal(funds.length, 1);
      assert.equal(funds[0].block_number, 48_800_001);
      assert.ok(rows(ctx.indexer).every((row) => row.points === 0));
      assert.ok(rows(ctx.indexer).every((row) => row.points >= 0));
      assert.equal(ctx.indexer.enforcerFlags.length, 1);
      assert.equal(ctx.indexer.enforcerFlags[0].kind, "PAIR_CAP");
      assert.equal(ctx.indexer.enforcerFlags[0].wallet, payer.address.toLowerCase());
      assert.equal(ctx.indexer.enforcerFlags[0].withhold_wallet, false);
      assert.equal(ctx.indexer.enforcerFlags[0].auto_cancel, false);
      assert.equal(ctx.indexer.enforcerFlags[0].reason, "review_only");
    } finally {
      ctx.close();
    }
  });

  it("does not record a pair-cap flag for a minimum-escrow reject", async () => {
    const payer = account();
    const payee = account();
    const day = 20_810 * 86400 + 5;
    const ctx = tempIndexer();
    try {
      ctx.indexer.setGates({
        min_escrow_amount_wei: "2",
        same_pair_lifetime: null,
        same_pair_per_day: null,
        min_escrow_duration_seconds: null,
      });
      const log = createdLog({
        escrowId: `0x${"9".repeat(64)}`,
        payer: payer.address,
        payee: payee.address,
        amount: 1n,
        expiresAt: day + 100,
        blockNumber: 48_810_001,
        logIndex: 1,
        txHash: `0x${"9".repeat(64)}`,
        timestamp: day,
      });
      ctx.indexer.ingestLogs([log]);
      const candidate = ctx.indexer.attribute().candidates.find((item) => item.wallet === payer.address.toLowerCase());
      const credited = await creditCandidate(ctx.indexer, payer, candidate);
      assert.equal(credited.link.stored, true);
      assert.equal(credited.link.committed, false);
      assert.equal(credited.link.reason, "min_escrow_amount");
      assert.equal(rows(ctx.indexer, ACTION.fund).length, 0);
      assert.deepEqual(ctx.indexer.enforcerFlags, []);
      assert.equal(ctx.indexer.lastSkips.some((skip) => skip.reason === "min_escrow_amount"), true);
    } finally {
      ctx.close();
    }
  });
});

describe("checklist #11 disclaimer slots", () => {
  it("returns https slots and leaves every other slot null", () => {
    const sepolia = readJson(SEPOLIA_FILE);
    for (const key of ["master_disclaimer", "legal_notice_url", "as_is", "not_investment", "eligibility_notice", "abuse_policy"]) {
      assert.equal(sepolia.disclaimer_links[key], "");
    }
    const api = createReadApi({
      enabled: () => true,
      config: { ratePerMinute: 20 },
      store: {
        getCursor() {
          return { last_scanned_block: null, finalized_block: null, pass_completed: false };
        },
        getLedgerSummary() {
          return { points_total: 0, rows_count: 0, first_activity_utc_day: null };
        },
        listLedgerRows() {
          return [];
        },
        getConfig() {
          return {
            weights: {},
            gates: {},
            rule_version: null,
            legal_notice_url: "https://notice.invalid/from-field",
            disclaimer_links: {
              master_disclaimer: "https://notice.invalid/master",
              as_is: "http://notice.invalid/as-is",
              not_investment: "not a url",
              eligibility_notice: "",
              abuse_policy: "https://user:secret@notice.invalid/abuse",
            },
          };
        },
      },
    });
    try {
      const config = api.handle({
        method: "GET",
        path: "/v1/points/config",
        query: {},
        headers: {},
        remoteAddress: "127.0.0.1",
      });
      assert.equal(config.status, 200);
      assert.equal(config.body.disclaimer.links.master_disclaimer, "https://notice.invalid/master");
      assert.equal(config.body.disclaimer.links.legal_notice_url, "https://notice.invalid/from-field");
      assert.equal(config.body.disclaimer.links.as_is, null);
      assert.equal(config.body.disclaimer.links.not_investment, null);
      assert.equal(config.body.disclaimer.links.eligibility_notice, null);
      assert.equal(config.body.disclaimer.links.abuse_policy, null);
      assert.equal(Object.hasOwn(config.body.disclaimer.links, "bvt_securities_disclaimer"), false);
      assert.equal(config.body.enforcer.owner, "TBD");
      assert.equal(config.body.enforcer.auto_cancel, false);
      assert.equal(config.body.enforcer.flags, "review_only");
      assert.equal(Object.hasOwn(config.body.enforcer, "_note"), false);
      assert.notEqual(config.body.enforcer.owner, sepolia.enforcer.owner);
    } finally {
      api.close();
    }
  });
});

describe("checklist #12 draft caps", () => {
  it("keeps points gates null and leaves the draft labels in place", () => {
    const points = readJson(POINTS_FILE);
    const sepolia = readJson(SEPOLIA_FILE);
    assert.ok(Object.values(points.weights).every((value) => value === null));
    assert.ok(Object.values(points.gates).every((value) => value === null));
    assert.equal(points.enforcer.owner, "TBD");
    assert.equal(points.enforcer.auto_cancel, false);
    assert.equal(points.enforcer.flags, "review_only");
    assert.equal(JSON.stringify(points).includes(sepolia.enforcer.owner), false);
    assert.equal(sepolia.caps._label, "DRAFT/GUESS");
    assert.equal(sepolia.hooks.caps_lock_12, "pending");
    assert.equal(sepolia.points_ledger._label, "locked");
    assert.equal(sepolia.points_ledger.gates.same_pair_cap_per_utc_day.status, "locked");
    assert.equal(points.gates.same_pair_per_day, null);
    assert.equal(points.gates.same_pair_lifetime, null);
    assert.notEqual(points.gates.same_pair_per_day, sepolia.points_ledger.gates.same_pair_cap_per_utc_day.value);
  });
});
