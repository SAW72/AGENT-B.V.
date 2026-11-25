use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("policy.testnet"))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .account_balance(NearToken::from_near(10));
    testing_env!(b.build());
}

/// Owner, an agent with a 1 NEAR limit, warn above 0.5 NEAR,
/// `good.testnet` attested pass, `drainer.testnet` blocklisted.
fn setup() -> Policy {
    ctx("owner.testnet");
    let mut p = Policy::new(acc("owner.testnet"), U128(ONE_NEAR / 2));
    p.set_agent_limit(acc("agent.testnet"), U128(ONE_NEAR));
    p.record_attestation(acc("good.testnet"), Outcome::Pass, "audit report sha256:abc".into());
    p.add_to_blocklist(acc("drainer.testnet"), "known drainer, reported 2026-11-11".into());
    p
}

#[test]
fn allow_for_attested_receiver_within_limits() {
    let p = setup();
    let d = p.check(acc("agent.testnet"), acc("good.testnet"), U128(ONE_NEAR / 10));
    assert_eq!(d.verdict, Verdict::Allow);
}

#[test]
fn block_for_blocklisted_receiver() {
    let p = setup();
    let d = p.check(acc("agent.testnet"), acc("drainer.testnet"), U128(1));
    assert_eq!(d.verdict, Verdict::Block);
    assert!(d.reasons[0].contains("blocklist"));
    assert!(d.reasons[0].contains("known drainer"));
}

#[test]
fn block_for_failed_attestation() {
    let mut p = setup();
    p.record_attestation(acc("badbot.testnet"), Outcome::Fail, "prompt-injection exfil".into());
    let d = p.check(acc("agent.testnet"), acc("badbot.testnet"), U128(1));
    assert_eq!(d.verdict, Verdict::Block);
    assert!(d.reasons.iter().any(|r| r.contains("failed bot attestation")));
}

#[test]
fn warn_for_unattested_receiver() {
    let p = setup();
    let d = p.check(acc("agent.testnet"), acc("unknown.testnet"), U128(1));
    assert_eq!(d.verdict, Verdict::Warn);
    assert!(d.reasons[0].contains("no bot attestation"));
}

#[test]
fn warn_for_attestation_warn() {
    let mut p = setup();
    p.record_attestation(acc("meh.testnet"), Outcome::Warn, "2 open medium findings".into());
    let d = p.check(acc("agent.testnet"), acc("meh.testnet"), U128(1));
    assert_eq!(d.verdict, Verdict::Warn);
}

#[test]
fn warn_above_threshold() {
    let p = setup();
    let d = p.check(acc("agent.testnet"), acc("good.testnet"), U128(ONE_NEAR / 2 + 1));
    assert_eq!(d.verdict, Verdict::Warn);
    assert!(d.reasons[0].contains("warn threshold"));
}

#[test]
fn block_over_spend_limit() {
    let p = setup();
    let d = p.check(acc("agent.testnet"), acc("good.testnet"), U128(ONE_NEAR + 1));
    assert_eq!(d.verdict, Verdict::Block);
    assert!(d.reasons.iter().any(|r| r.contains("spend limit")));
}

#[test]
fn block_unregistered_agent() {
    let p = setup();
    let d = p.check(acc("stranger.testnet"), acc("good.testnet"), U128(1));
    assert_eq!(d.verdict, Verdict::Block);
    assert!(d.reasons.iter().any(|r| r.contains("not registered")));
}

#[test]
fn block_zero_amount_and_self_pay() {
    let p = setup();
    assert_eq!(p.check(acc("agent.testnet"), acc("good.testnet"), U128(0)).verdict, Verdict::Block);
    assert_eq!(p.check(acc("agent.testnet"), acc("agent.testnet"), U128(1)).verdict, Verdict::Block);
    assert_eq!(p.check(acc("agent.testnet"), acc("policy.testnet"), U128(1)).verdict, Verdict::Block);
}

#[test]
fn blocklist_beats_pass_attestation() {
    let mut p = setup();
    p.add_to_blocklist(acc("good.testnet"), "compromised".into());
    assert_eq!(p.check(acc("agent.testnet"), acc("good.testnet"), U128(1)).verdict, Verdict::Block);
    p.remove_from_blocklist(acc("good.testnet"));
    assert_eq!(p.check(acc("agent.testnet"), acc("good.testnet"), U128(1)).verdict, Verdict::Allow);
}

#[test]
fn request_payment_block_moves_nothing() {
    let mut p = setup();
    ctx("agent.testnet");
    let r = p.request_payment(acc("drainer.testnet"), U128(ONE_NEAR / 10));
    assert_eq!(r.verdict, Verdict::Block);
    assert!(!r.paid);
    assert_eq!(p.get_agent(acc("agent.testnet")).unwrap().spent, U128(0));
    assert_eq!(p.get_blocked_attempts(), 1);
    assert!(get_logs().iter().any(|l| l.contains("payment_blocked")));
}

