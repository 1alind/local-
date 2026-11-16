const statusEl = document.querySelector("#status");
const chatEl = document.querySelector("#chat");
const loadBtn = document.querySelector("#load");
const clearBtn = document.querySelector("#clear");
const fileInput = document.querySelector("#modelFile");
const form = document.querySelector("#form");
const promptEl = document.querySelector("#prompt");
const sendBtn = document.querySelector("#send");

let engine = null;
let conversation = null;
let loading = false;
let generating = false;
let webGpuReady = false;

function setStatus(message) { statusEl.textContent = message; }
function append(message) {
  chatEl.textContent += message;
  chatEl.scrollTop = chatEl.scrollHeight;
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  loadBtn.disabled = !file || !webGpuReady || loading || !!engine;
  if (file) {
    const size = (file.size / (1024 ** 3)).toFixed(2);
    setStatus("Selected: " + file.name + " (" + size + " GB). The model stays on this device.");
  }
});

async function checkWebGPU() {
  if (!window.isSecureContext) {
    setStatus("This page is not in a secure context. WebGPU is blocked on a LAN HTTP address. Open the site through HTTPS, or use localhost on the same device.");
    return false;
  }
  if (!("gpu" in navigator)) {
    setStatus("WebGPU is unavailable in this browser. The local-file picker works, but LiteRT-LM Web cannot run this model without WebGPU. Try a supported current Chrome/Edge browser.");
    return false;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("No compatible GPU adapter was found.");
    const info = adapter.info || {};
    const name = [info.vendor, info.architecture, info.device].filter(Boolean).join(" ");
    setStatus("WebGPU ready" + (name ? " (" + name + ")" : "") + ". Choose your .litertlm model file.");
    return true;
  } catch (error) {
    setStatus("WebGPU check failed: " + error.message);
    return false;
  }
}

loadBtn.addEventListener("click", async () => {
  const file = fileInput.files?.[0];
  if (!file || loading || engine) return;
  loading = true;
  loadBtn.disabled = true;
  setStatus("Loading " + file.name + " from your device. This may take a while. The file is not uploaded.");
  try {
    const { Engine } = await import("https://cdn.jsdelivr.net/npm/@litert-lm/core/+esm");
    engine = await Engine.create({ model: file });
    conversation = await engine.createConversation();
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
    loadBtn.disabled = !fileInput.files?.[0] || !webGpuReady;
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
loadBtn.disabled = !webGpuReady || !fileInput.files?.[0];
