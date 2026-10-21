"""Shared hardening helpers for the stamp API and audit runner.

Covers off-chain Breaker findings not handled by the on-chain PR:
- F-03: bind fingerprint_hash to canonical(fingerprint)
- F-05: the software scorer is the judgment. A model score is guidance and is not attestation-grade.
- F-09: cap + isolate untrusted conversation / rap-sheet history
- F-11: xAI base URL from env only (no client-supplied SSRF)
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import urlparse

DEFAULT_XAI_API_BASE = "https://api.x.ai/v1"

# Conversation history (audit context). Fail closed on overflow — do not truncate.
DEFAULT_HISTORY_MAX_MESSAGES = 32
DEFAULT_HISTORY_MAX_CONTENT_CHARS = 4000
DEFAULT_HISTORY_MAX_TOTAL_CHARS = 32000

# Rap-sheet history stored by the stamp API.
DEFAULT_HISTORY_STORE_MAX_ENTRIES = 64
DEFAULT_HISTORY_STORE_SUMMARY_MAX = 500
DEFAULT_HISTORY_STORE_DETAILS_MAX = 2000

UNTRUSTED_HISTORY_ROLES = frozenset({"user", "assistant"})
HISTORY_STORE_KINDS = frozenset({"version", "incident", "provenance", "note"})
SCORING_MODES = frozenset({"software", "llm_judge"})

GUIDANCE_ONLY_NOTE = (
    "The model provides guidance only. The software scorer is the judgment. "
    "A model score is not part of the fingerprint."
)

# Kept so older imports still resolve. The env flag no longer grants attestation.
KEYWORD_SCORER_NOTE = GUIDANCE_ONLY_NOTE


def _int_env(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value < 1:
        raise ValueError(f"{name} must be >= 1")
    return value


def canonical_dumps(obj: Any) -> str:
    """Deterministic JSON used for fingerprint binding."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def canonical_fingerprint_hash(fingerprint: Any) -> str:
    """sha256(canonical(fingerprint)) — must match on register (F-03)."""
    if not isinstance(fingerprint, dict):
        raise ValueError("fingerprint must be a JSON object")
    return hashlib.sha256(canonical_dumps(fingerprint).encode("utf-8")).hexdigest()


def normalize_fingerprint_hash(value: str) -> str:
    raw = (value or "").strip().lower()
    if raw.startswith("0x"):
        raw = raw[2:]
    return raw


def hashes_match(provided: str, expected: str) -> bool:
    return normalize_fingerprint_hash(provided) == normalize_fingerprint_hash(expected)


def keyword_attestation_allowed() -> bool:
    return (os.environ.get("ALLOW_KEYWORD_ATTESTATION") or "").strip() == "1"


def normalize_scoring_mode(mode: Optional[str]) -> str:
    raw = (mode or "software").strip().lower()
    if raw in ("keyword", "software"):
        return "software"
    if raw in ("llm", "llm-judge", "llm_as_judge", "llm_judge"):
        return "llm_judge"
    raise ValueError(
        f"unknown scoring_mode {mode!r}; expected software or llm_judge"
    )


def attestation_grade_allowed(scoring_mode: Optional[str]) -> bool:
    """The software scorer is the judgment. A model mode is guidance only."""
    try:
        mode = normalize_scoring_mode(scoring_mode)
    except ValueError:
        return False
    return mode == "software"


def refuse_attestation_reason(scoring_mode: Optional[str]) -> Optional[str]:
    if attestation_grade_allowed(scoring_mode):
        return None
    return (
        "attestation-grade output refused: the model provides guidance only. "
        "Judgment is the software scorer."
    )


def resolve_xai_api_base(base_url: Optional[str] = None) -> str:
    """xAI base URL from env only. Client-supplied values are rejected (F-11)."""
    if base_url is not None:
        raise RuntimeError(
            "xAI base URL is env-only (XAI_API_BASE); client-supplied base is rejected"
        )
    raw = (os.environ.get("XAI_API_BASE") or DEFAULT_XAI_API_BASE).strip()
    return validate_xai_api_base(raw)


def validate_xai_api_base(url: str) -> str:
    parsed = urlparse((url or "").strip())
    if parsed.scheme != "https":
        raise RuntimeError("XAI_API_BASE must use https")
    if parsed.username or parsed.password:
        raise RuntimeError("XAI_API_BASE must not include credentials")
    if not parsed.hostname:
        raise RuntimeError("XAI_API_BASE is not a valid URL")
    if parsed.query or parsed.fragment:
        raise RuntimeError("XAI_API_BASE must not include query or fragment")
    path = parsed.path.rstrip("/")
    return f"https://{parsed.hostname}{'' if parsed.port is None else f':{parsed.port}'}{path}"


