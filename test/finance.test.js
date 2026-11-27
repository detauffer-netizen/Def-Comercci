import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client, createEnv, newMerchant } from "./helpers/env.js";

async function setup() {
  const env = createEnv();
  const m = await newMerchant(env);
  const product = async (body) => (await m.client.post("/api/products", { stock: 10, ...body })).data.id;
  const sale = async (body) => {
    const res = await m.client.post("/api/sales", { id: crypto.randomUUID(), ...body });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data;
  };
  const stockOf = async (id) => (await m.client.get("/api/products")).data.find((p) => p.id === id);
  return { env, m, product, sale, stockOf };
}

describe("contas a receber", () => {
  test("baixa parcial e total, sem passar do saldo", async () => {
    const { m, product, sale } = await setup();
    const id = await product({ name: "Sofá", price_cents: 100000 });
    const s = await sale({ items: [{ id, quantity: 1 }], customer_name: "Dona Rosa", customer_phone: "54977776666", payments: [{ method: "pix", amount_cents: 20000 }, { method: "account", amount_cents: 80000 }] });
    let list = (await m.client.get("/api/receivables")).data;
    assert.equal(list.total_cents, 80000);
    assert.equal(list.items[0].customer_name, "Dona Rosa");
    assert.equal((await m.client.post(`/api/receivables/${s.id}`, { amount_cents: 90000, method: "pix" })).status, 400);
    assert.equal((await m.client.post(`/api/receivables/${s.id}`, { amount_cents: 30000, method: "boleto" })).status, 400);
    const r1 = await m.client.post(`/api/receivables/${s.id}`, { amount_cents: 30000, method: "cash" });
    assert.equal(r1.status, 201);
    assert.equal(r1.data.receivable_cents, 50000);
    const both = await Promise.all([1, 2].map(() => m.client.post(`/api/receivables/${s.id}`, { amount_cents: 50000, method: "pix" })));
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 400]);
    list = (await m.client.get("/api/receivables")).data;
    assert.equal(list.total_cents, 0);
    assert.equal(list.items.length, 0);
    const d = (await m.client.get("/api/dashboard?period=today")).data;
    assert.deepEqual(d.receivable, { cents: 0, sales: 0 });
  });

  test("outra loja não dá baixa", async () => {
    const { env, product, sale } = await setup();
    const id = await product({ name: "Mesa", price_cents: 5000 });
    const s = await sale({ items: [{ id, quantity: 1 }], customer_name: "Ana", customer_phone: "54977776666", payments: [{ method: "account", amount_cents: 5000 }] });
    const other = await newMerchant(env);
    assert.equal((await other.client.post(`/api/receivables/${s.id}`, { amount_cents: 1000, method: "pix" })).status, 404);
  });
});

