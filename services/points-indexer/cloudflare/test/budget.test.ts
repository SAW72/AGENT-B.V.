import { env, listDurableObjectIds, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ESCROW_START_BLOCK } from "./helpers";

function stub() {
  return env.POINTS.get(env.POINTS.idFromName("base-sepolia"));
}

describe("points request budget", () => {
  it("counts a duplicate query against the client and does not wake the object", async () => {
    expect(await listDurableObjectIds(env.POINTS)).toEqual([]);
    const healthHeaders = { "CF-Connecting-IP": "203.0.113.50" };
    for (let index = 0; index < 3; index += 1) {
      const response = await SELF.fetch("https://points.test/health?x=1&x=2", { headers: healthHeaders });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: "duplicate_query" });
    }
    const healthBlocked = await SELF.fetch("https://points.test/health?x=1&x=2", { headers: healthHeaders });
    expect(healthBlocked.status).toBe(429);
    expect(await healthBlocked.json()).toEqual({ ok: false, error: "rate_limited" });
    const healthOther = await SELF.fetch("https://points.test/health?y=1&y=2", {
      headers: { "CF-Connecting-IP": "203.0.113.51" },
    });
    expect(healthOther.status).toBe(400);
    expect(await healthOther.json()).toEqual({ ok: false, error: "duplicate_query" });

    const readHeaders = { "CF-Connecting-IP": "203.0.113.60" };
    for (let index = 0; index < 20; index += 1) {
      const response = await SELF.fetch("https://points.test/v1/points/config?x=1&x=2", { headers: readHeaders });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: "duplicate_query" });
    }
    const readBlocked = await SELF.fetch("https://points.test/v1/points/config?x=1&x=2", { headers: readHeaders });
    expect(readBlocked.status).toBe(429);
    expect(await readBlocked.json()).toEqual({ ok: false, error: "rate_limited" });
    const readOther = await SELF.fetch("https://points.test/v1/points/config?y=1&y=2", {
      headers: { "CF-Connecting-IP": "203.0.113.61" },
    });
    expect(readOther.status).toBe(400);
    expect(await readOther.json()).toEqual({ ok: false, error: "duplicate_query" });
    expect(await listDurableObjectIds(env.POINTS)).toEqual([]);
  });

  it("caches health, limits it, and caps durable object wakes across addresses", async () => {
    const repeated = await SELF.fetch("https://points.test/health?x=1&x=2");
    expect(repeated.status).toBe(400);
    expect(await repeated.json()).toEqual({ ok: false, error: "client_address_required" });

    const missingHealth = await SELF.fetch("https://points.test/health");
    expect(missingHealth.status).toBe(400);
    expect(await missingHealth.json()).toEqual({ ok: false, error: "client_address_required" });

    const missingRead = await SELF.fetch("https://points.test/v1/points/config");
    expect(missingRead.status).toBe(400);
    expect(await missingRead.json()).toEqual({ ok: false, error: "client_address_required" });

    await runInDurableObject(stub(), async (_instance, state) => {
      const put = (key: string, value: string) => {
        state.storage.sql.exec(
          "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          key,
          value,
        );
      };
      put("last_pass_at", String(Date.now()));
      put("chain_head", String(ESCROW_START_BLOCK));
      put("last_scanned_block", String(ESCROW_START_BLOCK));
    });

    const headers = { "CF-Connecting-IP": "203.0.113.10" };
    const first = await SELF.fetch("https://points.test/health", { headers });
    expect(first.status).toBe(200);
    expect(first.headers.get("x-points-cache")).toBe("miss");
    expect(first.headers.get("cache-control")).toBe("public, max-age=15");
    const firstBody = await first.json() as { ok: boolean; behind?: number };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.behind).toBeUndefined();

    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO meta(key, value) VALUES('chain_head', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        String(ESCROW_START_BLOCK + 5_000),
      );
    });

    const second = await SELF.fetch("https://points.test/health", { headers });
    expect(second.status).toBe(200);
    expect(second.headers.get("x-points-cache")).toBe("hit");
    const secondBody = await second.json() as { behind?: number };
    expect(secondBody.behind).toBeUndefined();

    const third = await SELF.fetch("https://points.test/health", { headers });
    expect(third.status).toBe(200);
    const fourth = await SELF.fetch("https://points.test/health", { headers });
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toEqual({ ok: false, error: "rate_limited" });

    for (let index = 0; index < 3; index += 1) {
      const response = await SELF.fetch("https://points.test/v1/points/config", {
        headers: { "CF-Connecting-IP": index === 2 ? "203.0.113.11" : "203.0.113.10" },
      });
      expect(response.status).toBe(200);
    }
    const blocked = await SELF.fetch("https://points.test/v1/points/config", {
      headers: { "CF-Connecting-IP": "203.0.113.12" },
    });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ ok: false, error: "rate_limited" });
  });
});
