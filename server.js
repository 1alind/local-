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
const TOKEN = fs.existsSync(TOKEN_FILE)
  ? fs.readFileSync(TOKEN_FILE, "utf8").trim()
  : crypto.randomBytes(32).toString("hex");

if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });

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
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}
function authorized(req) {
  const supplied = (req.headers.authorization || "").replace(/^Bearer /, "");
  const a = Buffer.from(supplied), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function local(address = "") {
  if (address.startsWith("::ffff:")) address = address.slice(7);
  return address === "127.0.0.1" || address === "::1" || /^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}
function body(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; if (raw.length > 2048) reject(new Error("Request too large")); });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("Invalid JSON")); } });
    req.on("error", reject);
  });
}
function runSafeCommand(key, res) {
  const entry = COMMANDS[key];
  if (!entry) return reply(res, 400, { error: "Command is not in the allowed list" });
  const [program, args] = entry;
  const child = spawn(program, args, { cwd: process.env.HOME || process.cwd(), env: process.env });
  let stdout = "", stderr = "";
  const timer = setTimeout(() => child.kill("SIGTERM"), 15000);
  child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-60000); });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-60000); });
  child.on("error", error => { clearTimeout(timer); reply(res, 500, { error: error.message }); });
  child.on("close", code => { clearTimeout(timer); reply(res, 200, { ok: code === 0, code, stdout, stderr }); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    if (!local(req.socket.remoteAddress)) return reply(res, 403, { error: "LAN only" });
    if (!authorized(req)) return reply(res, 401, { error: "Enter the dashboard token" });
    if (req.method === "GET" && url.pathname === "/api/status") {
      return reply(res, 200, { online: true, device: os.hostname(), platform: os.platform() + " " + os.arch(), commands: Object.keys(COMMANDS) });
    }
    if (req.method === "POST" && url.pathname === "/api/run") {
      try { const data = await body(req); return runSafeCommand(String(data.command || ""), res); }
      catch (error) { return reply(res, 400, { error: error.message }); }
    }
    return reply(res, 404, { error: "Not found" });
  }
  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(ROOT, requested);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end("Forbidden"); return; }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end("Not found"); return; }
  const type = path.extname(file) === ".html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, HOST, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(Boolean).filter(x => x.family === "IPv4" && !x.internal).map(x => x.address);
  console.log("LAN dashboard: ");
  for (const ip of ips) console.log("http://" + ip + ":" + PORT);
  console.log("Token: " + TOKEN);
  console.log("Keep Termux open. Ctrl+C stops the server.");
});
