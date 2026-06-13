#!/bin/sh
# chat-scrobbler installer.
#   curl -fsSL https://raw.githubusercontent.com/beejsbj/chat-scrobbler/main/install.sh | sh
#
# Downloads the prebuilt binary for your platform into ~/.local/bin and unpacks
# the browser extension into ~/.local/share/chat-scrobbler/extension. No sudo,
# no build step. Read it before you pipe it to a shell; that is the polite norm.
set -eu

REPO="beejsbj/chat-scrobbler"
BIN_DIR="${HOME}/.local/bin"
EXT_DIR="${HOME}/.local/share/chat-scrobbler/extension"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) echo "chat-scrobbler: unsupported OS '$os' (macOS and Linux only)"; exit 1 ;;
esac

case "$arch" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) echo "chat-scrobbler: unsupported arch '$arch'"; exit 1 ;;
esac

asset="chat-scrobbler-${os}-${arch}"
base="https://github.com/${REPO}/releases/latest/download"

echo "chat-scrobbler: installing ${asset}"
mkdir -p "$BIN_DIR" "$EXT_DIR"

# Binary
curl -fsSL "${base}/${asset}" -o "${BIN_DIR}/chat-scrobbler"
chmod +x "${BIN_DIR}/chat-scrobbler"

# Extension (unzip into a clean dir)
tmp="$(mktemp -d)"
curl -fsSL "${base}/extension.zip" -o "${tmp}/extension.zip"
rm -rf "${EXT_DIR}"
mkdir -p "${EXT_DIR}"
unzip -q "${tmp}/extension.zip" -d "${EXT_DIR}"
rm -rf "${tmp}"

echo "chat-scrobbler: installed to ${BIN_DIR}/chat-scrobbler"

case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) echo ""; echo "Add ${BIN_DIR} to your PATH, then restart your shell:";
     echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc" ;;
esac

cat <<EOF

Next:
  chat-scrobbler init      # scaffold data dirs + a starter config
  chat-scrobbler serve     # start the capture receiver + MCP endpoint
  chat-scrobbler connect   # MCP endpoint + how to wire it into Claude
  Load the extension unpacked from: ${EXT_DIR}
EOF
