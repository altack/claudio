# Custom LiteLLM callback that appends one JSONL record per request to
# /data/litellm/spend.jsonl. The webapp reads this file directly to render
# the usage panel; LiteLLM's own spend endpoints require Prisma, which we
# deliberately don't ship.
#
# Registered via `litellm_settings.callbacks: spend_logger.proxy_handler_instance`
# in the generated config. PYTHONPATH must include /etc/litellm so the import
# resolves at proxy startup.
#
# Record schema v2. Three things v1 got wrong and this fixes:
#
#   1. Double counting. LiteLLM drives both the sync and the async success
#      path for one async call, so a logger implementing both handlers wrote
#      each request twice. Every record now carries LiteLLM's own call id and
#      we skip ids we've already written.
#   2. Non-generation traffic. Claude Code calls /v1/messages/count_tokens
#      constantly; logging those as if they were completions inflated totals
#      by the size of every context it ever measured. Those call types are
#      dropped.
#   3. Prompt-cache reads counted as fresh input. Anthropic's `prompt_tokens`
#      folds in cache reads and cache writes, and Claude Code caches hard - the
#      cache-read stream is routinely 10-20x the genuinely new input. We split
#      usage into input / output / cache_read / cache_write so the dashboard
#      can report work done rather than context re-sent.

import json
import os
import threading
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs

import litellm
from litellm.integrations.custom_logger import CustomLogger

# Required for response headers to land in _hidden_params / _response_headers.
# Set once at module import; Copilot's per-call rate-limit headers ride on
# every completion response and are how we surface "premium quota left".
litellm.return_response_headers = True

SCHEMA_VERSION = 2

SPEND_LOG_PATH = Path(os.environ.get("CLAUDIO_SPEND_LOG", "/data/litellm/spend.jsonl"))

# Append is atomic on POSIX for writes <= PIPE_BUF (4096 bytes); our records
# are well under that. The lock guards against torn writes when LiteLLM fans
# out callbacks across its async worker pool inside one process.
_write_lock = threading.Lock()

# Ring of call ids already written, so the sync and async success handlers
# firing for the same request produce one line, not two. Bounded so a
# long-lived proxy doesn't grow this without limit.
_SEEN_MAX = 4096
_seen_ids = OrderedDict()

# Call types that consume no model tokens, or whose tokens aren't generation.
# `count_tokens` is the big one: Claude Code measures its context on nearly
# every turn and those measurements are not consumption.
_SKIP_CALL_TYPE_MARKERS = (
    "count_tokens",
    "embedding",
    "moderation",
    "transcription",
    "speech",
    "rerank",
    "image_generation",
    "batch",
    "file",
)


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


def _as_dict(obj) -> dict:
    """Best-effort dict view of a pydantic model, dataclass or mapping."""
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    for attr in ("model_dump", "dict"):
        fn = getattr(obj, attr, None)
        if callable(fn):
            try:
                out = fn()
            except Exception:  # noqa: BLE001 - logging must not raise
                continue
            if isinstance(out, dict):
                return out
    return {}


def _extract_usage(kwargs, response_obj) -> dict:
    """Usage off the completed response.

    For streamed calls LiteLLM hands the success handler the reassembled
    response, but it also stashes it in kwargs - check both so a streamed turn
    doesn't land with zero tokens.
    """
    for candidate in (
        response_obj,
        kwargs.get("complete_streaming_response"),
        kwargs.get("response"),
    ):
        if candidate is None:
            continue
        if isinstance(candidate, dict):
            usage = candidate.get("usage")
        else:
            usage = getattr(candidate, "usage", None)
        usage = _as_dict(usage)
        if usage:
            return usage
    return {}


def _split_tokens(usage: dict) -> dict:
    """Break `prompt_tokens` into what was newly processed vs served by cache.

    Anthropic reports `cache_read_input_tokens` / `cache_creation_input_tokens`
    alongside `prompt_tokens`; LiteLLM also mirrors them into
    `prompt_tokens_details` as `cached_tokens` / `cache_creation_tokens`
    depending on provider and version. Read whichever is present.
    """
    details = _as_dict(usage.get("prompt_tokens_details"))

    prompt_tokens = _coerce_int(usage.get("prompt_tokens"))
    completion_tokens = _coerce_int(usage.get("completion_tokens"))

    cache_read = _coerce_int(
        usage.get("cache_read_input_tokens") or details.get("cached_tokens")
    )
    cache_write = _coerce_int(
        usage.get("cache_creation_input_tokens")
        or details.get("cache_creation_tokens")
    )

    # Some providers report cache buckets *in addition to* prompt_tokens rather
    # than inside it. Clamping keeps a provider quirk from producing negative
    # input, and the raw prompt_tokens stays on the record either way.
    input_tokens = max(prompt_tokens - cache_read - cache_write, 0)

    return {
        "input_tokens": input_tokens,
        "output_tokens": completion_tokens,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "prompt_tokens": prompt_tokens,
    }


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
    except Exception:  # noqa: BLE001
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

    Premium interactions is the bucket that gates Claude 4.x/5 and the other
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


