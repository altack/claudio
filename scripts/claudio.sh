#!/usr/bin/env bash
# Run Claude Code through the local LiteLLM proxy backed by GitHub Copilot.
#
# Sets the Anthropic-compatible env vars Claude Code reads, then invokes
# `claude` with whatever arguments you pass through. Reads the LiteLLM
# master key (which doubles as the proxy's auth token) from
# ~/.claudio/config.json, written by setup.sh.

set -euo pipefail

config_path=$HOME/.claudio/config.json
if [[ ! -f "$config_path" ]]; then
  echo "claudio isn't configured yet. Run scripts/setup.sh from the claudio repo first." >&2
  exit 1
fi

# We control both files we parse here (~/.claudio/config.json and the
# webapp's /api/preferences response), so a sed-based extractor is enough —
# no jq dependency to install on the user's machine.
extract_json_string() {
  local key=$1 src=$2
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" <<<"$src" | head -n1
}

config_blob=$(cat "$config_path")
master_key=$(extract_json_string master_key "$config_blob")
if [[ -z "$master_key" ]]; then
  echo "Config at $config_path is missing 'master_key'. Re-run scripts/setup.sh." >&2
  exit 1
fi

# Smoke-test the proxy before handing control to claude. A clear error here
# beats a confusing one from inside the harness.
if ! curl -fsS --max-time 2 http://127.0.0.1:4000/health/liveliness >/dev/null 2>&1; then
  cat >&2 <<EOF
LiteLLM proxy is not reachable at http://127.0.0.1:4000.
Start the container:    podman compose up -d   (or docker compose up -d)
Open the control panel: http://localhost:3000
EOF
  exit 1
fi

export ANTHROPIC_BASE_URL=http://127.0.0.1:4000
export ANTHROPIC_AUTH_TOKEN=$master_key

# Defaults used when the webapp is unreachable or hasn't been told otherwise.
opus_default=claude-opus-4-7
sonnet_default=claude-sonnet-4-6
haiku_default=claude-haiku-4-5

# Pull per-tier defaults from the webapp. The user picks them in /; the
# webapp persists them on the claudio_app named volume. Soft-fail to the
# hardcoded values if the webapp can't be reached so the wrapper still
# works headless.
prefs=$(curl -fsS --max-time 2 http://127.0.0.1:3000/api/preferences 2>/dev/null || true)
if [[ -n "$prefs" ]]; then
  o=$(extract_json_string opus   "$prefs")
  s=$(extract_json_string sonnet "$prefs")
  h=$(extract_json_string haiku  "$prefs")
  [[ -n "$o" ]] && opus_default=$o
  [[ -n "$s" ]] && sonnet_default=$s
  [[ -n "$h" ]] && haiku_default=$h
fi

# Pin alias resolution to the IDs the gateway actually serves. Without this
# `/model sonnet` could resolve to an ID the gateway doesn't recognise.
export ANTHROPIC_DEFAULT_OPUS_MODEL=$opus_default
export ANTHROPIC_DEFAULT_SONNET_MODEL=$sonnet_default
export ANTHROPIC_DEFAULT_HAIKU_MODEL=$haiku_default

# Heartbeat to the webapp so the dashboard can show "claudio running" while
# this script is alive. Soft-fails if the webapp is down; the proxy is what
# actually matters and was already smoke-tested above.
session_id=$(cat /proc/sys/kernel/random/uuid 2>/dev/null \
  || uuidgen 2>/dev/null \
  || printf '%s-%s' "$$" "$(date +%s)")
webapp_base='http://127.0.0.1:3000'

heartbeat_post() {
  curl -fsS --max-time 2 -X POST -H 'Content-Type: application/json' \
    -d "{\"id\":\"$session_id\"}" "$webapp_base/api/session/heartbeat" \
    >/dev/null 2>&1 || true
}
heartbeat_post

# Capture parent PID so the subshell can die if we get SIGKILL'd (the trap
# below won't fire in that case).
parent_pid=$$
(
  while sleep 10; do
    kill -0 "$parent_pid" 2>/dev/null || exit 0
    heartbeat_post
  done
) &
hb_pid=$!

cleanup() {
  if [[ -n "${hb_pid:-}" ]]; then
    kill "$hb_pid" 2>/dev/null || true
    wait "$hb_pid" 2>/dev/null || true
  fi
  curl -fsS --max-time 1 -X POST -H 'Content-Type: application/json' \
    -d "{\"id\":\"$session_id\"}" "$webapp_base/api/session/end" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

# claude is in PATH already (Claude Code installs itself globally). Don't
# exec — we need the shell to stick around to run cleanup. Bash forwards
# SIGINT/SIGTERM to the foreground child, so signals still reach claude.
claude "$@"
