#!/data/data/com.termux/files/usr/bin/sh
# Free the configured TCP port, then launch the supervisor.
set -eu

APP_DIR="$HOME/local-"
cd "$APP_DIR"

PORT="${PORT:-8787}"
PID_FILE="$APP_DIR/.watchdog.pid"
mkdir -p "$APP_DIR/logs"

if ! command -v ss >/dev/null 2>&1; then
  echo "[start] The 'ss' command is required to identify the process using port $PORT."
  echo "[start] Install it with: pkg install iproute2"
  exit 1
fi

port_rows() {
  ss -ltnp 2>/dev/null | awk -v suffix=":$PORT" 'NR > 1 && substr($4, length($4) - length(suffix) + 1) == suffix'
}

port_pids() {
  port_rows | sed -nE 's/.*pid=([0-9]+).*/\1/p' | awk '!seen[$0]++'
}

process_cmdline() {
  tr '\000' ' ' < "/proc/$1/cmdline" 2>/dev/null || true
}

stop_pid() {
  target_pid="$1"
  case "$target_pid" in
    ''|*[!0-9]*) return ;;
  esac
  [ "$target_pid" = "$$" ] && return
  if kill -0 "$target_pid" 2>/dev/null; then
    echo "[start] Sending SIGTERM to PID $target_pid"
    kill -TERM "$target_pid" 2>/dev/null || true
    count=0
    while kill -0 "$target_pid" 2>/dev/null && [ "$count" -lt 25 ]; do
      sleep 0.1
      count=$((count + 1))
    done
    if kill -0 "$target_pid" 2>/dev/null; then
      echo "[start] PID $target_pid did not exit; sending SIGKILL"
      kill -KILL "$target_pid" 2>/dev/null || true
    fi
  fi
}

# Stop an older supervisor started by this project, if its PID file is valid.
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  case "$OLD_PID" in
    ''|*[!0-9]*) ;;
    *)
      if kill -0 "$OLD_PID" 2>/dev/null; then
        OLD_CMD="$(process_cmdline "$OLD_PID")"
        case "$OLD_CMD" in
          *watchdog.js*) stop_pid "$OLD_PID" ;;
        esac
      fi
      ;;
  esac
  rm -f "$PID_FILE"
fi

# Free only listeners bound to this exact TCP port. If Termux cannot reveal
# their PIDs, stop rather than guessing and killing unrelated processes.
ROWS="$(port_rows)"
if [ -n "$ROWS" ]; then
  PIDS="$(printf '%s\n' "$ROWS" | sed -nE 's/.*pid=([0-9]+).*/\1/p' | awk '!seen[$0]++')"
  if [ -z "$PIDS" ]; then
    echo "[start] Port $PORT is occupied, but ss did not expose its PID."
    echo "[start] Refusing to kill an unidentified process."
    printf '%s\n' "$ROWS"
    exit 1
  fi

  for PID in $PIDS; do
    [ "$PID" = "$$" ] && continue
    PARENT_PID="$(ps -o ppid= -p "$PID" 2>/dev/null | tr -d ' ' || true)"
    if [ -n "$PARENT_PID" ]; then
      PARENT_CMD="$(process_cmdline "$PARENT_PID")"
      case "$PARENT_CMD" in
        *watchdog.js*) stop_pid "$PARENT_PID" ;;
      esac
    fi
    stop_pid "$PID"
  done
fi

# Wait briefly for the kernel to release the listening socket.
attempt=0
while [ -n "$(port_rows)" ] && [ "$attempt" -lt 30 ]; do
  sleep 0.1
  attempt=$((attempt + 1))
done
if [ -n "$(port_rows)" ]; then
  echo "[start] Port $PORT is still occupied. Server was not started."
  port_rows
  exit 1
fi

echo "[start] Port $PORT is free. Starting Local LAN Control..."
echo "$$" > "$PID_FILE"

case "${1:-}" in
  --server-only) exec node "$APP_DIR/server.js" ;;
  *) exec node "$APP_DIR/watchdog.js" ;;
esac
