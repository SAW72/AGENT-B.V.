import worker from "../src/index";

// cloudflare:test SELF is a Proxy that always reads the worker's fetch.
// Assigning SELF.fetch does not change what tests call.
// The harness stamps request.cf. Production code ignores a client CF-IPCountry.
type FetchFn = typeof worker.fetch;
const original: FetchFn = worker.fetch.bind(worker);

function headerText(headers: Headers, name: string) {
  return headers.get(name) || "";
}

function edgeCf(request: Request) {
  if (!request.url.includes("__geo=raw")) {
    return { country: "US", regionCode: "", region: "" };
  }
  return {
    country: headerText(request.headers, "x-test-cf-country"),
    regionCode: headerText(request.headers, "x-test-cf-region-code"),
    region: headerText(request.headers, "x-test-cf-region"),
  };
}

worker.fetch = (async (request: Parameters<FetchFn>[0], env: Parameters<FetchFn>[1]) => {
  const headers = new Headers(request.headers);
  headers.delete("x-test-cf-country");
  headers.delete("x-test-cf-region-code");
  headers.delete("x-test-cf-region");
  const next = new Request(request, { headers, cf: edgeCf(request) } as RequestInit);
  return original(next as Parameters<FetchFn>[0], env);
}) as FetchFn;
