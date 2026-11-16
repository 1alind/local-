# Local LAN Control

A small LAN-only dashboard for a Node.js server running in Termux on Android. Open the dashboard from another device connected to the same Wi-Fi and run the included diagnostic commands.

## Requirements

- Android with Termux
- Node.js 20 or newer
- The phone and browser device connected to the same Wi-Fi network

No cloud account, domain, public hosting, database, or npm dependencies are required.

## Install on Termux

```sh
pkg update
pkg install nodejs git
git clone https://github.com/1alind/local-.git
cd local-
npm start
```

The first start creates a private `.local-token` file and prints the token in Termux. Keep it private. The server also prints one or more local URLs, for example:

```
http://192.168.1.50:8787
```

Open that URL in a browser on another device connected to the same Wi-Fi. Paste the token from Termux into the dashboard.

To stop the server, press Ctrl+C in Termux. To start it again later:

```sh
cd ~/local-
npm start
```

## Security

- The server binds to the LAN interfaces on port 8787.
- API requests require the random token generated on first start.
- API requests from non-private IP ranges are rejected.
- The first version intentionally exposes only a small list of diagnostic commands. It does not provide an unrestricted remote shell.
- Do not configure router port forwarding for port 8787. Do not use this on public or untrusted Wi-Fi.
- Keep `.local-token` private. If it is exposed, stop the server, delete `.local-token`, and restart to generate a new token.

## Current commands

- Current working directory
- List Termux home directory
- Disk usage
- Memory usage
- Uptime
- System information
- Node.js version
- npm version
- Termux diagnostics

This is a starter LAN control panel. Additional actions can be added deliberately as the project grows.
