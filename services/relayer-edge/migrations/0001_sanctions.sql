CREATE TABLE IF NOT EXISTS sanctions_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1), fetched_at INTEGER, source TEXT, list_version TEXT,
  addresses_json TEXT, addresses_sha256 TEXT, raw_sha256 TEXT);
CREATE TABLE IF NOT EXISTS sanctions_wallets (
  wallet TEXT PRIMARY KEY, wallet_hash TEXT, reason TEXT NOT NULL, checked_at INTEGER NOT NULL, list_version TEXT);
CREATE TABLE IF NOT EXISTS sanctions_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, wallet_hash TEXT NOT NULL, result TEXT NOT NULL, reason TEXT NOT NULL,
  checked_at INTEGER NOT NULL, list_version TEXT, list_sha256 TEXT, source TEXT, persisted INTEGER NOT NULL,
  chain_id INTEGER, decision_point TEXT);
CREATE TABLE IF NOT EXISTS sanctions_account_wallets (
  account_id TEXT NOT NULL, wallet_hash TEXT NOT NULL, wallet_sealed TEXT NOT NULL, linked_at INTEGER NOT NULL,
  unlinked_at INTEGER, PRIMARY KEY (account_id, wallet_hash));
CREATE TABLE IF NOT EXISTS sanctions_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, wallet_hash TEXT NOT NULL, reason TEXT NOT NULL,
  blocked_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sanctions_disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, wallet_hash TEXT NOT NULL, opened_at INTEGER NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sanctions_release_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, wallet_hash TEXT NOT NULL, outcome TEXT NOT NULL, list_version TEXT,
  released_at INTEGER NOT NULL, actor TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS screen_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE IF NOT EXISTS screen_sessions (
  token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, wallet_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sanctions_session_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, outcome TEXT NOT NULL, acted_at INTEGER NOT NULL,
  actor TEXT NOT NULL, removed INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sanctions_tie_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, wallet_hash TEXT NOT NULL, outcome TEXT NOT NULL,
  acted_at INTEGER NOT NULL, actor TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS relayer_data_nonces (nonce TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);

-- Append-only audit tables (same as sanctions.mjs:131-187)
CREATE TRIGGER IF NOT EXISTS sanctions_release_audit_no_update BEFORE UPDATE ON sanctions_release_audit
BEGIN SELECT RAISE(ABORT, 'sanctions_release_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS sanctions_release_audit_no_delete BEFORE DELETE ON sanctions_release_audit
BEGIN SELECT RAISE(ABORT, 'sanctions_release_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS sanctions_session_audit_no_update BEFORE UPDATE ON sanctions_session_audit
BEGIN SELECT RAISE(ABORT, 'sanctions_session_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS sanctions_session_audit_no_delete BEFORE DELETE ON sanctions_session_audit
BEGIN SELECT RAISE(ABORT, 'sanctions_session_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS sanctions_tie_audit_no_update BEFORE UPDATE ON sanctions_tie_audit
BEGIN SELECT RAISE(ABORT, 'sanctions_tie_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS sanctions_tie_audit_no_delete BEFORE DELETE ON sanctions_tie_audit
BEGIN SELECT RAISE(ABORT, 'sanctions_tie_audit is append-only'); END;

-- Indexes for the retention purge and lookups (minimal: each adds a row written)
CREATE INDEX IF NOT EXISTS idx_checks_result_at ON sanctions_checks(result, checked_at);
CREATE INDEX IF NOT EXISTS idx_wallets_hash ON sanctions_wallets(wallet_hash);
CREATE INDEX IF NOT EXISTS idx_wallets_at ON sanctions_wallets(checked_at);
CREATE INDEX IF NOT EXISTS idx_acct_wallets_hash ON sanctions_account_wallets(wallet_hash);
CREATE INDEX IF NOT EXISTS idx_blocks_account ON sanctions_blocks(account_id);
CREATE INDEX IF NOT EXISTS idx_blocks_at ON sanctions_blocks(blocked_at);
CREATE INDEX IF NOT EXISTS idx_disputes_at ON sanctions_disputes(opened_at);
CREATE INDEX IF NOT EXISTS idx_screen_nonces_exp ON screen_nonces(expires_at);
CREATE INDEX IF NOT EXISTS idx_screen_sessions_exp ON screen_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_screen_sessions_acct ON screen_sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_data_nonces_at ON relayer_data_nonces(seen_at);
