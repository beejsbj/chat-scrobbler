#!/bin/zsh
set -euo pipefail

readonly repo="/Users/burooj/BJsWorkspace/Projects/chat-scrobbler"
readonly bun="/Users/burooj/.bun/bin/bun"
readonly snapshot="/Users/burooj/.local/share/chat-scrobbler/usage/snapshots/mac.json"
readonly remote_tmp="/tmp/usage-dashboard-mac-${UID}.json"

cd "$repo"
"$bun" run src/cli/chat-scrobbler.ts usage collect --device mac --incremental-days 7 --out "$snapshot"
/usr/bin/scp -q -o BatchMode=yes -o ConnectTimeout=15 "$snapshot" "bjslab:$remote_tmp"
/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=15 bjslab \
  "sudo install -o 999 -g 999 -m 600 '$remote_tmp' /mnt/server-ssd/chat-scrobbler/usage/snapshots/mac.json && rm '$remote_tmp'"
