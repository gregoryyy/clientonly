import { CreateWebWorkerMLCEngine } from "./web-llm/index.js";
import { createRagRuntime, safeJsonParse } from "./rag.js";

const HF_PROXY = window.__WEBLLM_HF_PROXY__ ?? "http://localhost:8787/proxy/hf/";
window.__WEBLLM_HF_PROXY__ = HF_PROXY;
const HF_ORIGIN = "https://huggingface.co/";
const API_BASE = HF_PROXY.includes("/proxy/hf")
  ? HF_PROXY.replace(/\/proxy\/hf\/?$/i, "/")
  : HF_PROXY;
if (!window.__WEBLLM_FETCH_PATCHED__) {
  const originalFetch = window.fetch.bind(window);
  const base = HF_PROXY.endsWith("/") ? HF_PROXY : `${HF_PROXY}/`;
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url;
    if (typeof url === "string" && url.startsWith(HF_ORIGIN)) {
      const suffix = url.slice(HF_ORIGIN.length);
      const proxiedUrl = base + suffix;
      if (typeof input === "string") {
        return originalFetch(proxiedUrl, init);
      }
      const requestInit = {
        method: input.method,
        headers: input.headers,
        mode: input.mode,
        credentials: input.credentials,
        cache: input.cache,
        redirect: input.redirect,
        referrer: init?.referrer ?? input.referrer,
        referrerPolicy: init?.referrerPolicy ?? input.referrerPolicy,
        integrity: init?.integrity ?? input.integrity,
        keepalive: init?.keepalive ?? input.keepalive,
        signal: init?.signal ?? input.signal
      };
      const mergedInit = init
        ? { ...requestInit, ...init, headers: init.headers ?? requestInit.headers }
        : requestInit;
      return originalFetch(proxiedUrl, mergedInit);
    }
    return originalFetch(input, init);
  };
  window.__WEBLLM_FETCH_PATCHED__ = true;
}

const MODELS = [
  { id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 0.5B Instruct (q4f16_1) – tiny, fast" },
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", label: "Llama 3.2 1B Instruct (q4f16_1) – small" },
  { id: "Phi-3-mini-4k-instruct-q4f32_1-MLC", label: "Phi-3 Mini 4K Instruct (q4f32_1) – small/good" },
  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 1.5B Instruct (q4f16_1)" },
  { id: "Llama-3.1-8B-Instruct-q4f16_1-MLC", label: "Llama 3.1 8B Instruct (q4f16_1) – heavier" },
  { id: "Hermes-3-Llama-3.2-3B-q4f16_1-MLC", label: "Hermes 3 Llama 3.2 3B (q4f16_1) – tools ready" },
  { id: "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC", label: "Hermes 2 Pro Llama 3 8B (q4f16_1) – tools ready" },
  { id: "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC", label: "Hermes 2 Pro Mistral 7B (q4f16_1) – tools ready" }
];

const els = {
  model: document.getElementById("model"),
  loadBtn: document.getElementById("loadBtn"),
  status: document.getElementById("status"),
  gpu: document.getElementById("gpu"),
  temp: document.getElementById("temp"),
  tempVal: document.getElementById("tempVal"),
  system: document.getElementById("system"),
  messages: document.getElementById("messages"),
  input: document.getElementById("input"),
  sendBtn: document.getElementById("sendBtn"),
  stopBtn: document.getElementById("stopBtn"),
  newChatBtn: document.getElementById("newChatBtn"),
  clearBtn: document.getElementById("clearBtn")
};

MODELS.forEach((m) => {
  const option = document.createElement("option");
  option.value = m.id;
  option.textContent = m.label;
  els.model.appendChild(option);
});

els.model.value = MODELS[0].id;

els.gpu.textContent = navigator.gpu
  ? "Available ✅"
  : "Not available ❌ — will fall back to WASM (slower)";

els.temp.addEventListener("input", () => {
  els.tempVal.textContent = els.temp.value;
});

const SETTINGS_KEY = "webllm-chat:settings";
const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
if (settings.model) els.model.value = settings.model;
if (typeof settings.temp === "number") {
  els.temp.value = settings.temp;
  els.tempVal.textContent = settings.temp.toFixed(1);
}
if (settings.system) els.system.value = settings.system;

function saveSettings() {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      model: els.model.value,
      temp: Number(els.temp.value),
      system: els.system.value
    })
  );
}

