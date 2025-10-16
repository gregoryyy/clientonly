# Client-side chat bot

Idea: 
- build a simple client-side WebLLM chatbot allowing to select different models.
- add functions to allow document and search engine rag.
- build a CORS proxy to access external services.

ChatGPT link: https://chatgpt.com/share/68f10e5f-9ed4-8012-bb20-06cb3af2afdc


Prepare:

- ensure you are in subdir `gpt`
- `npm install @mlc-ai/web-llm`, copy node_modules/@mlc-ai/web-llm/dist to ./models
- Use the proxy: `npm install express express-rate-limit morgan node-fetch`

Run:

- Run Web server `python -m http.server 8080`
- Run proxy: `ALLOW_ORIGIN=http://localhost:8080 PORT=8787 node server.js`
- 