// Relayer gate. Persisted rows live in D1 behind the edge Worker.
// The in-memory snapshot stays here. This file does not import node:sqlite.

import { guardDecision, openWallet, sealWallet } from "./accountScreen.mjs";
import { fitAddressesJson } from "./sanctionsData.mjs";
import {
  SCREEN_MAX_AGE_MS,
  SCREEN_SESSION_MS,
  verifyScreenProof,
} from "./screenAuth.mjs";
import { sha256Utf8 } from "./sha256.mjs";
import {
  PUBLIC_DENIAL_MESSAGE,
  SANCTIONS_CLEAR_RETENTION_MS,
  SANCTIONS_MATCH,
  SANCTIONS_MATCH_RETENTION_MS,
  SANCTIONS_UNAVAILABLE,
  SDN_ADVANCED_URL,
  normalizeSanctionsAddress,
  refreshParsedList,
  sanctionsCheckLog,
  sanctionsCheckParams,
  screenFromStored,
  walletHashHex,
} from "./sanctions.mjs";

const ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,80}$/;
const ACTOR_ID = /^[A-Za-z0-9._-]{1,64}$/;
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function unavailable() {
  return { result: "unavailable", reason: SANCTIONS_UNAVAILABLE, persisted: false };
}

function deny(decision) {
  return {
    ok: false,
    status: decision?.result === "match" ? "ineligible" : "unverified",
    http: 403,
    message: PUBLIC_DENIAL_MESSAGE,
    decision: decision || unavailable(),
  };
}

function allowUnverified(decision) {
  return { ok: true, status: "unverified", http: 200, message: null, decision };
}

function refused(error) {
  if (error && error.code === "unproven") return { ok: false, http: 401, error: "unproven" };
  return deny(unavailable());
}

function requireAccount(input) {
  const accountId = String(input?.accountId || "").trim();
  if (!ACCOUNT_ID.test(accountId)) throw new Error("account");
  return accountId;
}

function requireProven(input) {
  if (input?.proven !== true) {
    const error = new Error("unproven");
    error.code = "unproven";
    throw error;
  }
}

function releaseActor(value) {
  const actor = String(value || "").trim();
  if (!ACTOR_ID.test(actor)) return "";
  return actor;
}

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

function tokenText() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

function failClosedData() {
  return {
    async call() {
      const error = new Error("unavailable");
      error.code = "unavailable";
      error.status = 0;
      throw error;
    },
  };
}

function checkBody(params) {
  return {
    walletHash: params.walletHash,
    result: params.result,
    reason: params.reason,
    checkedAt: params.checkedAt,
    listVersion: params.listVersion,
    listSha256: params.listSha256,
    source: params.source,
    persisted: params.persisted,
    chainId: params.chainId,
    decisionPoint: params.decisionPoint,
  };
}

