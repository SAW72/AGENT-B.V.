import { describe, expect, it } from "vitest";
import { decideGeoblock as pagesDecide, PUBLIC_DENIAL_MESSAGE as pagesMessage } from "../functions/geo.mjs";
import { decideGeoblock as relayerDecide, PUBLIC_DENIAL_MESSAGE as relayerMessage } from "../../../claim-relayer/geoblock.mjs";

const cases = [
  { country: "CU", edge: true },
  { country: "IR", edge: true },
  { country: "KP", edge: true },
  { country: "SY", edge: true },
  { country: "RU", edge: true },
  { country: "VE", edge: true },
  { country: "US", edge: true },
  { country: "UA", edge: true },
  { country: "UA", regionCode: "43", edge: true },
  { country: "UA", regionCode: "14", edge: true },
  { country: "UA", regionCode: "09", edge: true },
  { country: "UA", region: "Crimea", edge: true },
  { country: "UA", region: "Kyiv", edge: true },
  { country: "", edge: true },
  { country: "XX", edge: true },
  { country: "", edge: false },
];

describe("Pages geoblock matches the relayer module", () => {
  it("uses the same denial sentence and the same decisions", () => {
    expect(pagesMessage).toBe(relayerMessage);
    const at = 1_700_000_000_000;
    for (const input of cases) {
      const left = pagesDecide({ ...input, at });
      const right = relayerDecide({ ...input, at });
      expect(left.decision, JSON.stringify(input)).toBe(right.decision);
      expect(left.country, JSON.stringify(input)).toBe(right.country);
    }
  });
});
