import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client, createEnv, newMerchant } from "./helpers/env.js";

const BUYER = { customer_name: "Joana", customer_phone: "54999990000" };

async function productWithVariants(client, variants, extra = {}) {
  const res = await client.post("/api/products", { name: "Camiseta", price_cents: 5000, stock: 0, variants, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const list = (await client.get("/api/products")).data;
  return list.find((p) => p.id === res.data.id);
}

const order = (env, slug, items, ip = "192.0.2.30") => new Client(env, ip).post(`/api/order-request/${slug}`, { ...BUYER, items });

describe("variações de produto", () => {
  test("estoque do produto é a soma das variações", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const p = await productWithVariants(m.client, [
      { name: "P", stock: 2, sku: "CAM-P" },
      { name: "M", stock: 5, sku: "CAM-M", price_cents: 5500 },
    ]);
    assert.equal(p.stock, 7);
    assert.deepEqual(p.variants.map((x) => [x.name, x.stock, x.price_cents]), [["P", 2, null], ["M", 5, 5500]]);
  });

  test("valida nomes, SKUs e quantidade de variações", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const bad = [
      [{ name: "P", stock: 1 }, { name: "p", stock: 1 }],
      [{ name: "", stock: 1 }],
      [{ name: "P", stock: -1 }],
      [{ name: "P", stock: 1, sku: "X" }, { name: "M", stock: 1, sku: "X" }],
      Array.from({ length: 61 }, (_, i) => ({ name: `V${i}`, stock: 1 })),
    ];
    for (const variants of bad) {
      assert.equal((await m.client.post("/api/products", { name: "A", price_cents: 100, stock: 0, variants })).status, 400);
    }
    await m.client.post("/api/products", { name: "Outro", price_cents: 100, stock: 1, sku: "USADO" });
    const dup = await m.client.post("/api/products", { name: "A", price_cents: 100, stock: 0, variants: [{ name: "P", stock: 1, sku: "USADO" }] });
    assert.equal(dup.status, 201, "SKU de variação e de produto são índices separados");
    const dup2 = await m.client.post("/api/products", { name: "B", price_cents: 100, stock: 0, variants: [{ name: "P", stock: 1, sku: "USADO" }] });
    assert.equal(dup2.status, 409);
    assert.equal((await m.client.get("/api/products")).data.filter((p) => p.name === "B").length, 0, "lote desfeito");
  });

  test("editar mantém, altera, cria e remove variações", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const p = await productWithVariants(m.client, [{ name: "P", stock: 2 }, { name: "M", stock: 3 }]);
    const [pv] = p.variants;
    const res = await m.client.patch(`/api/products/${p.id}`, {
      name: "Camiseta", price_cents: 5000, stock: 999,
      variants: [{ id: pv.id, name: "PP", stock: 4 }, { name: "G", stock: 1 }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const after = (await m.client.get("/api/products")).data[0];
    assert.deepEqual(after.variants.map((x) => [x.name, x.stock]), [["PP", 4], ["G", 1]]);
    assert.equal(after.variants[0].id, pv.id, "variação existente preserva o id");
    assert.equal(after.stock, 5, "estoque enviado é ignorado quando há variações");
    // Editar sem enviar variações não as altera.
    await m.client.patch(`/api/products/${p.id}`, { name: "Camiseta Nova", price_cents: 5000, stock: 0 });
    assert.equal((await m.client.get("/api/products")).data[0].variants.length, 2);
    // Lista vazia transforma em produto simples com estoque próprio.
    await m.client.patch(`/api/products/${p.id}`, { name: "Camiseta", price_cents: 5000, stock: 9, variants: [] });
    const simple = (await m.client.get("/api/products")).data[0];
    assert.equal(simple.variants.length, 0);
    assert.equal(simple.stock, 9);
  });

  test("uma loja não altera variações de outra", async () => {
    const env = createEnv();
    const a = await newMerchant(env);
    const b = await newMerchant(env);
    const p = await productWithVariants(a.client, [{ name: "P", stock: 2 }]);
    const bp = (await b.client.post("/api/products", { name: "X", price_cents: 1, stock: 0, variants: [{ id: p.variants[0].id, name: "Hack", stock: 99 }] })).data;
    assert.ok(bp.id);
    const still = (await a.client.get("/api/products")).data[0].variants[0];
    assert.equal(still.name, "P");
    assert.equal(still.stock, 2);
  });

  test("vitrine mostra apenas variações ativas e preço por variação", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    await productWithVariants(m.client, [
      { name: "P", stock: 2 },
      { name: "M", stock: 3, price_cents: 4500 },
      { name: "G", stock: 7, active: false },
    ], { promo_price_cents: 4800 });
    const shop = (await new Client(env).get(`/api/store/${m.slug}`)).data.products[0];
    assert.deepEqual(shop.variants.map((x) => [x.name, x.final_price_cents]), [["P", 4800], ["M", 4500]]);
    assert.equal(shop.stock, 5);
    assert.equal(shop.final_price_cents, 4500, "preço “a partir de”");
  });

  test("pedido com variação usa preço e estoque da variação", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const p = await productWithVariants(m.client, [{ name: "P", stock: 2 }, { name: "M", stock: 3, price_cents: 6000 }]);
    const [vp, vm] = p.variants;
    assert.equal((await order(env, m.slug, [{ id: p.id, quantity: 1 }])).status, 400, "precisa escolher a opção");
    assert.equal((await order(env, m.slug, [{ id: p.id, variant_id: vp.id, quantity: 3 }])).status, 409);
    const ok = await order(env, m.slug, [{ id: p.id, variant_id: vp.id, quantity: 2 }, { id: p.id, variant_id: vm.id, quantity: 1, price_cents: 1 }]);
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.equal(ok.data.total_cents, 2 * 5000 + 6000);
    assert.deepEqual(ok.data.items.map((i) => i.variant_name), ["P", "M"]);
    assert.equal((await order(env, m.slug, [{ id: p.id, variant_id: vp.id, quantity: 1 }, { id: p.id, variant_id: vp.id, quantity: 1 }])).status, 400);
  });

  test("confirmar baixa o estoque da variação; cancelar repõe", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const p = await productWithVariants(m.client, [{ name: "P", stock: 2 }, { name: "M", stock: 3 }]);
    const [vp, vm] = p.variants;
    const o = (await order(env, m.slug, [{ id: p.id, variant_id: vp.id, quantity: 2 }, { id: p.id, variant_id: vm.id, quantity: 1 }])).data;
    const read = async () => (await m.client.get("/api/products")).data[0];
    assert.equal((await m.client.patch(`/api/orders/${o.id}`, { status: "confirmed" })).status, 200);
    let now = await read();
    assert.deepEqual(now.variants.map((x) => x.stock), [0, 2]);
    assert.equal(now.stock, 2);
    assert.equal((await m.client.patch(`/api/orders/${o.id}`, { status: "cancelled" })).status, 200);
    now = await read();
    assert.deepEqual(now.variants.map((x) => x.stock), [2, 3]);
    assert.equal(now.stock, 5);
  });

  test("variação esgotada concorrente não fica negativa", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const p = await productWithVariants(m.client, [{ name: "P", stock: 1 }]);
    const v = p.variants[0];
    const o1 = (await order(env, m.slug, [{ id: p.id, variant_id: v.id, quantity: 1 }], "192.0.2.41")).data;
    const o2 = (await order(env, m.slug, [{ id: p.id, variant_id: v.id, quantity: 1 }], "192.0.2.42")).data;
    assert.equal((await m.client.patch(`/api/orders/${o1.id}`, { status: "confirmed" })).status, 200);
    assert.equal((await m.client.patch(`/api/orders/${o2.id}`, { status: "confirmed" })).status, 409);
    assert.equal((await m.client.get("/api/products")).data[0].variants[0].stock, 0);
  });

  test("variação removida depois do pedido impede a confirmação sem afetar outros estoques", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const p = await productWithVariants(m.client, [{ name: "P", stock: 2 }, { name: "M", stock: 2 }]);
    const o = (await order(env, m.slug, [{ id: p.id, variant_id: p.variants[0].id, quantity: 1 }])).data;
    await m.client.patch(`/api/products/${p.id}`, { name: "Camiseta", price_cents: 5000, stock: 0, variants: [{ id: p.variants[1].id, name: "M", stock: 2 }] });
    assert.equal((await m.client.patch(`/api/orders/${o.id}`, { status: "confirmed" })).status, 409);
    assert.equal((await m.client.get("/api/products")).data[0].stock, 2);
  });

  test("pedido antigo sem variação de um produto que passou a ter variações não é confirmado", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const id = (await m.client.post("/api/products", { name: "Boné", price_cents: 3000, stock: 5 })).data.id;
    const o = (await order(env, m.slug, [{ id, quantity: 1 }])).data;
    await m.client.patch(`/api/products/${id}`, { name: "Boné", price_cents: 3000, stock: 0, variants: [{ name: "Azul", stock: 5 }] });
    assert.equal((await m.client.patch(`/api/orders/${o.id}`, { status: "confirmed" })).status, 409);
    assert.equal((await m.client.get("/api/products")).data[0].stock, 5);
  });

  test("produtos simples continuam funcionando como antes", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const id = (await m.client.post("/api/products", { name: "Caneca", price_cents: 2500, stock: 3 })).data.id;
    assert.equal((await order(env, m.slug, [{ id, variant_id: "00000000-0000-0000-0000-000000000000", quantity: 1 }])).status, 400);
    const o = (await order(env, m.slug, [{ id, quantity: 2 }])).data;
    await m.client.patch(`/api/orders/${o.id}`, { status: "confirmed" });
    assert.equal((await m.client.get("/api/products")).data[0].stock, 1);
  });

  test("excluir produto remove as variações", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const p = await productWithVariants(m.client, [{ name: "P", stock: 2 }]);
    assert.equal((await m.client.delete(`/api/products/${p.id}`)).status, 200);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM product_variants").first();
    assert.equal(left.n, 0);
  });
});
