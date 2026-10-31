import { decideGeoblock, geoLog, PUBLIC_DENIAL_MESSAGE } from "./geo.mjs";

export async function onRequest(context) {
  const cf = context.request.cf;
  const onEdge = cf != null && typeof cf === "object";
  // Pages is a public route. request.cf is set by Cloudflare. A client
  // CF-IPCountry header is not a location. Off-edge and unknown country deny.
  const decision = decideGeoblock({
    country: onEdge && typeof cf.country === "string" ? cf.country : "",
    regionCode: onEdge && typeof cf.regionCode === "string" ? cf.regionCode : "",
    region: onEdge && typeof cf.region === "string" ? cf.region : "",
    edge: onEdge,
    publicRoute: true,
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
