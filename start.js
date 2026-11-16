#!/data/data/com.termux/files/usr/bin/node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.PORT || 8787);
const PID_FILE = path.join(ROOT, ".watchdog.pid");
const target = process.argv[2] === "--server-only" ? "server.js" : "watchdog.js";

function listeningSocketInodes() {
  const wanted = PORT.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let rows;
    try { rows = fs.readFileSync(table, "utf8").trim().split("\n").slice(1); }
    catch { continue; }
    for (const row of rows) {
      const fields = row.trim().split(/\s+/);
      if (fields.length >= 10 && fields[1]?.toUpperCase().endsWith(":" + wanted) && fields[3] === "0A") {
        inodes.add(fields[9]);
      }
    }
  }
  return inodes;
}

function findOwners(inodes) {
  const owners = new Set();
  if (!inodes.size) return owners;
  let pids = [];
  try { pids = fs.readdirSync("/proc").filter(name => /^\d+$/.test(name)); } catch {}
  for (const pid of pids) {
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link;
      try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      const match = /^socket:\[(\d+)\]$/.exec(link);
      if (match && inodes.has(match[1])) owners.add(Number(pid));
    }
  }
  return owners;
}

function processInfo(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const tail = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const ppid = Number(tail[1]);
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    return { ppid, cmd };
  } catch { return null; }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function stopPid(pid) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await sleep(100);
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
}

async function clearPort() {
  console.log(`[start] Checking TCP port ${PORT}...`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const owners = findOwners(listeningSocketInodes());
    if (!owners.size) return;

    const toStop = new Set();
    for (const owner of owners) {
      toStop.add(owner);
      let current = owner;
      for (let depth = 0; depth < 8; depth++) {
        const info = processInfo(current);
        if (!info || !info.ppid || info.ppid === current) break;
        if (info.cmd.includes("watchdog.js")) {
          toStop.add(current);
          break;
        }
        current = info.ppid;
      }
    }

    for (const pid of toStop) {
      const info = processInfo(pid);
      console.log(`[start] Stopping PID ${pid}${info?.cmd ? " (" + info.cmd.trim().slice(0, 100) + ")" : ""}`);
    }
    // Stop watchdogs first so they cannot respawn the listener.
    const ordered = [...toStop].sort((a, b) => {
      const ac = processInfo(a)?.cmd.includes("watchdog.js") ? 0 : 1;
      const bc = processInfo(b)?.cmd.includes("watchdog.js") ? 0 : 1;
      return ac - bc;
    });
    for (const pid of ordered) await stopPid(pid);
    await sleep(300);
  }

  const remaining = findOwners(listeningSocketInodes());
  if (remaining.size) {
    throw new Error(`Port ${PORT} is still occupied by PID(s): ${[...remaining].join(", ")}. Server not started.`);
  }
}

async function main() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("Invalid PORT value.");
  await clearPort();

  const child = spawn(process.execPath, [path.join(ROOT, target)], {
    cwd: ROOT, env: process.env, stdio: "inherit"
  });
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`[start] Port ${PORT} is clear. Started ${target} (PID ${child.pid}).`);

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
