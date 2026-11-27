// Servidor local que executa o Worker real com D1 (SQLite), R2 em memória e
// os arquivos de public/. Usado pelos testes de ponta a ponta e para revisão.

import { createServer } from "node:http";
import worker from "../../src/index.js";
import { createEnv } from "../helpers/env.js";

export function startServer(port = 0) {
  const env = createEnv();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const origin = `http://${req.headers.host}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    headers.set("CF-Connecting-IP", req.socket.remoteAddress || "127.0.0.1");
    const body = chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
    const response = await worker.fetch(new Request(origin + req.url, { method: req.method, headers, body }), env);
    const out = {};
    response.headers.forEach((v, k) => (out[k] = v));
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, env, url: `http://localhost:${server.address().port}` })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startServer(Number(process.env.PORT || 8787));
  console.log(`Def Commerce local em ${url}`);
}
