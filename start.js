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

async function clearPort() {
  console.log(`[start] Checking TCP port ${PORT}...`);

  // First stop the supervisor recorded by this project.
  try {
    const oldPid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    signalOwnedPid(oldPid, "SIGTERM");
  } catch {}

  // Also stop orphaned processes belonging to this exact project directory.
  // pkill is used only with this project's full script paths, never by port number.
  for (const script of ["watchdog.js", "server.js"]) {
    const pattern = path.join(ROOT, script).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const result = await new Promise(resolve => {
      const child = spawn("pkill", ["-TERM", "-f", pattern], { stdio: "ignore" });
      child.once("error", () => resolve(null));
      child.once("exit", code => resolve(code));
    });
    if (result === 0) console.log(`[start] Stopped old ${script} process(es).`);
  }

  for (let i = 0; i < 40; i++) {
    if (await portIsFree()) {
      try { fs.unlinkSync(PID_FILE); } catch {}
      console.log(`[start] Verified: port ${PORT} is free.`);
      return;
    }
    await sleep(250);
  }

  throw new Error(
    `Port ${PORT} is still occupied after stopping this project's old processes.\n` +
    "Android does not allow this app to inspect or kill arbitrary socket owners. " +
    "The remaining listener is not confirmed to belong to this project, so it was left untouched."
  );
}

async function main() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("Invalid PORT value.");
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
    process.exitCode = code ?? (stopping ? 0 : signal ? 1 : 0);
  });
}

main().catch(error => {
  console.error("[start]", error.message);
  process.exitCode = 1;
});
