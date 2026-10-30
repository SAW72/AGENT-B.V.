// Shared test edge secret. 64 hex characters, built with repeat, not a literal.
export const TEST_EDGE_AUTH = "a".repeat(64);

export function edgeRequestHeaders(headers = {}) {
  const out = { ...headers };
  if (!Object.prototype.hasOwnProperty.call(headers, "x-relayer-edge-auth")) {
    out["x-relayer-edge-auth"] = TEST_EDGE_AUTH;
  } else if (!out["x-relayer-edge-auth"]) {
    delete out["x-relayer-edge-auth"];
  }
  if (!Object.prototype.hasOwnProperty.call(headers, "x-edge-country")) {
    out["x-edge-country"] = "US";
  } else if (!out["x-edge-country"]) {
    delete out["x-edge-country"];
  }
  return out;
}
