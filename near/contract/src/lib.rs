//! Agent-BV policy contract (NEAR testnet only).
//!
//! The contract answers one question before an AI agent spends:
//! "may this agent pay this receiver this amount?" and returns
//! `allow`, `warn` or `block` with human-readable reasons.
//!
//! Inputs to the decision:
//! * an owner-managed blocklist (with a reason / evidence string per entry),
//! * a bot attestation outcome recorded per receiver (`pass`, `warn`, `fail`),
//! * a per-agent cumulative spend limit and a per-transaction warn threshold.
//!
//! The contract also holds the (testnet) funds an agent may spend. A registered
//! agent calls `request_payment`; the contract re-runs the same policy on-chain
//! and only transfers on `allow`. On `warn` it parks the payment until the owner
//! (a human) approves it. On `block` it records the attempt and moves nothing.
//! Because the agent signs with a function-call key scoped to this contract, it
//! has no other way to move value: the policy cannot be skipped by a hijacked
//! agent, only by the owner.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

/// Attestation outcome recorded for a receiver (for example, the result of an
/// Agent-BV bot audit). `Warn` means "attested, but with open findings".
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Pass,
    Warn,
    Fail,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attestation {
    pub outcome: Outcome,
    /// Free-form evidence pointer (report hash, URL, short note).
    pub evidence: String,
    /// Block timestamp in nanoseconds when this was recorded.
    pub recorded_at_ns: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Allow,
    Warn,
    Block,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub verdict: Verdict,
    pub reasons: Vec<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentConfig {
    /// Cumulative spend limit in yoctoNEAR.
    pub limit: U128,
    /// Total already paid out for this agent, in yoctoNEAR.
    pub spent: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingPayment {
    pub id: u64,
    pub agent: AccountId,
    pub receiver: AccountId,
    pub amount: U128,
    pub reasons: Vec<String>,
}

/// Result of `request_payment`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentResult {
    pub verdict: Verdict,
    pub reasons: Vec<String>,
    /// `true` only when a transfer was scheduled by this call.
    pub paid: bool,
    /// Set when the payment was parked for human approval.
    pub pending_id: Option<u64>,
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Blocklist,
    Attestations,
    Agents,
    Pending,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Policy {
    owner: AccountId,
    blocklist: IterableMap<AccountId, String>,
    attestations: LookupMap<AccountId, Attestation>,
    agents: IterableMap<AccountId, AgentConfig>,
    pending: IterableMap<u64, PendingPayment>,
    next_pending_id: u64,
    /// Single payments strictly above this amount return `warn`.
    warn_above: U128,
    blocked_attempts: u64,
}

/// Cap on parked payments so a hijacked agent cannot grow storage without bound.
const MAX_PENDING: u32 = 50;

/// Balance kept back for storage staking; payments never dip into it.
const STORAGE_RESERVE: NearToken = NearToken::from_millinear(500);

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({
            "standard": "agent-bv-policy",
            "version": "0.1.0",
            "event": event,
            "data": [data],
        })
    ));
}

#[near]
impl Policy {
    #[init]
    pub fn new(owner: AccountId, warn_above: U128) -> Self {
        Self {
            owner,
            blocklist: IterableMap::new(StorageKey::Blocklist),
            attestations: LookupMap::new(StorageKey::Attestations),
            agents: IterableMap::new(StorageKey::Agents),
            pending: IterableMap::new(StorageKey::Pending),
            next_pending_id: 0,
            warn_above,
            blocked_attempts: 0,
        }
    }

    // ----- owner (human) methods -------------------------------------------

    pub fn add_to_blocklist(&mut self, account: AccountId, reason: String) {
        self.assert_owner();
        require!(reason.len() <= 256, "reason too long");
        emit("blocklist_add", near_sdk::serde_json::json!({ "account": account, "reason": reason }));
        self.blocklist.insert(account, reason);
    }

    pub fn remove_from_blocklist(&mut self, account: AccountId) {
        self.assert_owner();
        if self.blocklist.remove(&account).is_some() {
            emit("blocklist_remove", near_sdk::serde_json::json!({ "account": account }));
        }
    }

