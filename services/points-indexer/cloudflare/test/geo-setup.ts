import worker from "../src/index";

// cloudflare:test SELF is a Proxy that always reads the worker's fetch.
// Assigning SELF.fetch does not change what tests call.
type FetchFn = typeof worker.fetch;
const original: FetchFn = worker.fetch.bind(worker);

worker.fetch = (async (request: Parameters<FetchFn>[0], env: Parameters<FetchFn>[1]) => {
  let next = request;
  if (!request.url.includes("__geo=raw")) {
    const headers = new Headers(request.headers);
    if (!headers.has("CF-IPCountry")) {
      headers.set("CF-IPCountry", "US");
      next = new Request(request, { headers }) as Parameters<FetchFn>[0];
    }
  }
  return original(next, env);
}) as FetchFn;
