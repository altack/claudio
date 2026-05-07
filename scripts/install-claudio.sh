#!/usr/bin/env bash
# Install the claudio wrapper into ~/.local/bin and persist its master key.
#
# Called by setup.sh, but also runnable on its own if you only want to
# refresh the wrapper after pulling repo changes. Idempotent.
#
# Usage: install-claudio.sh <master-key>

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $(basename "$0") <master-key>" >&2
  exit 2
fi
master_key=$1

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
src=$repo_root/scripts/claudio.sh

bin_dir=$HOME/.local/bin
cfg_dir=$HOME/.claudio
cfg_path=$cfg_dir/config.json

# 1. Drop the wrapper into ~/.local/bin/claudio (no extension on Linux).
mkdir -p "$bin_dir"
install -m 0755 "$src" "$bin_dir/claudio"
echo "[claudio] wrapper installed -> $bin_dir/claudio"

# 2. Persist the master key, mode 600.
mkdir -p "$cfg_dir"
chmod 700 "$cfg_dir"
umask 077
printf '{"master_key":"%s"}\n' "$master_key" > "$cfg_path"
chmod 600 "$cfg_path"
echo "[claudio] master key written -> $cfg_path"

# 3. Make sure ~/.local/bin is on PATH for both bash and zsh. Many distros
#    already add it via ~/.profile, but that only fires for login shells —
#    most terminal emulators open non-login interactive shells, so we guard
#    .bashrc / .zshrc directly. Marker comments let uninstall.sh remove it.
read -r -d '' path_block <<'EOF' || true
# >>> claudio PATH >>>
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH";; esac
# <<< claudio PATH <<<
EOF

ensure_in_rc() {
  local rc=$1
  [[ -e "$rc" ]] || touch "$rc"
  if grep -qF '>>> claudio PATH >>>' "$rc"; then
    echo "[claudio] PATH guard already in $rc"
  else
    printf '\n%s\n' "$path_block" >> "$rc"
    echo "[claudio] added PATH guard to $rc"
  fi
}

ensure_in_rc "$HOME/.bashrc"
ensure_in_rc "$HOME/.zshrc"

echo
echo "Done. Open a fresh terminal and try:"
echo "    claudio --version"
