import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("points read API while POINTS_ENABLED is unset", () => {
  it("returns 503 points_disabled for /v1/points routes", async () => {
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
      expect(await response.json()).toEqual({ ok: false, error: "points_disabled" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("still answers /health", async () => {
    const response = await SELF.fetch("https://points.test/health");
    const body = await response.json() as { error?: string; chainId?: number };
    expect(body.error).not.toBe("points_disabled");
    expect(body.chainId).toBe(84532);
  });
});
