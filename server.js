import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const ROOT = path.resolve("public");
const MAX_BODY = 65536;
const MAX_INPUT = 32768;
const MAX_SESSIONS = 4;
const MAX_EVENT_BYTES = 256 * 1024;
const SESSION_IDLE_MS = 30 * 60 * 1000;
let shuttingDown = false;
let updateInProgress = false;
const sessions = new Map();

function reply(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  try {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Connection": "close"
    });
    res.end(JSON.stringify(value));
  } catch (error) {
    console.error("[http] Failed to send response:", error.message);
    res.destroy();
  }
}

function isPrivateAddress(address = "") {
  if (address.startsWith("::ffff:")) address = address.slice(7);
  return address === "127.0.0.1" || address === "::1" ||
    /^10\./.test(address) || /^192\.168\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
    /^fc[0-9a-f]{2}:/i.test(address) || /^fd[0-9a-f]{2}:/i.test(address) ||
    /^fe80:/i.test(address);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let settled = false;
    req.on("data", chunk => {
      if (settled) return;
      raw += chunk.toString("utf8");
      if (Buffer.byteLength(raw) > MAX_BODY) {
        settled = true;
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(raw || "{}")); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", error => {
      if (!settled) { settled = true; reject(error); }
    });
  });
}

function sendEvent(session, type, data = {}) {
  if (session.closed && type !== "exit") return;
  const event = { id: ++session.eventId, type, ...data };
  const encoded = JSON.stringify(event);
  session.events.push({ id: event.id, encoded, bytes: Buffer.byteLength(encoded) });
  session.eventBytes += Buffer.byteLength(encoded);
  while (session.events.length > 500 || session.eventBytes > MAX_EVENT_BYTES) {
    const removed = session.events.shift();
    session.eventBytes -= removed.bytes;
  }
  for (const response of session.clients) {
    try {
      response.write("id: " + event.id + "\ndata: " + encoded + "\n\n");
    } catch {}
  }
}

function touchSession(session) {
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    sendEvent(session, "notice", { text: "Session closed after 30 minutes of inactivity." });
    try { session.child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { session.child.kill("SIGKILL"); } catch {} }, 1500).unref();
  }, SESSION_IDLE_MS);
  session.idleTimer.unref();
}

function createTerminalSession(res) {
  if (sessions.size >= MAX_SESSIONS) return reply(res, 429, { error: "Maximum of 4 terminal sessions reached." });
  const id = randomUUID();
  const shell = process.env.SHELL || "bash";
  let child;
  try {
    child = spawn(shell, ["--noprofile", "--norc", "-i"], {
      cwd: process.env.HOME || process.cwd(),
      env: {
        ...process.env,
        TERM: process.env.TERM || "xterm-256color",
        PS1: "\\u@\\h:\\w\\$ ",
        HISTFILE: path.join(process.env.HOME || process.cwd(), ".local-lan-control-history")
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (error) {
    return reply(res, 500, { error: "Could not start Termux shell: " + error.message });
  }

  const session = {
    id, child, clients: new Set(), events: [], eventId: 0,
    eventBytes: 0, closed: false, idleTimer: null
  };
  sessions.set(id, session);
  touchSession(session);
  child.stdout.on("data", chunk => sendEvent(session, "output", { text: chunk.toString("utf8") }));
  child.stderr.on("data", chunk => sendEvent(session, "output", { text: chunk.toString("utf8") }));
  child.on("error", error => {
    sendEvent(session, "error", { text: "Shell error: " + error.message });
    session.closed = true;
    clearTimeout(session.idleTimer);
    sessions.delete(id);
  });
  child.on("close", (code, signal) => {
    sendEvent(session, "exit", { code, signal });
    session.closed = true;
    clearTimeout(session.idleTimer);
    for (const response of session.clients) {
      try { response.end(); } catch {}
    }
    session.clients.clear();
    setTimeout(() => sessions.delete(id), 60000).unref();
  });
  reply(res, 201, { ok: true, sessionId: id, shell });
}

function streamTerminal(req, res, url) {
  const session = sessions.get(url.searchParams.get("id") || "");
  if (!session) return reply(res, 404, { error: "Terminal session not found. Create a new session." });
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff"
  });
  res.flushHeaders?.();
  res.write(": connected\n\n");
  const lastId = Number(req.headers["last-event-id"] || 0);
  for (const event of session.events) {
    if (event.id > lastId) res.write("id: " + event.id + "\ndata: " + event.encoded + "\n\n");
  }
  session.clients.add(res);
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(": keepalive\n\n");
  }, 20000);
  heartbeat.unref();
  res.on("close", () => {
    clearInterval(heartbeat);
    session.clients.delete(res);
  });
}

function terminalInput(res, data, action) {
  const session = sessions.get(String(data.sessionId || ""));
  if (!session || session.closed || session.child.killed) return reply(res, 404, { error: "Terminal session is not running." });
  touchSession(session);
  if (action === "interrupt") {
    try { session.child.kill("SIGINT"); }
    catch (error) { return reply(res, 500, { error: error.message }); }
    return reply(res, 200, { ok: true });
  }
  if (typeof data.input !== "string" || data.input.length > MAX_INPUT) {
    return reply(res, 400, { error: "Input must be text under 32 KB." });
  }
  try {
    session.child.stdin.write(data.input);
    return reply(res, 200, { ok: true });
  } catch (error) {
    return reply(res, 500, { error: "Could not send input: " + error.message });
  }
}

