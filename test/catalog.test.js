import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createEnv, fakeAI, newMerchant } from "./helpers/env.js";

async function setup(opts) {
  const env = createEnv(opts);
  const m = await newMerchant(env);
  const list = async () => (await m.client.get("/api/products")).data;
  return { env, m, list };
}

describe("importação por planilha", () => {
  test("cria e atualiza pelo SKU; prévia não grava; erro em uma linha não grava nada", async () => {
    const { m, list } = await setup();
    await m.client.post("/api/products", { name: "Garrafa antiga", price_cents: 4000, stock: 3, sku: "GAR-1" });
    const rows = [
      { name: "Garrafa térmica", price_cents: 4990, cost_cents: 2500, stock: 20, sku: "gar-1", barcode: "7891234567895", category: "Utilidades", supplier: "Sul" },
      { name: "Kit de copos", price_cents: 2990, sku: "COP-6", category: "Utilidades" },
      { name: "Sem SKU", price_cents: 1000, stock: 2, active: 0 },
    ];
    const dry = await m.client.post("/api/products/import", { rows, dry_run: true });
    assert.equal(dry.status, 200);
    assert.deepEqual([dry.data.created, dry.data.updated], [2, 1]);
    assert.equal((await list()).length, 1);
    const badRows = [...rows, { name: "", price_cents: 100 }, { name: "Y", price_cents: -1 }];
    const preview = await m.client.post("/api/products/import", { rows: badRows, dry_run: true });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.valid, false);
    const bad = await m.client.post("/api/products/import", { rows: badRows });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.data.errors.map((e) => e.row), [5, 6]);
    assert.equal((await list()).length, 1);
    const ok = await m.client.post("/api/products/import", { rows });
    assert.equal(ok.status, 201);
    const products = await list();
    assert.equal(products.length, 3);
    const g = products.find((p) => p.sku === "GAR-1");
    assert.deepEqual([g.name, g.price_cents, g.stock, g.cost_cents, g.supplier], ["Garrafa térmica", 4990, 20, 2500, "Sul"]);
    assert.equal(products.find((p) => p.sku === "COP-6").stock, 0);
    assert.equal(products.find((p) => p.name === "Sem SKU").active, false);
    // Atualizar sem informar estoque mantém o estoque atual.
    await m.client.post("/api/products/import", { rows: [{ name: "Garrafa térmica", price_cents: 5290, sku: "GAR-1" }] });
    assert.equal((await list()).find((p) => p.sku === "GAR-1").stock, 20);
  });

  test("SKU repetido na planilha, limite de linhas e limite do plano", async () => {
    const { env, m } = await setup();
    const dup = await m.client.post("/api/products/import", { rows: [{ name: "A", price_cents: 1, sku: "X" }, { name: "B", price_cents: 1, sku: "x" }] });
    assert.equal(dup.status, 400);
    assert.match(dup.data.errors[0].message, /repetido/);
    const many = Array.from({ length: 501 }, (_, i) => ({ name: `P${i}`, price_cents: 100 }));
    assert.equal((await m.client.post("/api/products/import", { rows: many })).status, 400);
    await env.DB.prepare("UPDATE plans SET max_products=2 WHERE id='beta'").run();
    const over = await m.client.post("/api/products/import", { rows: [{ name: "A", price_cents: 1 }, { name: "B", price_cents: 1 }, { name: "C", price_cents: 1 }] });
    assert.equal(over.status, 402);
  });
});

describe("edição em massa", () => {
  test("categoria, fornecedor, visibilidade e reajuste de preço (com variações e promoção)", async () => {
    const { env, m, list } = await setup();
    const a = (await m.client.post("/api/products", { name: "A", price_cents: 1000, promo_price_cents: 900, stock: 1 })).data.id;
    const b = (await m.client.post("/api/products", { name: "B", price_cents: 2000, stock: 1, variants: [{ name: "P", stock: 1, price_cents: 2500 }] })).data.id;
    const c = (await m.client.post("/api/products", { name: "C", price_cents: 3000, stock: 1 })).data.id;
    const bulk = (body) => m.client.post("/api/products/bulk", { ids: [a, b], ...body });
    assert.equal((await bulk({ action: "category", value: "Promo" })).data.updated, 2);
    await bulk({ action: "supplier", value: "Sul" });
    await bulk({ action: "visibility", value: false });
    assert.equal((await bulk({ action: "price_percent", value: 10 })).status, 200);
    const p = await list();
    const pa = p.find((x) => x.id === a);
    const pb = p.find((x) => x.id === b);
    assert.deepEqual([pa.category, pa.supplier, pa.active, pa.price_cents, pa.promo_price_cents], ["Promo", "Sul", false, 1100, 990]);
    assert.equal(pb.variants[0].price_cents, 2750);
    assert.equal(p.find((x) => x.id === c).price_cents, 3000);
    assert.equal((await bulk({ action: "price_percent", value: -95 })).status, 400);
    assert.equal((await bulk({ action: "apagar" })).status, 400);
    const other = await newMerchant(env);
    assert.equal((await other.client.post("/api/products/bulk", { ids: [c], action: "category", value: "X" })).data.updated, 0);
    assert.equal((await list()).find((x) => x.id === c).category, "");
  });
});

describe("IA entende custo e quantidade informados", () => {
  test("mensagem com custo e quantidade preenche a sugestão; a foto nunca deduz custo", async () => {
    const ai = fakeAI(() => ({ response: { name: "Garrafa térmica", description: "Mantém a bebida gelada.", category: "Utilidades", price_reais: 49.9, cost_reais: 25, quantity: 20, variants: [], features: [] } }));
    const { m } = await setup({ ai });
    const r = await m.client.post("/api/ai/product-from-text", { text: "Comprei 20 garrafas térmicas por R$ 25 cada. Quero vender por R$ 49,90." });
    assert.equal(r.status, 200);
    assert.deepEqual([r.data.suggestion.price_cents, r.data.suggestion.cost_cents, r.data.suggestion.stock], [4990, 2500, 20]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const photo = await m.client.request("POST", "/api/ai/product-from-photo", png, { raw: true, headers: { "Content-Type": "image/png" } });
    assert.equal(photo.status, 200);
    assert.deepEqual([photo.data.suggestion.price_cents, photo.data.suggestion.cost_cents, photo.data.suggestion.stock], [null, null, null]);
  });
});
