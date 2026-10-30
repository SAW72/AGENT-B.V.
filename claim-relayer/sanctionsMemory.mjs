// In-memory stand-in for the Worker ops. Tests inject this. Production uses sanctionsData.mjs.
// The points indexer does not import this file.

function emptyState() {
  return {
    cache: null,
    wallets: [],
    checks: [],
    links: [],
    blocks: [],
    disputes: [],
    releaseAudit: [],
    tieAudit: [],
    sessionAudit: [],
    nonces: [],
    sessions: [],
    applied: true,
  };
}

function stillMatched(state, accountId) {
  const hashes = state.links.filter((row) => row.account_id === accountId).map((row) => row.wallet_hash);
  return state.wallets.some((row) => hashes.includes(row.wallet_hash));
}

function accountBlocked(state, accountId) {
  if (stillMatched(state, accountId)) return true;
  return state.blocks.some((row) => row.account_id === accountId);
}

function walletBlocked(state, wallet, walletHash) {
  if (wallet && state.wallets.some((row) => row.wallet === wallet)) return true;
  if (!walletHash) return false;
  const accounts = state.links.filter((row) => row.wallet_hash === walletHash).map((row) => row.account_id);
  for (const accountId of accounts) {
    const hashes = state.links.filter((row) => row.account_id === accountId).map((row) => row.wallet_hash);
    if (state.wallets.some((row) => hashes.includes(row.wallet_hash))) return true;
    if (state.blocks.some((row) => row.account_id === accountId)) return true;
  }
  return false;
}

function upsertLink(state, accountId, link) {
  const existing = state.links.find((row) => row.account_id === accountId && row.wallet_hash === link.walletHash);
  if (existing) {
    existing.wallet_sealed = link.walletSealed;
    existing.unlinked_at = null;
    return;
  }
  state.links.push({
    account_id: accountId,
    wallet_hash: link.walletHash,
    wallet_sealed: link.walletSealed,
    linked_at: link.linkedAt,
    unlinked_at: null,
  });
}

function pushCheck(state, check) {
  state.checks.push({
    wallet_hash: check.walletHash,
    result: check.result,
    reason: check.reason,
    checked_at: check.checkedAt,
    list_version: check.listVersion ?? null,
    list_sha256: check.listSha256 ?? null,
    source: check.source ?? null,
    persisted: check.persisted,
    chain_id: check.chainId ?? null,
    decision_point: check.decisionPoint ?? null,
  });
}

function pushWallet(state, wallet) {
  if (!wallet) return;
  if (state.wallets.some((row) => row.wallet === wallet.wallet)) return;
  state.wallets.push({
    wallet: wallet.wallet,
    wallet_hash: wallet.walletHash,
    reason: wallet.reason,
    checked_at: wallet.checkedAt,
    list_version: wallet.listVersion ?? null,
  });
}

function purgeScreen(state, now) {
  state.nonces = state.nonces.filter((row) => Number(row.expires_at) > now);
  state.sessions = state.sessions.filter((row) => Number(row.expires_at) > now);
}

function accountWrite(state, body, policy) {
  pushCheck(state, body.check);
  pushWallet(state, body.wallet);
  const blocked = accountBlocked(state, body.accountId);
  if (body.link && (policy === "always" || !blocked)) upsertLink(state, body.accountId, body.link);
  return { blocked };
}