function closeTerminal(res, data) {
  const session = sessions.get(String(data.sessionId || ""));
  if (!session) return reply(res, 200, { ok: true });
  clearTimeout(session.idleTimer);
  try { session.child.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { session.child.kill("SIGKILL"); } catch {} }, 1500).unref();
  return reply(res, 200, { ok: true });
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch(error => {
    console.error("[request] Unhandled request error:", error);
    reply(res, 500, { error: "Internal server error. The server is still running." });
  });
});

async function handleRequest(req, res) {
  let url;
  try { url = new URL(req.url, "http://localhost"); }
  catch { return reply(res, 400, { error: "Bad URL" }); }

  if (url.pathname.startsWith("/api/")) {
    if (!isPrivateAddress(req.socket.remoteAddress || "")) return reply(res, 403, { error: "Private network connections only" });

    if (req.method === "GET" && url.pathname === "/api/status") {
      return reply(res, 200, {
        online: true, device: os.hostname(),
        platform: os.platform() + " " + os.arch(),
        terminalSessions: sessions.size,
        uptime: Math.floor(process.uptime())
      });
    }
    if (req.method === "POST" && url.pathname === "/api/terminal/session") return createTerminalSession(res);
    if (req.method === "GET" && url.pathname === "/api/terminal/events") return streamTerminal(req, res, url);
    if (req.method === "POST" && url.pathname === "/api/terminal/input") {
      let data;
      try { data = await readBody(req); } catch (error) { return reply(res, 400, { error: error.message }); }
      return terminalInput(res, data, "input");
    }
    if (req.method === "POST" && url.pathname === "/api/terminal/interrupt") {
      let data;
      try { data = await readBody(req); } catch (error) { return reply(res, 400, { error: error.message }); }
      return terminalInput(res, data, "interrupt");
    }
    if (req.method === "POST" && url.pathname === "/api/terminal/close") {
      let data;
      try { data = await readBody(req); } catch (error) { return reply(res, 400, { error: error.message }); }
      return closeTerminal(res, data);
    }

    if (req.method === "GET" && url.pathname === "/api/update/status") {
      try {
        const statusFile = path.resolve("logs/update-status.json");
        const status = JSON.parse(await fs.promises.readFile(statusFile, "utf8"));
        return reply(res, 200, status);
      } catch {
        return reply(res, 200, { status: "idle", message: "No update has been run yet." });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/update") {
      if (updateInProgress) return reply(res, 409, { error: "An update is already running." });
      updateInProgress = true;
      let updater;
      try {
        updater = spawn(process.execPath, [path.resolve("update.js")], {
          cwd: path.resolve("."), env: process.env, stdio: ["ignore", "ignore", "ignore"]
        });
      } catch (error) {
        updateInProgress = false;
        return reply(res, 500, { error: "Could not start updater: " + error.message });
      }
      updater.once("error", error => {
        updateInProgress = false;
        console.error("[update] Could not start updater:", error.message);
        try {
          fs.mkdirSync("logs", { recursive: true });
          fs.writeFileSync("logs/update-status.json", JSON.stringify({
            status: "failed", message: "Could not start updater: " + error.message,
            updatedAt: new Date().toISOString()
          }, null, 2));
        } catch {}
      });
      updater.once("exit", code => {
        updateInProgress = false;
        if (code !== 0) console.error("[update] Updater exited with code", code);
      });
      return reply(res, 202, { ok: true, message: "Update check started. The terminal will reconnect if the server restarts." });
    }
    return reply(res, 404, { error: "Not found" });
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Allow": "GET, HEAD" }).end("Method not allowed");
    return;
  }
  let requested;
  try { requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1)); }
  catch { res.writeHead(400).end("Bad path"); return; }
  const file = path.resolve(ROOT, requested);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end("Forbidden"); return;
  }
  let stat;
  try { stat = await fs.promises.stat(file); } catch { res.writeHead(404).end("Not found"); return; }
  if (!stat.isFile()) { res.writeHead(404).end("Not found"); return; }
  const types = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
    ".png": "image/png", ".ico": "image/x-icon"
  };
  res.writeHead(200, {
    "Content-Type": types[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  });
  if (req.method === "HEAD") return res.end();
  const stream = fs.createReadStream(file);
  stream.on("error", error => {
    console.error("[static] File stream error:", error.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
}

server.on("clientError", (error, socket) => {
  console.warn("[http] Bad client request:", error.message);
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});
server.on("error", error => {
  console.error("[server] Fatal server error:", error);
  process.exitCode = 1;
  shutdown();
});
server.keepAliveTimeout = 5000;
server.headersTimeout = 10000;
server.requestTimeout = 20000;
server.maxHeadersCount = 50;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[server] Shutting down...");
  for (const session of sessions.values()) {
    clearTimeout(session.idleTimer);
    try { session.child.kill("SIGTERM"); } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("unhandledRejection", error => console.error("[process] Unhandled rejection:", error));
process.on("uncaughtException", error => {
  console.error("[process] Uncaught exception. Exiting so watchdog can restart:", error);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(Boolean)
    .filter(item => item.family === "IPv4" && !item.internal).map(item => item.address);
  console.log("[server] LAN terminal listening on port " + PORT);
  for (const ip of ips) console.log("http://" + ip + ":" + PORT);
  console.log("[server] PID " + process.pid);
});
