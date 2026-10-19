/**
 * POINTS_ENABLED is on only for the exact string "true".
 * TRUE, " true ", 1, yes, and on stay off. An unset value stays off.
 * This file does not open a database and does not read process.env.
 * The read module and the process entry both use this parser.
 * @param {{ POINTS_ENABLED?: unknown } | undefined} env
 */
export function pointsEnabled(env) {
  return env?.POINTS_ENABLED === "true";
}
