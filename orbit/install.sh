#!/usr/bin/env bash

set -e

ORBIT_ROOT="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.orbit"
BIN_DIR="$INSTALL_DIR/bin"
GLOBAL_ORBIT_BIN="$BIN_DIR/orbit"

echo "Installing Orbit..."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Please install Node.js 20+."
  exit 1
fi

mkdir -p "$BIN_DIR"

cd "$ORBIT_ROOT"

if command -v pnpm >/dev/null 2>&1; then
  pnpm install
  pnpm build
else
  npm install
  npm run build
fi

cat > "$GLOBAL_ORBIT_BIN" <<EOF
#!/usr/bin/env bash
node "$ORBIT_ROOT/dist/cli.js" "\$@"
EOF

chmod +x "$GLOBAL_ORBIT_BIN"

SHELL_NAME="$(basename "$SHELL")"

case "$SHELL_NAME" in
  zsh)
    PROFILE="$HOME/.zshrc"
    ;;
  bash)
    PROFILE="$HOME/.bashrc"
    ;;
  *)
    PROFILE="$HOME/.profile"
    ;;
esac

if ! grep -q 'export PATH="$HOME/.orbit/bin:$PATH"' "$PROFILE" 2>/dev/null; then
  echo '' >> "$PROFILE"
  echo '# Orbit CLI' >> "$PROFILE"
  echo 'export PATH="$HOME/.orbit/bin:$PATH"' >> "$PROFILE"
fi

echo ""
echo "Orbit installed."
echo ""
echo "Restart your terminal or run:"
echo '  export PATH="$HOME/.orbit/bin:$PATH"'
echo ""
echo "Then call:"
echo "  orbit"