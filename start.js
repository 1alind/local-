#!/data/data/com.termux/files/usr/bin/node
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DEFAULT_PORT = Number(process.env.PORT || 8787);
const PID_FILE = path.join(ROOT, ".watchdog.pid");
const target = process.argv[2] === "--server-only" ? "server.js" : "watchdog.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function processCommandLine(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return "";
  }
}

function signalOwnedPid(pid, signal) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  const commandLine = processCommandLine(pid);
  if (!commandLine || !commandLine.includes(ROOT)) return false;
  if (!/(watchdog|server)\.js(?:\s|$)/.test(commandLine)) return false;
  try {
    process.kill(pid, signal);
    console.log(`[start] Sent ${signal} to our process PID ${pid}: ${commandLine}`);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") console.log(`[start] Could not signal PID ${pid}: ${error.message}`);
    return false;
  }
}

function portIsFree(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", error => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else reject(error);
    });
    probe.listen({ host: "0.0.0.0", port, exclusive: true }, () => {
      probe.close(error => error ? reject(error) : resolve(true));
    });
  });
}

async function stopOldProjectProcesses() {
  try {
    const oldPid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    signalOwnedPid(oldPid, "SIGTERM");
  } catch {}

  for (const script of ["watchdog.js", "server.js"]) {
    const pattern = path.join(ROOT, script).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await new Promise(resolve => {
      const child = spawn("pkill", ["-TERM", "-f", pattern], { stdio: "ignore" });
      child.once("error", () => resolve());
      child.once("exit", code => {
        if (code === 0) console.log(`[start] Stopped old ${script} process(es).`);
        resolve();
      });
    });
  }
}

async function choosePort() {
  if (!Number.isInteger(DEFAULT_PORT) || DEFAULT_PORT < 1 || DEFAULT_PORT > 65535) {
    throw new Error("Invalid PORT value.");
  }

  console.log(`[start] Checking preferred port ${DEFAULT_PORT}...`);
  if (await portIsFree(DEFAULT_PORT)) return DEFAULT_PORT;

  console.log(`[start] Port ${DEFAULT_PORT} is occupied. Searching ${DEFAULT_PORT + 1}-${Math.min(DEFAULT_PORT + 20, 65535)}...`);
  for (let port = DEFAULT_PORT + 1; port <= Math.min(DEFAULT_PORT + 20, 65535); port++) {
    if (await portIsFree(port)) return port;
  }
  throw new Error(`Ports ${DEFAULT_PORT}-${Math.min(DEFAULT_PORT + 20, 65535)} are all occupied. No server was started.`);
}

async function main() {
  await stopOldProjectProcesses();

  let selectedPort = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    selectedPort = await choosePort();
    if (await portIsFree(selectedPort)) break;
    selectedPort = null;
    await sleep(100);
  }
  if (!selectedPort) throw new Error("Could not reserve a free port.");

  const childEnv = { ...process.env, PORT: String(selectedPort) };
  fs.writeFileSync(path.join(ROOT, ".active-port"), String(selectedPort));
  const child = spawn(process.execPath, [path.join(ROOT, target)], {
    cwd: ROOT, env: childEnv, stdio: "inherit"
  });
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`[start] Starting ${target} on port ${selectedPort} (PID ${child.pid}).`);

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