    pub fn record_attestation(&mut self, account: AccountId, outcome: Outcome, evidence: String) {
        self.assert_owner();
        require!(evidence.len() <= 256, "evidence too long");
        let att = Attestation { outcome, evidence, recorded_at_ns: env::block_timestamp() };
        emit("attestation", near_sdk::serde_json::json!({ "account": account, "attestation": att }));
        self.attestations.insert(account, att);
    }

    /// Registers an agent (or changes its limit). `spent` is kept.
    pub fn set_agent_limit(&mut self, agent: AccountId, limit: U128) {
        self.assert_owner();
        let spent = self.agents.get(&agent).map(|a| a.spent).unwrap_or(U128(0));
        self.agents.insert(agent.clone(), AgentConfig { limit, spent });
        emit("agent_limit", near_sdk::serde_json::json!({ "agent": agent, "limit": limit }));
    }

    pub fn set_warn_above(&mut self, warn_above: U128) {
        self.assert_owner();
        self.warn_above = warn_above;
    }

    /// Human approval of a parked `warn` payment. Blocking rules are re-checked
    /// at approval time, so a receiver blocklisted in the meantime is refused.
    pub fn approve_pending(&mut self, id: u64) -> PaymentResult {
        self.assert_owner();
        let p = self.pending.remove(&id).unwrap_or_else(|| env::panic_str("no such pending payment"));
        let blocks = self.block_reasons(&p.agent, &p.receiver, p.amount.0);
        if !blocks.is_empty() {
            emit("pending_refused", near_sdk::serde_json::json!({ "id": id, "reasons": blocks }));
            return PaymentResult { verdict: Verdict::Block, reasons: blocks, paid: false, pending_id: Some(id) };
        }
        self.pay(&p.agent, &p.receiver, p.amount.0);
        emit("pending_approved", near_sdk::serde_json::json!({ "id": id }));
        PaymentResult { verdict: Verdict::Allow, reasons: vec!["approved by owner".into()], paid: true, pending_id: Some(id) }
    }

    pub fn reject_pending(&mut self, id: u64) {
        self.assert_owner();
        require!(self.pending.remove(&id).is_some(), "no such pending payment");
        emit("pending_rejected", near_sdk::serde_json::json!({ "id": id }));
    }

    /// Lets the owner top up the spend pool (any attached deposit is kept).
    #[payable]
    pub fn fund(&mut self) {}

    // ----- agent method ----------------------------------------------------

    /// Called by a registered agent with its function-call key. Runs the same
    /// policy as `check` and only transfers on `allow`.
    pub fn request_payment(&mut self, receiver: AccountId, amount: U128) -> PaymentResult {
        let agent = env::predecessor_account_id();
        let d = self.check(agent.clone(), receiver.clone(), amount);
        match d.verdict {
            Verdict::Block => {
                self.blocked_attempts += 1;
                emit(
                    "payment_blocked",
                    near_sdk::serde_json::json!({ "agent": agent, "receiver": receiver, "amount": amount, "reasons": d.reasons }),
                );
                PaymentResult { verdict: Verdict::Block, reasons: d.reasons, paid: false, pending_id: None }
            }
            Verdict::Warn if self.pending.len() >= MAX_PENDING => {
                let reasons = vec![format!("too many payments waiting for human approval (max {})", MAX_PENDING)];
                self.blocked_attempts += 1;
                emit("payment_blocked", near_sdk::serde_json::json!({ "agent": agent, "receiver": receiver, "amount": amount, "reasons": reasons }));
                PaymentResult { verdict: Verdict::Block, reasons, paid: false, pending_id: None }
            }
            Verdict::Warn => {
                let id = self.next_pending_id;
                self.next_pending_id += 1;
                self.pending.insert(
                    id,
                    PendingPayment { id, agent: agent.clone(), receiver: receiver.clone(), amount, reasons: d.reasons.clone() },
                );
                emit(
                    "payment_pending",
                    near_sdk::serde_json::json!({ "id": id, "agent": agent, "receiver": receiver, "amount": amount, "reasons": d.reasons }),
                );
                PaymentResult { verdict: Verdict::Warn, reasons: d.reasons, paid: false, pending_id: Some(id) }
            }
            Verdict::Allow => {
                self.pay(&agent, &receiver, amount.0);
                emit("payment_allowed", near_sdk::serde_json::json!({ "agent": agent, "receiver": receiver, "amount": amount }));
                PaymentResult { verdict: Verdict::Allow, reasons: d.reasons, paid: true, pending_id: None }
            }
        }
    }

