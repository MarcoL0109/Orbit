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

echo "Initialized the Orbit Configuration File"

# For testing purposes, I need to command the file checking if-statement in case we want to overwrite the project json file
# if [ ! -f "$PROJECT_FILE" ]; then
cat > "$PROJECT_FILE" << EOF
{
  "projects": []
}
EOF
# fi

echo "Initialized the Orbit Project File"

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
echo "Initialized the Orbit Preference File"

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

# Orbit's testing agent needs an OpenAI API key at runtime. Skip asking if
# it's already available one way or another — either set in this shell
# already, or persisted from a previous install run — so re-running
# install.sh is idempotent and never re-prompts. Only prompts when stdin is
# an actual interactive terminal ([ -t 0 ]); a non-interactive install
# (piped, scripted, CI) just gets the manual instructions instead of
# hanging on a read that will never receive input.
if [ -n "$OPENAI_API_KEY" ]; then
  echo "OPENAI_API_KEY is already set in your environment."
elif grep -q '^export OPENAI_API_KEY=' "$PROFILE" 2>/dev/null; then
  echo "OPENAI_API_KEY is already configured in $PROFILE."
elif [ -t 0 ]; then
  echo ""
  read -r -s -p "Enter your OpenAI API key (used by Orbit's testing agent — press Enter to skip): " ENTERED_API_KEY
  echo ""
  if [ -n "$ENTERED_API_KEY" ]; then
    echo '' >> "$PROFILE"
    echo '# Orbit OpenAI API key' >> "$PROFILE"
    echo "export OPENAI_API_KEY=\"$ENTERED_API_KEY\"" >> "$PROFILE"
    echo "Saved to $PROFILE."
  else
    echo "Skipped. Set it later with:"
    echo '  export OPENAI_API_KEY="your_key_here"'
  fi
else
  echo "OPENAI_API_KEY is not set. Set it before using Orbit:"
  echo '  export OPENAI_API_KEY="your_key_here"'
fi

echo ""
echo "Orbit installed."
echo ""
echo "This terminal won't see the PATH or API key changes yet — $PROFILE only"
echo "gets read when a shell starts. Restart your terminal, or run:"
echo "  source $PROFILE"
echo ""
echo "Then call:"
echo "  orbit"