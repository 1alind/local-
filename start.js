#!/data/data/com.termux/files/usr/bin/node
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const PID_FILE = path.join(ROOT, ".watchdog.pid");
const target = process.argv[2] === "--server-only" ? "server.js" : "watchdog.js";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const WATCHDOG = path.join(ROOT, "watchdog.js");
const SERVER = path.join(ROOT, "server.js");

function readProcess(pid) {
  try {
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    const executable = path.basename(args[0] || "");
    if (executable !== "node" && executable !== "nodejs") return null;
    return { pid, args };
  } catch {
    return null;
  }
}

function projectProcesses() {
  const found = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const info = readProcess(Number(entry));
    if (!info) continue;
    if (info.args.includes(WATCHDOG) || info.args.includes(SERVER)) found.push(info);
  }
  return found;
}

function portIsFree() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", error => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else reject(error);
    });
    probe.listen({ host: "0.0.0.0", port: PORT, exclusive: true }, () => {
      probe.close(error => error ? reject(error) : resolve(true));
    });
  });
}

async function waitForPortFree(timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await portIsFree()) return true;
    await sleep(250);
  }
  return portIsFree();
}

async function stopPreviousProjectServer() {
  const processes = projectProcesses();
  if (!processes.length) return;

  const watchdogs = processes.filter(p => p.args.includes(WATCHDOG));
  const servers = processes.filter(p => p.args.includes(SERVER));
  console.log("[start] Existing instance of this project found. Restarting only its server process tree.");

  // Stop the watchdog first. It will gracefully stop its own server child.
  for (const proc of watchdogs) {
    try {
      process.kill(proc.pid, "SIGTERM");
      console.log(`[start] Sent SIGTERM to this project's watchdog (PID ${proc.pid}).`);
    } catch {}
  }

  if (await waitForPortFree(7000)) {
    try { fs.unlinkSync(PID_FILE); } catch {}
    return;
  }

  // A server-only launch or an orphaned server has no watchdog to stop it.
  // Re-scan and signal only processes whose command line names this exact project file.
  const remaining = projectProcesses();
  for (const proc of remaining.filter(p => p.args.includes(SERVER))) {
    try {
      process.kill(proc.pid, "SIGTERM");
      console.log(`[start] Sent SIGTERM to this project's server.js (PID ${proc.pid}).`);
    } catch {}
  }

  if (await waitForPortFree(3000)) {
    try { fs.unlinkSync(PID_FILE); } catch {}
    return;
  }

  // Last resort: force-stop only this repository's exact server/watchdog processes.
  for (const proc of projectProcesses()) {
    if (!proc.args.includes(SERVER) && !proc.args.includes(WATCHDOG)) continue;
    try {
      process.kill(proc.pid, "SIGKILL");
      console.log(`[start] Force-stopped this project's process (PID ${proc.pid}).`);
    } catch {}
  }

  if (!(await waitForPortFree(3000))) {
    throw new Error(
      `Port ${PORT} is still occupied by a process that does not belong to this project. ` +
      "It was left untouched; no other Node.js process or Termux app was killed."
    );
  }
  try { fs.unlinkSync(PID_FILE); } catch {}
}

async function main() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("Invalid PORT value.");
  }

  console.log(`[start] Required port: ${PORT}`);
  if (!(await portIsFree())) await stopPreviousProjectServer();

  if (!(await portIsFree())) {
    throw new Error(`Port ${PORT} is still unavailable. No unrelated process was touched.`);
  }

  const child = spawn(process.execPath, [path.join(ROOT, target)], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: "inherit"
  });

  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`[start] Started ${target} (PID ${child.pid}) on port ${PORT}.`);

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
      if (fs.readFileSync(PID_FILE, "utf8").trim() === String(child.pid)) {
        fs.unlinkSync(PID_FILE);
      }
    } catch {}
    process.exitCode = code ?? (stopping ? 0 : signal ? 1 : 0);
  });
}

main().catch(error => {
  console.error("[start]", error.message);
  process.exitCode = 1;
});
