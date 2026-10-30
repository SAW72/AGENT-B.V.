import { createMemorySanctionsData } from "../sanctionsMemory.mjs";
import { createSanctionsGate } from "../sanctionsGate.mjs";
import { screenFromAddressList } from "../sanctions.mjs";

export const TEST_PEPPER = "test-wallet-hash-pepper";
const CLEAR_ADDRESS = "0x3333333333333333333333333333333333333333";

export function clearSanctionsGate(now = Date.now()) {
  return createSanctionsGate({
    pepper: TEST_PEPPER,
    now: () => now,
    data: createMemorySanctionsData(),
    screen: screenFromAddressList([CLEAR_ADDRESS], now, {
      minAddresses: 1,
      listVersion: "test-clear",
    }),
  });
}