    // ----- views -------------------------------------------------------------

    /// The policy decision for `agent` paying `receiver` `amount` yoctoNEAR.
    pub fn check(&self, agent: AccountId, receiver: AccountId, amount: U128) -> Decision {
        let blocks = self.block_reasons(&agent, &receiver, amount.0);
        if !blocks.is_empty() {
            return Decision { verdict: Verdict::Block, reasons: blocks };
        }
        let mut warns = Vec::new();
        match self.attestations.get(&receiver) {
            None => warns.push("receiver has no bot attestation on record".to_string()),
            Some(a) if a.outcome == Outcome::Warn => {
                warns.push(format!("receiver attestation is warn: {}", a.evidence))
            }
            _ => {}
        }
        if amount.0 > self.warn_above.0 {
            warns.push(format!("amount {} yoctoNEAR is above the warn threshold {}", amount.0, self.warn_above.0));
        }
        if warns.is_empty() {
            Decision { verdict: Verdict::Allow, reasons: vec!["receiver attested pass, not blocklisted, within limit".into()] }
        } else {
            Decision { verdict: Verdict::Warn, reasons: warns }
        }
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn get_attestation(&self, account: AccountId) -> Option<Attestation> {
        self.attestations.get(&account).cloned()
    }

    pub fn get_blocklist(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<(AccountId, String)> {
        self.blocklist
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    pub fn get_agent(&self, agent: AccountId) -> Option<AgentConfig> {
        self.agents.get(&agent).cloned()
    }

    pub fn get_pending(&self) -> Vec<PendingPayment> {
        self.pending.values().take(100).cloned().collect()
    }

    pub fn get_warn_above(&self) -> U128 {
        self.warn_above
    }

    pub fn get_blocked_attempts(&self) -> u64 {
        self.blocked_attempts
    }

    /// Spendable pool in yoctoNEAR (balance minus the storage reserve).
    pub fn get_pool(&self) -> U128 {
        U128(self.pool())
    }

    // ----- internal ----------------------------------------------------------

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can do this");
    }

    fn pool(&self) -> u128 {
        let storage_cost = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        env::account_balance()
            .as_yoctonear()
            .saturating_sub(storage_cost)
            .saturating_sub(STORAGE_RESERVE.as_yoctonear())
    }

    fn block_reasons(&self, agent: &AccountId, receiver: &AccountId, amount: u128) -> Vec<String> {
        let mut r = Vec::new();
        if let Some(reason) = self.blocklist.get(receiver) {
            r.push(format!("receiver is on the blocklist: {}", reason));
        }
        if let Some(a) = self.attestations.get(receiver) {
            if a.outcome == Outcome::Fail {
                r.push(format!("receiver failed bot attestation: {}", a.evidence));
            }
        }
        if amount == 0 {
            r.push("amount must be greater than zero".into());
        }
        if receiver == agent || *receiver == env::current_account_id() {
            r.push("receiver must not be the agent or the policy contract".into());
        }
        match self.agents.get(agent) {
            None => r.push("agent is not registered with this policy".into()),
            Some(cfg) => {
                let after = cfg.spent.0.saturating_add(amount);
                if after > cfg.limit.0 {
                    r.push(format!(
                        "spend limit exceeded: spent {} + {} > limit {} yoctoNEAR",
                        cfg.spent.0, amount, cfg.limit.0
                    ));
                }
            }
        }
        if amount > self.pool() {
            r.push("policy pool has insufficient funds".into());
        }
        r
    }

    fn pay(&mut self, agent: &AccountId, receiver: &AccountId, amount: u128) {
        let mut cfg = self.agents.get(agent).cloned().expect("agent checked above");
        cfg.spent = U128(cfg.spent.0 + amount);
        self.agents.insert(agent.clone(), cfg);
        Promise::new(receiver.clone()).transfer(NearToken::from_yoctonear(amount)).detach();
    }
}

#[cfg(test)]
mod tests;
