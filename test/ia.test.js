import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client, createEnv, fakeAI, newMerchant } from "./helpers/env.js";
import { TEXT_MODEL, VISION_MODEL, parseModelJson } from "../src/lib/ai.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);
const product = {
  name: "Camiseta Básica Azul", description: "Camiseta de algodão macio, ideal para o dia a dia.",
  category: "Camisetas", price_reais: 59.9, variants: ["P", "M", "G", "m"], features: ["100% algodão"],
};

describe("inteligência artificial (Workers AI)", () => {
  test("sem o binding AI, as rotas respondem 503 e o resto funciona", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    assert.equal((await m.client.post("/api/ai/product-from-text", { text: "camiseta azul 59,90" })).status, 503);
    assert.deepEqual((await m.client.get("/api/ai/usage")).data, { used: 0, limit: 30, available: false });
  });

  test("cadastro por mensagem: chama o modelo com JSON schema e higieniza a sugestão", async () => {
    const ai = fakeAI(() => ({ response: product }));
    const env = createEnv({ ai });
    const m = await newMerchant(env);
    const res = await m.client.post("/api/ai/product-from-text", { text: "Camiseta azul algodão P M G 59,90" });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(res.data.suggestion, {
      name: "Camiseta Básica Azul", description: "Camiseta de algodão macio, ideal para o dia a dia.", category: "Camisetas",
      price_cents: 5990, variants: ["P", "M", "G"], features: ["100% algodão"],
    });
    assert.equal(ai.calls[0].model, TEXT_MODEL);
    assert.equal(ai.calls[0].input.response_format.type, "json_schema");
    assert.match(ai.calls[0].input.messages[1].content, /Camiseta azul algodão P M G 59,90/);
    assert.equal((await m.client.get("/api/products")).data.length, 0, "nada é salvo automaticamente");
  });

  test("aceita resposta do modelo em texto com JSON e recusa resposta inválida", async () => {
    assert.deepEqual(parseModelJson({ response: 'Aqui está: {"name":"X"} fim' }), { name: "X" });
    assert.equal(parseModelJson({ response: "sem json" }), null);
    const env = createEnv({ ai: fakeAI(() => ({ response: "desculpe, não consigo" })) });
    const m = await newMerchant(env);
    assert.equal((await m.client.post("/api/ai/product-from-text", { text: "bolo de pote" })).status, 502);
    const broken = createEnv({ ai: fakeAI(() => { throw new Error("3040 out of capacity"); }) });
    const b = await newMerchant(broken);
    const r = await b.client.post("/api/ai/product-from-text", { text: "bolo de pote" });
    assert.equal(r.status, 502);
    assert.ok(!JSON.stringify(r.data).includes("3040"), "detalhe interno não vaza");
  });

  test("sugestões absurdas são limitadas: textos cortados e preço inválido descartado", async () => {
    const env = createEnv({ ai: fakeAI(() => ({ response: { name: "X".repeat(500), description: "<b>ok</b>", category: "C", price_reais: -10, variants: "P", features: [] } })) });
    const m = await newMerchant(env);
    const s = (await m.client.post("/api/ai/product-from-text", { text: "algo" })).data.suggestion;
    assert.equal(s.name.length, 120);
    assert.equal(s.price_cents, null);
    assert.deepEqual(s.variants, []);
  });

  test("cadastro por foto usa o modelo de visão, valida a imagem e nunca sugere preço", async () => {
    const ai = fakeAI(() => ({ response: product }));
    const env = createEnv({ ai });
    const m = await newMerchant(env);
    const fake = await m.client.post("/api/ai/product-from-photo", new TextEncoder().encode("não é imagem"), { raw: true, headers: { "Content-Type": "image/png" } });
    assert.equal(fake.status, 415);
    assert.equal(ai.calls.length, 0, "imagem inválida não consome IA");
    const res = await m.client.post("/api/ai/product-from-photo?hint=tamanho%20M", PNG, { raw: true, headers: { "Content-Type": "image/png" } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.suggestion.price_cents, null);
    assert.equal(ai.calls[0].model, VISION_MODEL);
    const parts = ai.calls[0].input.messages[1].content;
    assert.match(parts[0].text, /tamanho M/);
    assert.match(parts[1].image_url.url, /^data:image\/png;base64,iVBORw0KGgo/);
  });

  test("limite diário por loja, sem afetar outras lojas", async () => {
    const env = createEnv({ ai: fakeAI(() => ({ response: product })), vars: { AI_DAILY_LIMIT: "2" } });
    const a = await newMerchant(env);
    const b = await newMerchant(env);
    assert.equal((await a.client.post("/api/ai/product-from-text", { text: "a" })).status, 200);
    assert.equal((await a.client.post("/api/ai/product-from-text", { text: "b" })).status, 200);
    assert.equal((await a.client.post("/api/ai/product-from-text", { text: "c" })).status, 429);
    assert.deepEqual((await a.client.get("/api/ai/usage")).data, { used: 2, limit: 2, available: true });
    assert.equal((await b.client.post("/api/ai/product-from-text", { text: "d" })).status, 200);
  });

  test("melhorar descrição devolve sugestão sem alterar o produto", async () => {
    const env = createEnv({ ai: fakeAI(() => ({ response: { name: "Bolo de Pote de Ninho", description: "Bolo cremoso feito na hora." } })) });
    const m = await newMerchant(env);
    const res = await m.client.post("/api/ai/improve-description", { name: "bolo pote", description: "" });
    assert.deepEqual(res.data.suggestion, { name: "Bolo de Pote de Ninho", description: "Bolo cremoso feito na hora." });
    assert.equal((await m.client.post("/api/ai/improve-description", { name: "" })).status, 400);
  });

  test("divulgação usa só produtos e preços reais da própria loja", async () => {
    const ai = fakeAI(() => ({ response: { whatsapp_message: "Oi!", instagram_caption: "Novidades #moda", ideas: ["Stories", "Status"] } }));
    const env = createEnv({ ai });
    const a = await newMerchant(env);
    const b = await newMerchant(env);
    assert.equal((await a.client.post("/api/ai/campaign", { goal: "promoção" })).status, 400, "sem produtos");
    const mine = (await a.client.post("/api/products", { name: "Vestido", price_cents: 10000, promo_price_cents: 8000, stock: 1 })).data.id;
    const other = (await b.client.post("/api/products", { name: "Segredo da Outra Loja", price_cents: 1, stock: 1 })).data.id;
    const res = await a.client.post("/api/ai/campaign", { goal: "Black Friday", product_ids: [mine, other] });
    assert.equal(res.status, 200);
    const prompt = ai.calls[0].input.messages[1].content;
    assert.match(prompt, /Vestido: de R\$ 100,00 por R\$ 80,00/);
    assert.ok(!prompt.includes("Segredo da Outra Loja"), "não usa produto de outra loja");
    assert.match(prompt, new RegExp(`/loja/${a.slug}`));
    assert.deepEqual(res.data.suggestion.ideas, ["Stories", "Status"]);
  });

  test("funcionário sem permissão de produtos não usa a IA; uso aparece na administração", async () => {
    const env = createEnv({ ai: fakeAI(() => ({ response: product })) });
    const m = await newMerchant(env);
    await m.client.post("/api/team", { name: "F", email: "fia@x.com", password: "provisoria-123", permissions: ["orders"] });
    const staff = new Client(env, "198.18.9.1");
    await staff.post("/api/login", { email: "fia@x.com", password: "provisoria-123" });
    await staff.post("/api/account/password", { current_password: "provisoria-123", new_password: "nova-senha-forte" });
    assert.equal((await staff.post("/api/ai/product-from-text", { text: "x" })).status, 403);
    await m.client.post("/api/ai/product-from-text", { text: "x" });
    const row = await env.DB.prepare("SELECT requests FROM ai_usage").first();
    assert.equal(row.requests, 1);
    assert.equal((await m.client.post("/api/account/delete", { password: m.password, confirm_slug: m.slug })).status, 200, "exclusão apaga o uso de IA");
  });
});
