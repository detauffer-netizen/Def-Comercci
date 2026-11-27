// Servidor local que executa o Worker real com D1 (SQLite), R2 em memória e
// os arquivos de public/. Usado pelos testes de ponta a ponta e para revisão.

import { createServer } from "node:http";
import worker from "../../src/index.js";
import { createEnv, fakeAI } from "../helpers/env.js";

// IA simulada com respostas fixas: o E2E verifica a interface, não o modelo.
const demoAI = fakeAI((model, input) => {
  if (input.response_format?.json_schema?.properties?.whatsapp_message) {
    return { response: { whatsapp_message: "Oferta especial na Moda da Ana! Confira o catálogo.", instagram_caption: "Novidades da semana #moda", ideas: ["Publique nos stories", "Envie para clientes antigos"] } };
  }
  return { response: { name: "Saia Midi Plissada", description: "Saia leve e elegante para o dia a dia.", category: "Saias", price_reais: 89.9, variants: ["P", "M"], features: [] } };
});

export function startServer(port = 0) {
  const env = createEnv({ ai: demoAI });
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
