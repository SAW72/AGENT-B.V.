import { reset, runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import sepolia from "../../../../config/reputation/sepolia.json";
import { createReadApi, httpsUrl, pointsEnabled } from "../src/read-api";
import { publicDetail } from "../src/rpc";

const DISCLAIMER = "Testnet only. Not a token. Can't be transferred, sold, or redeemed. May be adjusted or cancelled, and does not convert to anything.";

function forbidRankAndEarn(payload: string) {
  const lower = payload.toLowerCase();
  expect(lower).not.toContain("rank");
  expect(lower).not.toContain("earn");
}

function stub() {
  return env.POINTS.get(env.POINTS.idFromName("base-sepolia"));
}

async function wallet() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("points read API", () => {
  afterEach(async () => {
    await reset();
  });

  it("serves config, address, and history with the bundled disclaimer", async () => {
    expect(sepolia.display.disclaimer).toBe(DISCLAIMER);
    const address = await wallet();
    const origin = { Origin: "https://agent-bv.pages.dev", "CF-Connecting-IP": "203.0.113.20" };

    const configResponse = await SELF.fetch("https://points.test/v1/points/config", { headers: origin });
    expect(configResponse.status).toBe(200);
    expect(configResponse.headers.get("access-control-allow-origin")).toBe("https://agent-bv.pages.dev");
    const config = await configResponse.json() as {
      chainId: number;
      status: string;
      weights: Record<string, unknown>;
      rule_version: string | null;
      disclaimer: { text: string };
    };
    expect(config.chainId).toBe(84532);
    expect(config.status).toBe("draft");
    expect(config.rule_version).toBeNull();
    expect(config.weights).toEqual({
      first_activity: null,
      fund: null,
      release_or_refund: null,
      dispute_open_or_vote: null,
      vote: null,
      return_day: null,
    });
    expect(config.disclaimer.text).toBe(DISCLAIMER);
    forbidRankAndEarn(JSON.stringify(config));

    const addressResponse = await SELF.fetch(`https://points.test/v1/points/${address}`, { headers: origin });
    expect(addressResponse.status).toBe(200);
    const body = await addressResponse.json() as {
      address: string;
      points_total: number;
      points_withheld: boolean;
      eligibility: { status: string; reason: string };
      rows_count: number;
      disclaimer: { text: string; links: Record<string, string | null> };
    };
    expect(body.address).toBe(address);
    expect(body.points_total).toBe(0);
    expect(body.points_withheld).toBe(true);
    expect(body.eligibility).toEqual({ status: "unverified", reason: "ofac_unconfigured" });
    expect(body.rows_count).toBe(0);
    expect(body.disclaimer.text).toBe(sepolia.display.disclaimer);
    expect(body.disclaimer.text).toBe(DISCLAIMER);
    expect(body.disclaimer.links.master_disclaimer).toBeNull();
    expect(body.disclaimer.links.legal_notice_url).toBeNull();
    expect(body.disclaimer.links).not.toHaveProperty("bvt_securities_disclaimer");
    forbidRankAndEarn(JSON.stringify(body));

    const otherOrigin = await SELF.fetch(`https://points.test/v1/points/${address}`, {
      headers: { Origin: "https://example.com", "CF-Connecting-IP": "203.0.113.21" },
    });
    expect(otherOrigin.headers.get("access-control-allow-origin")).toBeNull();

    const options = await SELF.fetch(`https://points.test/v1/points/${address}`, { method: "OPTIONS", headers: origin });
    expect(options.status).toBe(204);

    await runInDurableObject(stub(), async (_instance, state) => {
      const insert = (block: number, logIndex: number, day: number) => {
        state.storage.sql.exec(
          `INSERT INTO ledger_rows(
             seq, chain_id, contract, tx_hash, log_index, block_number, block_timestamp, utc_day,
             wallet, action, escrow_id, points, eligibility_status, eligibility_reason, points_withheld,
             rule_weight, counts_for_return_day
           ) VALUES(?, 84532, ?, ?, ?, ?, 1, ?, ?, 'fund', ?, 0, 'unverified', 'ofac_unconfigured', 1, null, 0)`,
          block,
          address,
          address,
          logIndex,
          block,
          day,
          address,
          address,
        );
      };
      insert(10, 1, 10);
      insert(11, 2, 11);
    });

    const firstPage = await SELF.fetch(`https://points.test/v1/points/${address}/history?limit=1`, { headers: origin });
    expect(firstPage.status).toBe(200);
    const page = await firstPage.json() as {
      items: Array<{ block_number: number; points: number; points_withheld: boolean; eligibility_reason: string }>;
      next_cursor: string | null;
      limit: number;
      disclaimer: { text: string };
    };
    expect(page.limit).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].block_number).toBe(10);
    expect(page.items[0].points).toBe(0);
    expect(page.items[0].points_withheld).toBe(true);
    expect(page.items[0].eligibility_reason).toBe("ofac_unconfigured");
    expect(page.next_cursor).toBeTruthy();
    expect(page.disclaimer.text).toBe(DISCLAIMER);

    const secondPage = await SELF.fetch(
      `https://points.test/v1/points/${address}/history?limit=1&cursor=${page.next_cursor}`,
      { headers: { ...origin, "CF-Connecting-IP": "203.0.113.22" } },
    );
    const rest = await secondPage.json() as { items: Array<{ block_number: number }>; next_cursor: string | null };
    expect(rest.items.map((item) => item.block_number)).toEqual([11]);
    expect(rest.next_cursor).toBeNull();
    forbidRankAndEarn(JSON.stringify(page));
    forbidRankAndEarn(JSON.stringify(rest));

    const health = await SELF.fetch("https://points.test/health", {
      headers: { "CF-Connecting-IP": "203.0.113.23" },
    });
    forbidRankAndEarn(await health.text());
  });

  it("rejects a repeated query param and a missing client address", async () => {
    const address = await wallet();
    const repeated = await SELF.fetch(`https://points.test/v1/points/${address}?cursor=a&cursor=b`, {
      headers: { "CF-Connecting-IP": "203.0.113.30" },
    });
    expect(repeated.status).toBe(400);
    expect(await repeated.json()).toEqual({ ok: false, error: "duplicate_query" });
    const options = await SELF.fetch(`https://points.test/v1/points/${address}?x=1&x=2`, { method: "OPTIONS" });
    expect(options.status).toBe(400);
    expect(await options.json()).toEqual({ ok: false, error: "duplicate_query" });
    const missing = await SELF.fetch(`https://points.test/v1/points/${address}`);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ ok: false, error: "client_address_required" });
    const unknownPath = await SELF.fetch("https://points.test/nope?a=1&a=2");
    expect(unknownPath.status).toBe(400);
    expect(await unknownPath.json()).toEqual({ ok: false, error: "duplicate_query" });
  });

  it("accepts only an https legal notice link", () => {
    expect(httpsUrl("https://example.com/legal")).toBe("https://example.com/legal");
    expect(httpsUrl("http://example.com/legal")).toBeNull();
    expect(httpsUrl("")).toBeNull();
  });

  it("drops client addresses and header secrets from log details", () => {
    const address = `0x${"ab".repeat(20)}`;
    const detail = publicDetail(
      `empty ${address} from 203.0.113.8 via 2001:db8::1 Authorization: secret hmac=abcdef http://rpc.test/base`,
      "http://rpc.test/base",
    );
    expect(detail).not.toContain(address);
    expect(detail).not.toContain("203.0.113.8");
    expect(detail).not.toContain("2001:db8");
    expect(detail).not.toContain("secret");
    expect(detail).not.toContain("abcdef");
    expect(detail).not.toContain("rpc.test");
    expect(detail).toContain("[redacted]");
  });

  it("limits by CF-Connecting-IP and ignores X-Forwarded-For", async () => {
    const address = await wallet();
    const path = `https://points.test/v1/points/${address}`;
    for (let index = 0; index < 60; index += 1) {
      const response = await SELF.fetch(path, {
        headers: {
          "CF-Connecting-IP": "203.0.113.8",
          "X-Forwarded-For": "198.51.100.1",
        },
      });
      expect(response.status).toBe(200);
    }
    const limited = await SELF.fetch(path, {
      headers: {
        "CF-Connecting-IP": "203.0.113.8",
        "X-Forwarded-For": "198.51.100.9",
      },
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ ok: false, error: "rate_limited" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    const other = await SELF.fetch(path, {
      headers: {
        "CF-Connecting-IP": "203.0.113.9",
        "X-Forwarded-For": "203.0.113.8",
      },
    });
    expect(other.status).toBe(200);
  });

  it("opens the read circuit after repeated store failures", async () => {
    const address = await wallet();
    const api = createReadApi({
      allow: () => ({ ok: true }),
      store: {
        getCursor: () => ({
          last_scanned_block: null,
          finalized_block: null,
          pass_completed: false,
          stale: false,
        }),
        getLedgerSummary: () => {
          throw new Error("store_down");
        },
        listLedgerRows: () => [],
        getConfig: () => ({ weights: {}, gates: {}, rule_version: null }),
      },
    });
    for (let index = 0; index < 5; index += 1) {
      const failed = api.handle({ method: "GET", path: `/v1/points/${address}`, query: {} });
      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({ ok: false, error: "internal" });
    }
    const blocked = api.handle({ method: "GET", path: `/v1/points/${address}`, query: {} });
    expect(blocked.status).toBe(503);
    expect(blocked.body).toEqual({ ok: false, error: "points_unavailable" });
  });

  it("turns on only for the exact string true", () => {
    expect(pointsEnabled(undefined)).toBe(false);
    expect(pointsEnabled({})).toBe(false);
    expect(pointsEnabled({ POINTS_ENABLED: "true" })).toBe(true);
    expect(pointsEnabled({ POINTS_ENABLED: "TRUE" })).toBe(false);
    expect(pointsEnabled({ POINTS_ENABLED: " true " })).toBe(false);
    expect(pointsEnabled({ POINTS_ENABLED: "1" })).toBe(false);
    expect(pointsEnabled({ POINTS_ENABLED: "yes" })).toBe(false);
    expect(pointsEnabled({ POINTS_ENABLED: "on" })).toBe(false);
  });

  it("reads stored weights so a tamper shows until the bundle is applied again", async () => {
    const tampered = {
      first_activity: 5,
      fund: 5,
      release_or_refund: 5,
      dispute_open_or_vote: 5,
      vote: 5,
      return_day: 5,
    };
    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO meta(key, value) VALUES('weights', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        JSON.stringify(tampered),
      );
    });
    const tamperedResponse = await SELF.fetch("https://points.test/v1/points/config", {
      headers: { "CF-Connecting-IP": "203.0.113.31" },
    });
    const tamperedBody = await tamperedResponse.json() as { weights: Record<string, unknown> };
    expect(tamperedBody.weights).toEqual(tampered);
    await runInDurableObject(stub(), async (_instance, state) => {
      const { refreshBundled } = await import("../src/ledger");
      refreshBundled(state.storage.sql);
    });
    const restored = await SELF.fetch("https://points.test/v1/points/config", {
      headers: { "CF-Connecting-IP": "203.0.113.32" },
    });
    const restoredBody = await restored.json() as { weights: Record<string, number | null> };
    expect(restoredBody.weights.first_activity).toBeNull();
    expect(restoredBody.weights.fund).toBeNull();
    expect(restoredBody.weights.return_day).toBeNull();
  });
});
