import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client, createEnv, newMerchant } from "./helpers/env.js";

async function setup() {
  const env = createEnv();
  const m = await newMerchant(env);
  const product = async (body) => (await m.client.post("/api/products", { stock: 10, ...body })).data.id;
  const get = async (id) => (await m.client.get("/api/products")).data.find((p) => p.id === id);
  const adjust = (body) => m.client.post("/api/stock-adjustments", body);
  return { env, m, product, get, adjust };
}

describe("movimentações de estoque", () => {
  test("entrada com custo atualiza o custo pela média ponderada; perda e ajuste", async () => {
    const { m, product, get, adjust } = await setup();
    const id = await product({ name: "Garrafa", price_cents: 5000, cost_cents: 2000, stock: 10 });
    const entry = await adjust({ product_id: id, kind: "entry", quantity: 10, unit_cost_cents: 3000, supplier: "Distribuidora Sul" });
    assert.equal(entry.status, 201, JSON.stringify(entry.data));
    assert.equal(entry.data.stock_after, 20);
    let p = await get(id);
    assert.equal(p.stock, 20);
    assert.equal(p.cost_cents, 2500);
    assert.equal((await adjust({ product_id: id, kind: "loss", quantity: 3, reason: "Quebrou" })).data.stock_after, 17);
    assert.equal((await adjust({ product_id: id, kind: "adjust", delta: -2 })).data.stock_after, 15);
    assert.equal((await adjust({ product_id: id, kind: "loss", quantity: 99 })).status, 409);
    assert.equal((await adjust({ product_id: id, kind: "adjust", delta: 0 })).status, 400);
    assert.equal((await adjust({ product_id: id, kind: "roubo", quantity: 1 })).status, 400);
    p = await get(id);
    assert.equal(p.stock, 15);
    const list = (await m.client.get("/api/stock-adjustments")).data;
    assert.deepEqual(list.map((r) => r.kind_label), ["Ajuste", "Perda", "Entrada"]);
    // O histórico automático continua registrando as mudanças.
    const moves = (await m.client.get("/api/stock-movements")).data;
    assert.ok(moves.some((x) => x.delta === -3));
  });

  test("inventário define a quantidade contada, inclusive em variações", async () => {
    const { m, product, get, adjust } = await setup();
    const id = await product({ name: "Copo", price_cents: 1000, stock: 8 });
    const count = await adjust({ product_id: id, kind: "count", quantity: 5, reason: "Contagem mensal" });
    assert.equal(count.status, 201);
    assert.equal(count.data.delta, -3);
    assert.equal((await get(id)).stock, 5);
    assert.equal((await adjust({ product_id: id, kind: "count", quantity: 5 })).data.delta, 0);
    const shirt = await product({ name: "Camiseta", price_cents: 5000, variants: [{ name: "P", stock: 2 }, { name: "M", stock: 4 }] });
    const vm = (await get(shirt)).variants.find((x) => x.name === "M");
    assert.equal((await adjust({ product_id: shirt, kind: "entry", quantity: 1 })).status, 400);
    assert.equal((await adjust({ product_id: shirt, variant_id: vm.id, kind: "count", quantity: 10 })).data.delta, 6);
    const p = await get(shirt);
    assert.equal(p.variants.find((x) => x.name === "M").stock, 10);
    assert.equal(p.stock, 12);
    assert.equal((await m.client.get("/api/stock-adjustments")).data[0].product_name, "Camiseta · M");
  });

  test("isolamento e permissão", async () => {
    const { env, m, product, adjust } = await setup();
    const id = await product({ name: "Garrafa", price_cents: 5000 });
    const other = await newMerchant(env);
    assert.equal((await other.client.post("/api/stock-adjustments", { product_id: id, kind: "entry", quantity: 5 })).status, 404);
    assert.equal((await other.client.get("/api/stock-adjustments")).data.length, 0);
    await m.client.post("/api/team", { name: "Dani", email: "dani-estoque@exemplo.com.br", password: "senha-provisoria-1", permissions: ["orders"] });
    const staff = new Client(env, "198.51.100.249");
    await staff.post("/api/login", { email: "dani-estoque@exemplo.com.br", password: "senha-provisoria-1" });
    await staff.post("/api/account/password", { current_password: "senha-provisoria-1", new_password: "senha-nova-forte-1" });
    assert.equal((await staff.post("/api/stock-adjustments", { product_id: id, kind: "entry", quantity: 5 })).status, 403);
    assert.equal((await adjust({ product_id: id, kind: "entry", quantity: 1 })).status, 201);
  });
});

describe("fornecedores e Preciso repor", () => {
  test("lista de compras agrupada por fornecedor, com reservas de pedidos pendentes", async () => {
    const { env, m, product } = await setup();
    assert.equal((await m.client.post("/api/suppliers", { name: "Distribuidora Sul", phone: "(54) 3333-2222" })).status, 201);
    assert.equal((await m.client.post("/api/suppliers", { name: "distribuidora sul" })).status, 409);
    const a = await product({ name: "Garrafa", price_cents: 5000, cost_cents: 2000, stock: 6, min_stock: 5, supplier: "Distribuidora Sul" });
    await product({ name: "Copo", price_cents: 1000, stock: 2 }); // sem fornecedor, padrão 3
    await product({ name: "Panela", price_cents: 9000, stock: 50 });
    // Pedido pendente reserva 2 garrafas: disponível 4 ≤ 5.
    const buyer = new Client(env, "203.0.113.92");
    await buyer.post(`/api/order-request/${m.slug}`, { customer_name: "Ana", customer_phone: "54999990000", items: [{ id: a, quantity: 2 }] });
    const r = (await m.client.get("/api/restock")).data;
    assert.equal(r.count, 2);
    assert.equal(r.groups[0].supplier, "Distribuidora Sul");
    assert.equal(r.groups[0].phone, "5433332222");
    const g = r.groups[0].items[0];
    assert.deepEqual([g.stock, g.reserved, g.available, g.suggested], [6, 2, 4, 6]);
    assert.equal(r.groups[0].estimated_cost_cents, 12000);
    assert.equal(r.groups[1].supplier, "");
    assert.equal(r.groups[1].items[0].name, "Copo");
    const sup = (await m.client.get("/api/suppliers")).data[0];
    assert.equal(sup.products, 1);
    // Renomear o fornecedor atualiza os produtos ligados.
    assert.equal((await m.client.patch(`/api/suppliers/${sup.id}`, { name: "Sul Distribuidora", phone: "" })).status, 200);
    assert.equal((await m.client.get("/api/products")).data.find((p) => p.id === a).supplier, "Sul Distribuidora");
    const other = await newMerchant(env);
    assert.equal((await other.client.get("/api/suppliers")).data.length, 0);
    assert.equal((await other.client.delete(`/api/suppliers/${sup.id}`)).status, 404);
    assert.equal((await m.client.delete(`/api/suppliers/${sup.id}`)).status, 200);
    assert.equal((await m.client.post("/api/account/delete", { password: m.password, confirm_slug: m.slug })).status, 200);
  });
});
