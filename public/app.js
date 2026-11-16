const $ = id => document.getElementById(id);
let retryTimer = null;
let retryDelay = 2000;
let busy = false;

function setStatus(online, label) {
  $("status").classList.toggle("online", online);
  $("status").innerHTML = '<span class="dot"></span>' + label;
}
function scheduleReconnect() {
  if (retryTimer) return;
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    try { await checkStatus(); retryDelay = 2000; }
    catch { retryDelay = Math.min(retryDelay * 1.7, 30000); scheduleReconnect(); }
  }, retryDelay);
}
async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(path, {
      ...options,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed: " + response.status);
    return data;
  } finally { clearTimeout(timeout); }
}
async function checkStatus() {
  const info = await api("/api/status");
  $("device").textContent = "Device: " + (info.device || "Android");
  $("platform").textContent = info.platform || "";
  setStatus(true, "Phone connected");
  $("dashboard").classList.remove("hidden");
  return info;
}

async function run(command, button) {
  if (busy) return;
  busy = true;
  $("output").textContent = "Running " + button.querySelector("strong").textContent + "...";
  document.querySelectorAll(".cmd").forEach(item => item.disabled = true);
  try {
    const result = await api("/api/run", { method: "POST", body: JSON.stringify({ command }) });
    const parts = [];
    if (result.stdout) parts.push(result.stdout.trimEnd());
    if (result.stderr) parts.push("[stderr]\n" + result.stderr.trimEnd());
    if (!parts.length) parts.push(result.ok ? "Command completed with no output." : "Command returned no output.");
    if (result.timedOut) parts.push("Command timed out and was stopped.");
    $("output").textContent = parts.join("\n\n") + "\n\nExit code: " + result.code;
    setStatus(true, "Phone connected");
  } catch (error) {
    $("output").textContent = error.name === "AbortError" ? "The request timed out. The phone may be busy or disconnected." : error.message;
    setStatus(false, "Reconnecting…");
    scheduleReconnect();
  } finally {
    busy = false;
    document.querySelectorAll(".cmd").forEach(item => item.disabled = false);
  }
}
$("refresh").addEventListener("click", async () => {
  try { await checkStatus(); $("output").textContent = "Connection is healthy."; }
  catch { setStatus(false, "Phone offline"); scheduleReconnect(); }
});
$("update").addEventListener("click", async () => {
  if (busy) return;
  if (!confirm("Check GitHub for an update and install it if available? The server may restart.")) return;
  busy = true;
  $("update").disabled = true;
  $("updateHint").textContent = "Checking GitHub and preparing the update…";
  $("output").textContent = "Update check started. Keep the phone and Termux running.";
  try {
    const result = await api("/api/update", { method: "POST", body: "{}" });
    $("updateHint").textContent = result.message || "Update process started.";
    $("output").textContent = result.message || "Update process started. The dashboard will reconnect after a restart.";
  } catch (error) {
    $("updateHint").textContent = "Could not start update: " + error.message;
    $("output").textContent = error.message;
  } finally {
    busy = false;
    $("update").disabled = false;
  }
});
$("clear").addEventListener("click", () => $("output").textContent = "");
document.querySelectorAll(".cmd").forEach(button => button.addEventListener("click", () => run(button.dataset.cmd, button)));
window.addEventListener("online", () => { scheduleReconnect(); });
window.addEventListener("offline", () => setStatus(false, "Network offline"));
window.addEventListener("error", event => { $("output").textContent = "Dashboard error: " + (event.message || "unknown error") + ". Refresh the page if needed."; });
window.addEventListener("unhandledrejection", event => { $("output").textContent = "Dashboard request failed: " + (event.reason?.message || "unknown error"); });
setInterval(async () => {
  if (busy || document.hidden) return;
  try { await checkStatus(); }
  catch { setStatus(false, "Phone offline"); scheduleReconnect(); }
}, 15000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scheduleReconnect();
});
checkStatus().catch(() => { setStatus(false, "Phone offline"); scheduleReconnect(); });
