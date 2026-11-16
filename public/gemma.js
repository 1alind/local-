const statusEl = document.querySelector("#status");
const chatEl = document.querySelector("#chat");
const loadBtn = document.querySelector("#load");
const clearBtn = document.querySelector("#clear");
const form = document.querySelector("#form");
const promptEl = document.querySelector("#prompt");
const sendBtn = document.querySelector("#send");

let engine = null;
let conversation = null;
let loading = false;
let generating = false;

function setStatus(message) {
  statusEl.textContent = message;
}
function append(message) {
  chatEl.textContent += message;
  chatEl.scrollTop = chatEl.scrollHeight;
}

async function checkWebGPU() {
  if (!("gpu" in navigator)) {
    setStatus("WebGPU is not available in this browser. Try a current Chrome or Edge build on a supported device.");
    loadBtn.disabled = true;
    return false;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("No compatible GPU adapter was found.");
    const info = adapter.info || {};
    const gpuName = [info.vendor, info.architecture, info.device].filter(Boolean).join(" ");
    setStatus("WebGPU is available" + (gpuName ? " (" + gpuName + ")" : "") + ". Ready to load the model.");
    return true;
  } catch (error) {
    setStatus("WebGPU check failed: " + error.message);
    loadBtn.disabled = true;
    return false;
  }
}

loadBtn.addEventListener("click", async () => {
  if (loading || engine) return;
  loading = true;
  loadBtn.disabled = true;
  setStatus("Loading LiteRT-LM and downloading Gemma 4 E2B (~2 GB). This can take a while. Do not close this tab.");
  try {
    const { Engine } = await import("https://cdn.jsdelivr.net/npm/@litert-lm/core/+esm");
    engine = await Engine.create({
      model: "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm"
    });
    conversation = await engine.createConversation();
    setStatus("Gemma 4 E2B is loaded. Prompts are processed locally on this device.");
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
      "\n\nCheck WebGPU support, available memory, internet access, and the browser console. You can try loading again.");
    loadBtn.disabled = false;
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

checkWebGPU();
