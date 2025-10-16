const HF_ORIGIN = "https://huggingface.co/";
const params = new URL(import.meta.url).searchParams;
const proxyParam = params.get("proxy") || "http://localhost:8787/proxy/hf/";
const proxyBase = proxyParam.endsWith("/") ? proxyParam : `${proxyParam}/`;

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input?.url;
  if (typeof url === "string" && url.startsWith(HF_ORIGIN)) {
    const suffix = url.slice(HF_ORIGIN.length);
    const proxiedUrl = proxyBase + suffix;
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

import { WebWorkerMLCEngineHandler } from "./web-llm/index.js";

const handler = new WebWorkerMLCEngineHandler();
handler.postMessage = (msg) => {
  globalThis.postMessage(msg);
};

globalThis.onmessage = (event) => {
  handler.onmessage(event);
};

globalThis.onmessageerror = (event) => {
  console.error("WebLLM worker message error", event);
};
