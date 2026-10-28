import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker sanctions age boundary", () => {
  it("keeps a list at exactly 24 hours and drops it one millisecond later", async () => {
    const id = env.POINTS.idFromName("age-boundary");
    await runInDurableObject(env.POINTS.get(id), async () => {
      const {
        SANCTIONS_MAX_AGE_MS,
        addressListSha256,
        listWithinMaxAge,
        screenFromStored,
      } = await import("../../src/sanctions.mjs");
      const now = 10_000;
      const wallet = "0x00000000000000000000000000000000000000a1";
      const row = {
        fetched_at: now,
        source: "test",
        list_version: "v",
        addresses_json: JSON.stringify([wallet]),
        addresses_sha256: addressListSha256([wallet]),
      };
      expect(SANCTIONS_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
      expect(listWithinMaxAge(now, now + SANCTIONS_MAX_AGE_MS)).toBe(true);
      expect(listWithinMaxAge(now, now + SANCTIONS_MAX_AGE_MS + 1)).toBe(false);
      expect(screenFromStored(row, [], now + SANCTIONS_MAX_AGE_MS, { minAddresses: 1 }).listReady).toBe(true);
      expect(screenFromStored(row, [], now + SANCTIONS_MAX_AGE_MS + 1, { minAddresses: 1 }).listReady).toBe(false);
      expect(screenFromStored({ ...row, fetched_at: now + 1 }, [], now, { minAddresses: 1 }).listReady).toBe(false);
    });
  });
});
