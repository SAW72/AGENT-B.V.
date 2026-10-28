"""Handshake vs the real stamp API (auth, attestation-grade, fingerprint bind)."""

import time

import pytest
from fastapi.testclient import TestClient

from api.stamp_api import DENYLIST, HISTORY, REGISTRY, app
from bot2bot.handshake import HandshakeClient, StampClient, verify_counterparty
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


def _stamp(session=None, api_key=None) -> StampClient:
    return StampClient(
        "http://testserver",
        api_key=OPERATOR_KEY if api_key is None else api_key,
        session=session or _client(),
    )


def _register(client: TestClient, bot_id="payee", **extra):
    fp = extra.pop("fingerprint", {"honesty": 1, "bot": bot_id})
    body = {
        "bot_id": bot_id,
        "fingerprint": fp,
        "fingerprint_hash": extra.pop("fingerprint_hash", canonical_fingerprint_hash(fp)),
        "tier": extra.pop("tier", 3),
        "scoring_mode": extra.pop("scoring_mode", "software"),
        "require_attestation": extra.pop("require_attestation", True),
    }
    body.update(extra)
    r = client.post("/v1/bots", json=body, headers={"X-API-Key": OPERATOR_KEY})
    assert r.status_code == 200, r.text
    return body, r.json()


def test_real_api_happy_path_attestation_grade():
    client = _client()
    _register(client)
    ok, reason = verify_counterparty(_stamp(client), "payee", required_tier=3)
    assert ok and reason == "ok"


def test_real_api_model_mode_is_not_attestation_grade():
    client = _client()
    _register(client, scoring_mode="llm_judge", require_attestation=False)
    ok, reason = verify_counterparty(_stamp(client), "payee")
    assert not ok
    assert reason == "not_attestation_grade"


def test_real_api_denylist_blocks():
    client = _client()
    body, _ = _register(client)
    listed = client.post(
        f"/v1/denylist/{body['fingerprint_hash']}",
        headers={"X-API-Key": OPERATOR_KEY},
    )
    assert listed.status_code == 200
    ok, reason = verify_counterparty(_stamp(client), "payee")
    assert not ok and reason.startswith("denylisted")


def test_real_api_tier_too_low():
    client = _client()
    _register(client, tier=1)
    ok, reason = verify_counterparty(_stamp(client), "payee", required_tier=3)
    assert not ok
    assert reason.startswith("tier_too_low") or reason.startswith("access_denied")


def test_real_api_unknown_bot():
    ok, reason = verify_counterparty(_stamp(), "missing")
    assert not ok and reason == "unknown_bot"


def test_stamp_client_sends_env_api_key(monkeypatch):
    monkeypatch.setenv("STAMP_API_KEY", OPERATOR_KEY)
    captured = {}

    class Probe:
        def get(self, url, params=None, headers=None, timeout=None):
            captured["headers"] = headers
            captured["params"] = params

            class R:
                status_code = 404

                def raise_for_status(self):
                    raise AssertionError("should not be called after 404")

                def json(self):
                    return {}

            return R()

    stamp = StampClient("http://testserver", session=Probe())
    assert stamp.api_key == OPERATOR_KEY
    with pytest.raises(KeyError):
        stamp.get_stamp("x")
    assert captured["headers"]["X-API-Key"] == OPERATOR_KEY
    assert captured["params"]["attestation"] == "true"


def test_missing_fingerprint_hash_is_rejected():
    class MissingFP:
        def get_stamp(self, bot_id, attestation=True):
            return {
                "bot_id": bot_id,
                "tier": 3,
                "attestation_grade": True,
                "issued_at": int(time.time()),
                "expires_at": int(time.time()) + 3600,
                "fingerprint_hash": "",
            }

        def access_check(self, bot_id, permissions):
            return {"allowed": True}

        def check_denylist(self, fingerprint_hash):
            raise AssertionError("denylist must not be skipped when hash is missing")

    ok, reason = verify_counterparty(MissingFP(), "ghost")
    assert not ok and reason == "missing_fingerprint"


