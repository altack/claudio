# Custom LiteLLM callback that appends one JSONL record per request to
# /data/litellm/spend.jsonl. The webapp reads this file directly to render
# the /spend page; LiteLLM's own spend endpoints require Prisma, which we
# deliberately don't ship.
#
# Registered via `litellm_settings.callbacks: spend_logger.proxy_handler_instance`
# in /etc/litellm/config.yaml. PYTHONPATH must include /etc/litellm so the
# import resolves at proxy startup.

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs

import litellm
from litellm.integrations.custom_logger import CustomLogger

# Required for response headers to land in _hidden_params / _response_headers.
# Set once at module import; Copilot's per-call rate-limit headers ride on
# every completion response and are how we surface "premium quota left".
litellm.return_response_headers = True

SPEND_LOG_PATH = Path(os.environ.get("CLAUDIO_SPEND_LOG", "/data/litellm/spend.jsonl"))

# Append is atomic on POSIX for writes <= PIPE_BUF (4096 bytes); our records
# are well under that. The lock guards against torn writes when LiteLLM fans
# out callbacks across its async worker pool inside one process.
_write_lock = threading.Lock()


def _coerce_int(value) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _coerce_float(value) -> float:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return 0.0
    if f != f or f in (float("inf"), float("-inf")):
        return 0.0
    return f


def _extract_usage(response_obj) -> dict:
    if response_obj is None:
        return {}
    usage = None
    if isinstance(response_obj, dict):
        usage = response_obj.get("usage")
    else:
        usage = getattr(response_obj, "usage", None)
    if usage is None:
        return {}
    if hasattr(usage, "model_dump"):
        usage = usage.model_dump()
    elif hasattr(usage, "dict"):
        usage = usage.dict()
    if not isinstance(usage, dict):
        return {}
    return usage


def _extract_response_headers(response_obj) -> dict:
    """Flatten upstream provider headers off a litellm response object.

    LiteLLM stashes them in `_response_headers` and `_hidden_params`
    (sometimes nested under `additional_headers`). We collect from all
    those sources, lowercase the keys, and strip LiteLLM's
    `llm_provider-` prefix so callers see the raw header names.
    """
    if response_obj is None:
        return {}
    candidates = []
    for attr in ("_response_headers", "_hidden_params"):
        val = getattr(response_obj, attr, None)
        if isinstance(val, dict):
            candidates.append(val)
    for src in list(candidates):
        for nested_key in (
            "additional_headers",
            "response_headers",
            "headers",
            "raw_response_headers",
        ):
            nested = src.get(nested_key)
            if isinstance(nested, dict):
                candidates.append(nested)
    flat: dict = {}
    for c in candidates:
        for k, v in c.items():
            if not isinstance(k, str):
                continue
            kl = k.lower()
            if kl.startswith("llm_provider-"):
                kl = kl[len("llm_provider-"):]
            if kl.startswith("x-"):
                flat.setdefault(kl, str(v))
    return flat


def _parse_quota_snapshot(value: str) -> dict:
    """Parse Copilot's x-quota-snapshot-* querystring into a flat dict.

    Format: `ent=300&ov=0.0&ovPerm=true&rem=96.3&rst=2026-06-01T00%3A00%3A00Z&totRem=289.1`

    - ent: entitlement (total per period); -1 means unlimited
    - ov: current overage
    - ovPerm: whether overage is permitted (true/false)
    - rem: percentage remaining
    - rst: reset timestamp (ISO 8601)
    - totRem: absolute remaining count (-1 for unlimited)
    """
    if not value:
        return {}
    try:
        parsed = parse_qs(value, keep_blank_values=True)
    except Exception:
        return {}
    out: dict = {}
    flat = {k: v[0] for k, v in parsed.items() if v}
    for src, dst in (
        ("ent", "entitlement"),
        ("rem", "percent_remaining"),
        ("totRem", "remaining"),
        ("ov", "overage"),
        ("ovPerm", "overage_permitted"),
        ("rst", "reset_at"),
    ):
        if src in flat:
            out[dst] = flat[src]
    return out


def _extract_quota(headers: dict) -> dict:
    """Pull Copilot's premium-interaction quota out of the response headers.

    Premium interactions is the bucket that gates Claude 4.x and the other
    paid models. The chat/completions buckets are unlimited on most plans
    (ent=-1) so they're not interesting for the dashboard.
    """
    if not headers:
        return {}
    snap = headers.get("x-quota-snapshot-premium_interactions")
    if not snap:
        return {}
    parsed = _parse_quota_snapshot(snap)
    if not parsed:
        return {}
    return {"premium_interactions": parsed}


def _record(kwargs, response_obj, start_time, end_time, status: str) -> dict:
    usage = _extract_usage(response_obj)
    prompt_tokens = _coerce_int(usage.get("prompt_tokens"))
    completion_tokens = _coerce_int(usage.get("completion_tokens"))
    total_tokens = _coerce_int(usage.get("total_tokens")) or (
        prompt_tokens + completion_tokens
    )

    when = end_time or start_time or datetime.now(timezone.utc)
    if isinstance(when, datetime):
        ts = when.astimezone(timezone.utc).isoformat()
    else:
        ts = datetime.now(timezone.utc).isoformat()

    # `kwargs["model"]` is the alias the client requested (e.g. claude-opus-4-7).
    # The actual upstream is in litellm_params.model (e.g. github_copilot/...).
    model = kwargs.get("model") or "unknown"
    litellm_params = kwargs.get("litellm_params") or {}
    backend = litellm_params.get("model") or model

    duration_ms = 0
    if isinstance(start_time, datetime) and isinstance(end_time, datetime):
        duration_ms = max(int((end_time - start_time).total_seconds() * 1000), 0)

    headers = _extract_response_headers(response_obj)
    quota = _extract_quota(headers)

    record = {
        "ts": ts,
        "status": status,
        "model": model,
        "backend": backend,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "cost": _coerce_float(kwargs.get("response_cost")),
        "duration_ms": duration_ms,
    }
    if quota:
        record["quota"] = quota
    return record


def _append(record: dict) -> None:
    line = json.dumps(record, separators=(",", ":")) + "\n"
    try:
        SPEND_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with _write_lock:
            with SPEND_LOG_PATH.open("a", encoding="utf-8") as f:
                f.write(line)
    except OSError as e:
        # Don't let logger failures take down a real request.
        print(f"[spend_logger] write failed: {e}", flush=True)


class SpendLogger(CustomLogger):
    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        _append(_record(kwargs, response_obj, start_time, end_time, "success"))

    def log_failure_event(self, kwargs, response_obj, start_time, end_time):
        _append(_record(kwargs, response_obj, start_time, end_time, "failure"))

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        _append(_record(kwargs, response_obj, start_time, end_time, "success"))

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        _append(_record(kwargs, response_obj, start_time, end_time, "failure"))


proxy_handler_instance = SpendLogger()
