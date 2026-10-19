import { env, listDurableObjectIds, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function forbidRankAndEarn(payload: string) {
  const lower = payload.toLowerCase();
  expect(lower).not.toContain("rank");
  expect(lower).not.toContain("earn");
}

describe("points read API while POINTS_ENABLED is unset", () => {
  it("returns 503 points_disabled for /v1/points routes and does not wake the object", async () => {
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    const address = `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    for (const path of [
      "/v1/points/config",
      `/v1/points/${address}`,
      `/v1/points/${address}/history`,
    ]) {
      const response = await SELF.fetch(`https://points.test${path}`);
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ ok: false, error: "points_disabled" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      forbidRankAndEarn(text);
    }
    const options = await SELF.fetch(`https://points.test/v1/points/${address}`, {
      method: "OPTIONS",
      headers: { Origin: "https://agent-bv.pages.dev" },
    });
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-methods")).toContain("OPTIONS");
    const repeated = await SELF.fetch(`https://points.test/v1/points/${address}?limit=1&limit=2`);
    expect(repeated.status).toBe(400);
    const repeatedText = await repeated.text();
    expect(JSON.parse(repeatedText)).toEqual({ ok: false, error: "duplicate_query" });
    forbidRankAndEarn(repeatedText);
    expect(await listDurableObjectIds(env.POINTS)).toEqual([]);
  });

  it("answers /health as disabled without the durable object", async () => {
    const response = await SELF.fetch("https://points.test/health");
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ status: "disabled" });
    forbidRankAndEarn(text);
    const repeated = await SELF.fetch("https://points.test/health?ready=1&ready=1");
    expect(repeated.status).toBe(400);
    expect(await repeated.json()).toEqual({ ok: false, error: "duplicate_query" });
    expect(await listDurableObjectIds(env.POINTS)).toEqual([]);
  });

  it("does not build schema or reschedule a leftover alarm when the flag is off", async () => {
    const stub = env.POINTS.get(env.POINTS.idFromName("base-sepolia"));
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      const names = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((row) => String(row.name));
      expect(names).not.toContain("meta");
      expect(names).not.toContain("raw_logs");
      state.storage.sql.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      state.storage.sql.exec("INSERT INTO meta(key, value) VALUES('last_scanned_block', '5')");
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      const row = state.storage.sql.exec("SELECT value FROM meta WHERE key = 'last_scanned_block'").toArray()[0];
      expect(String(row.value)).toBe("5");
      const names = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((row) => String(row.name));
      expect(names).not.toContain("raw_logs");
    });
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });
});