#[test]
fn request_payment_allow_counts_spend() {
    let mut p = setup();
    ctx("agent.testnet");
    let r = p.request_payment(acc("good.testnet"), U128(ONE_NEAR / 10));
    assert_eq!(r.verdict, Verdict::Allow);
    assert!(r.paid);
    assert_eq!(p.get_agent(acc("agent.testnet")).unwrap().spent, U128(ONE_NEAR / 10));
}

#[test]
fn cumulative_limit_blocks_later_payment() {
    let mut p = setup();
    ctx("agent.testnet");
    for _ in 0..2 {
        assert!(p.request_payment(acc("good.testnet"), U128(ONE_NEAR * 4 / 10)).paid);
    }
    let r = p.request_payment(acc("good.testnet"), U128(ONE_NEAR * 4 / 10));
    assert_eq!(r.verdict, Verdict::Block);
    assert!(r.reasons.iter().any(|x| x.contains("spend limit")));
}

#[test]
fn warn_parks_payment_until_owner_approves() {
    let mut p = setup();
    ctx("agent.testnet");
    let r = p.request_payment(acc("unknown.testnet"), U128(ONE_NEAR / 10));
    assert_eq!(r.verdict, Verdict::Warn);
    assert!(!r.paid);
    let id = r.pending_id.unwrap();
    assert_eq!(p.get_pending().len(), 1);
    assert_eq!(p.get_agent(acc("agent.testnet")).unwrap().spent, U128(0));
    ctx("owner.testnet");
    let a = p.approve_pending(id);
    assert!(a.paid);
    assert!(p.get_pending().is_empty());
    assert_eq!(p.get_agent(acc("agent.testnet")).unwrap().spent, U128(ONE_NEAR / 10));
}

#[test]
fn approval_rechecks_blocklist() {
    let mut p = setup();
    ctx("agent.testnet");
    let id = p.request_payment(acc("unknown.testnet"), U128(1)).pending_id.unwrap();
    ctx("owner.testnet");
    p.add_to_blocklist(acc("unknown.testnet"), "reported after request".into());
    let a = p.approve_pending(id);
    assert_eq!(a.verdict, Verdict::Block);
    assert!(!a.paid);
}

#[test]
fn reject_pending_removes_it() {
    let mut p = setup();
    ctx("agent.testnet");
    let id = p.request_payment(acc("unknown.testnet"), U128(1)).pending_id.unwrap();
    ctx("owner.testnet");
    p.reject_pending(id);
    assert!(p.get_pending().is_empty());
}

#[test]
fn pending_queue_is_capped() {
    let mut p = setup();
    ctx("agent.testnet");
    for _ in 0..MAX_PENDING {
        assert_eq!(p.request_payment(acc("unknown.testnet"), U128(1)).verdict, Verdict::Warn);
    }
    let r = p.request_payment(acc("unknown.testnet"), U128(1));
    assert_eq!(r.verdict, Verdict::Block);
    assert!(r.reasons[0].contains("too many payments"));
}

#[test]
#[should_panic(expected = "only the owner")]
fn agent_cannot_edit_blocklist() {
    let mut p = setup();
    ctx("agent.testnet");
    p.remove_from_blocklist(acc("drainer.testnet"));
}

#[test]
#[should_panic(expected = "only the owner")]
fn agent_cannot_record_attestation() {
    let mut p = setup();
    ctx("agent.testnet");
    p.record_attestation(acc("drainer.testnet"), Outcome::Pass, "trust me".into());
}

#[test]
#[should_panic(expected = "only the owner")]
fn agent_cannot_raise_own_limit() {
    let mut p = setup();
    ctx("agent.testnet");
    p.set_agent_limit(acc("agent.testnet"), U128(u128::MAX));
}

#[test]
#[should_panic(expected = "only the owner")]
fn agent_cannot_approve_own_pending() {
    let mut p = setup();
    ctx("agent.testnet");
    let id = p.request_payment(acc("unknown.testnet"), U128(1)).pending_id.unwrap();
    p.approve_pending(id);
}

#[test]
fn insufficient_pool_blocks() {
    let p = setup();
    // balance is 10 NEAR; limit is 1 NEAR so raise it to test the pool check
    let mut p = p;
    p.set_agent_limit(acc("agent.testnet"), U128(100 * ONE_NEAR));
    let d = p.check(acc("agent.testnet"), acc("good.testnet"), U128(10 * ONE_NEAR));
    assert_eq!(d.verdict, Verdict::Block);
    assert!(d.reasons.iter().any(|r| r.contains("insufficient funds")));
}

#[test]
fn views_return_state() {
    let p = setup();
    assert_eq!(p.get_owner(), acc("owner.testnet"));
    assert_eq!(p.get_attestation(acc("good.testnet")).unwrap().outcome, Outcome::Pass);
    assert!(p.get_attestation(acc("nobody.testnet")).is_none());
    let bl = p.get_blocklist(None, None);
    assert_eq!(bl.len(), 1);
    assert_eq!(bl[0].0, acc("drainer.testnet"));
    assert_eq!(p.get_warn_above(), U128(ONE_NEAR / 2));
}
