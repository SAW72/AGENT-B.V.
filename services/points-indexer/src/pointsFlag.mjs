/**
 * POINTS_ENABLED is off unless the value is 1, true, on, or yes.
 * An unset or blank value stays off.
 * This file does not open a database and does not read process.env.
 * The read module and the process entry both use this parser.
 * @param {{ POINTS_ENABLED?: unknown } | undefined} env
 */
export function pointsEnabled(env) {
  const raw = env?.POINTS_ENABLED;
  if (raw == null || String(raw).trim() === "") return false;
  const text = String(raw).trim().toLowerCase();
  return text === "1" || text === "true" || text === "on" || text === "yes";
}
