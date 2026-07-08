#!/usr/bin/env bash

set -e

ORBIT_ROOT="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.orbit"
BIN_DIR="$INSTALL_DIR/bin"
GLOBAL_ORBIT_BIN="$BIN_DIR/orbit"
CONFIG_FILE="$INSTALL_DIR/config.json"
PROJECT_FILE="$INSTALL_DIR/projects.json"
PREFERENCE_FILE="$INSTALL_DIR/memory/preference.md"


echo "Installing Orbit..."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Please install Node.js 20+."
  exit 1
fi

mkdir -p "$BIN_DIR"
mkdir -p "$INSTALL_DIR/memory"

cd "$ORBIT_ROOT"

if command -v pnpm >/dev/null 2>&1; then
  pnpm install
  pnpm build
else
  npm install
  npm run build
fi

if [ ! -f "$CONFIG_FILE" ]; then
  cat > "$CONFIG_FILE" << EOF
{
  "version": 1,
  "approvalMode": "ask",
  "defaultBrowser": "chromium",
  "defaultModel": "gpt-5.2",
  "telemetry": false,
  "lastOpenedProject": null
}
EOF
fi

ECHO "Initialized the Orbit Configuration File"

# if [ ! -f "$PROJECT_FILE" ]; then
cat > "$PROJECT_FILE" << EOF
{
  "projects": []
}
EOF
# fi

ECHO "Initialized the Orbit Project File"

if [ ! -f "$PREFERENCE_FILE" ]; then
  cat > "$PREFERENCE_FILE" << 'EOF'
# Orbit User Preferences

## QA Preferences

- Prefer Playwright tests.
- Prefer role-based selectors.
- Ask before modifying files.
- Ask before running commands.

## Style

- Keep generated test files simple.
- Explain risky changes before applying them.
EOF
fi
ECHO "Initialized the Orbit Preference File"

cat > "$GLOBAL_ORBIT_BIN" << EOF
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