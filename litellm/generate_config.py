#!/usr/bin/env python3
"""Generate LiteLLM's model_list from GitHub Copilot's live model catalog.

Runs once, immediately before the proxy starts (supervisor/litellm-start.sh).
Merges litellm/config.base.yaml with a freshly-discovered model_list and
writes /data/litellm/config.generated.yaml, which is what LiteLLM actually
boots against.

Why generate at all: Claude Code's /model picker only accepts IDs from
/v1/models that start with "claude" or "anthropic", and LiteLLM's own
provider model-discovery (`check_provider_endpoint`) doesn't cover
github_copilot - and would surface IDs as `github_copilot/...` anyway. So we
enumerate Copilot's catalog ourselves and mint picker-safe aliases.

This must never stop the proxy from booting. Every failure path degrades to
the last cached catalog, then to the bundled snapshot.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import yaml

BASE_CONFIG = Path(
    os.environ.get("CLAUDIO_BASE_CONFIG", "/etc/litellm/config.base.yaml")
)
FALLBACK_CATALOG = Path(
    os.environ.get("CLAUDIO_FALLBACK_CATALOG", "/etc/litellm/models.fallback.yaml")
)
OUT_CONFIG = Path(
    os.environ.get("CLAUDIO_GENERATED_CONFIG", "/data/litellm/config.generated.yaml")
)
CACHE_PATH = Path(
    os.environ.get("CLAUDIO_MODEL_CACHE", "/data/litellm/models.cache.json")
)

TOKEN_DIR = Path(os.environ.get("GITHUB_COPILOT_TOKEN_DIR", "/data/copilot"))
ACCESS_TOKEN_FILE = TOKEN_DIR / "access-token"
API_KEY_FILE = TOKEN_DIR / "api-key.json"

COPILOT_API_BASE = (
    os.environ.get("GITHUB_COPILOT_API_BASE") or "https://api.githubcopilot.com"
)
COPILOT_API_KEY_URL = (
    os.environ.get("GITHUB_COPILOT_API_KEY_URL")
    or "https://api.github.com/copilot_internal/v2/token"
)

# Copilot's endpoints reject requests that don't look like the official VS Code
# client. Keep these in lockstep with `editorHeaders` in
# webapp/lib/copilot-auth.ts - if one is bumped, bump both.
EDITOR_HEADERS = {
    "editor-version": "vscode/1.85.1",
    "editor-plugin-version": "copilot-chat/0.12.0",
    "user-agent": "GitHubCopilotChat/0.12.0",
    "accept": "application/json",
}

HTTP_TIMEOUT = 10
ALIAS_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def log(msg):
    print(f"[generate_config] {msg}", flush=True)


# --------------------------------------------------------------------------
# Copilot catalog
# --------------------------------------------------------------------------


def _read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _get(url, headers):
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as res:
        return json.loads(res.read().decode("utf-8"))


def _refresh_api_key():
    """Exchange the stored GitHub OAuth token for a fresh Copilot API key.

    Copilot API keys expire in well under an hour, so on a cold boot the one
    on disk is usually stale. Mirrors refreshCopilotApiKey() in
    webapp/lib/copilot-auth.ts and writes the same file LiteLLM itself reads.
    """
    try:
        access_token = ACCESS_TOKEN_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if not access_token:
        return None
    try:
        api_key = _get(
            COPILOT_API_KEY_URL,
            dict(EDITOR_HEADERS, authorization=f"token {access_token}"),
        )
    except (urllib.error.URLError, OSError, ValueError) as e:
        log(f"api key refresh failed: {e}")
        return None
    try:
        API_KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
        API_KEY_FILE.write_text(json.dumps(api_key, indent=2), encoding="utf-8")
    except OSError as e:
        log(f"api key write failed: {e}")
    return api_key


def _copilot_api_key():
    api_key = _read_json(API_KEY_FILE)
    expires_at = (api_key or {}).get("expires_at")
    fresh = isinstance(expires_at, (int, float)) and expires_at > time.time() + 60
    if api_key and api_key.get("token") and fresh:
        return api_key
    return _refresh_api_key() or api_key


def fetch_catalog():
    api_key = _copilot_api_key()
    token = (api_key or {}).get("token")
    if not token:
        log("no copilot token on disk - not signed in yet")
        return None

    # The token response carries the tenant's own endpoint map; prefer it so
    # GHE / proxied installs keep working.
    api_base = COPILOT_API_BASE
    endpoints = api_key.get("endpoints") if isinstance(api_key, dict) else None
    if isinstance(endpoints, dict) and isinstance(endpoints.get("api"), str):
        api_base = endpoints["api"]

    url = f"{api_base.rstrip('/')}/models"
    headers = dict(
        EDITOR_HEADERS,
        authorization=f"Bearer {token}",
    )
    headers["copilot-integration-id"] = "vscode-chat"
    try:
        body = _get(url, headers)
    except (urllib.error.URLError, OSError, ValueError) as e:
        log(f"catalog fetch failed ({url}): {e}")
        return None
    if not isinstance(body, dict) or not isinstance(body.get("data"), list):
        log("catalog response had no `data` array")
        return None
    return body


def load_catalog():
    """Live catalog, else last-good cache, else the bundled snapshot."""
    live = fetch_catalog()
    if live:
        payload = {
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "data": live["data"],
        }
        try:
            CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
            CACHE_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        except OSError as e:
            log(f"cache write failed: {e}")
        return live, "live"

    cached = _read_json(CACHE_PATH)
    if isinstance(cached, dict) and isinstance(cached.get("data"), list):
        log(f"using cached catalog from {cached.get('fetched_at') or 'unknown time'}")
        return cached, "cache"

    try:
        bundled = yaml.safe_load(FALLBACK_CATALOG.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as e:
        log(f"bundled catalog unreadable: {e}")
        bundled = None
    if isinstance(bundled, dict) and isinstance(bundled.get("data"), list):
        log("using bundled catalog snapshot")
        return bundled, "bundled"

    log("no catalog available at all - proxy will start with no models")
    return {"data": []}, "none"


# --------------------------------------------------------------------------
# Alias minting
# --------------------------------------------------------------------------


def _picker_safe(alias):
    a = alias.lower()
    return a.startswith("claude") or a.startswith("anthropic")


def alias_for(model_id, vendor):
    """Mint an alias Claude Code's /model picker will actually surface."""
    if not model_id or not ALIAS_RE.match(model_id):
        return None
    if vendor.lower() == "anthropic":
        # Copilot's Anthropic IDs already read `claude-...`; keep them 1:1 so
        # `claudio --model claude-opus-5` is the obvious thing that works.
        return model_id if _picker_safe(model_id) else f"claude-{model_id}"
    # Everything else is an opt-in fallback. The `claude-via-` prefix satisfies
    # the picker's filter while keeping the real upstream readable.
    return f"claude-via-{model_id}"


