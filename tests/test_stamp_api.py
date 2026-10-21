from fastapi.testclient import TestClient
import pytest

from api.stamp_api import HISTORY, REGISTRY, DENYLIST, app
from pipeline.security import canonical_fingerprint_hash

OPERATOR_KEY = "test-operator-key"


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    REGISTRY.clear()
    DENYLIST.clear()
    HISTORY.clear()
    monkeypatch.setenv("STAMP_API_KEY", OPERATOR_KEY)
    monkeypatch.delenv("ALLOW_KEYWORD_ATTESTATION", raising=False)
    yield
    REGISTRY.clear()
    DENYLIST.clear()
    HISTORY.clear()


def _client() -> TestClient:
    return TestClient(app)


def _auth(**extra):
    headers = {"X-API-Key": OPERATOR_KEY}
    headers.update(extra)
    return headers


def _register_body(bot_id="bot-1", fingerprint=None, **extra):
    fp = fingerprint if fingerprint is not None else {"honesty": 1}
    body = {
        "bot_id": bot_id,
        "fingerprint": fp,
        "fingerprint_hash": canonical_fingerprint_hash(fp),
        "tier": 1,
    }
    body.update(extra)
    return body


def test_health():
    c = _client()
    body = c.get("/health").json()
    assert body["ok"] is True
    assert body["privileged_writes"] == "configured"


def _assert_no_insurance_field_keys(node):
    """Live JSON must not use 'insurance' as a field key for the backstop tier."""
    if isinstance(node, dict):
        for key, value in node.items():
            assert "insurance" not in str(key).lower()
            _assert_no_insurance_field_keys(value)
    elif isinstance(node, list):
        for item in node:
            _assert_no_insurance_field_keys(item)


def test_register_and_stamp():
    c = _client()
    body = _register_body()
    r = c.post("/v1/bots", json=body, headers=_auth())
    assert r.status_code == 200
    stamp = c.get("/v1/bots/bot-1/stamp").json()
    assert stamp["bot_id"] == "bot-1"
    assert stamp["denylist_status"] == "clean"
    assert stamp["claims_backstop_tier"] == "standard"
    assert "insurance_level" not in stamp
    _assert_no_insurance_field_keys(stamp)
    assert stamp["attestation_grade"] is True
    assert stamp["scoring_mode"] == "software"
    assert "scorer_note" not in stamp
    assert "not a certification" in stamp["disclaimer"].lower()
    assert "not_insurance" in stamp["limitations"]
    assert stamp["attestation_status"] == "stub_not_hardware_attested"
    assert stamp["legal_ref"] == "/v1/disclaimer"
    record = c.get("/v1/bots/bot-1").json()
    assert record["claims_backstop_tier"] == "standard"
    _assert_no_insurance_field_keys(record)


def test_claims_backstop_tier_round_trip():
    c = _client()
    body = _register_body("bot-backstop", claims_backstop_tier="elevated")
    r = c.post("/v1/bots", json=body, headers=_auth())
    assert r.status_code == 200
    registered = r.json()
    assert registered["stamp"]["claims_backstop_tier"] == "elevated"
    _assert_no_insurance_field_keys(registered)
    stamp = c.get("/v1/bots/bot-backstop/stamp").json()
    assert stamp["claims_backstop_tier"] == "elevated"
    assert "insurance_level" not in stamp


def test_disclaimer_endpoint():
    c = _client()
    r = c.get("/v1/disclaimer")
    assert r.status_code == 200
    body = r.json()
    assert "experimental" in body["disclaimer"].lower()
    assert body["attestation_live"] is False
    assert body["contracts_firm_audited"] is False
    assert body["mode"] == "demo_in_memory"


def test_financial_blocked_on_low_tier():
    c = _client()
    c.post("/v1/bots", json=_register_body("bot-2", fingerprint={}), headers=_auth())
    r = c.post("/v1/access/check", json={
        "bot_id": "bot-2",
        "requested_permissions": ["transfer"],
    })
    payload = r.json()
    assert payload["allowed"] is False
    assert "disclaimer" in payload
    assert "not insurance" in payload["disclaimer"].lower()


def test_privileged_register_rejects_unauthenticated():
    c = _client()
    r = c.post("/v1/bots", json=_register_body())
    assert r.status_code == 401
    assert r.json()["detail"] == "unauthorized"


def test_privileged_register_rejects_wrong_key():
    c = _client()
    r = c.post("/v1/bots", json=_register_body(), headers={"X-API-Key": "nope"})
    assert r.status_code == 401


def test_privileged_denylist_rejects_unauthenticated():
    c = _client()
    r = c.post("/v1/denylist/abc")
    assert r.status_code == 401


def test_privileged_writes_fail_closed_without_configured_key(monkeypatch):
    monkeypatch.delenv("STAMP_API_KEY", raising=False)
    c = _client()
    r = c.post("/v1/bots", json=_register_body(), headers=_auth())
    assert r.status_code == 503
    assert "STAMP_API_KEY" in r.json()["detail"]


