#!/data/data/com.termux/files/usr/bin/node
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.PORT || 8787);
const PID_FILE = path.join(ROOT, ".watchdog.pid");
const target = process.argv[2] === "--server-only" ? "server.js" : "watchdog.js";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readProcess(pid) {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterName = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
    return { cmdline, ppid: Number(afterName[1]) };
  } catch {
    return null;
  }
}

function parentProcesses() {
  const parents = new Set([process.pid]);
  let pid = process.pid;
  for (let i = 0; i < 20; i++) {
    const info = readProcess(pid);
    if (!info || !info.ppid || parents.has(info.ppid)) break;
    parents.add(info.ppid);
    pid = info.ppid;
  }
  return parents;
}

function isNodeProcess(info) {
  if (!info?.cmdline?.length) return false;
  const executable = path.basename(info.cmdline[0]);
  return executable === "node" || executable === "nodejs";
}

function listNodeProcesses() {
  const protectedPids = parentProcesses();
  const found = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (protectedPids.has(pid)) continue;
    const info = readProcess(pid);
    if (!isNodeProcess(info)) continue;
    found.push({ pid, command: info.cmdline.join(" ") });
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

async function killTermuxNodeProcesses() {
  console.log("[start] Stopping existing Termux Node.js processes to free the port...");
  const processes = listNodeProcesses();

  for (const item of processes) {
    try {
      process.kill(item.pid, "SIGTERM");
      console.log(`[start] SIGTERM PID ${item.pid}: ${item.command}`);
    } catch (error) {
      if (error.code !== "ESRCH") console.log(`[start] Could not stop PID ${item.pid}: ${error.message}`);
    }
  }

  await sleep(1500);
  for (const item of processes) {
    try {
      process.kill(item.pid, 0);
      process.kill(item.pid, "SIGKILL");
      console.log(`[start] SIGKILL PID ${item.pid}`);
    } catch {}
  }

  // Also clean up the saved supervisor PID if it is still alive and belongs to this project.
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
      const info = readProcess(pid);
      if (info?.cmdline.join(" ").includes(ROOT)) {
        try { process.kill(pid, "SIGTERM"); } catch {}
      }
    }
  } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
}

async function main() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("Invalid PORT value.");

  console.log(`[start] Required port: ${PORT}`);
  if (!(await portIsFree())) {
    await killTermuxNodeProcesses();
  }

  let free = false;
  for (let i = 0; i < 20; i++) {
    if (await portIsFree()) { free = true; break; }
    await sleep(250);
  }
  if (!free) {
    throw new Error(
      `Port ${PORT} is still occupied. All other Termux Node.js processes were stopped, ` +
      "but the remaining listener is not a Node.js process or belongs to another Android app. " +
      "Android does not permit Termux to kill another app's process without root."
    );
  }

  const child = spawn(process.execPath, [path.join(ROOT, target)], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: "inherit"
  });
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`[start] Port ${PORT} is free. Starting ${target} (PID ${child.pid}).`);

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
    process.exitCode = code ?? (stopping ? 0 : signal ? 1 : 0);
  });
}

main().catch(error => {
  console.error("[start]", error.message);
  process.exitCode = 1;
});