function chatKey() {
  return `webllm-chat:log:${els.model.value}`;
}
function loadChat() {
  const arr = JSON.parse(localStorage.getItem(chatKey()) || "[]");
  return Array.isArray(arr) ? arr : [];
}
function saveChat(messages) {
  localStorage.setItem(chatKey(), JSON.stringify(messages));
}

function render(messages) {
  els.messages.innerHTML = "";
  for (const m of messages) {
    if (m.role === "system") continue;
    const div = document.createElement("div");
    div.className = `msg ${m.role}`;
    if (m.role === "assistant" && m.tool_calls?.length) {
      const label = document.createElement("div");
      label.className = "tool-call dim";
      const parts = m.tool_calls
        .map((t) => {
          const args = safeJsonParse(t.function?.arguments);
          const query = typeof args?.query === "string" ? args.query : "";
          const engine = args?.engine ? ` • ${args.engine}` : "";
          return `🔧 search_web(${query || "…"})${engine}`;
        })
        .join("\n");
      label.textContent = parts;
      div.appendChild(label);
      if (m.content) {
        const body = document.createElement("div");
        body.textContent = m.content;
        div.appendChild(body);
      }
    } else if (m.role === "tool") {
      div.classList.add("tool");
      const name = m.name || "tool";
      const header = document.createElement("div");
      header.className = "tool-header dim";
      header.textContent = `Result from ${name}`;
      div.appendChild(header);
      const body = document.createElement("div");
      body.className = "tool-body";
      const parsed = safeJsonParse(m.content);
      if (parsed?.items?.length) {
        const list = document.createElement("div");
        for (const item of parsed.items.slice(0, 8)) {
          const link = document.createElement("a");
          link.href = item.url || "#";
          link.target = "_blank";
          link.rel = "noreferrer";
          link.textContent = item.title || item.url || "Untitled";
          const snippet = document.createElement("div");
          snippet.className = "tool-snippet";
          snippet.textContent = item.snippet || "";
          const block = document.createElement("div");
          block.className = "tool-item";
          block.appendChild(link);
          if (snippet.textContent) block.appendChild(snippet);
          list.appendChild(block);
        }
        body.appendChild(list);
      } else {
        body.textContent = typeof m.content === "string" ? m.content : JSON.stringify(parsed, null, 2);
      }
      div.appendChild(body);
    } else {
      div.textContent = m.content;
    }
    els.messages.appendChild(div);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

let engine = null;
let abortCtrl = null;
let isLoadingModel = false;

const { generateAssistantMessage, executeToolCall } = createRagRuntime({
  engineAccessor: () => engine,
  setStatus,
  saveChat,
  render,
  getModelId: () => els.model.value,
  getAbortController: () => abortCtrl,
  setAbortController: (ctrl) => {
    abortCtrl = ctrl;
  },
  apiBase: API_BASE
});

async function loadModel() {
  if (isLoadingModel) return;
  isLoadingModel = true;
  els.loadBtn.disabled = true;
  setStatus(`Loading ${els.model.value}…`);

  try {
    if (engine?.worker) {
      engine.worker.terminate?.();
    }
    const workerUrl = new URL("./worker.js", import.meta.url);
    workerUrl.searchParams.set("proxy", HF_PROXY);
    const worker = new Worker(workerUrl, { type: "module" });

    engine = await CreateWebWorkerMLCEngine(worker, els.model.value, {
      initProgressCallback: (p) => {
        const pct = p.progress ? Math.round(p.progress * 100) : null;
        setStatus(pct != null ? `${p.text} — ${pct}%` : p.text);
      }
    });

    let deviceLabel = "CPU/WASM";
    try {
      if (typeof engine.getGPUVendor === "function") {
        const vendor = await engine.getGPUVendor();
        if (vendor) deviceLabel = vendor;
      } else if (typeof engine.runtimeStatsText === "function") {
        const stats = await engine.runtimeStatsText();
        const match = /Device:\s*(.+)/i.exec(String(stats));
        if (match?.[1]) deviceLabel = match[1];
      }
    } catch (infoError) {
      console.debug("Unable to determine device info", infoError);
    }

    setStatus(`Ready • ${deviceLabel} • ${els.model.value}`);
    saveSettings();
    render(loadChat());
  } catch (e) {
    console.error(e);
    setStatus("Failed to load model. See console for details.");
    alert(`Model load failed.\n\n${e?.message || e}`);
  } finally {
    els.loadBtn.disabled = false;
    isLoadingModel = false;
  }
}

function setStatus(s) {
  els.status.innerHTML = `Status: <span class="dim">${s}</span>`;
}

async function send() {
  const text = els.input.value.trim();
  if (!text) return;
  if (!engine) {
    alert("Load a model first.");
    return;
  }

  els.input.value = "";
  els.sendBtn.disabled = true;
  els.stopBtn.disabled = false;

  const systemPrompt = els.system.value.trim();
  let chatHistory = loadChat();
  chatHistory = Array.isArray(chatHistory) ? chatHistory.filter((m) => m.role !== "system") : [];

  const conversation = chatHistory.slice();
  const userMessage = { role: "user", content: text };
  chatHistory.push(userMessage);
  conversation.push(userMessage);
  saveChat(chatHistory);
  render(chatHistory);

  const temperature = Number(els.temp.value) || 0.7;

  try {
    let finished = false;
    while (!finished) {
      const messagesToSend = [];
      if (systemPrompt) messagesToSend.push({ role: "system", content: systemPrompt });
      for (const message of conversation) {
        const copy = { role: message.role, content: message.content };
        if (message.tool_calls) {
          copy.tool_calls = message.tool_calls.map((tc) => ({
            id: tc.id,
            function: {
              name: tc.function?.name || "",
              arguments: tc.function?.arguments || ""
            }
          }));
        }
        if (message.tool_call_id) copy.tool_call_id = message.tool_call_id;
        if (message.name) copy.name = message.name;
        messagesToSend.push(copy);
      }

      const assistantMessage = { role: "assistant", content: "" };
      chatHistory.push(assistantMessage);
      conversation.push(assistantMessage);
      saveChat(chatHistory);
      render(chatHistory);

      const { finishReason } = await generateAssistantMessage(messagesToSend, assistantMessage, temperature, chatHistory);

      if (assistantMessage.tool_calls?.length) {
        for (const toolCall of assistantMessage.tool_calls) {
          const resultMessage = await executeToolCall(toolCall);
          chatHistory.push(resultMessage);
          conversation.push(resultMessage);
          saveChat(chatHistory);
          render(chatHistory);
        }
      } else {
        finished = true;
        setStatus(finishReason === "stop" ? "Done." : `Finished: ${finishReason || "complete"}`);
      }
    }
  } catch (e) {
    if (e.name === "AbortError") {
      setStatus("Generation stopped.");
    } else {
      console.error(e);
      setStatus("Error during generation.");
      alert(`Generation error:\n\n${e?.message || e}`);
    }
  } finally {
    abortCtrl = null;
    els.sendBtn.disabled = false;
    els.stopBtn.disabled = true;
    saveChat(chatHistory);
    render(chatHistory);
  }
}

els.loadBtn.addEventListener("click", async () => {
  saveSettings();
  await loadModel();
});

els.sendBtn.addEventListener("click", send);
els.stopBtn.addEventListener("click", () => {
  if (abortCtrl) {
    abortCtrl.abort();
    abortCtrl = null;
  }
  els.stopBtn.disabled = true;
});

els.newChatBtn.addEventListener("click", () => {
  saveChat([]);
  render([]);
});

els.clearBtn.addEventListener("click", () => {
  if (confirm("Delete all saved chats for this model?")) {
    localStorage.removeItem(chatKey());
    render([]);
  }
});

els.model.addEventListener("change", () => {
  saveSettings();
  render(loadChat());
  setStatus(`Model selected: ${els.model.value}. Click “Load model”.`);
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.sendBtn.click();
  }
});

(async () => {
  render(loadChat());
  setStatus("Idle.");
})();
