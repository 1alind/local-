const $ = id => document.getElementById(id);
let token = sessionStorage.getItem("lan-control-token") || "";

function setStatus(online, label) {
  $("status").classList.toggle("online", online);
  $("status").innerHTML = '<span class="dot"></span>' + label;
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token,
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error("Wrong token. Copy the token printed in Termux.");
  if (!response.ok) throw new Error(data.error || "Request failed: " + response.status);
  return data;
}
async function connect() {
  token = $("token").value.trim();
  if (!token) return;
  try {
    const info = await api("/api/status");
    sessionStorage.setItem("lan-control-token", token);
    $("login").classList.add("hidden");
    $("dashboard").classList.remove("hidden");
    $("device").textContent = "Device: " + info.device;
    $("platform").textContent = info.platform;
    setStatus(true, "Phone connected");
    $("output").textContent = "Connected. Select a diagnostic command.";
  } catch (error) {
    setStatus(false, "Connection failed");
    $("output").textContent = error.message;
    $("login").classList.remove("hidden");
  }
}
async function run(command, button) {
  const label = button.querySelector("strong").textContent;
  $("output").textContent = "Running " + label + "...";
  document.querySelectorAll(".cmd").forEach(item => item.disabled = true);
  try {
    const result = await api("/api/run", {
      method: "POST",
      body: JSON.stringify({ command })
    });
    const parts = [];
    if (result.stdout) parts.push(result.stdout.trimEnd());
    if (result.stderr) parts.push("[stderr]\n" + result.stderr.trimEnd());
    if (!parts.length) parts.push(result.ok ? "Command completed with no output." : "Command returned no output.");
    $("output").textContent = parts.join("\n\n") + "\n\nExit code: " + result.code;
  } catch (error) {
    $("output").textContent = error.message;
    if (/token/i.test(error.message)) {
      sessionStorage.removeItem("lan-control-token");
      $("dashboard").classList.add("hidden");
      $("login").classList.remove("hidden");
      setStatus(false, "Disconnected");
    }
  } finally {
    document.querySelectorAll(".cmd").forEach(item => item.disabled = false);
  }
}
$("connect").addEventListener("click", connect);
$("token").addEventListener("keydown", event => { if (event.key === "Enter") connect(); });
$("refresh").addEventListener("click", connect);
$("clear").addEventListener("click", () => $("output").textContent = "");
document.querySelectorAll(".cmd").forEach(button => {
  button.addEventListener("click", () => run(button.dataset.cmd, button));
});
if (token) {
  $("token").value = token;
  connect();
}
