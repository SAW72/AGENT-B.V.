import { decideGeoblock, geoLog, PUBLIC_DENIAL_MESSAGE } from "./geo.mjs";

export async function onRequest(context) {
  const headers = context.request.headers;
  const cf = context.request.cf;
  const onEdge = cf != null && typeof cf === "object";
  // request.cf is set by Cloudflare. wrangler pages dev leaves it unset, so local
  // previews are not treated as the edge. On the edge a missing country denies.
  const decision = decideGeoblock({
    country: (onEdge && typeof cf.country === "string" && cf.country) || headers.get("CF-IPCountry") || "",
    regionCode: (onEdge && typeof cf.regionCode === "string" && cf.regionCode) || headers.get("CF-Region-Code") || "",
    region: (onEdge && typeof cf.region === "string" && cf.region) || headers.get("CF-Region") || "",
    edge: onEdge,
  });
  console.info(JSON.stringify(geoLog(decision)));
  if (decision.decision === "deny") {
    return new Response(JSON.stringify({ ok: false, message: PUBLIC_DENIAL_MESSAGE }), {
      status: 403,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  return context.next();
}
