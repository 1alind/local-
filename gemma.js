const statusEl = document.querySelector("#status");
const chatEl = document.querySelector("#chat");
const loadBtn = document.querySelector("#load");
const clearBtn = document.querySelector("#clear");
const fileInput = document.querySelector("#modelFile");
const form = document.querySelector("#form");
const promptEl = document.querySelector("#prompt");
const sendBtn = document.querySelector("#send");
const progressWrap = document.querySelector("#loadProgress");
const progressTrack = document.querySelector("#progressTrack");
const progressFill = document.querySelector("#progressFill");
const progressPhase = document.querySelector("#progressPhase");
const progressPercent = document.querySelector("#progressPercent");

let engine = null;
let conversation = null;
let loading = false;
let generating = false;
let webGpuReady = false;
let webGpuMessage = "Checking WebGPU support…";

function setStatus(message) { statusEl.textContent = message; }
function append(message) {
  chatEl.textContent += message;
  chatEl.scrollTop = chatEl.scrollHeight;
}
function setProgress(percent, phase, busy = true) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  progressWrap.hidden = false;
  progressFill.style.width = value + "%";
  progressFill.classList.toggle("busy", busy);
  progressTrack.setAttribute("aria-valuenow", String(value));
  progressPhase.textContent = phase;
  progressPercent.textContent = value + "%";
}
function resetProgress() {
  progressWrap.hidden = true;
  progressFill.style.width = "0%";
  progressFill.classList.remove("busy");
  progressTrack.setAttribute("aria-valuenow", "0");
}
function updateLoadState() {
  loadBtn.disabled = !fileInput.files?.[0] || !webGpuReady || loading || !!engine;
  if (fileInput.files?.[0] && !webGpuReady) {
    const file = fileInput.files[0];
    setStatus("Selected: " + file.name + " (" + (file.size / 1024 ** 3).toFixed(2) +
      " GB).\n\nCannot load yet: " + webGpuMessage);
  }
}

async function checkWebGPU() {
  if (!window.isSecureContext) {
    webGpuMessage = "This page is not running in a secure context. Open the HTTPS GitHub Pages URL.";
    setStatus(webGpuMessage);
    return false;
  }
  if (!navigator.gpu) {
    webGpuMessage = "WebGPU is unavailable in this browser. Use a current browser and device with WebGPU enabled.";
    setStatus(webGpuMessage);
    return false;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("No compatible GPU adapter was found.");
    const info = adapter.info || {};
    const name = [info.vendor, info.architecture, info.device].filter(Boolean).join(" ");
    webGpuMessage = "WebGPU ready" + (name ? " (" + name + ")" : "") + ".";
    setStatus(webGpuMessage + " Choose your .litertlm model file.");
    return true;
  } catch (error) {
    webGpuMessage = "WebGPU check failed: " + (error?.message || String(error));
    setStatus(webGpuMessage);
    return false;
  }
}

fileInput.addEventListener("change", () => {
  resetProgress();
  const file = fileInput.files?.[0];
  if (file && webGpuReady) {
    setStatus("Selected: " + file.name + " (" + (file.size / 1024 ** 3).toFixed(2) +
      " GB). The model stays on this device. Click Load selected model.");
  } else if (!file) {
    setStatus(webGpuMessage);
  }
  updateLoadState();
});

loadBtn.addEventListener("click", async () => {
  const file = fileInput.files?.[0];
  if (!file || loading || engine) return;
  loading = true;
  updateLoadState();
  setProgress(0, "Starting runtime…");
  setStatus("Preparing to load " + file.name + " locally. The model is not uploaded.");
  try {
    const { Engine } = await import("https://cdn.jsdelivr.net/npm/@litert-lm/core/+esm");
    setProgress(0, "Reading model file…");
    let bytesRead = 0;
    const modelStream = file.stream().pipeThrough(new TransformStream({
      transform(chunk, controller) {
        bytesRead += chunk.byteLength;
        const percent = file.size ? Math.min(90, (bytesRead / file.size) * 90) : 90;
        setProgress(percent, "Reading model file (" + (bytesRead / 1024 ** 3).toFixed(2) +
          " / " + (file.size / 1024 ** 3).toFixed(2) + " GB)…");
        controller.enqueue(chunk);
      }
    }));
    engine = await Engine.create({ model: modelStream });
    setProgress(96, "Preparing chat session…");
    conversation = await engine.createConversation();
    setProgress(100, "Model ready", false);
    setStatus("Model loaded. Prompts are processed locally in this browser.");
    promptEl.disabled = false;
    sendBtn.disabled = false;
    loadBtn.textContent = "Model loaded";
  } catch (error) {
    console.error("[Gemma] Model load failed:", error);
    if (engine) {
      try { await engine.delete(); } catch {}
      engine = null;
    }
    setStatus("Model failed to load:\n" + (error?.stack || error?.message || String(error)) +
      "\n\nCheck that you selected the Gemma 4 E2B WEB .litertlm file, WebGPU is available, and the device has enough memory.");
    updateLoadState();
  } finally {
    loading = false;
  }
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  const prompt = promptEl.value.trim();
  if (!conversation || !prompt || generating) return;
  promptEl.value = "";
  generating = true;
  sendBtn.disabled = true;
  append("\n\nYou: " + prompt + "\nGemma: ");
  try {
    for await (const chunk of conversation.sendMessageStreaming(prompt)) {
      for (const item of chunk.content || []) {
        if (item.type === "text" || typeof item.text === "string") append(item.text || "");
      }
    }
  } catch (error) {
    append("\n[Generation failed: " + (error?.message || String(error)) + "]");
    console.error("[Gemma] Generation failed:", error);
  } finally {
    generating = false;
    sendBtn.disabled = false;
    promptEl.focus();
  }
});

clearBtn.addEventListener("click", () => {
  chatEl.textContent = "Chat display cleared. The loaded model and conversation remain in memory.";
});

window.addEventListener("pagehide", () => {
  if (engine) engine.delete().catch(() => {});
});

webGpuReady = await checkWebGPU();
updateLoadState();
