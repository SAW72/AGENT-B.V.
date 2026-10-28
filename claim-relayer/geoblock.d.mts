export const COMPREHENSIVE_COUNTRY_CODES: readonly string[];
export const PROGRAM_NOTE: string;
export const PUBLIC_DENIAL_MESSAGE: string;

export type GeoDecision = {
  decision: "deny" | "allow" | "skip";
  country: string;
  at: number;
};

export function decideGeoblock(input?: {
  country?: string;
  regionCode?: string;
  region?: string;
  edge?: boolean;
  at?: number;
}): GeoDecision;

export function geoLog(decision: GeoDecision): {
  message: string;
  country: string;
  decision: string;
  at: number;
};

export function geoInputFromHeaders(
  headers: { get(name: string): string | null },
  cf: unknown,
  edge: boolean,
): {
  country: string;
  regionCode: string;
  region: string;
  edge: boolean;
};
