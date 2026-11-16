# Termux Web Terminal

A browser-based terminal for an Android phone running Termux. Open the page from another device on the same trusted Wi-Fi network, enter commands, and watch output stream back while commands run.

## Requirements

- Android with Termux
- Node.js 20 or newer
- Bash available in Termux (normally installed by default)
- Phone and browser device on the same private Wi-Fi network
- Optional: Termux:Boot for startup after reboot

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

Start the project with the shell launcher:

```sh
sh start.sh
```

The launcher starts the Node.js watchdog, which runs and monitors only this project's `server.js`. If port 8787 is already occupied, startup stops with an error. It does not kill other Node.js processes, Termux processes, or unrelated apps.

Open the LAN URL printed in Termux from another device on the same Wi-Fi network. The web page starts a shell session automatically.

## Using the terminal

- Enter commands in the box and press Enter.
- Output and errors stream into the terminal as they happen.
- Commands that ask for text input can receive it through the same input box.
- Use **Ctrl+C** to interrupt the current command.
- Use **New session** if the shell exits.
- Shift+Enter inserts a newline in the input box.

The shell runs as the Termux app user, with the same permissions and access as commands typed directly into Termux. This implementation connects to an interactive Bash process through pipes, not a real pseudo-terminal (PTY). Most command-line tools and text prompts work, but full-screen terminal programs or tools that require a real TTY (for example vim, nano, or interactive top) may not work correctly. Terminal escape sequences are displayed as text rather than rendered by a full terminal emulator.

## Update from the dashboard

Press **Check for updates**. The updater fetches the configured GitHub upstream and applies changes only with a fast-forward update. After a successful update, it signals only the running `server.js` process. The watchdog stays alive and starts a fresh `server.js` using the updated files. The shell launcher and watchdog are not restarted.

- Local changes are automatically backed up before updating and restored afterward. If restoration conflicts, the backup is retained rather than discarded.
- It does not run arbitrary downloaded shell scripts or install npm packages.
- Update details are appended to `logs/update.log`, and the dashboard displays checking, success, up-to-date, and failure states.
- A legacy `.local-token` file is ignored so it cannot block updates.

## Reliability

- `sh start.sh` (or `npm start`) starts the watchdog and the web server on port 8787.
- `npm run start:server` starts only the web server without the watchdog.
- If port 8787 is occupied, the launcher refuses to start and leaves every other process untouched.
- Termux:Boot uses the same launcher, so startup after reboot follows the same port check.
- The browser reconnects to the live output stream if the network briefly drops.
- Terminal sessions close after 30 minutes without input.
- Up to four shell sessions can exist at once.
- Android may still stop Termux due to battery management, force-stop, reboot, or low memory. Set Termux battery use to Unrestricted and use Termux:Boot if desired.

To stop the supervisor:

```sh
cd ~/local-
sh stop.sh
```

## Security warning

There is no login or token, as requested. **Any device on the same private LAN can execute arbitrary commands as the Termux app user.** This is substantially more powerful than the previous diagnostics-only dashboard. Do not use this on public/shared Wi-Fi, do not enable router port forwarding, and stop the server when you do not need remote access.

## Notes

- The server listens on port 8787 and rejects API requests from non-private IP ranges.
- The terminal uses Bash stdin/stdout pipes rather than a PTY, so it is a live command console but not a complete xterm replacement.
- No physical Android device test has been performed as part of these repository changes.
