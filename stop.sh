#!/data/data/com.termux/files/usr/bin/sh
set -u
APP_DIR="$HOME/local-"
PID_FILE="$APP_DIR/.watchdog.pid"

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID" 2>/dev/null || true
    echo "Stop signal sent to supervisor ($PID)."
  else
    echo "Supervisor is not running."
  fi
  rm -f "$PID_FILE"
else
  echo "No supervisor PID file found."
fi

if command -v termux-wake-unlock >/dev/null 2>&1; then
  termux-wake-unlock >/dev/null 2>&1 || true
fi