def xai_chat_completions_url() -> str:
    return f"{resolve_xai_api_base()}/chat/completions"


def sanitize_untrusted_history(
    history: Optional[Iterable[Dict[str, Any]]],
    *,
    allow_system: bool = False,
) -> List[Dict[str, str]]:
    """Cap and isolate conversation history so attackers cannot poison audits (F-09).

    System-role messages are operator-only (AUDIT_SYSTEM_PROMPT / allow_system).
    Overflow is rejected, not truncated.
    """
    if not history:
        return []
    if isinstance(history, (str, bytes)) or not isinstance(history, (list, tuple)):
        raise ValueError("history must be a list of {role, content} messages")

    max_messages = _int_env("HISTORY_MAX_MESSAGES", DEFAULT_HISTORY_MAX_MESSAGES)
    max_content = _int_env("HISTORY_MAX_CONTENT_CHARS", DEFAULT_HISTORY_MAX_CONTENT_CHARS)
    max_total = _int_env("HISTORY_MAX_TOTAL_CHARS", DEFAULT_HISTORY_MAX_TOTAL_CHARS)

    if len(history) > max_messages:
        raise ValueError(f"history exceeds max messages ({max_messages})")

    allowed = set(UNTRUSTED_HISTORY_ROLES)
    if allow_system:
        allowed.add("system")

    out: List[Dict[str, str]] = []
    total = 0
    for msg in history:
        if not isinstance(msg, dict):
            raise ValueError("Invalid history message (need role+content)")
        role = msg.get("role")
        content = msg.get("content")
        if role == "system" and not allow_system:
            raise ValueError(
                "system history is operator-isolated; untrusted system messages are rejected"
            )
        if role not in allowed or content is None:
            raise ValueError(f"Invalid history message (need role+content): {msg!r}")
        if not isinstance(content, str):
            raise ValueError("history content must be a string")
        if len(content) > max_content:
            raise ValueError(f"history message exceeds max content chars ({max_content})")
        total += len(content)
        if total > max_total:
            raise ValueError(f"history exceeds max total chars ({max_total})")
        out.append({"role": str(role), "content": content})
    return out


def operator_system_messages() -> List[Dict[str, str]]:
    """Operator-controlled system prompt from env — not from client history."""
    prompt = (os.environ.get("AUDIT_SYSTEM_PROMPT") or "").strip()
    if not prompt:
        return []
    max_content = _int_env("HISTORY_MAX_CONTENT_CHARS", DEFAULT_HISTORY_MAX_CONTENT_CHARS)
    if len(prompt) > max_content:
        raise ValueError("AUDIT_SYSTEM_PROMPT exceeds content cap")
    return [{"role": "system", "content": prompt}]


def build_audit_messages(
    prompt: str,
    history: Optional[Iterable[Dict[str, Any]]] = None,
) -> List[Dict[str, str]]:
    if not isinstance(prompt, str) or not prompt:
        raise ValueError("prompt must be a non-empty string")
    max_content = _int_env("HISTORY_MAX_CONTENT_CHARS", DEFAULT_HISTORY_MAX_CONTENT_CHARS)
    if len(prompt) > max_content:
        raise ValueError(f"prompt exceeds max content chars ({max_content})")
    messages = operator_system_messages()
    messages.extend(sanitize_untrusted_history(history, allow_system=False))
    messages.append({"role": "user", "content": prompt})
    return messages


def validate_history_store_entry(
    kind: str,
    summary: str,
    details: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Validate a rap-sheet append so the store cannot be poisoned cheaply (F-09)."""
    kind_norm = (kind or "").strip().lower()
    if kind_norm not in HISTORY_STORE_KINDS:
        raise ValueError(
            f"invalid history kind {kind!r}; expected one of {sorted(HISTORY_STORE_KINDS)}"
        )
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError("history summary is required")
    max_summary = _int_env("HISTORY_STORE_SUMMARY_MAX", DEFAULT_HISTORY_STORE_SUMMARY_MAX)
    if len(summary) > max_summary:
        raise ValueError(f"history summary exceeds max chars ({max_summary})")
    payload: Dict[str, Any] = {"kind": kind_norm, "summary": summary.strip()}
    if details is None:
        return payload
    if not isinstance(details, dict):
        raise ValueError("history details must be a JSON object")
    encoded = canonical_dumps(details)
    max_details = _int_env("HISTORY_STORE_DETAILS_MAX", DEFAULT_HISTORY_STORE_DETAILS_MAX)
    if len(encoded) > max_details:
        raise ValueError(f"history details exceed max bytes ({max_details})")
    payload["details"] = details
    return payload


def history_store_max_entries() -> int:
    return _int_env("HISTORY_STORE_MAX_ENTRIES", DEFAULT_HISTORY_STORE_MAX_ENTRIES)
