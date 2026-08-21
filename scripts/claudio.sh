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

# Only used for ~/.claudio/config.json, which we write ourselves and which is
# flat — no jq dependency to install on the user's machine. Model defaults come
# back as plain KEY=value lines precisely so this never has to parse anything
# nested.
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

# Per-tier defaults. Nothing is hardcoded here: the webapp resolves each tier
# against the models the gateway is actually serving right now (which come from
# GitHub Copilot's live catalog) and returns them as KEY=value lines. We cache
# the answer so the wrapper still works when the proxy is up but the webapp
# hasn't finished booting.
defaults_cache=$HOME/.claudio/defaults.env
defaults_url='http://127.0.0.1:3000/api/preferences?format=env'
defaults=$(curl -fsS --max-time 2 "$defaults_url" 2>/dev/null || true)
if [[ -n "$defaults" ]]; then
  mkdir -p "$(dirname "$defaults_cache")"
  printf '%s\n' "$defaults" >"$defaults_cache"
elif [[ -f "$defaults_cache" ]]; then
  defaults=$(cat "$defaults_cache")
fi

# Here-string, not a pipe: the loop has to run in this shell for `export` to
# stick. Both key and value are validated so a mangled response can't inject
# arbitrary variables into claude's environment.
applied=0
while IFS='=' read -r key value; do
  [[ $key =~ ^ANTHROPIC_DEFAULT_[A-Z]+_MODEL$ ]] || continue
  [[ $value =~ ^[A-Za-z0-9._-]+$ ]] || continue
  export "$key=$value"
  applied=$((applied + 1))
done <<<"$defaults"

if (( applied == 0 )); then
  # Better to leave the vars unset than to pin an alias the gateway may not
  # serve - claude will at least fail with a name you recognise.
  echo "claudio: no model defaults available (control panel unreachable, nothing cached)." >&2
  echo "         '/model opus|sonnet|haiku' may not resolve; pass --model <alias> explicitly." >&2
fi

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
