import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client, createEnv, newMerchant } from "./helpers/env.js";
import { periodRange } from "../src/routes/dashboard.js";

async function setup() {
  const env = createEnv();
  const m = await newMerchant(env);
  const buyer = new Client(env, "203.0.113.90");
  const product = async (body) => (await m.client.post("/api/products", { stock: 10, ...body })).data.id;
  const sell = async (items, { confirm = true } = {}) => {
    const res = await buyer.post(`/api/order-request/${m.slug}`, { customer_name: "Ana", customer_phone: "54999990000", items });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    if (confirm) assert.equal((await m.client.patch(`/api/orders/${res.data.id}`, { status: "confirmed" })).status, 200);
    return res.data;
  };
  return { env, m, buyer, product, sell };
}

describe("custo e dados de compra do produto", () => {
  test("salva campos opcionais e não os apaga em edições que não os enviam", async () => {
    const { m, product } = await setup();
    const id = await product({ name: "Garrafa", price_cents: 4990, cost_cents: 2500, min_stock: 5, barcode: "7891234567895", supplier: "Distribuidora Sul", location: "Prateleira A2" });
    const get = async () => (await m.client.get("/api/products")).data.find((p) => p.id === id);
    let p = await get();
    assert.deepEqual([p.cost_cents, p.min_stock, p.barcode, p.supplier, p.location], [2500, 5, "7891234567895", "Distribuidora Sul", "Prateleira A2"]);
    // Cliente antigo do painel: não envia os campos novos.
    assert.equal((await m.client.patch(`/api/products/${id}`, { name: "Garrafa térmica", price_cents: 4990, stock: 10 })).status, 200);
    p = await get();
    assert.equal(p.cost_cents, 2500);
    assert.equal(p.supplier, "Distribuidora Sul");
    // Limpar o custo explicitamente.
    await m.client.patch(`/api/products/${id}`, { name: "Garrafa térmica", price_cents: 4990, stock: 10, cost_cents: null });
    assert.equal((await get()).cost_cents, null);
    assert.equal((await m.client.post("/api/products", { name: "X", price_cents: 1, stock: 1, barcode: "abc<script>" })).status, 400);
    assert.equal((await m.client.post("/api/products", { name: "X", price_cents: 1, stock: 1, cost_cents: -5 })).status, 400);
  });

  test("o pedido guarda o custo da época, sem mostrá-lo ao comprador nem na lista de pedidos", async () => {
    const { env, m, product, sell } = await setup();
    const id = await product({ name: "Garrafa", price_cents: 4990, cost_cents: 2500 });
    const order = await sell([{ id, quantity: 2 }]);
    assert.equal(order.items[0].cost_cents, undefined);
    const stored = await env.DB.prepare("SELECT items_json FROM orders WHERE id=?").bind(order.id).first();
    assert.equal(JSON.parse(stored.items_json)[0].cost_cents, 2500);
    const listed = (await m.client.get("/api/orders")).data[0];
    assert.equal(listed.items[0].cost_cents, undefined);
    // Mudar o custo depois não altera o lucro da venda já feita.
    await m.client.patch(`/api/products/${id}`, { name: "Garrafa", price_cents: 4990, stock: 8, cost_cents: 4000 });
    const d = (await m.client.get("/api/dashboard?period=today")).data;
    assert.equal(d.current.cogs, 5000);
    assert.equal(d.current.gross_profit, 9980 - 5000);
  });
});