def test_attestation_grade_string_false_is_rejected():
    class StrFalse:
        def get_stamp(self, bot_id, attestation=True):
            return {
                "bot_id": bot_id,
                "tier": 3,
                "attestation_grade": "false",
                "issued_at": int(time.time()),
                "expires_at": int(time.time()) + 3600,
                "fingerprint_hash": "ab",
            }

        def access_check(self, bot_id, permissions):
            return {"allowed": True}

        def check_denylist(self, fingerprint_hash):
            return {"listed": False, "level": "none"}

    ok, reason = verify_counterparty(StrFalse(), "x")
    assert not ok and reason == "not_attestation_grade"


def test_expires_at_in_the_past_is_rejected():
    class Expired:
        def get_stamp(self, bot_id, attestation=True):
            return {
                "bot_id": bot_id,
                "tier": 3,
                "attestation_grade": True,
                "issued_at": int(time.time()),
                "expires_at": int(time.time()) - 10,
                "fingerprint_hash": "ab",
            }

        def access_check(self, bot_id, permissions):
            return {"allowed": True}

        def check_denylist(self, fingerprint_hash):
            return {"listed": False, "level": "none"}

    ok, reason = verify_counterparty(Expired(), "x")
    assert not ok and reason == "stamp_expired"


def test_fingerprint_bind_mismatch_is_rejected():
    class Mismatch:
        def get_stamp(self, bot_id, attestation=True):
            return {
                "bot_id": bot_id,
                "tier": 3,
                "attestation_grade": True,
                "issued_at": int(time.time()),
                "expires_at": int(time.time()) + 3600,
                "fingerprint_hash": "0" * 64,
            }

        def get_bot(self, bot_id):
            return {"fingerprint": {"honesty": 1}, "fingerprint_hash": "0" * 64, "active": True}

        def access_check(self, bot_id, permissions):
            return {"allowed": True}

        def check_denylist(self, fingerprint_hash):
            return {"listed": False, "level": "none"}

    ok, reason = verify_counterparty(Mismatch(), "x")
    assert not ok and reason == "fingerprint_hash_mismatch"


def test_inactive_bot_is_rejected():
    class Inactive:
        def get_stamp(self, bot_id, attestation=True):
            return {
                "bot_id": bot_id,
                "tier": 3,
                "attestation_grade": True,
                "active": False,
                "issued_at": int(time.time()),
                "expires_at": int(time.time()) + 3600,
                "fingerprint_hash": "ab",
            }

        def access_check(self, bot_id, permissions):
            return {"allowed": True}

        def check_denylist(self, fingerprint_hash):
            return {"listed": False, "level": "none"}

    ok, reason = verify_counterparty(Inactive(), "x")
    assert not ok and reason == "bot_inactive"


def test_handshake_transact_opens_wired_escrow():
    client = _client()
    _register(client)

    class Escrow:
        def __init__(self):
            self.calls = []

        def create_escrow(self, **kwargs):
            self.calls.append(kwargs)
            return "escrow-1"

    esc = Escrow()
    out = HandshakeClient(_stamp(client), escrow_contract=esc).transact(
        "payee",
        1_000_000,
        payer_bot_id="payer",
        payee="0xpayee",
        escrow_id="escrow-1",
    )
    assert out["ok"] and out["stage"] == "escrow_created"
    assert esc.calls and esc.calls[0]["amount_wei"] == 1_000_000
    assert out["escrow_id"] == "escrow-1"


def test_handshake_client_blocks_model_guidance_counterparty():
    client = _client()
    _register(client, scoring_mode="llm_judge", require_attestation=False)
    out = HandshakeClient(_stamp(client)).transact("payee", 1_000_000)
    assert not out["ok"] and out["stage"] == "verify"
    assert out["reason"] == "not_attestation_grade"


def test_handshake_client_accepts_keyword_alias():
    client = _client()
    _register(client, scoring_mode="keyword", require_attestation=False)
    out = HandshakeClient(_stamp(client)).transact("payee", 1_000_000, payer_bot_id="payer")
    assert out["ok"] and out["stage"] == "verified_only"


def test_real_api_stamp_includes_active():
    client = _client()
    _register(client)
    stamp = client.get("/v1/bots/payee/stamp", params={"attestation": "true"}).json()
    assert stamp["active"] is True
    assert stamp["attestation_grade"] is True
    assert stamp["expires_at"] > stamp["issued_at"]
