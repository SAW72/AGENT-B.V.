export class PointsError extends Error {
  reason: string;
  constructor(reason: string, extra?: object);
}
export function isUniqueError(error: unknown): boolean;
export function lowerHex(value: unknown): string | null;