describe("devoluções", () => {
  test("devolução parcial repõe o estoque, rateia o desconto e não passa do vendido", async () => {
    const { m, product, sale, stockOf } = await setup();
    const id = await product({ name: "Copo", price_cents: 1000, cost_cents: 400 });
    const s = await sale({ items: [{ id, quantity: 4 }], discount_cents: 400, payments: [{ method: "cash", amount_cents: 3600 }] });
    assert.equal((await stockOf(id)).stock, 6);
    const r = await m.client.post(`/api/orders/${s.id}/returns`, { items: [{ id, quantity: 1 }], reason: "Trincado" });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.value_cents, 900); // 1000 com 10% de desconto rateado
    assert.equal(r.data.refund_cents, 900);
    assert.equal((await stockOf(id)).stock, 7);
    assert.equal((await m.client.post(`/api/orders/${s.id}/returns`, { items: [{ id, quantity: 4 }] })).status, 409);
    // Sem repor estoque (produto avariado).
    assert.equal((await m.client.post(`/api/orders/${s.id}/returns`, { items: [{ id, quantity: 3 }], restock: false })).status, 201);
    assert.equal((await stockOf(id)).stock, 7);
    assert.equal((await m.client.post(`/api/orders/${s.id}/returns`, { items: [{ id, quantity: 1 }] })).status, 409);
    const listed = (await m.client.get("/api/orders?channel=pos")).data[0];
    assert.equal(listed.items[0].returned, 4);
    assert.equal(listed.returned_cents, 3600);
    const d = (await m.client.get("/api/dashboard?period=today")).data;
    assert.equal(d.current.returns_cents, 3600);
    assert.equal(d.current.net_revenue, 0);
    assert.equal(d.current.cogs, 0);
    assert.equal(d.current.gross_profit, 0);
  });

  test("variação volta para a variação; venda a prazo abate o saldo antes de devolver dinheiro", async () => {
    const { m, product, sale, stockOf } = await setup();
    const shirt = await product({ name: "Camiseta", price_cents: 5000, variants: [{ name: "P", stock: 3 }] });
    const vid = (await stockOf(shirt)).variants[0].id;
    const s = await sale({ items: [{ id: shirt, variant_id: vid, quantity: 2 }], customer_name: "Ana", customer_phone: "54977776666", payments: [{ method: "pix", amount_cents: 7000 }, { method: "account", amount_cents: 3000 }] });
    const r = await m.client.post(`/api/orders/${s.id}/returns`, { items: [{ id: shirt, variant_id: vid, quantity: 1 }] });
    assert.equal(r.status, 201);
    assert.equal(r.data.credit_cents, 3000);
    assert.equal(r.data.refund_cents, 2000);
    const p = await stockOf(shirt);
    assert.equal(p.variants[0].stock, 2);
    assert.equal(p.stock, 2);
    assert.equal((await m.client.get("/api/receivables")).data.total_cents, 0);
    assert.equal((await m.client.post(`/api/orders/${s.id}/returns`, { items: [{ id: shirt, quantity: 1 }] })).status, 400);
  });

  test("só vendas concluídas; isolamento entre lojas", async () => {
    const { env, m, product } = await setup();
    const id = await product({ name: "Copo", price_cents: 1000 });
    const buyer = new Client(env, "203.0.113.91");
    const order = (await buyer.post(`/api/order-request/${m.slug}`, { customer_name: "Ana", customer_phone: "54999990000", items: [{ id, quantity: 1 }] })).data;
    assert.equal((await m.client.post(`/api/orders/${order.id}/returns`, { items: [{ id, quantity: 1 }] })).status, 409);
    await m.client.patch(`/api/orders/${order.id}`, { status: "confirmed" });
    await m.client.patch(`/api/orders/${order.id}`, { status: "completed" });
    const other = await newMerchant(env);
    assert.equal((await other.client.post(`/api/orders/${order.id}/returns`, { items: [{ id, quantity: 1 }] })).status, 404);
    assert.equal((await m.client.post(`/api/orders/${order.id}/returns`, { items: [{ id, quantity: 1 }] })).status, 201);
  });
});

describe("despesas e resultado", () => {
  test("despesas do período entram no resultado estimado", async () => {
    const { env, m, product, sale } = await setup();
    const id = await product({ name: "Garrafa", price_cents: 5000, cost_cents: 2000 });
    await sale({ items: [{ id, quantity: 2 }], payments: [{ method: "pix", amount_cents: 10000 }] });
    const today = (await m.client.get("/api/dashboard?period=today")).data.start;
    assert.equal((await m.client.post("/api/expenses", { description: "Sacolas", category: "Embalagem", amount_cents: 1500, paid_on: today })).status, 201);
    assert.equal((await m.client.post("/api/expenses", { description: "Aluguel antigo", amount_cents: 90000, paid_on: "2020-01-05" })).status, 201);
    assert.equal((await m.client.post("/api/expenses", { description: "", amount_cents: 100, paid_on: today })).status, 400);
    assert.equal((await m.client.post("/api/expenses", { description: "X", amount_cents: 0, paid_on: today })).status, 400);
    assert.equal((await m.client.post("/api/expenses", { description: "X", amount_cents: 100, paid_on: "31/12/2026" })).status, 400);
    const d = (await m.client.get("/api/dashboard?period=today")).data.current;
    assert.equal(d.gross_profit, 6000);
    assert.equal(d.expenses_cents, 1500);
    assert.equal(d.result_cents, 4500);
    const list = (await m.client.get(`/api/expenses?start=${today}&end=${today}`)).data;
    assert.equal(list.items.length, 1);
    assert.equal(list.total_cents, 1500);
    const other = await newMerchant(env);
    assert.equal((await other.client.get("/api/expenses")).data.items.length, 0);
    assert.equal((await other.client.delete(`/api/expenses/${list.items[0].id}`)).status, 404);
    assert.equal((await m.client.delete(`/api/expenses/${list.items[0].id}`)).status, 200);
    // Exportação e exclusão da loja incluem as tabelas novas.
    const exported = (await m.client.get("/api/account/export")).data;
    assert.equal(exported.expenses.length, 1);
    assert.equal((await m.client.post("/api/account/delete", { password: m.password, confirm_slug: m.slug })).status, 200);
  });
});
