#!/data/data/com.termux/files/usr/bin/sh
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$APP_DIR"

# The Node launcher starts the watchdog. Updates restart only server.js;
# the watchdog and this shell-launched supervisor stay alive.
exec node "$APP_DIR/start.js" "$@"
