#!/data/data/com.termux/files/usr/bin/sh
set -eu

APP_DIR="$HOME/local-"
cd "$APP_DIR"
exec node "$APP_DIR/start.js" "$@"