def is_usable(entry):
    caps = entry.get("capabilities")
    kind = caps.get("type") if isinstance(caps, dict) else None
    if kind is not None and kind != "chat":
        return False  # embeddings et al - not something Claude Code can drive
    policy = entry.get("policy")
    if isinstance(policy, dict) and policy.get("state") not in (None, "enabled"):
        # Model needs a policy acceptance we can't give from here; calling it
        # would 400. Leave it out of the picker rather than offer a dud.
        return False
    return True


def build_model_list(catalog):
    entries = []
    seen = set()

    def add(alias, backend_id, entry):
        if alias in seen or not ALIAS_RE.match(alias):
            return
        seen.add(alias)
        item = {
            "model_name": alias,
            "litellm_params": {"model": f"github_copilot/{backend_id}"},
        }
        limits = (entry.get("capabilities") or {}).get("limits")
        if isinstance(limits, dict):
            info = {}
            if isinstance(limits.get("max_context_window_tokens"), int):
                info["max_input_tokens"] = limits["max_context_window_tokens"]
            if isinstance(limits.get("max_output_tokens"), int):
                info["max_output_tokens"] = limits["max_output_tokens"]
            if info:
                item["model_info"] = info
        entries.append(item)

    for entry in catalog.get("data", []):
        if not isinstance(entry, dict) or not is_usable(entry):
            continue
        model_id = str(entry.get("id") or "")
        vendor = str(entry.get("vendor") or "")
        alias = alias_for(model_id, vendor)
        if not alias:
            continue
        add(alias, model_id, entry)
        # Claude Code's ANTHROPIC_DEFAULT_*_MODEL env vars use dashes, never
        # dots. Ship a dashed twin of every dotted Anthropic alias so
        # `/model opus|sonnet|haiku` resolves to something the gateway serves.
        if vendor.lower() == "anthropic" and "." in alias:
            add(alias.replace(".", "-"), model_id, entry)

    return entries


# --------------------------------------------------------------------------


def main():
    try:
        base = yaml.safe_load(BASE_CONFIG.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as e:
        log(f"FATAL: base config unreadable ({BASE_CONFIG}): {e}")
        return 1

    catalog, source = load_catalog()
    model_list = build_model_list(catalog)
    anthropic = sum(
        1 for m in model_list if not m["model_name"].startswith("claude-via-")
    )
    log(f"catalog source={source} -> {len(model_list)} aliases ({anthropic} anthropic)")

    base["model_list"] = model_list
    header = (
        "# GENERATED FILE - do not edit.\n"
        "# Written by generate_config.py at "
        f"{datetime.now(timezone.utc).isoformat()}\n"
        f"# Catalog source: {source}. Edit litellm/config.base.yaml instead.\n"
    )
    try:
        OUT_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        OUT_CONFIG.write_text(
            header + yaml.safe_dump(base, sort_keys=False, default_flow_style=False),
            encoding="utf-8",
        )
    except OSError as e:
        log(f"FATAL: could not write {OUT_CONFIG}: {e}")
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 - a generator crash must not block boot
        log(f"unexpected failure: {e!r}")
        sys.exit(1)
