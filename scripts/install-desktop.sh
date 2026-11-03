#!/bin/sh
# Adds Forge to the app menu and puts a `forge` command on the PATH. Undo: delete the two files it prints.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
chmod +x "$ROOT/scripts/forge"
ln -sf "$ROOT/scripts/forge" "$HOME/.local/bin/forge"
cat > "$HOME/.local/share/applications/forge.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Forge
GenericName=AI coding assistant
Comment=Chat with an AI that builds software on your PC
Exec=$HOME/.local/bin/forge
Icon=$ROOT/build/icon.svg
Terminal=false
Categories=Development;Utility;
StartupWMClass=forge
DESKTOP
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
echo "Installed:"
echo "  $HOME/.local/bin/forge"
echo "  $HOME/.local/share/applications/forge.desktop"
