import { reset, runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import sepolia from "../../../config/reputation/sepolia.json";
import { createReadApi, pointsEnabled } from "../src/read-api";

const DISCLAIMER = "Testnet only. Not a token. Can't be transferred, sold, or redeemed. May be adjusted or cancelled, and does not convert to anything.";

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
    expect(JSON.stringify(config)).not.toContain("rank");
    expect(JSON.stringify(config).toLowerCase()).not.toContain("earn");

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
    };
    expect(page.limit).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].block_number).toBe(10);
    expect(page.items[0].points).toBe(0);
    expect(page.items[0].points_withheld).toBe(true);
    expect(page.items[0].eligibility_reason).toBe("ofac_unconfigured");
    expect(page.next_cursor).toBeTruthy();

    const secondPage = await SELF.fetch(
      `https://points.test/v1/points/${address}/history?limit=1&cursor=${page.next_cursor}`,
      { headers: { ...origin, "CF-Connecting-IP": "203.0.113.22" } },
    );
    const rest = await secondPage.json() as { items: Array<{ block_number: number }>; next_cursor: string | null };
    expect(rest.items.map((item) => item.block_number)).toEqual([11]);
    expect(rest.next_cursor).toBeNull();
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

  it("treats an unset flag as disabled", () => {
    expect(pointsEnabled(undefined)).toBe(false);
    expect(pointsEnabled({})).toBe(false);
    expect(pointsEnabled({ POINTS_ENABLED: " " })).toBe(false);
    expect(pointsEnabled({ POINTS_ENABLED: "1" })).toBe(true);
  });
});