export function createSanctionsGate(options = {}) {
  const data = options.data || failClosedData();
  const pepper = options.pepper ?? "";
  const now = options.now || Date.now;
  let snapshot = options.screen || screenFromStored(null, [], now());

  function note(screen, wallet, decision) {
    console.info(JSON.stringify(sanctionsCheckLog(screen, wallet, decision, { pepper })));
  }

  async function writeAccount(op, screen, input, decision, link) {
    const params = sanctionsCheckParams(screen, input.wallet, decision, {
      pepper: input.pepper,
      chainId: input.chainId ?? 84532,
      decisionPoint: input.decisionPoint ?? "screen",
    });
    note(screen, input.wallet, decision);
    const normalized = normalizeSanctionsAddress(input.wallet);
    const hash = walletHashHex(input.pepper, normalized);
    const wallet = decision.result === "match" && normalized && hash
      ? {
        wallet: normalized,
        walletHash: hash,
        reason: SANCTIONS_MATCH,
        checkedAt: screen.checkedAt ?? input.now ?? Date.now(),
        listVersion: screen.listVersion ?? null,
      }
      : null;
    let sealed = null;
    if (link && normalized && hash) {
      sealed = {
        walletHash: hash,
        walletSealed: await sealWallet(input.pepper, normalized, { accountId: input.accountId, walletHash: hash }),
        linkedAt: input.now ?? Date.now(),
      };
    }
    const result = await data.call(op, {
      accountId: input.accountId,
      check: checkBody(params),
      wallet,
      link: sealed,
    });
    if (decision.result === "match" && normalized && screen?.persisted instanceof Set) screen.persisted.add(normalized);
    return result;
  }

  async function rescreen(at) {
    const listed = await data.call("linked.list", {});
    const blocks = [];
    const checks = [];
    const wallets = [];
    for (const row of listed.rows || []) {
      let wallet = "";
      try {
        wallet = await openWallet(pepper, row.wallet_sealed, {
          accountId: row.account_id,
          walletHash: row.wallet_hash,
        });
      } catch {
        blocks.push({
          accountId: String(row.account_id),
          walletHash: "unreadable",
          reason: SANCTIONS_UNAVAILABLE,
          blockedAt: at,
        });
        continue;
      }
      const decision = guardDecision(snapshot, wallet);
      const params = sanctionsCheckParams(snapshot, wallet, decision, {
        pepper,
        chainId: 84532,
        decisionPoint: "refresh",
      });
      note(snapshot, wallet, decision);
      checks.push(checkBody(params));
      if (decision.result === "match") {
        const normalized = normalizeSanctionsAddress(wallet);
        const hash = walletHashHex(pepper, normalized);
        if (normalized && hash) {
          wallets.push({
            wallet: normalized,
            walletHash: hash,
            reason: SANCTIONS_MATCH,
            checkedAt: snapshot.checkedAt ?? at,
            listVersion: snapshot.listVersion ?? null,
          });
          if (snapshot.persisted instanceof Set) snapshot.persisted.add(normalized);
        }
      }
    }
    const chunk = 20;
    for (let i = 0; i < Math.max(blocks.length, checks.length, wallets.length, 1); i += chunk) {
      const blockSlice = blocks.slice(i, i + chunk);
      const checkSlice = checks.slice(i, i + chunk);
      const walletSlice = wallets.slice(i, i + chunk);
      if (!blockSlice.length && !checkSlice.length && !walletSlice.length) continue;
      await data.call("blocks.insert", { blocks: blockSlice, checks: checkSlice, wallets: walletSlice });
    }
  }

  return {
    data,
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
    async screen(wallet, decisionPoint = "claim") {
      try {
        const raw = guardDecision(snapshot, wallet);
        const decision = pepper ? raw : (raw.result === "match" ? raw : unavailable());
        const params = sanctionsCheckParams(snapshot, wallet, decision, {
          pepper,
          chainId: 84532,
          decisionPoint,
        });
        const normalized = normalizeSanctionsAddress(wallet);
        const hash = walletHashHex(pepper, normalized);
        const recorded = await data.call("check.record", {
          check: checkBody(params),
          storeWallet: Boolean(decision.result === "match" && normalized && hash),
          wallet: decision.result === "match" && normalized ? normalized : "",
          walletHash: hash || "",
        });
        note(snapshot, wallet, decision);
        if (recorded?.blocked) return { result: "match", reason: SANCTIONS_MATCH, persisted: true };
        return decision;
      } catch {
        return unavailable();
      }
    },
    async refresh(fetchImpl, refreshOptions = {}) {
      try {
        const at = refreshOptions.now ?? now();
        const loaded = await data.call("snapshot.load", {});
        const outcome = await refreshParsedList(
          fetchImpl,
          SDN_ADVANCED_URL,
          at,
          refreshOptions.refreshMs,
          loaded.cache,
          refreshOptions,
        );
        if (outcome.failed) return { ...outcome, broadcast: false };
        if (outcome.addressesJson != null) {
          const addressesJson = fitAddressesJson(outcome.addressesJson);
          await data.call("cache.swap", {
            fetchedAt: outcome.fetchedAt,
            source: SDN_ADVANCED_URL,
            listVersion: outcome.listVersion,
            addressesJson,
            addressesSha256: outcome.addressesSha256,
            rawSha256: outcome.rawSha256,
          });
        }
        const again = await data.call("snapshot.load", {});
        snapshot = screenFromStored(again.cache, again.wallets, at);
        await rescreen(at);
        return outcome;
      } catch {
        return { refreshed: false, failed: true, listVersion: null };
      }
    },
    async signup(body) {
      try {
        requireProven(body);
        const accountId = requireAccount(body);
        const scoped = { ...body, accountId, pepper, now: now(), chainId: 84532, decisionPoint: "signup" };
        const decision = guardDecision(snapshot, body.wallet);
        const result = await writeAccount("account.signup", snapshot, scoped, decision, decision.result === "clear");
        if (decision.result !== "clear") return deny(decision);
        if (result?.blocked) return deny({ result: "match", reason: SANCTIONS_MATCH, persisted: true });
        return allowUnverified(decision);
      } catch (error) {
        return refused(error);
      }
    },
    async link(body) {
      try {
        requireProven(body);
        const accountId = requireAccount(body);
        const scoped = {
          ...body,
          accountId,
          pepper,
          now: now(),
          chainId: 84532,
          decisionPoint: body.decisionPoint || "link",
        };
        const decision = guardDecision(snapshot, scoped.wallet);
        const wantLink = decision.result === "match" || decision.result === "clear";
        const result = await writeAccount("account.link", snapshot, scoped, decision, wantLink);
        if (decision.result === "match") return deny(decision);
        if (decision.result !== "clear") return deny(decision);
        if (result?.blocked) return deny({ result: "match", reason: SANCTIONS_MATCH, persisted: true });
        return allowUnverified(decision);
      } catch (error) {
        return refused(error);
      }
    },
    async change(body) {
      return this.link({ ...body, wallet: body?.nextWallet || body?.wallet, decisionPoint: "change" });
    },
    async unlink(body) {
      try {
        requireProven(body);
        const accountId = requireAccount(body);
        const normalized = normalizeSanctionsAddress(body.wallet);
        const hash = walletHashHex(pepper, normalized);
        if (!normalized || !hash) return deny(unavailable());
        const result = await data.call("account.unlink", {
          accountId,
          walletHash: hash,
          unlinkedAt: now(),
          wallet: normalized,
        });
        if (result?.blocked) return deny({ result: "match", reason: SANCTIONS_MATCH, persisted: true });
        const decision = guardDecision(snapshot, normalized);
        if (decision.result !== "clear") return deny(decision);
        return allowUnverified(decision);
      } catch (error) {
        return refused(error);
      }
    },
    async blocks(wallet) {
      try {
        if (!pepper) return true;
        const normalized = normalizeSanctionsAddress(wallet);
        const hash = walletHashHex(pepper, normalized);
        if (!hash) return false;
        const result = await data.call("wallet.blocked", { wallet: normalized, walletHash: hash });
        return result?.blocked === true;
      } catch {
        return true;
      }
    },
    async release(wallet, actor) {
      const normalized = normalizeSanctionsAddress(wallet);
      const hash = walletHashHex(pepper, normalized);
      const at = now();
      const listVersion = snapshot?.listVersion == null ? null : String(snapshot.listVersion);
      const actorId = releaseActor(actor);
      if (!normalized || !hash) return { ok: false, http: 403, error: "release_refused" };
      const ready = snapshot?.listReady === true && snapshot.addresses instanceof Set;
      const listed = ready && snapshot.addresses.has(normalized);
      const outcome = !ready || listed ? (listed ? "refused_match" : "refused_unavailable") : "released";
      await data.call("release", {
        outcome,
        wallet: normalized,
        walletHash: hash,
        listVersion,
        at,
        actor: actorId,
      });
      if (outcome !== "released") return { ok: false, http: 403, error: "release_refused" };
      if (snapshot.persisted instanceof Set) snapshot.persisted.delete(normalized);
      if (snapshot.memo instanceof Map) snapshot.memo.delete(normalized);
      return { ok: true, http: 200 };
    },
    async issueNonce() {
      const at = now();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const nonce = randomNonce();
        try {
          return await data.call("nonce.issue", {
            nonce,
            expiresAt: at + SCREEN_MAX_AGE_MS,
            now: at,
          });
        } catch (error) {
          if (error?.code !== "conflict") throw error;
        }
      }
      throw new Error("nonce");
    },
    verifyScreen(action, body, sessionToken, overrides = {}) {
      return verifyScreenProof({
        purge(at) {
          return data.call("session.read", { now: at });
        },
        async accountHasWallets(accountId) {
          const result = await data.call("linked.list", { accountId });
          return result?.hasWallet === true;
        },
        async readSession(token, at) {
          if (!token) return null;
          const result = await data.call("session.read", { tokenHash: sha256Utf8(String(token)), now: at });
          const row = result?.session;
          if (!row || Number(row.expires_at) <= at) return null;
          return { accountId: String(row.account_id), walletHash: String(row.wallet_hash) };
        },
        async consumeNonce(nonce, at) {
          const result = await data.call("nonce.consume", { nonce: String(nonce || ""), now: at });
          return result?.consumed === true;
        },
      }, {
        action,
        message: body?.message,
        signature: body?.signature,
        sessionToken,
        domain: overrides.domain || options.siweDomain || "agent-bv.pages.dev",
        chainId: overrides.chainId || options.chainId || 84532,
        now: now(),
      });
    },
    async sessionFor(accountId, wallet) {
      const hash = walletHashHex(pepper, wallet);
      if (!hash) return "";
      const token = tokenText();
      const at = now();
      await data.call("session.create", {
        tokenHash: sha256Utf8(token),
        accountId: String(accountId),
        walletHash: hash,
        expiresAt: at + SCREEN_SESSION_MS,
        now: at,
      });
      return token;
    },
    async dropTie(accountId, wallet, actor) {
      const actorId = releaseActor(actor);
      const at = now();
      let id = "";
      try {
        id = requireAccount({ accountId });
      } catch {
        id = "";
      }
      const normalized = normalizeSanctionsAddress(wallet);
      const hash = walletHashHex(pepper, normalized);
      if (!actorId || !id || !normalized || !hash) return { ok: false, http: 403, error: "untie_refused" };
      const result = await data.call("tie.drop", { accountId: id, walletHash: hash, at, actor: actorId });
      if (result?.outcome !== "untied") return { ok: false, http: 404, error: "untie_absent" };
      if (snapshot?.memo instanceof Map) snapshot.memo.delete(normalized);
      return { ok: true, http: 200 };
    },
    async revokeSession(accountId, actor) {
      const id = String(accountId || "").trim();
      const actorId = String(actor || "").trim();
      const at = now();
      if (!ACTOR_ID.test(actorId) || !ACCOUNT_ID.test(id)) {
        await data.call("sessions.revoke", {
          refused: true,
          accountId: id.slice(0, 80),
          actor: actorId.slice(0, 64),
          at,
        });
        return { ok: false, http: 403, error: "revoke_refused" };
      }
      const result = await data.call("sessions.revoke", { accountId: id, actor: actorId, at, refused: false });
      if (result?.outcome === "revoke_absent") return { ok: false, http: 404, error: "revoke_absent" };
      return { ok: true, http: 200, removed: Number(result?.removed || 0) };
    },
    async purgeRetention(at = now()) {
      const counts = await data.call("retention.purge", {
        clearBefore: at - SANCTIONS_CLEAR_RETENTION_MS,
        matchBefore: at - SANCTIONS_MATCH_RETENTION_MS,
      });
      console.info(JSON.stringify({ message: "sanctions_retention", ...counts, at }));
      return counts;
    },
  };
}