export function createMemorySanctionsData() {
  const state = emptyState();

  async function call(op, body = {}) {
    if (op === "health") return { applied: state.applied === true, name: state.applied ? "0001_sanctions.sql" : null };
    if (op === "check.record") {
      pushCheck(state, body.check);
      if (body.storeWallet) {
        pushWallet(state, {
          wallet: body.wallet,
          walletHash: body.walletHash || body.check.walletHash,
          reason: body.check.reason,
          checkedAt: body.check.checkedAt,
          listVersion: body.check.listVersion,
        });
      }
      return { blocked: walletBlocked(state, body.wallet || "", body.walletHash || "") };
    }
    if (op === "wallet.blocked") {
      return { blocked: walletBlocked(state, body.wallet || "", body.walletHash || "") };
    }
    if (op === "snapshot.load" || op === "cache.read") {
      return {
        cache: state.cache,
        wallets: state.wallets.map((row) => ({ wallet: row.wallet, wallet_hash: row.wallet_hash })),
      };
    }
    if (op === "cache.swap") {
      state.cache = {
        fetched_at: body.fetchedAt,
        source: body.source ?? null,
        list_version: body.listVersion ?? null,
        addresses_json: body.addressesJson,
        addresses_sha256: body.addressesSha256,
        raw_sha256: body.rawSha256,
      };
      return { stored: "full" };
    }
    if (op === "account.signup") return accountWrite(state, body, "if_unblocked");
    if (op === "account.link" || op === "account.change") return accountWrite(state, body, "always");
    if (op === "account.unlink") {
      const row = state.links.find((item) => item.account_id === body.accountId && item.wallet_hash === body.walletHash);
      if (row) row.unlinked_at = body.unlinkedAt;
      const blocked = accountBlocked(state, body.accountId) || walletBlocked(state, body.wallet || "", body.walletHash);
      return { blocked };
    }
    if (op === "linked.list") {
      if (body.accountId != null) {
        return {
          hasWallet: state.links.some((row) => row.account_id === body.accountId),
          rows: [],
        };
      }
      return {
        hasWallet: false,
        rows: state.links.map((row) => ({
          account_id: row.account_id,
          wallet_hash: row.wallet_hash,
          wallet_sealed: row.wallet_sealed,
        })),
      };
    }
    if (op === "blocks.insert") {
      for (const check of body.checks || []) pushCheck(state, check);
      for (const wallet of body.wallets || []) pushWallet(state, wallet);
      for (const block of body.blocks || []) {
        state.blocks.push({
          account_id: block.accountId,
          wallet_hash: block.walletHash,
          reason: block.reason,
          blocked_at: block.blockedAt,
        });
      }
      return { inserted: (body.checks || []).length + (body.wallets || []).length + (body.blocks || []).length };
    }
    if (op === "release") {
      if (body.outcome === "released") {
        state.wallets = state.wallets.filter((row) => row.wallet !== body.wallet);
        const accounts = [...new Set(state.links.filter((row) => row.wallet_hash === body.walletHash).map((row) => row.account_id))];
        for (const accountId of accounts) {
          if (!stillMatched(state, accountId)) {
            state.blocks = state.blocks.filter((row) => row.account_id !== accountId);
          }
        }
      }
      state.releaseAudit.push({
        wallet_hash: body.walletHash,
        outcome: body.outcome,
        list_version: body.listVersion ?? null,
        released_at: body.at,
        actor: body.actor || "",
      });
      return { outcome: body.outcome };
    }
    if (op === "tie.drop") {
      const exists = state.links.some((row) => row.account_id === body.accountId && row.wallet_hash === body.walletHash);
      const outcome = exists ? "untied" : "untie_absent";
      state.tieAudit.push({
        account_id: body.accountId,
        wallet_hash: body.walletHash,
        outcome,
        acted_at: body.at,
        actor: body.actor,
      });
      if (exists) {
        state.links = state.links.filter((row) => !(row.account_id === body.accountId && row.wallet_hash === body.walletHash));
        if (!stillMatched(state, body.accountId)) {
          state.blocks = state.blocks.filter((row) => row.account_id !== body.accountId);
        }
      }
      return { outcome };
    }
    if (op === "sessions.revoke") {
      if (body.refused === true) {
        state.sessionAudit.push({
          account_id: String(body.accountId || "").slice(0, 80),
          outcome: "revoke_refused",
          acted_at: body.at,
          actor: String(body.actor || "").slice(0, 64),
          removed: 0,
        });
        return { outcome: "revoke_refused", removed: 0 };
      }
      purgeScreen(state, body.at);
      const removed = state.sessions.filter((row) => row.account_id === body.accountId).length;
      const outcome = removed === 0 ? "revoke_absent" : "revoked";
      state.sessionAudit.push({
        account_id: body.accountId,
        outcome,
        acted_at: body.at,
        actor: body.actor,
        removed,
      });
      state.sessions = state.sessions.filter((row) => row.account_id !== body.accountId);
      return { outcome, removed };
    }
    if (op === "nonce.issue") {
      purgeScreen(state, body.now);
      if (state.nonces.some((row) => row.nonce === body.nonce)) {
        const error = new Error("conflict");
        error.code = "conflict";
        error.status = 409;
        throw error;
      }
      state.nonces.push({ nonce: body.nonce, expires_at: body.expiresAt, used_at: null });
      return { nonce: body.nonce, expiresAt: body.expiresAt };
    }
    if (op === "nonce.consume") {
      purgeScreen(state, body.now);
      const row = state.nonces.find((item) => item.nonce === body.nonce && item.used_at == null && Number(item.expires_at) > body.now);
      if (!row) return { consumed: false };
      row.used_at = body.now;
      return { consumed: true };
    }
    if (op === "session.create") {
      purgeScreen(state, body.now);
      state.sessions.push({
        token_hash: body.tokenHash,
        account_id: body.accountId,
        wallet_hash: body.walletHash,
        expires_at: body.expiresAt,
      });
      return { created: true };
    }
    if (op === "session.read") {
      purgeScreen(state, body.now);
      if (!body.tokenHash) return { session: null };
      const row = state.sessions.find((item) => item.token_hash === body.tokenHash) || null;
      return { session: row };
    }
    if (op === "retention.purge") {
      const drop = (rows, keep) => {
        const next = rows.filter(keep);
        return { next, changes: rows.length - next.length };
      };
      const cleared = drop(state.checks, (row) => !(row.result === "clear" && row.checked_at < body.clearBefore));
      state.checks = cleared.next;
      const unavailable = drop(state.checks, (row) => !(row.result === "unavailable" && row.checked_at < body.clearBefore));
      state.checks = unavailable.next;
      const matches = drop(state.checks, (row) => !(row.result === "match" && row.checked_at < body.matchBefore));
      state.checks = matches.next;
      const blocks = drop(state.blocks, (row) => !(row.blocked_at < body.matchBefore));
      state.blocks = blocks.next;
      const wallets = drop(state.wallets, (row) => !(row.checked_at < body.matchBefore));
      state.wallets = wallets.next;
      const disputes = drop(state.disputes, (row) => !(row.opened_at < body.matchBefore));
      state.disputes = disputes.next;
      return {
        cleared: cleared.changes,
        unavailable: unavailable.changes,
        matches: matches.changes,
        blocks: blocks.changes + wallets.changes,
        disputes: disputes.changes,
      };
    }
    const error = new Error("not_found");
    error.code = "not_found";
    error.status = 404;
    throw error;
  }

  return { call, state };
}
