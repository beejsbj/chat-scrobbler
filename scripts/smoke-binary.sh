#!/bin/sh
# scripts/smoke-binary.sh
# Run a compiled chat-scrobbler binary against throwaway data dirs: prints help,
# then builds and lists an empty index, which exercises bun:sqlite FTS5.
# Usage: scripts/smoke-binary.sh dist/release/chat-scrobbler-linux-x64
set -eu

bin="$1"
chmod +x "$bin"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export HOME="$tmp/home"
export CHAT_SCROBBLER_CONFIG="$tmp/none.json"
export CANONICAL_DIR="$tmp/canonical"
export INDEX_PATH="$tmp/index/index.db"

"$bin" --help >/dev/null
"$bin" unify
"$bin" list
test -s "$INDEX_PATH"
echo "smoke: $bin ok"
