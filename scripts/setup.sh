#!/usr/bin/env bash
# One-shot setup for claudex on Linux / WSL.
#
# 1. Detects podman (preferred) or docker.
# 2. Verifies .env exists and has LITELLM_MASTER_KEY set.
# 3. Builds and starts the container.
# 4. Installs the claudex wrapper into ~/.local/bin and adds it to PATH.
# 5. Opens the control panel in your default browser.
#
# Re-running is safe; everything is idempotent.

set -euo pipefail

skip_browser=0
for arg in "$@"; do
  case "$arg" in
    --skip-browser) skip_browser=1 ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

# --- 1. Container CLI -------------------------------------------------------
detect_compose() {
  if command -v podman >/dev/null 2>&1; then
    if podman compose version >/dev/null 2>&1; then
      printf 'podman compose'
      return
    fi
    if command -v podman-compose >/dev/null 2>&1; then
      printf 'podman-compose'
      return
    fi
    echo "warn: podman found but no compose support. Install podman-compose (pip install podman-compose) or Podman Desktop." >&2
  fi
  if command -v docker >/dev/null 2>&1; then
    if docker compose version >/dev/null 2>&1; then
      printf 'docker compose'
      return
    fi
  fi
  echo "error: neither podman nor docker with compose support is installed." >&2
  exit 1
}

echo "[1/5] Detecting container CLI..."
compose=$(detect_compose)
echo "      using: $compose"

# --- 2. .env ----------------------------------------------------------------
echo "[2/5] Checking .env..."
env_file="$repo_root/.env"
if [[ ! -f "$env_file" ]]; then
  cp "$repo_root/.env.example" "$env_file"
  echo "      created .env from .env.example"
fi

read_master_key() {
  grep -E '^LITELLM_MASTER_KEY=' "$env_file" 2>/dev/null \
    | head -n1 \
    | cut -d= -f2- \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

mint_master_key() {
  if command -v openssl >/dev/null 2>&1; then
    printf 'sk-claudex-%s' "$(openssl rand -hex 24)"
  elif command -v xxd >/dev/null 2>&1; then
    printf 'sk-claudex-%s' "$(head -c 24 /dev/urandom | xxd -p -c 256)"
  else
    printf 'sk-claudex-%s' "$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
  fi
}

master_key=$(read_master_key)
if [[ -z "$master_key" || "$master_key" == "sk-claudex-change-me" ]]; then
  master_key=$(mint_master_key)
  if grep -qE '^LITELLM_MASTER_KEY=' "$env_file"; then
    tmp=$(mktemp)
    awk -v k="$master_key" '
      /^LITELLM_MASTER_KEY=/ { print "LITELLM_MASTER_KEY=" k; next }
      { print }
    ' "$env_file" > "$tmp"
    mv "$tmp" "$env_file"
  else
    printf 'LITELLM_MASTER_KEY=%s\n' "$master_key" >> "$env_file"
  fi
  echo "      minted a random LITELLM_MASTER_KEY in .env"
fi

# --- 3. Build & start -------------------------------------------------------
echo "[3/5] Building image (first time can take a few minutes)..."
$compose build

echo "[4/5] Starting container..."
$compose up -d

# --- 4. Wrapper -------------------------------------------------------------
echo "[5/5] Installing claudex wrapper..."
"$repo_root/scripts/install-claudex.sh" "$master_key"

# --- 5. Hand-off ------------------------------------------------------------
echo
echo "claudex is up."
echo "  Control panel: http://localhost:3000"
echo "  Proxy:         http://127.0.0.1:4000"
echo
echo "Next: open the control panel and click 'Sign in with GitHub' on /auth."
echo "      Then run 'claudex' from a fresh terminal."

if [[ "$skip_browser" -eq 0 ]]; then
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open http://localhost:3000 >/dev/null 2>&1 || true
  elif command -v wslview >/dev/null 2>&1; then
    wslview http://localhost:3000 >/dev/null 2>&1 || true
  fi
fi
