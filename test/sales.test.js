import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client, createEnv, newMerchant } from "./helpers/env.js";

async function setup() {
  const env = createEnv();
  const m = await newMerchant(env);
  const product = async (body) => (await m.client.post("/api/products", { stock: 5, ...body })).data.id;
  const sale = (body) => m.client.post("/api/sales", { id: crypto.randomUUID(), ...body });
  const stockOf = async (id) => (await m.client.get("/api/products")).data.find((p) => p.id === id);
  return { env, m, product, sale, stockOf };
}

describe("PDV — venda presencial", () => {
  test("venda no Pix baixa o estoque, fica concluída e calcula o total no servidor", async () => {
    const { m, product, sale, stockOf } = await setup();
    const id = await product({ name: "Garrafa", price_cents: 4990, cost_cents: 2500 });
    const res = await sale({ items: [{ id, quantity: 2, price_cents: 1 }], discount_cents: 980, payments: [{ method: "pix", amount_cents: 9000 }] });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.total_cents, 9000);
    assert.equal(res.data.status, "completed");
    assert.equal(res.data.channel, "pos");
    assert.equal(res.data.customer_name, "Cliente do balcão");
    assert.equal(res.data.items[0].cost_cents, undefined);
    assert.equal((await stockOf(id)).stock, 3);
    const d = (await m.client.get("/api/dashboard?period=today")).data;
    assert.equal(d.current.revenue, 9000);
    assert.equal(d.current.cogs, 5000);
  });

  test("reenviar a mesma venda não duplica o registro nem a baixa", async () => {
    const { env, m, product, stockOf } = await setup();
    const id = await product({ name: "Copo", price_cents: 1000 });
    const body = { id: crypto.randomUUID(), items: [{ id, quantity: 1 }], payments: [{ method: "cash", amount_cents: 1000 }] };
    assert.equal((await m.client.post("/api/sales", body)).status, 201);
    const again = await m.client.post("/api/sales", body);
    assert.equal(again.status, 200);
    assert.equal(again.data.replayed, true);
    assert.equal((await stockOf(id)).stock, 4);
    assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM orders").first()).n, 1);
  });

  test("estoque nunca fica negativo, mesmo com vendas simultâneas", async () => {
    const { product, sale, stockOf } = await setup();
    const id = await product({ name: "Último", price_cents: 1000, stock: 1 });
    const results = await Promise.all([1, 2, 3].map(() => sale({ items: [{ id, quantity: 1 }], payments: [{ method: "pix", amount_cents: 1000 }] })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
    assert.equal((await stockOf(id)).stock, 0);
  });

  test("pagamento misto precisa fechar o total; a prazo exige cliente e vira conta a receber", async () => {
    const { m, product, sale } = await setup();
    const id = await product({ name: "Panela", price_cents: 10000 });
    assert.equal((await sale({ items: [{ id, quantity: 1 }], payments: [{ method: "pix", amount_cents: 5000 }, { method: "cash", amount_cents: 4000 }] })).status, 400);
    assert.equal((await sale({ items: [{ id, quantity: 1 }], payments: [{ method: "boleto", amount_cents: 10000 }] })).status, 400);
    const mixed = await sale({ items: [{ id, quantity: 1 }], payments: [{ method: "pix", amount_cents: 6000 }, { method: "debit", amount_cents: 4000 }] });
    assert.equal(mixed.status, 201);
    assert.equal(mixed.data.payments.length, 2);
    assert.equal((await sale({ items: [{ id, quantity: 1 }], payments: [{ method: "account", amount_cents: 10000 }] })).status, 400);
    const credit = await sale({ items: [{ id, quantity: 1 }], customer_name: "Seu Jorge", customer_phone: "(54) 98888-1111", payments: [{ method: "cash", amount_cents: 3000 }, { method: "account", amount_cents: 7000 }] });
    assert.equal(credit.status, 201);
    assert.equal(credit.data.receivable_cents, 7000);
    const d = (await m.client.get("/api/dashboard?period=today")).data;
    assert.deepEqual(d.receivable, { cents: 7000, sales: 1 });
    const customers = (await m.client.get("/api/customers")).data;
    assert.equal(customers.find((c) => c.phone === "54988881111").name, "Seu Jorge");
  });

  test("vende produto oculto da vitrine e variação; desconto maior que a venda é recusado", async () => {
    const { m, product, sale, stockOf } = await setup();
    const hidden = await product({ name: "Só no balcão", price_cents: 2000, active: false });
    assert.equal((await sale({ items: [{ id: hidden, quantity: 1 }], payments: [{ method: "credit", amount_cents: 2000 }] })).status, 201);
    assert.equal((await sale({ items: [{ id: hidden, quantity: 1 }], discount_cents: 2500, payments: [{ method: "pix", amount_cents: 0 }] })).status, 400);
    const shirt = await product({ name: "Camiseta", price_cents: 5000, variants: [{ name: "P", stock: 2 }, { name: "M", stock: 2 }] });
    const p = await stockOf(shirt);
    const m1 = p.variants.find((x) => x.name === "M");
    assert.equal((await sale({ items: [{ id: shirt, quantity: 1 }], payments: [{ method: "pix", amount_cents: 5000 }] })).status, 400);
    assert.equal((await sale({ items: [{ id: shirt, variant_id: m1.id, quantity: 2 }], payments: [{ method: "pix", amount_cents: 10000 }] })).status, 201);
    const after = await stockOf(shirt);
    assert.equal(after.variants.find((x) => x.name === "M").stock, 0);
    assert.equal(after.stock, 2);
    // Venda presencial não dispara aviso de pedido novo, e o filtro por canal funciona.
    const n = (await m.client.get("/api/notifications?since=2000-01-01 00:00:00")).data;
    assert.equal(n.new_orders.length, 0);
    assert.equal((await m.client.get("/api/orders?channel=pos")).data.length, 2);
    assert.equal((await m.client.get("/api/orders?channel=online")).data.length, 0);
  });

  test("isolamento e permissões", async () => {
    const { env, m, product, sale } = await setup();
    const id = await product({ name: "Garrafa", price_cents: 1000 });
    const other = await newMerchant(env);
    const res = await other.client.post("/api/sales", { id: crypto.randomUUID(), items: [{ id, quantity: 1 }], payments: [{ method: "pix", amount_cents: 1000 }] });
    assert.equal(res.status, 409);
    const sold = await sale({ items: [{ id, quantity: 1 }], payments: [{ method: "pix", amount_cents: 1000 }] });
    const ownId = await other.client.post("/api/products", { name: "X", price_cents: 1000, stock: 3 });
    const steal = await other.client.post("/api/sales", { id: sold.data.id, items: [{ id: ownId.data.id, quantity: 1 }], payments: [{ method: "pix", amount_cents: 1000 }] });
    assert.equal(steal.status, 409);
    assert.equal((await m.client.post("/api/sales", { id: "123", items: [{ id, quantity: 1 }], payments: [{ method: "pix", amount_cents: 1000 }] })).status, 400);
    await m.client.post("/api/team", { name: "Caio", email: "caio-pdv@exemplo.com.br", password: "senha-provisoria-1", permissions: ["products"] });
    const staff = new Client(env, "198.51.100.253");
    await staff.post("/api/login", { email: "caio-pdv@exemplo.com.br", password: "senha-provisoria-1" });
    await staff.post("/api/account/password", { current_password: "senha-provisoria-1", new_password: "senha-nova-forte-1" });
    assert.equal((await staff.post("/api/sales", { id: crypto.randomUUID(), items: [{ id, quantity: 1 }], payments: [{ method: "pix", amount_cents: 1000 }] })).status, 403);
  });
});
