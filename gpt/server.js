import express from "express";
import fetch from "node-fetch";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

const app = express();
app.use(express.json());
app.use(morgan("tiny"));
const allowOrigin = process.env.ALLOW_ORIGIN || "*";
const maxK = Number(process.env.MAX_K || 8);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.use("/api/", rateLimit({ windowMs: 60_000, max: 60 }));

app.use("/proxy/hf", async (req, res) => {
  const targetPath = req.path.slice(1);              // strip leading slash
  const url = `https://huggingface.co/${targetPath}${req.url.includes("?") ? `?${req.url.split("?")[1]}` : ""}`;

  const upstream = await fetch(url, {
    method: req.method,
    headers: {
      // Forward only headers Hugging Face expects; include Range for shard slices
      "Range": req.headers["range"],
      "Accept": req.headers["accept"],
    },
  });

  res.status(upstream.status);
  res.set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range");
  res.set("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes");
  res.set("Content-Length", upstream.headers.get("content-length") || "");
  res.set("Content-Range", upstream.headers.get("content-range") || "");
  res.set("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");

  upstream.body.pipe(res);
});

app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 500);
    const engine = String(req.query.engine || "serper").toLowerCase();
    const k = Math.max(1, Math.min(Number(req.query.k || 5), maxK));
    if (!q) return res.status(400).json({ error: "Missing q" });

    let out;
    if (engine === "serper") out = await doSerper(q, k, "serper");
    else if (engine === "google") out = await doSerper(q, k, "google");
    else if (engine === "brave") out = await doBrave(q, k);
    else if (engine === "bing") out = await doBing(q, k);
    else out = await doWiki(q, k);

    res.set("Cache-Control", "public, max-age=60");
    res.json({ query: q, ...out });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

async function doSerper(q, k, label = "serper") {
  const r = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": process.env.SERPER_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q, num: k }),
  });
  const j = await r.json();
  const items = (j.organic || j.results || []).slice(0, k).map((it) => ({
    title: it.title || "",
    url: it.link || it.url,
    snippet: it.snippet || it.description || "",
  }));
  return { engine: label, items };
}
async function doBrave(q, k) {
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${k}`, {
    headers: { "X-Subscription-Token": process.env.BRAVE_KEY },
  });
  const j = await r.json();
  const items = (j.web?.results || []).slice(0, k).map((it) => ({
    title: it.title, url: it.url, snippet: it.description || "",
  }));
  return { engine: "brave", items };
}
async function doBing(q, k) {
  const r = await fetch(`https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(q)}&count=${k}`, {
    headers: { "Ocp-Apim-Subscription-Key": process.env.BING_KEY },
  });
  const j = await r.json();
  const items = (j.webPages?.value || []).slice(0, k).map((it) => ({
    title: it.name, url: it.url, snippet: it.snippet || "",
  }));
  return { engine: "bing", items };
}
async function doWiki(q, k) {
  const u = `https://en.wikipedia.org/w/api.php?action=query&list=search&srprop=snippet&format=json&origin=*&srsearch=${encodeURIComponent(q)}`;
  const j = await (await fetch(u)).json();
  const items = (j?.query?.search || []).slice(0, k).map((s) => ({
    title: s.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title)}`,
    snippet: String(s.snippet || "").replace(/<[^>]+>/g, ""),
  }));
  return { engine: "wiki", items };
}

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`CORS proxy listening on :${port}`));
