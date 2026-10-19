import { env, listDurableObjectIds, SELF } from "cloudflare:test";
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
    expect(await listDurableObjectIds(env.POINTS)).toEqual([]);
  });

  it("answers /health as disabled without the durable object", async () => {
    const response = await SELF.fetch("https://points.test/health");
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ status: "disabled" });
    forbidRankAndEarn(text);
    expect(await listDurableObjectIds(env.POINTS)).toEqual([]);
  });
});
