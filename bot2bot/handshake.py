#!/usr/bin/env python3
"""Bot-to-bot attestation handshake client.

Before a bot pays another bot, it calls this to verify the counterparty's
on-chain stamp: attestation-grade, not expired, fingerprint-bound, not
denylisted, tier sufficient. If it passes, the bot can create an escrow
on-chain and release funds.

Usage:
    from bot2bot.handshake import StampClient, verify_counterparty, HandshakeClient
    stamp = StampClient(stamp_api_url)  # picks up STAMP_API_KEY from env
    ok, reason = verify_counterparty(stamp, counterparty_bot_id, required_tier=3)
    if ok:
        out = client.transact(counterparty_bot_id, amount_wei, payee=payee_addr, ...)
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None  # type: ignore[assignment]

try:
    from pipeline.security import canonical_fingerprint_hash, hashes_match
except ImportError:  # pragma: no cover
    canonical_fingerprint_hash = None  # type: ignore[assignment]
    hashes_match = None  # type: ignore[assignment]


def _is_true(value: Any) -> bool:
    """Strict-ish truth for API fields. The string 'false' is not True."""
    if value is True:
        return True
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value == 1
    if isinstance(value, str) and value.strip().lower() in {"1", "true", "yes"}:
        return True
    return False


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


class StampClient:
    """Thin client for the stamp API (api/stamp_api.py)."""

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        timeout: float = 10.0,
        session: Any = None,
    ):
        self.base_url = base_url.rstrip("/")
        # Fail closed to the configured operator key when the caller omits one.
        if api_key is None:
            api_key = os.environ.get("STAMP_API_KEY") or ""
        self.api_key = str(api_key).strip()
        self.timeout = timeout
        self.session = session

    def _http(self) -> Any:
        if self.session is not None:
            return self.session
        if requests is None:
            raise RuntimeError("requests is required for StampClient")
        return requests

    def _headers(self) -> Dict[str, str]:
        h = {"Accept": "application/json"}
        if self.api_key:
            h["X-API-Key"] = self.api_key
        return h

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        http = self._http()
        url = f"{self.base_url}{path}"
        fn = getattr(http, method.lower())
        # Injected sessions (FastAPI TestClient) reject or warn on timeout=.
        if self.session is not None:
            return fn(url, headers=self._headers(), **kwargs)
        try:
            return fn(url, headers=self._headers(), timeout=self.timeout, **kwargs)
        except TypeError:
            return fn(url, headers=self._headers(), **kwargs)

    def _raise_for_stamp(self, r: Any, bot_id: str) -> None:
        status = getattr(r, "status_code", 0)
        if status == 404:
            raise KeyError(f"bot {bot_id} not registered")
        if status == 403:
            raise PermissionError("not_attestation_grade")
        if status == 401:
            raise PermissionError("unauthorized")
        if hasattr(r, "raise_for_status"):
            r.raise_for_status()
        elif status >= 400:
            raise RuntimeError(f"stamp http {status}")

    def get_stamp(self, bot_id: str, attestation: bool = True) -> Dict[str, Any]:
        r = self._request(
            "get",
            f"/v1/bots/{bot_id}/stamp",
            params={"attestation": str(bool(attestation)).lower()},
        )
        self._raise_for_stamp(r, bot_id)
        return r.json()

    def get_bot(self, bot_id: str) -> Dict[str, Any]:
        r = self._request("get", f"/v1/bots/{bot_id}")
        self._raise_for_stamp(r, bot_id)
        return r.json()

    def access_check(
        self,
        bot_id: str,
        permissions: List[str],
        agent_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"bot_id": bot_id, "requested_permissions": permissions}
        if agent_id is not None and str(agent_id).strip() != "":
            body["agent_id"] = str(agent_id)
        r = self._request(
            "post",
            "/v1/access/check",
            json=body,
        )
        if hasattr(r, "raise_for_status"):
            r.raise_for_status()
        return r.json()

    def check_denylist(self, fingerprint_hash: str) -> Dict[str, Any]:
        r = self._request("get", f"/v1/denylist/{fingerprint_hash}")
        if hasattr(r, "raise_for_status"):
            r.raise_for_status()
        return r.json()


def verify_counterparty(
    stamp: StampClient,
    bot_id: str,
    *,
    required_tier: int = 3,
    required_permissions: Optional[List[str]] = None,
    max_age_seconds: int = 3600,
    require_fingerprint: bool = True,
) -> Tuple[bool, str]:
    """Verify a counterparty bot is safe to transact with.

    Checks, in order:
      1. Stamp exists and is attestation-grade (403 → not_attestation_grade).
      2. Not expired (`expires_at` if present, else issued_at + max_age).
      3. Fingerprint hash present and bound to canonical(fingerprint) when available.
      4. Not denylisted (stamp status + denylist API). Missing hash is a fail.
      5. Bot is active when the field is present.
      6. Tier meets the required minimum.
      7. Access check passes for the requested permissions.
    """
    perms = required_permissions or ["transfer"]
    try:
        stamp_data = stamp.get_stamp(bot_id, attestation=True)
    except PermissionError as exc:
        reason = str(exc) or "not_attestation_grade"
        return False, reason if reason in {"not_attestation_grade", "unauthorized"} else "not_attestation_grade"
    except KeyError:
        return False, "unknown_bot"
    except Exception as exc:  # noqa: BLE001
        return False, f"stamp_fetch_failed:{exc}"

    if not _is_true(stamp_data.get("attestation_grade")):
        return False, "not_attestation_grade"

    # Missing `active` is tolerated (pre-harden stamps). Explicit False is not.
    if stamp_data.get("active") is False:
        return False, "bot_inactive"

    now = time.time()
    expires = stamp_data.get("expires_at")
    if expires is not None:
        exp = _as_int(expires, default=-1)
        if exp <= 0 or exp <= now:
            return False, "stamp_expired"

    issued = _as_int(stamp_data.get("issued_at") or 0)
    if issued <= 0 or (now - issued) > max_age_seconds:
        return False, "stamp_expired"

    bot_record: Dict[str, Any] = {}
    get_bot = getattr(stamp, "get_bot", None)
    if callable(get_bot):
        try:
            fetched = get_bot(bot_id)
            if isinstance(fetched, dict):
                bot_record = fetched
        except Exception:  # noqa: BLE001
            bot_record = {}

    if bot_record.get("active") is False:
        return False, "bot_inactive"

    fp_hash = (stamp_data.get("fingerprint_hash") or bot_record.get("fingerprint_hash") or "").strip()
    if require_fingerprint and not fp_hash:
        return False, "missing_fingerprint"

    fingerprint = bot_record.get("fingerprint")
    if fingerprint and fp_hash and canonical_fingerprint_hash is not None and hashes_match is not None:
        try:
            expected = canonical_fingerprint_hash(fingerprint)
        except Exception as exc:  # noqa: BLE001
            return False, f"fingerprint_bind_failed:{exc}"
        if not hashes_match(fp_hash, expected):
            return False, "fingerprint_hash_mismatch"

    status = stamp_data.get("denylist_status") or bot_record.get("denylist_status")
    if status and str(status).lower() not in {"clean", "none", ""}:
        return False, f"denylisted:{status}"

    if fp_hash:
        try:
            dl = stamp.check_denylist(fp_hash)
        except Exception as exc:  # noqa: BLE001
            return False, f"denylist_check_failed:{exc}"
        if _is_true(dl.get("listed")):
            return False, f"denylisted:{dl.get('level')}"
    elif require_fingerprint:
        return False, "missing_fingerprint"

    tier = _as_int(stamp_data.get("tier") or bot_record.get("tier") or 0)
    if tier < required_tier:
        return False, f"tier_too_low:{tier}<{required_tier}"

    try:
        access = stamp.access_check(bot_id, perms)
    except Exception as exc:  # noqa: BLE001
        return False, f"access_check_failed:{exc}"
    if not access.get("allowed"):
        return False, f"access_denied:{access.get('reason')}"

    return True, "ok"


@dataclass
class HandshakeResult:
    counterparty: str
    allowed: bool
    reason: str
    stamp: Dict[str, Any]
    checked_at: float
    # Onboarding block from POST /v1/access/check. Present for an unknown bot.
    next: Optional[Dict[str, Any]] = None

    def to_json(self) -> str:
        payload: Dict[str, Any] = {
            "counterparty": self.counterparty,
            "allowed": self.allowed,
            "reason": self.reason,
            "stamp": self.stamp,
            "checked_at": self.checked_at,
        }
        if self.next is not None:
            payload["next"] = self.next
        return json.dumps(payload, indent=2)


def _next_from_access(stamp: StampClient, bot_id: str, permissions: List[str]) -> Dict[str, Any]:
    """Copy `next` from the access check. Fall back to the pinned registry block."""
    from api.stamp_api import register_and_verify_next

    access_check = getattr(stamp, "access_check", None)
    if callable(access_check):
        try:
            access = access_check(bot_id, permissions)
        except Exception:  # noqa: BLE001
            access = None
        if isinstance(access, dict) and isinstance(access.get("next"), dict):
            return access["next"]
    return register_and_verify_next()


class HandshakeClient:
    """High-level client: verify counterparty, then optionally open an escrow."""

    def __init__(
        self,
        stamp: StampClient,
        escrow_contract: Optional[Any] = None,
        default_tier: int = 3,
        default_permissions: Optional[List[str]] = None,
    ):
        self.stamp = stamp
        self.escrow = escrow_contract
        self.default_tier = default_tier
        self.default_permissions = default_permissions or ["transfer"]

    def verify(
        self,
        counterparty_bot_id: str,
        *,
        required_tier: Optional[int] = None,
        required_permissions: Optional[List[str]] = None,
    ) -> HandshakeResult:
        tier = self.default_tier if required_tier is None else required_tier
        permissions = required_permissions or self.default_permissions
        ok, reason = verify_counterparty(
            self.stamp,
            counterparty_bot_id,
            required_tier=tier,
            required_permissions=permissions,
        )
        stamp_data: Dict[str, Any] = {}
        try:
            stamp_data = self.stamp.get_stamp(counterparty_bot_id, attestation=True)
        except Exception:  # noqa: BLE001
            pass
        nxt = _next_from_access(self.stamp, counterparty_bot_id, permissions) if reason == "unknown_bot" else None
        return HandshakeResult(
            counterparty=counterparty_bot_id,
            allowed=ok,
            reason=reason,
            stamp=stamp_data,
            checked_at=time.time(),
            next=nxt,
        )

    def _open_escrow(
        self,
        *,
        escrow_id: Optional[str],
        payee: Optional[str],
        payer_bot_id: str,
        payee_bot_id: str,
        duration_seconds: int,
        amount_wei: int,
    ) -> Any:
        """Call a duck-typed escrow binding (create_escrow / createEscrow)."""
        kwargs = {
            "escrow_id": escrow_id,
            "payee": payee,
            "payer_bot_id": payer_bot_id,
            "payee_bot_id": payee_bot_id,
            "duration_seconds": duration_seconds,
            "amount_wei": amount_wei,
        }
        for name in ("create_escrow", "createEscrow"):
            fn = getattr(self.escrow, name, None)
            if not callable(fn):
                continue
            try:
                return fn(**kwargs)
            except TypeError:
                return fn(
                    escrow_id,
                    payee,
                    payer_bot_id,
                    payee_bot_id,
                    duration_seconds,
                    amount_wei,
                )
        return None

    def transact(
        self,
        counterparty_bot_id: str,
        amount_wei: int,
        *,
        escrow_id: Optional[str] = None,
        payer_bot_id: str = "",
        payee: Optional[str] = None,
        duration_seconds: int = 3600,
    ) -> Dict[str, Any]:
        """Verify the counterparty, then create an on-chain escrow if one is wired."""
        result = self.verify(counterparty_bot_id)
        if not result.allowed:
            return {"ok": False, "stage": "verify", "reason": result.reason}
        if self.escrow is None:
            return {
                "ok": True,
                "stage": "verified_only",
                "reason": result.reason,
                "note": "no escrow contract wired; funds not moved",
            }
        opened = self._open_escrow(
            escrow_id=escrow_id,
            payee=payee,
            payer_bot_id=payer_bot_id,
            payee_bot_id=counterparty_bot_id,
            duration_seconds=duration_seconds,
            amount_wei=amount_wei,
        )
        if opened is None:
            return {
                "ok": True,
                "stage": "ready_for_escrow",
                "counterparty": counterparty_bot_id,
                "amount_wei": amount_wei,
                "payer_bot_id": payer_bot_id,
                "payee": payee,
                "duration_seconds": duration_seconds,
                "escrow_id": escrow_id,
                "note": "escrow binding has no create_escrow/createEscrow",
            }
        return {
            "ok": True,
            "stage": "escrow_created",
            "counterparty": counterparty_bot_id,
            "amount_wei": amount_wei,
            "payer_bot_id": payer_bot_id,
            "payee": payee,
            "duration_seconds": duration_seconds,
            "escrow_id": opened if isinstance(opened, (str, bytes)) else escrow_id,
            "escrow": opened,
        }
