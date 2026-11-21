export const POINTS_ENFORCER: {
  owner: "TBD";
  auto_cancel: false;
  flags: "review_only";
};

export type PointsFlagKind =
  | "O5_REPEAT"
  | "DISPUTE_PREDATES_ESCROW"
  | "DENYLIST_LISTED"
  | "DENYLIST_UNLISTED"
  | "BOT_BURNED"
  | "PAIR_CAP"
  | "OTHER";

export type PointsFlagSignal = {
  kind?: string;
  wallet?: string | null;
  botId?: string | null;
  bot_id?: string | null;
  refs?: readonly unknown[];
};

export type PointsFlag = {
  kind: PointsFlagKind;
  wallet: string | null;
  bot_id: string | null;
  refs: string[];
  withhold_wallet: false;
  reason: "review_only";
  auto_cancel: false;
};

export function createPointsEnforcer(): {
  owner: "TBD";
  autoCancel: false;
  flag(signal?: PointsFlagSignal | null): { withhold_wallet: false; reason: "review_only" };
  flags(): PointsFlag[];
};
