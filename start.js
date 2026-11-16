#!/data/data/com.termux/files/usr/bin/node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.PORT || 8787);
const PID_FILE = path.join(ROOT, ".watchdog.pid");
const target = process.argv[2] === "--server-only" ? "server.js" : "watchdog.js";

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}

function listeners() {
  const result = run("ss", ["-H", "-ltnp", "sport", "=", ":" + PORT]);
  if (result.error) throw new Error("Cannot run ss: " + result.error.message);
  return (result.stdout || "").trim();
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function clearPort() {
  console.log(`[start] Checking TCP port ${PORT}...`);

  // Stop this project's old watchdog first so it cannot respawn its HTTP server.
  run("pkill", ["-TERM", "-f", path.join(ROOT, "watchdog.js")]);

  let active = listeners();
  if (active) {
    console.log("[start] Existing listener(s):");
    console.log(active);

    // fuser targets only processes holding this TCP port.
    run("fuser", ["-k", "-TERM", `${PORT}/tcp`]);
    await sleep(2500);

    active = listeners();
    if (active) {
      console.log("[start] Listener did not exit after SIGTERM. Sending SIGKILL.");
      run("fuser", ["-k", "-KILL", `${PORT}/tcp`]);
      await sleep(500);
    }
  }

  active = listeners();
  if (active) {
    throw new Error(`Port ${PORT} is still occupied. Server not started:\\n${active}`);
  }
  console.log(`[start] Port ${PORT} is free.`);
}

async function main() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("Invalid PORT value.");
  for (const command of ["ss", "fuser", "pkill"]) {
    if (run("sh", ["-c", "command -v " + command]).status !== 0) {
      throw new Error(`Required Termux command not found: ${command}`);
    }
  }

  await clearPort();

  const child = spawn(process.execPath, [path.join(ROOT, target)], {
    cwd: ROOT, env: process.env, stdio: "inherit"
  });
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`[start] Starting ${target} (PID ${child.pid}).`);

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      try { child.kill(signal); } catch {}
    });
  }

  child.on("error", error => {
    console.error("[start] Could not launch:", error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    try {
      if (fs.readFileSync(PID_FILE, "utf8").trim() === String(child.pid)) fs.unlinkSync(PID_FILE);
    } catch {}
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

main().catch(error => {
  console.error("[start]", error.message);
  process.exitCode = 1;
});
