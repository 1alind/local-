import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const ROOT = path.resolve("public");
const TOKEN_FILE = path.resolve(".local-token");
const MAX_BODY = 2048;
const MAX_OUTPUT = 60000;
let shuttingDown = false;
let updateInProgress = false;

function loadToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const value = fs.readFileSync(TOKEN_FILE, "utf8").trim();
      if (value.length >= 32) return value;
      throw new Error("Token file is invalid. Remove .local-token and restart.");
    }
    const value = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(TOKEN_FILE, value, { mode: 0o600, flag: "wx" });
    return value;
  } catch (error) {
    console.error("[startup] Cannot load token:", error.message);
    process.exit(1);
  }
}
const TOKEN = loadToken();

const COMMANDS = {
  pwd: ["pwd", []],
  list_home: ["ls", ["-lah", process.env.HOME || "."]],
  disk: ["df", ["-h", process.env.HOME || "."]],
  memory: ["free", ["-h"]],
  uptime: ["uptime", []],
  system: ["uname", ["-a"]],
  node: ["node", ["--version"]],
  npm: ["npm", ["--version"]],
  termux: ["termux-info", []]
};

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

function authorized(req) {
  const supplied = (req.headers.authorization || "").replace(/^Bearer /, "");
  const a = Buffer.from(supplied);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

function runSafeCommand(key, res) {
  const entry = COMMANDS[key];
  if (!entry) return reply(res, 400, { error: "Command is not in the allowed list" });

  const [program, args] = entry;
  let child;
  try {
    child = spawn(program, args, {
      cwd: process.env.HOME || process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    return reply(res, 500, { error: "Could not start command: " + error.message });
  }

  let stdout = "", stderr = "", finished = false, timedOut = false;
  const finish = (status, result) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    reply(res, status, result);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGTERM"); } catch {}
    const forceTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
    forceTimer.unref();
  }, 15000);
  timer.unref();

  child.stdout?.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-MAX_OUTPUT); });
  child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-MAX_OUTPUT); });
  child.on("error", error => finish(500, { error: error.message }));
  child.on("close", code => finish(200, {
    ok: code === 0 && !timedOut,
    code,
    timedOut,
    stdout,
    stderr
  }));
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
    if (!authorized(req)) return reply(res, 401, { error: "Enter the dashboard token" });

    if (req.method === "GET" && url.pathname === "/api/status") {
      return reply(res, 200, {
        online: true,
        device: os.hostname(),
        platform: os.platform() + " " + os.arch(),
        commands: Object.keys(COMMANDS),
        uptime: Math.floor(process.uptime())
      });
    }

    if (req.method === "POST" && url.pathname === "/api/update") {
      if (updateInProgress) return reply(res, 409, { error: "An update is already running." });
      updateInProgress = true;
      let updater;
      try {
        updater = spawn(process.execPath, [path.resolve("update.js")], {
          cwd: path.resolve("."),
          env: process.env,
          stdio: ["ignore", "ignore", "ignore"]
        });
      } catch (error) {
        updateInProgress = false;
        return reply(res, 500, { error: "Could not start updater: " + error.message });
      }
      updater.once("error", error => {
        updateInProgress = false;
        console.error("[update] Could not start updater:", error.message);
      });
      updater.once("exit", code => {
        updateInProgress = false;
        if (code !== 0) console.error("[update] Updater exited with code", code);
      });
      return reply(res, 202, { ok: true, message: "Update check started. The dashboard will reconnect if the server restarts." });
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      let data;
      try { data = await readBody(req); }
      catch (error) { return reply(res, 400, { error: error.message }); }
      return runSafeCommand(String(data.command || ""), res);
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
    res.writeHead(403).end("Forbidden");
    return;
  }

  let stat;
  try { stat = await fs.promises.stat(file); }
  catch { res.writeHead(404).end("Not found"); return; }
  if (!stat.isFile()) { res.writeHead(404).end("Not found"); return; }

  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon"
  };
  res.writeHead(200, {
    "Content-Type": types[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
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
    .filter(item => item.family === "IPv4" && !item.internal)
    .map(item => item.address);
  console.log("[server] LAN dashboard listening on port " + PORT);
  for (const ip of ips) console.log("http://" + ip + ":" + PORT);
  console.log("[server] Authentication token: " + TOKEN);
  console.log("[server] PID " + process.pid);
});
