const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "search_web",
      description:
        "Search DuckDuckGo (direct) or Google (via proxy) for external information. Defaults to Google.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query, be specific with keywords."
          },
          engine: {
            type: "string",
            enum: ["google", "duckduckgo"],
            description: "Pick the search backend. Defaults to google (via proxy)."
          },
          k: {
            type: "integer",
            description: "Number of results to return (1-8). Defaults to 5.",
            minimum: 1,
            maximum: 8
          }
        },
        required: ["query"]
      }
    }
  }
];

const TOOL_DISABLED_MODELS = new Set();

export function safeJsonParse(raw) {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createRagRuntime({
  engineAccessor,
  setStatus,
  saveChat,
  render,
  getModelId,
  getAbortController,
  setAbortController,
  apiBase
}) {
  function accumulateToolCalls(store, deltas) {
    for (const delta of deltas) {
      const index = delta.index ?? 0;
      if (!store[index]) {
        store[index] = {
          id: delta.id || `call_${index}`,
          function: { name: "", arguments: "" }
        };
      }
      const current = store[index];
      if (delta.id) current.id = delta.id;
      if (delta.function?.name) {
        current.function.name = (current.function.name || "") + delta.function.name;
      }
      if (delta.function?.arguments) {
        current.function.arguments = (current.function.arguments || "") + delta.function.arguments;
      }
    }
  }

  async function generateAssistantMessage(messages, assistantMessage, temperature, chatHistory) {
    const ctrl = new AbortController();
    setAbortController(ctrl);
    setStatus("Generating…");
    const toolCalls = [];
    let finishReason = null;
    const modelId = getModelId?.();
    const toolsInitiallyAllowed = modelId ? !TOOL_DISABLED_MODELS.has(modelId) : true;
    let toolsActive = toolsInitiallyAllowed;

    try {
      const engine = engineAccessor();
      if (!engine?.chat?.completions?.create) {
        throw new Error("Model engine is not ready.");
      }

      const openStream = async (enableTools) => {
        const params = {
          stream: true,
          messages,
          temperature
        };
        if (enableTools) {
          params.tools = TOOL_DEFINITIONS;
          params.tool_choice = "auto";
        }
        return engine.chat.completions.create(params);
      };

      let stream;
      try {
        stream = await openStream(toolsInitiallyAllowed);
      } catch (err) {
        if (toolsInitiallyAllowed && isToolsUnsupportedError(err)) {
          if (modelId) TOOL_DISABLED_MODELS.add(modelId);
          console.warn(`Tool calls disabled for ${modelId || "current model"}: ${err?.message || err}`);
          stream = await openStream(false);
          toolsActive = false;
        } else {
          throw err;
        }
      }

      for await (const chunk of stream) {
        const choice = chunk?.choices?.[0];
        const delta = choice?.delta || {};

        if (delta.content) {
          assistantMessage.content += delta.content;
          saveChat(chatHistory);
          render(chatHistory);
        }
        if (toolsActive && Array.isArray(delta.tool_calls)) {
          accumulateToolCalls(toolCalls, delta.tool_calls);
          assistantMessage.tool_calls = toolCalls;
          saveChat(chatHistory);
          render(chatHistory);
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (!getAbortController()) {
          throw new DOMException("Aborted", "AbortError");
        }
      }
    } finally {
      setAbortController(null);
    }

    if (toolCalls.length) {
      assistantMessage.tool_calls = toolCalls;
    } else {
      delete assistantMessage.tool_calls;
    }

    return { finishReason };
  }

  async function executeToolCall(toolCall) {
    const name = toolCall?.function?.name;
    if (name === "search_web") {
      setStatus("Searching the web…");
      const args = safeJsonParse(toolCall.function?.arguments) || {};
      const query = String(args.query || "").trim();
      const engine = typeof args.engine === "string" ? args.engine.toLowerCase() : "google";
      const kRaw = Number(args.k);
      const k = Number.isFinite(kRaw) ? Math.min(Math.max(Math.round(kRaw), 1), 8) : 5;

      if (!query) {
        setStatus("Search failed.");
        return {
          role: "tool",
          tool_call_id: toolCall.id,
          name,
          content: JSON.stringify({ error: "search_web: missing query" })
        };
      }

      try {
        const result =
          engine === "duckduckgo"
            ? await callDuckDuckGo(query, k)
            : await callProxySearch({ query, k, engine });

        setStatus("Search complete.");
        return {
          role: "tool",
          tool_call_id: toolCall.id,
          name,
          content: JSON.stringify(result)
        };
      } catch (error) {
        console.error("search_web error", error);
        setStatus("Search failed.");
        return {
          role: "tool",
          tool_call_id: toolCall.id,
          name,
          content: JSON.stringify({ error: String(error?.message || error || "search failed") })
        };
      }
    }

    return {
      role: "tool",
      tool_call_id: toolCall?.id || "unknown",
      name: name || "unknown_tool",
      content: JSON.stringify({ error: `Unhandled tool: ${name || "unknown"}` })
    };
  }

  async function callProxySearch({ query, k, engine }) {
    const url = new URL("api/search", apiBase);
    url.searchParams.set("q", query);
    url.searchParams.set("engine", engine || "google");
    url.searchParams.set("k", String(k));

    const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json?.error || `Search API error ${res.status}`);
    }
    return { ...json, engine };
  }

  async function callDuckDuckGo(query, k) {
    const url = new URL("https://api.duckduckgo.com/");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("no_redirect", "1");
    url.searchParams.set("no_html", "1");

    const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json?.error || `DuckDuckGo error ${res.status}`);
    }

    const items = [];
    if (json.AbstractText && json.AbstractURL) {
      items.push({
        title: json.Heading || json.AbstractText,
        url: json.AbstractURL,
        snippet: json.AbstractText
      });
    }
    const topics = Array.isArray(json.RelatedTopics) ? json.RelatedTopics : [];
    flattenTopics(topics, items);

    return {
      engine: "duckduckgo",
      query,
      items: items.slice(0, k)
    };
  }

  function flattenTopics(topics, items) {
    for (const topic of topics) {
      if (Array.isArray(topic.Topics)) {
        flattenTopics(topic.Topics, items);
      } else if (topic.FirstURL || topic.Text) {
        items.push({
          title: topic.Text || topic.FirstURL,
          url: topic.FirstURL || "",
          snippet: topic.Text || ""
        });
      }
    }
  }

  return { generateAssistantMessage, executeToolCall, toolDefinitions: TOOL_DEFINITIONS };
}

function isToolsUnsupportedError(err) {
  const msg = err?.message || String(err || "");
  return (
    err?.name === "UnsupportedModelIdError" ||
    msg.includes("UnsupportedModelIdError") ||
    msg.includes("not supported for ChatCompletionRequest.tools")
  );
}

export { TOOL_DEFINITIONS };
