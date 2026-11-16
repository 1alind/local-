# Local LAN Control

A LAN-only dashboard and supervised Node.js service for an Android phone running Termux. Open it from another device on the same Wi-Fi network.

## Requirements

- Android with Termux
- Node.js 20 or newer
- Phone and browser device on the same private Wi-Fi network
- Optional: Termux:Boot (install from the same trusted source as Termux) for automatic startup after reboot

No cloud account, domain, public hosting, database, or npm dependencies are required.

## Install

In Termux:

```sh
pkg update
pkg install nodejs git
git clone https://github.com/1alind/local-.git
cd local-
npm start
```

The watchdog starts the web server and restarts it if it exits. The first start creates `.local-token` and prints the private dashboard token. Keep it secret. Open the LAN URL printed in Termux from another device on the same Wi-Fi, then paste the token.

## Recovery and reliability

- `npm start` runs a supervisor that restarts the server after a crash, with a backoff delay.
- The supervisor checks the server health every 20 seconds and restarts it after repeated failed checks.
- HTTP request errors, malformed requests, missing files, command failures, and command timeouts are handled without intentionally taking down the server.
- The browser uses request timeouts and automatically retries a lost connection.
- Logs are written to the Termux session when started manually.

### Keep it running after you leave Termux

For Android background operation, run this once in Termux:

```sh
termux-wake-lock
```

Then open Android Settings and set **Termux** battery usage to **Unrestricted** (wording differs by Android version). Allow background activity and auto-start if your phone has those controls.

### Start automatically after Android reboot

1. Install the **Termux:Boot** companion app from the same trusted source as your Termux installation.
2. Open Termux:Boot once so Android registers it.
3. In Termux, run:

```sh
mkdir -p ~/.termux/boot
cp ~/local-/boot/start-local-control ~/.termux/boot/start-local-control
chmod +x ~/.termux/boot/start-local-control
```

4. Reboot the phone. Termux:Boot will start the supervisor, acquire a wake lock, and write logs to `~/local-/logs/supervisor.log`.

To inspect logs:

```sh
tail -n 100 ~/local-/logs/supervisor.log
```

To stop the background supervisor:

```sh
cd ~/local-
sh stop.sh
```

To run interactively again:

```sh
cd ~/local-
npm start
```

## Important Android limitation

No Termux app can guarantee 100% uptime. Android can still stop it if you force-stop Termux, the manufacturer aggressively kills background apps, the phone reboots without Termux:Boot working, storage is unavailable, or the device runs out of resources. The watchdog recovers Node server crashes while the supervisor itself is alive; Termux:Boot and battery settings improve recovery after reboot/background restrictions. Do not force-stop Termux if you want the service available.

## Security

- The server listens on the phone's LAN interfaces on port 8787.
- API access requires a random token stored in `.local-token`.
- API requests from non-private IP ranges are rejected.
- The first version exposes only a limited diagnostic command allowlist, not an unrestricted shell.
- Do not configure router port forwarding for port 8787. Avoid untrusted/public Wi-Fi.
- If the token is exposed, stop the service, delete `.local-token`, and restart to generate a new one.

## Available commands

- Current directory and home directory listing
- Storage and memory usage
- Uptime and system information
- Node.js and npm versions
- Termux diagnostics

This is the first supervised LAN version. New remote actions should be added through explicit, narrow allowlists rather than exposing arbitrary shell execution.
