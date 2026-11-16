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

async function main() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("Invalid PORT value.");
  }

  console.log(`[start] Required port: ${PORT}`);
  if (!(await portIsFree())) {
    throw new Error(
      `Port ${PORT} is already in use. Nothing was killed or restarted. ` +
      "Stop the existing instance of this project first, or identify the other process using this port."
    );
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