describe("dashboard", () => {
  test("faturamento, vendas, ticket médio e lucro estimado com cobertura de custo", async () => {
    const { m, product, sell } = await setup();
    const a = await product({ name: "Garrafa", price_cents: 5000, cost_cents: 2000 });
    const b = await product({ name: "Copo", price_cents: 3000 }); // sem custo
    await sell([{ id: a, quantity: 2 }]);
    await sell([{ id: b, quantity: 1 }]);
    await sell([{ id: a, quantity: 1 }], { confirm: false }); // pendente não conta
    const d = (await m.client.get("/api/dashboard?period=7d")).data;
    assert.equal(d.current.sales, 2);
    assert.equal(d.current.revenue, 13000);
    assert.equal(d.current.average_ticket, 6500);
    assert.equal(d.current.cogs, 4000);
    assert.equal(d.current.gross_profit, 6000); // só sobre os itens com custo
    assert.equal(d.current.cost_coverage, 77);
    assert.equal(d.pending_orders, 1);
    assert.equal(d.top_products[0].name, "Garrafa");
    assert.equal(d.top_products[0].share, 77);
    const kinds = d.recommendations.map((r) => r.kind);
    assert.ok(kinds.includes("pending"));
    assert.ok(kinds.includes("cost"));
    assert.deepEqual(d.recommendations.find((r) => r.kind === "cost").action.ids, [b]);
  });

  test("compara com o período anterior", async () => {
    const { env, m, product, sell } = await setup();
    const a = await product({ name: "Garrafa", price_cents: 5000 });
    const old = await sell([{ id: a, quantity: 1 }]);
    await env.DB.prepare("UPDATE orders SET created_at=datetime('now','-1 day') WHERE id=?").bind(old.id).run();
    await sell([{ id: a, quantity: 2 }]);
    const today = (await m.client.get("/api/dashboard?period=today")).data;
    assert.equal(today.current.revenue, 10000);
    assert.equal(today.previous.revenue, 5000);
    const yesterday = (await m.client.get("/api/dashboard?period=yesterday")).data;
    assert.equal(yesterday.current.revenue, 5000);
  });

  test("estoque: valor pelo custo, valor de venda e itens para repor pelo estoque mínimo", async () => {
    const { m, product } = await setup();
    await product({ name: "Garrafa", price_cents: 5000, promo_price_cents: 4000, cost_cents: 2000, stock: 10, min_stock: 12 });
    await product({ name: "Copo", price_cents: 1000, cost_cents: 500, stock: 4 });
    const d = (await m.client.get("/api/dashboard")).data;
    assert.equal(d.stock.cost_value, 10 * 2000 + 4 * 500);
    assert.equal(d.stock.sale_value, 10 * 4000 + 4 * 1000);
    assert.equal(d.stock.potential_profit, 44000 - 22000);
    assert.deepEqual(d.stock.restock.map((r) => r.name), ["Garrafa"]); // 10 ≤ 12; Copo 4 > 3 (padrão)
    assert.equal(d.recommendations.find((r) => r.kind === "restock").action.label, "Preciso repor");
  });

  test("períodos válidos, permissão e isolamento", async () => {
    const { env, m, product, sell } = await setup();
    const a = await product({ name: "Garrafa", price_cents: 5000 });
    await sell([{ id: a, quantity: 1 }]);
    assert.equal((await m.client.get("/api/dashboard?period=semana")).status, 400);
    assert.equal((await m.client.get("/api/dashboard?period=custom&start=2026-01-01&end=2027-06-01")).status, 400);
    assert.equal((await m.client.get("/api/dashboard?period=custom&start=2026-02-10&end=2026-02-01")).status, 400);
    const other = await newMerchant(env);
    const d = (await other.client.get("/api/dashboard")).data;
    assert.equal(d.current.sales, 0);
    assert.equal(d.top_products.length, 0);
    await m.client.post("/api/team", { name: "Bia", email: "bia-dash@exemplo.com.br", password: "senha-provisoria-1", permissions: ["orders"] });
    const staff = new Client(env, "198.51.100.252");
    await staff.post("/api/login", { email: "bia-dash@exemplo.com.br", password: "senha-provisoria-1" });
    await staff.post("/api/account/password", { current_password: "senha-provisoria-1", new_password: "senha-nova-forte-1" });
    assert.equal((await staff.get("/api/dashboard")).status, 403);
  });

  test("intervalos de datas", () => {
    const p = (q) => periodRange(new URLSearchParams(q), "2026-11-27");
    assert.deepEqual([p("period=today").start, p("period=today").end], ["2026-11-27", "2026-11-27"]);
    assert.equal(p("period=yesterday").start, "2026-11-26");
    assert.equal(p("period=7d").start, "2026-11-21");
    assert.equal(p("period=30d").start, "2026-10-29");
    assert.equal(p("period=custom&start=2026-01-01&end=2026-01-31").end, "2026-01-31");
  });
});
