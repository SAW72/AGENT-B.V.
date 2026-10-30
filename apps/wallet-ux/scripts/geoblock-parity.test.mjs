import { describe, expect, it } from "vitest";
import { decideGeoblock as pagesDecide, OWNER_POLICY_COUNTRY_CODES as pagesPolicy, PUBLIC_DENIAL_MESSAGE as pagesMessage } from "../functions/geo.mjs";
import { decideGeoblock as relayerDecide, OWNER_POLICY_COUNTRY_CODES as relayerPolicy, PUBLIC_DENIAL_MESSAGE as relayerMessage } from "../../../claim-relayer/geoblock.mjs";

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
  { country: "UA", regionCode: "40", edge: true },
  { country: "UA", regionCode: "UA-40", edge: true },
  { country: "UA", regionCode: "14", edge: true },
  { country: "UA", regionCode: "09", edge: true },
  { country: "UA", region: "Crimea", edge: true },
  { country: "UA", region: "Sevastopol", edge: true },
  { country: "UA", region: "Sevastopol City", edge: true },
  { country: "UA", regionCode: "30", region: "Sevastopol", edge: true },
  { country: "UA", region: "Kyiv", edge: true },
  { country: "", edge: true },
  { country: "XX", edge: true },
  { country: "T1", edge: false },
  { country: "", edge: false },
  { country: "US", edge: false, publicRoute: true },
  { country: "SY", edge: false, publicRoute: true },
  { country: "US", edge: true, publicRoute: true },
];

describe("Pages geoblock matches the relayer module", () => {
  it("uses the same denial sentence and the same decisions", () => {
    expect(pagesMessage).toBe(relayerMessage);
    expect([...pagesPolicy]).toEqual(["SY", "RU", "VE"]);
    expect([...pagesPolicy]).toEqual([...relayerPolicy]);
    const at = 1_700_000_000_000;
    for (const input of cases) {
      const left = pagesDecide({ ...input, at });
      const right = relayerDecide({ ...input, at });
      expect(left.decision, JSON.stringify(input)).toBe(right.decision);
      expect(left.country, JSON.stringify(input)).toBe(right.country);
    }
    for (const country of ["SY", "RU", "VE"]) {
      expect(pagesDecide({ country, edge: true, at }).decision).toBe("deny");
      expect(relayerDecide({ country, edge: true, at }).decision).toBe("deny");
    }
    expect(pagesDecide({ country: "", edge: false, at }).decision).toBe("deny");
    expect(relayerDecide({ country: "US", edge: false, publicRoute: true, at }).decision).toBe("deny");
    expect(pagesDecide({ country: "UA", edge: true, at }).decision).toBe("deny");
    expect(relayerDecide({ country: "UA", regionCode: "", region: "", edge: true, at }).decision).toBe("deny");
    expect(pagesDecide({ country: "UA", region: "Kyiv", edge: true, at }).decision).toBe("allow");
    expect(pagesDecide({ country: "UA", regionCode: "40", edge: true, at }).decision).toBe("deny");
    expect(pagesDecide({ country: "UA", regionCode: "40", edge: true, at }).country).toBe("UA-40");
    expect(relayerDecide({ country: "UA", region: "Sevastopol", edge: true, at }).country).toBe("UA-40");
    expect(pagesDecide({ country: "UA", regionCode: "UA-40", edge: true, at }).decision).toBe("deny");
  });
});
