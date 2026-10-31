import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const MESSAGE = "Agent-B.V. isn't available for this wallet or location. If you think this is a mistake, contact hello@stewardoftheking.com.";

async function statusFor(
  cf: { country?: string; regionCode?: string; region?: string },
  client: Record<string, string> = {},
  query = "",
) {
  const headers: Record<string, string> = { ...client };
  if (cf.country !== undefined) headers["x-test-cf-country"] = cf.country;
  if (cf.regionCode !== undefined) headers["x-test-cf-region-code"] = cf.regionCode;
  if (cf.region !== undefined) headers["x-test-cf-region"] = cf.region;
  return SELF.fetch(`https://points.test/health${query}`, { headers });
}

describe("worker edge geoblock", () => {
  it("uses request.cf, denies blocked countries, and ignores a client CF-IPCountry", async () => {
    const missing = await statusFor({}, { "CF-IPCountry": "US" }, "?__geo=raw");
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ ok: false, message: MESSAGE });
    for (const country of ["CU", "IR", "KP", "SY", "RU", "VE"]) {
      const response = await statusFor({ country }, { "CF-IPCountry": "US" }, "?__geo=raw");
      expect(response.status, country).toBe(403);
      const body = await response.text();
      expect(body.toLowerCase().includes("sanction")).toBe(false);
      expect(body.includes("SDN")).toBe(false);
    }
    const crimea = await statusFor(
      { country: "UA", regionCode: "43" },
      { "CF-IPCountry": "US" },
      "?__geo=raw",
    );
    expect(crimea.status).toBe(403);
    const sevastopol = await statusFor(
      { country: "UA", regionCode: "40" },
      { "CF-IPCountry": "US" },
      "?__geo=raw",
    );
    expect(sevastopol.status).toBe(403);
    const sevastopolName = await statusFor(
      { country: "UA", region: "Sevastopol" },
      { "CF-IPCountry": "US" },
      "?__geo=raw",
    );
    expect(sevastopolName.status).toBe(403);
    const ukraine = await statusFor({ country: "UA" }, { "CF-IPCountry": "SY" }, "?__geo=raw");
    expect(ukraine.status).toBe(403);
    const blankRegion = await statusFor(
      { country: "UA", regionCode: "", region: "" },
      { "CF-IPCountry": "US" },
      "?__geo=raw",
    );
    expect(blankRegion.status).toBe(403);
    const kyiv = await statusFor({ country: "UA", region: "Kyiv" }, { "CF-IPCountry": "SY" }, "?__geo=raw");
    expect(kyiv.status).not.toBe(403);
    const headerIgnored = await statusFor({ country: "US" }, { "CF-IPCountry": "SY" }, "?__geo=raw");
    expect(headerIgnored.status).not.toBe(403);
  });
});
