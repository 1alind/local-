import { spawn } from "node:child_process";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(ROOT, "server.js");
const PORT = Number(process.env.PORT || 8787);
let child = null, stopping = false, failures = 0, restartDelay = 1000;
let restartTimer = null, healthTimer = null, consecutiveHealthFailures = 0;

function log(...args) { console.log(new Date().toISOString(), "[watchdog]", ...args); }

function healthCheck() {
  const request = http.get({
    host: "127.0.0.1", port: PORT, path: "/api/status", timeout: 4000
  }, response => {
    response.resume();
    if (response.statusCode === 200) consecutiveHealthFailures = 0;
    else consecutiveHealthFailures++;
  });
  request.on("timeout", () => request.destroy(new Error("Health check timed out")));
  request.on("error", error => {
    consecutiveHealthFailures++;
    log("Health check failed:", error.message);
  });
  request.on("close", () => {
    if (consecutiveHealthFailures >= 3 && child && !stopping) {
      log("3 failed health checks. Restarting server.");
      consecutiveHealthFailures = 0;
      try { child.kill("SIGKILL"); } catch {}
    }
  });
}

function startServer() {
  if (stopping) return;
  log("Starting server...");
  const current = spawn(process.execPath, [SERVER], { cwd: ROOT, env: process.env, stdio: "inherit" });
  child = current;
  const startedAt = Date.now();
  current.on("error", error => log("Could not start server:", error.message));
  current.on("exit", (code, signal) => {
    if (child === current) child = null;
    if (stopping) return;
    if (Date.now() - startedAt > 60000) restartDelay = 1000;
    failures++;
    const delay = Math.min(restartDelay, 30000);
    restartDelay = Math.min(restartDelay * 2, 30000);
    log("Server exited (code:", code, "signal:", signal, "). Restart", failures, "in", delay, "ms.");
    restartTimer = setTimeout(startServer, delay);
  });
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  log("Stopping supervisor...");
  clearTimeout(restartTimer);
  clearInterval(healthTimer);
  if (!child) return process.exit(0);
  const current = child;
  const killTimer = setTimeout(() => { try { current.kill("SIGKILL"); } catch {} }, 4000);
  killTimer.unref();
  current.once("exit", () => { clearTimeout(killTimer); process.exit(0); });
  try { current.kill(signal); } catch { process.exit(0); }
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("uncaughtException", error => {
  log("Supervisor exception:", error);
  stop("SIGTERM");
  setTimeout(() => process.exit(1), 4500).unref();
});
process.on("unhandledRejection", error => log("Unhandled rejection:", error));

log("Supervisor started. PID", process.pid);
startServer();
healthTimer = setInterval(healthCheck, 20000);
healthTimer.unref();
