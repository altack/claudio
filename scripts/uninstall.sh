#!/usr/bin/env bash
# Remove the claudio wrapper. Does NOT touch the running container or volumes.
#
# Run `podman compose down -v` separately if you also want to stop the
# container and delete OAuth tokens / spend history.

set -euo pipefail

bin_dir=$HOME/.local/bin
cfg_dir=$HOME/.claudio

if [[ -f "$bin_dir/claudio" ]]; then
  rm -f "$bin_dir/claudio"
  echo "removed $bin_dir/claudio"
fi

# Drop the master key file too. Tokens themselves live in the container volume.
if [[ -d "$cfg_dir" ]]; then
  rm -rf "$cfg_dir"
  echo "removed $cfg_dir"
fi

# Strip the PATH guard block from rc files (between markers).
strip_block() {
  local rc=$1
  [[ -f "$rc" ]] || return 0
  if ! grep -qF '>>> claudio PATH >>>' "$rc"; then
    return 0
  fi
  tmp=$(mktemp)
  awk '
    /# >>> claudio PATH >>>/ { skip=1; next }
    /# <<< claudio PATH <<</ { skip=0; next }
    !skip
  ' "$rc" > "$tmp"
  mv "$tmp" "$rc"
  echo "removed PATH guard from $rc"
}

strip_block "$HOME/.bashrc"
strip_block "$HOME/.zshrc"

echo
echo "Wrapper uninstalled. The container is still running."
echo "To stop it and wipe tokens:    podman compose down -v"