def _iso(value) -> str:
    """ISO-8601 UTC from a datetime, a unix timestamp, or nothing."""
    if isinstance(value, datetime):
        when = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return when.astimezone(timezone.utc).isoformat()
    if isinstance(value, (int, float)) and value > 0:
        return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
    return datetime.now(timezone.utc).isoformat()


def _millis_between(start, end) -> int:
    if isinstance(start, datetime) and isinstance(end, datetime):
        return max(int((end - start).total_seconds() * 1000), 0)
    if isinstance(start, (int, float)) and isinstance(end, (int, float)):
        return max(int((end - start) * 1000), 0)
    return 0


def _should_skip(call_type: str) -> bool:
    ct = (call_type or "").lower()
    return any(marker in ct for marker in _SKIP_CALL_TYPE_MARKERS)


def _claim_id(call_id: str) -> bool:
    """True if this is the first time we've seen `call_id`.

    LiteLLM invokes both the sync and the async success handler for the same
    async request; without this, every call lands twice.
    """
    if not call_id:
        return True
    with _write_lock:
        if call_id in _seen_ids:
            return False
        _seen_ids[call_id] = None
        while len(_seen_ids) > _SEEN_MAX:
            _seen_ids.popitem(last=False)
    return True


def _record(kwargs, response_obj, start_time, end_time, status: str):
    slo = kwargs.get("standard_logging_object")
    if not isinstance(slo, dict):
        slo = {}

    call_type = str(slo.get("call_type") or kwargs.get("call_type") or "")
    if _should_skip(call_type):
        return None

    call_id = str(
        slo.get("id") or kwargs.get("litellm_call_id") or kwargs.get("id") or ""
    )
    if not _claim_id(call_id):
        return None

    usage = _extract_usage(kwargs, response_obj)
    tokens = _split_tokens(usage)

    # `kwargs["model"]` is the alias the client requested (e.g. claude-opus-5).
    # The actual upstream is in litellm_params.model (e.g. github_copilot/...).
    model = kwargs.get("model") or slo.get("model") or "unknown"
    litellm_params = kwargs.get("litellm_params") or {}
    backend = litellm_params.get("model") or model

    slo_start = slo.get("startTime", start_time)
    slo_end = slo.get("endTime", end_time)

    # Prefer the start_time/end_time the callback is handed over anything in
    # standard_logging_object. On the `anthropic_messages` route - which is the
    # one Claude Code uses - LiteLLM stamps startTime, completionStartTime and
    # endTime within a millisecond of each other, so trusting them reports a
    # ten-second streamed answer as "1ms".
    duration_ms = _millis_between(start_time, end_time)
    if duration_ms == 0:
        response_time = slo.get("response_time")
        if isinstance(response_time, (int, float)) and response_time > 0:
            duration_ms = max(int(response_time * 1000), 0)
        else:
            duration_ms = _millis_between(slo_start, slo_end)

    # Time-to-first-token is only meaningful where the provider actually
    # distinguishes it from completion. Where LiteLLM stamps completionStartTime
    # at the end, TTFT comes out equal to (or above) the full duration -
    # reporting that as latency is worse than reporting nothing, so drop it and
    # let the UI fall back to the duration.
    ttft_ms = _millis_between(slo_start, slo.get("completionStartTime"))
    if ttft_ms >= duration_ms:
        ttft_ms = 0

    headers = _extract_response_headers(response_obj)
    quota = _extract_quota(headers)

    record = {
        "v": SCHEMA_VERSION,
        "id": call_id,
        "ts": _iso(slo_end or end_time or start_time),
        "status": status,
        "call_type": call_type or "unknown",
        "stream": bool(kwargs.get("stream") or slo.get("stream")),
        "model": model,
        "backend": backend,
        "input_tokens": tokens["input_tokens"],
        "output_tokens": tokens["output_tokens"],
        "cache_read_tokens": tokens["cache_read_tokens"],
        "cache_write_tokens": tokens["cache_write_tokens"],
        "prompt_tokens": tokens["prompt_tokens"],
        "cost": _coerce_float(kwargs.get("response_cost") or slo.get("response_cost")),
        "duration_ms": duration_ms,
        "ttft_ms": ttft_ms,
    }
    if quota:
        record["quota"] = quota
    return record


def _append(record) -> None:
    if record is None:
        return
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
