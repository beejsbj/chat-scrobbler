#!/bin/sh
set -eu
# Run on the matching Bun release: this repo's baseline was verified on 1.3.14.
export PATH="$HOME/.bun/bin:$PATH"
curl -fsSL https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip -o /tmp/bjs-548-bun.zip
python3 - <<'PY'
import zipfile
with zipfile.ZipFile('/tmp/bjs-548-bun.zip') as archive:
    archive.extractall('/tmp/bjs-548-bun')
PY
chmod +x /tmp/bjs-548-bun/bun-linux-x64/bun
export PATH="/tmp/bjs-548-bun/bun-linux-x64:$PATH"
bun --version
bun install --frozen-lockfile
if [ "$#" -gt 0 ]; then
  bun "$@"
  exit
fi
bun test
bun x tsc --noEmit
python3 -m unittest discover -s services/embedder/tests -v
