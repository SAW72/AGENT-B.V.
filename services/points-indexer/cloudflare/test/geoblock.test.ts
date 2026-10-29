import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const MESSAGE = "Agent-B.V. isn't available for this wallet or location. If you think this is a mistake, contact hello@stewardoftheking.com.";

async function statusFor(headers: Record<string, string>, query = "") {
  const response = await SELF.fetch(`https://points.test/health${query}`, { headers });
  return response;
}

describe("worker edge geoblock", () => {
  it("denies a missing country and the comprehensive jurisdictions", async () => {
    const missing = await statusFor({}, "?__geo=raw");
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ ok: false, message: MESSAGE });
    for (const country of ["CU", "IR", "KP", "SY", "RU", "VE"]) {
      const response = await statusFor({ "CF-IPCountry": country }, "?__geo=raw");
      expect(response.status, country).toBe(403);
      const body = await response.text();
      expect(body.toLowerCase().includes("sanction")).toBe(false);
      expect(body.includes("SDN")).toBe(false);
    }
    const crimea = await statusFor({ "CF-IPCountry": "UA", "CF-Region-Code": "43" }, "?__geo=raw");
    expect(crimea.status).toBe(403);
    const ukraine = await statusFor({ "CF-IPCountry": "UA" }, "?__geo=raw");
    expect(ukraine.status).not.toBe(403);
  });
});
