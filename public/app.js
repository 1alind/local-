const $ = id => document.getElementById(id);
let retryTimer = null;
let retryDelay = 2000;
let sessionId = null;
let events = null;
let creatingSession = false;
let sending = false;
const MAX_DISPLAY = 500000;

function setStatus(online, label) {
  $("status").classList.toggle("online", online);
  $("status").innerHTML = '<span class="dot"></span>' + label;
}
function appendOutput(value) {
  const output = $("output");
  output.textContent += value;
  if (output.textContent.length > MAX_DISPLAY) output.textContent = output.textContent.slice(-MAX_DISPLAY);
  output.scrollTop = output.scrollHeight;
}
function scheduleReconnect() {
  if (retryTimer || document.hidden) return;
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    try {
      await checkStatus();
      retryDelay = 2000;
      if (!sessionId && !creatingSession) await startTerminal();
      else if (sessionId && (!events || events.readyState === EventSource.CLOSED)) connectEvents();
    } catch {
      retryDelay = Math.min(retryDelay * 1.7, 30000);
      scheduleReconnect();
    }
  }, retryDelay);
}
async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(path, {
      ...options, signal: controller.signal,
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
  setStatus(true, "Termux connected");
  $("dashboard").classList.remove("hidden");
  return info;
}
function connectEvents() {
  if (!sessionId) return;
  if (events) events.close();
  events = new EventSource("/api/terminal/events?id=" + encodeURIComponent(sessionId));
  events.onopen = () => {
    setStatus(true, "Terminal connected");
    $("terminalHint").textContent = "Connected to the Termux shell. Output streams live.";
    $("command").focus();
  };
  events.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "output") appendOutput(message.text || "");
    else if (message.type === "notice" || message.type === "error") appendOutput("\n[" + message.text + "]\n");
    else if (message.type === "exit") {
      appendOutput("\n[Shell exited. Exit code: " + message.code + "]\n");
      sessionId = null;
      events.close();
      events = null;
      $("terminalHint").textContent = "Shell closed. Start a new terminal session.";
      $("start").disabled = false;
    }
  };
  events.onerror = () => {
    setStatus(false, "Reconnecting terminal…");
    $("terminalHint").textContent = "Connection interrupted. The browser is trying to reconnect…";
    scheduleReconnect();
  };
}
async function startTerminal() {
  if (creatingSession || sessionId) return;
  creatingSession = true;
  $("start").disabled = true;
  $("terminalHint").textContent = "Starting Termux shell…";
  try {
    const result = await api("/api/terminal/session", { method: "POST", body: "{}" });
    sessionId = result.sessionId;
    $("output").textContent = "";
    appendOutput("Connected to " + result.shell + "\n");
    connectEvents();
  } catch (error) {
    $("terminalHint").textContent = "Could not start shell: " + error.message;
    $("start").disabled = false;
    setStatus(false, "Terminal unavailable");
  } finally { creatingSession = false; }
}
async function sendInput(value) {
  if (!sessionId || sending || !value) return;
  sending = true;
  try {
    await api("/api/terminal/input", {
      method: "POST", body: JSON.stringify({ sessionId, input: value })
    });
  } catch (error) {
    appendOutput("\n[Input failed: " + error.message + "]\n");
    scheduleReconnect();
  } finally { sending = false; }
}
$("terminalForm").addEventListener("submit", event => {
  event.preventDefault();
  const field = $("command");
  const value = field.value;
  if (!value || !sessionId) return;
  field.value = "";
  sendInput(value + "\n");
});
$("command").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("terminalForm").requestSubmit();
  }
});
$("start").addEventListener("click", startTerminal);
$("interrupt").addEventListener("click", async () => {
  if (!sessionId) return;
  try { await api("/api/terminal/interrupt", { method: "POST", body: JSON.stringify({ sessionId }) }); }
  catch (error) { appendOutput("\n[Interrupt failed: " + error.message + "]\n"); }
});
$("clear").addEventListener("click", () => { $("output").textContent = ""; });
$("update").addEventListener("click", async () => {
  if (!confirm("Check GitHub for an update and install it if available? The server may restart.")) return;
  $("update").disabled = true;
  $("updateHint").textContent = "Checking GitHub and preparing the update…";
  try {
    const result = await api("/api/update", { method: "POST", body: "{}" });
    $("updateHint").textContent = result.message || "Update process started.";
  } catch (error) {
    $("updateHint").textContent = "Could not start update: " + error.message;
  } finally { $("update").disabled = false; }
});
window.addEventListener("online", scheduleReconnect);
window.addEventListener("offline", () => setStatus(false, "Network offline"));
window.addEventListener("error", event => appendOutput("\n[Dashboard error: " + (event.message || "unknown error") + "]\n"));
window.addEventListener("unhandledrejection", event => appendOutput("\n[Request failed: " + (event.reason?.message || "unknown error") + "]\n"));
setInterval(async () => {
  if (document.hidden) return;
  try { await checkStatus(); }
  catch { setStatus(false, "Phone offline"); scheduleReconnect(); }
}, 15000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    scheduleReconnect();
    if (sessionId && (!events || events.readyState === EventSource.CLOSED)) connectEvents();
  }
});
checkStatus().then(startTerminal).catch(() => {
  setStatus(false, "Phone offline");
  $("terminalHint").textContent = "Waiting for Termux…";
  scheduleReconnect();
});
