const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "search_web",
      description:
        "Search the web for up-to-date information, news, or facts. Use when the question may need current data or external knowledge.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query, be specific with keywords."
          },
          engine: {
            type: "string",
            enum: ["serper", "brave", "bing", "wiki"],
            description: "Optional search backend. Defaults to serper (Google)."
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

    try {
      const engine = engineAccessor();
      if (!engine?.chat?.completions?.create) {
        throw new Error("Model engine is not ready.");
      }
      const stream = await engine.chat.completions.create({
        stream: true,
        messages,
        temperature,
        tools: TOOL_DEFINITIONS,
        tool_choice: "auto"
      });

      for await (const chunk of stream) {
        const choice = chunk?.choices?.[0];
        const delta = choice?.delta || {};

        if (delta.content) {
          assistantMessage.content += delta.content;
          saveChat(chatHistory);
          render(chatHistory);
        }
        if (Array.isArray(delta.tool_calls)) {
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
      const engine = typeof args.engine === "string" ? args.engine : "serper";
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
        const url = new URL("api/search", apiBase);
        url.searchParams.set("q", query);
        if (engine) url.searchParams.set("engine", engine);
        if (k) url.searchParams.set("k", String(k));
        const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
        const json = await res.json();
        if (!res.ok) {
          setStatus("Search failed.");
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            name,
            content: JSON.stringify({ error: json?.error || `Search API error ${res.status}` })
          };
        }
        setStatus("Search complete.");
        return {
          role: "tool",
          tool_call_id: toolCall.id,
          name,
          content: JSON.stringify(json)
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

  return { generateAssistantMessage, executeToolCall, toolDefinitions: TOOL_DEFINITIONS };
}

export { TOOL_DEFINITIONS };