def test_public_reads_do_not_need_auth():
    c = _client()
    assert c.get("/health").status_code == 200
    c.post("/v1/bots", json=_register_body(), headers=_auth())
    assert c.get("/v1/bots/bot-1").status_code == 200
    assert c.get("/v1/bots/bot-1/stamp").status_code == 200
    assert c.get("/v1/denylist/abc").status_code == 200
    assert c.post("/v1/access/check", json={"bot_id": "bot-1"}).status_code == 200


def test_bearer_auth_accepted():
    c = _client()
    r = c.post(
        "/v1/bots",
        json=_register_body(),
        headers={"Authorization": f"Bearer {OPERATOR_KEY}"},
    )
    assert r.status_code == 200


def test_register_rejects_fingerprint_hash_mismatch():
    c = _client()
    body = _register_body()
    body["fingerprint_hash"] = "0" * 64
    r = c.post("/v1/bots", json=body, headers=_auth())
    assert r.status_code == 400
    assert "fingerprint_hash mismatch" in r.json()["detail"]
    assert "bot-1" not in REGISTRY


def test_register_accepts_matching_fingerprint_hash():
    c = _client()
    fp = {"honesty": 2.5, "transparency": 1}
    body = _register_body(fingerprint=fp)
    r = c.post("/v1/bots", json=body, headers=_auth())
    assert r.status_code == 200
    rec = r.json()["stamp"]
    assert rec["fingerprint_hash"] == canonical_fingerprint_hash(fp)


def test_software_attestation_stamp_is_accepted():
    c = _client()
    r = c.post("/v1/bots", json=_register_body(require_attestation=True), headers=_auth())
    assert r.status_code == 200
    stamp = r.json()["stamp"]
    assert stamp["scoring_mode"] == "software"
    assert stamp["attestation_grade"] is True


def test_software_attestation_query_is_accepted():
    c = _client()
    assert c.post("/v1/bots", json=_register_body(), headers=_auth()).status_code == 200
    r = c.get("/v1/bots/bot-1/stamp", params={"attestation": "true"})
    assert r.status_code == 200
    assert r.json()["attestation_grade"] is True


def test_keyword_alias_is_software_judgment(monkeypatch):
    monkeypatch.setenv("ALLOW_KEYWORD_ATTESTATION", "0")
    c = _client()
    r = c.post(
        "/v1/bots",
        json=_register_body(scoring_mode="keyword", require_attestation=True),
        headers=_auth(),
    )
    assert r.status_code == 200
    assert r.json()["stamp"]["scoring_mode"] == "software"
    assert r.json()["stamp"]["attestation_grade"] is True


def test_llm_judge_register_is_guidance_only():
    c = _client()
    r = c.post(
        "/v1/bots",
        json=_register_body(scoring_mode="llm_judge", require_attestation=True),
        headers=_auth(),
    )
    assert r.status_code == 403
    assert "guidance only" in r.json()["detail"]


def test_history_write_requires_auth():
    c = _client()
    c.post("/v1/bots", json=_register_body(), headers=_auth())
    r = c.post("/v1/bots/bot-1/history", json={"kind": "note", "summary": "oops"})
    assert r.status_code == 401
    assert HISTORY["bot-1"] == []


def test_history_append_and_public_read():
    c = _client()
    c.post("/v1/bots", json=_register_body(), headers=_auth())
    r = c.post(
        "/v1/bots/bot-1/history",
        json={"kind": "incident", "summary": "flagged once", "details": {"id": "inc-1"}},
        headers=_auth(),
    )
    assert r.status_code == 200
    listed = c.get("/v1/bots/bot-1/history")
    assert listed.status_code == 200
    assert listed.json()["count"] == 1
    assert listed.json()["entries"][0]["kind"] == "incident"


def test_history_store_rejects_unbounded_or_invalid(monkeypatch):
    monkeypatch.setenv("HISTORY_STORE_MAX_ENTRIES", "1")
    monkeypatch.setenv("HISTORY_STORE_SUMMARY_MAX", "8")
    c = _client()
    c.post("/v1/bots", json=_register_body(), headers=_auth())
    too_long = c.post(
        "/v1/bots/bot-1/history",
        json={"kind": "note", "summary": "this is way too long"},
        headers=_auth(),
    )
    assert too_long.status_code == 400
    ok = c.post(
        "/v1/bots/bot-1/history",
        json={"kind": "note", "summary": "ok-note"},
        headers=_auth(),
    )
    assert ok.status_code == 200
    full = c.post(
        "/v1/bots/bot-1/history",
        json={"kind": "note", "summary": "second"},
        headers=_auth(),
    )
    assert full.status_code == 400
    assert "full" in full.json()["detail"]


def test_denylist_write_with_auth_then_public_read():
    c = _client()
    fp = {"x": 1}
    body = _register_body(fingerprint=fp)
    c.post("/v1/bots", json=body, headers=_auth())
    listed = c.post(f"/v1/denylist/{body['fingerprint_hash']}", headers=_auth())
    assert listed.status_code == 200
    check = c.get(f"/v1/denylist/{body['fingerprint_hash']}")
    assert check.json()["listed"] is True
    access = c.post("/v1/access/check", json={"bot_id": "bot-1", "requested_permissions": []})
    assert access.json()["allowed"] is False
    assert "denylisted" in access.json()["reason"]
    assert "disclaimer" in access.json()
    assert "not insurance" in access.json()["disclaimer"].lower()
