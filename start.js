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
  // Avoid ss filter syntax differences between Android/Termux builds.
  const result = run("ss", ["-H", "-ltnp"]);
  if (result.error) throw new Error("Cannot run ss: " + result.error.message);
  if (result.status !== 0) {
    throw new Error("ss failed: " + (result.stderr || result.stdout || "unknown error").trim());
  }
  return (result.stdout || "").split("\n").filter(line => {
    const fields = line.trim().split(/\s+/);
    return fields.length >= 4 && fields[3].endsWith(":" + PORT);
  }).join("\n").trim();
}

function report(command, args, result) {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  console.log(`[start] ${command} ${args.join(" ")} => exit ${result.status ?? "unknown"}${output ? "\n" + output : ""}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function clearPort() {
  console.log(`[start] Checking TCP port ${PORT}...`);

  // Stop this project's supervisor first, otherwise it can respawn its server.
  const watchdog = run("pkill", ["-TERM", "-f", "watchdog[.]js"]);
  if (watchdog.status === 0) console.log("[start] Stopped existing watchdog process.");

  let active = listeners();
  if (active) {
    console.log("[start] Existing listener(s):\n" + active);

    // Termux fuser syntax: fuser -k -SIGNAL -n tcp PORT
    const term = run("fuser", ["-k", "-TERM", "-n", "tcp", String(PORT)]);
    report("fuser", ["-k", "-TERM", "-n", "tcp", String(PORT)], term);
    for (let i = 0; i < 25 && listeners(); i++) await sleep(100);

    active = listeners();
    if (active) {
      console.log("[start] Still listening. Escalating to SIGKILL.");
      const hard = run("fuser", ["-k", "-KILL", "-n", "tcp", String(PORT)]);
      report("fuser", ["-k", "-KILL", "-n", "tcp", String(PORT)], hard);
      await sleep(500);
    }
  }

  active = listeners();
  if (active) {
    throw new Error(`Port ${PORT} is STILL occupied. HTTP server will NOT start. Remaining listener:\n${active}`);
  }
  console.log(`[start] Verified: TCP port ${PORT} is free.`);
}

async function main() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("Invalid PORT value.");
  for (const command of ["ss", "fuser", "pkill"]) {
    const check = run("sh", ["-c", "command -v " + command]);
    if (check.status !== 0) throw new Error(`Required command not found: ${command}`);
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
