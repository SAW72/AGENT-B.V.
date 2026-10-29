// Relayer-only gate. This file imports node:sqlite. The worker must not import it.

import { DatabaseSync } from "node:sqlite";
import {
  doSql,
  loadSnapshot,
  nodeSql,
  rescreenLinkedWallets,
  signupAccount,
  linkWallet,
  changeWallet,
  unlinkWallet,
  releaseFalsePositive,
  dropAccountTie,
  walletBlockedByAccount,
  guardDecision,
} from "./accountScreen.mjs";
import {
  createScreenSession,
  issueScreenNonce,
  verifyScreenProof,
} from "./screenAuth.mjs";
import {
  SANCTIONS_INSERT_CHECK,
  SANCTIONS_INSERT_WALLET,
  SANCTIONS_MATCH,
  SANCTIONS_READ_CACHE,
  SANCTIONS_UNAVAILABLE,
  SDN_ADVANCED_URL,
  migrateSanctionsSchema,
  refreshParsedList,
  sanctionsCheckLog,
  sanctionsCheckParams,
  screenFromStored,
  swapSanctionsCache,
  walletHashHex,
} from "./sanctions.mjs";

function unavailable() {
  return { result: "unavailable", reason: SANCTIONS_UNAVAILABLE, persisted: false };
}

export function createSanctionsGate(options = {}) {
  const db = options.db || new DatabaseSync(":memory:");
  migrateSanctionsSchema(db);
  const sql = nodeSql(db);
  let snapshot = options.screen || screenFromStored(null, [], options.now?.() ?? Date.now());
  const pepper = options.pepper ?? "";
  const now = options.now || Date.now;

  function writeCheck(wallet, decision, decisionPoint) {
    const params = sanctionsCheckParams(snapshot, wallet, decision, {
      pepper,
      chainId: 84532,
      decisionPoint,
    });
    sql.run(
      SANCTIONS_INSERT_CHECK,
      params.walletHash,
      params.result,
      params.reason,
      params.checkedAt,
      params.listVersion,
      params.listSha256,
      params.source,
      params.persisted,
      params.chainId,
      params.decisionPoint,
    );
    console.info(JSON.stringify(sanctionsCheckLog(snapshot, wallet, decision, { pepper })));
    return params;
  }

  return {
    db,
    sql,
    pepper,
    snapshot() {
      return snapshot;
    },
    replace(screen) {
      snapshot = screen;
    },
    decide(wallet) {
      return guardDecision(snapshot, wallet);
    },
    screen(wallet, decisionPoint = "claim") {
      try {
        const raw = guardDecision(snapshot, wallet);
        const decision = pepper ? raw : (raw.result === "match" ? raw : unavailable());
        const params = writeCheck(wallet, decision, decisionPoint);
        if (params.storeWallet && decision.result === "match") {
          sql.run(
            SANCTIONS_INSERT_WALLET,
            params.wallet,
            params.walletHash,
            SANCTIONS_MATCH,
            params.checkedAt,
            params.listVersion,
          );
        }
        if (walletBlockedByAccount(sql, pepper, wallet)) {
          return { result: "match", reason: "sanctions_match", persisted: true };
        }
        return decision;
      } catch {
        return unavailable();
      }
    },
    async refresh(fetchImpl, refreshOptions = {}) {
      try {
        const at = refreshOptions.now ?? now();
        const cache = sql.get(SANCTIONS_READ_CACHE);
        const outcome = await refreshParsedList(
          fetchImpl,
          SDN_ADVANCED_URL,
          at,
          refreshOptions.refreshMs,
          cache,
          refreshOptions,
        );
        if (outcome.failed) return { ...outcome, broadcast: false };
        if (outcome.addressesJson != null) {
          swapSanctionsCache(db, {
            fetchedAt: outcome.fetchedAt,
            source: SDN_ADVANCED_URL,
            listVersion: outcome.listVersion,
            addressesJson: outcome.addressesJson,
            addressesSha256: outcome.addressesSha256,
            rawSha256: outcome.rawSha256,
          });
        }
        snapshot = loadSnapshot(sql, at);
        await rescreenLinkedWallets(sql, snapshot, { pepper, now: at, chainId: 84532 });
        return outcome;
      } catch {
        return { refreshed: false, failed: true, listVersion: null };
      }
    },
    signup(body) {
      return signupAccount(sql, snapshot, { ...body, pepper, now: now(), chainId: 84532 });
    },
    link(body) {
      return linkWallet(sql, snapshot, { ...body, pepper, now: now(), chainId: 84532 });
    },
    change(body) {
      return changeWallet(sql, snapshot, {
        ...body,
        wallet: body?.nextWallet || body?.wallet,
        pepper,
        now: now(),
        chainId: 84532,
        decisionPoint: "change",
      });
    },
    unlink(body) {
      return unlinkWallet(sql, snapshot, { ...body, pepper, now: now(), chainId: 84532 });
    },
    blocks(wallet) {
      try {
        if (!pepper) return true;
        return walletBlockedByAccount(sql, pepper, wallet);
      } catch {
        return true;
      }
    },
    release(wallet, actor) {
      return releaseFalsePositive(sql, snapshot, { wallet, pepper, now: now(), actor });
    },
    issueNonce() {
      return issueScreenNonce(sql, now());
    },
    verifyScreen(action, body, sessionToken, overrides = {}) {
      return verifyScreenProof(sql, {
        action,
        message: body?.message,
        signature: body?.signature,
        sessionToken,
        domain: overrides.domain || options.siweDomain || "agent-bv.pages.dev",
        chainId: overrides.chainId || options.chainId || 84532,
        now: now(),
      });
    },
    sessionFor(accountId, wallet) {
      const hash = walletHashHex(pepper, wallet);
      if (!hash) return "";
      return createScreenSession(sql, accountId, hash, now());
    },
    dropTie(accountId, wallet, actor) {
      return dropAccountTie(sql, snapshot, { accountId, wallet, pepper, now: now(), actor });
    },
  };
}

export { doSql };
