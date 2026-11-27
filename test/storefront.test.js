import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client, createEnv, newMerchant } from "./helpers/env.js";

async function setup() {
  const env = createEnv();
  const m = await newMerchant(env);
  const buyer = new Client(env, "203.0.113.93");
  return { env, m, buyer };
}

describe("vitrine premium", () => {
  test("modelo, horário e aviso são salvos, validados e aparecem na vitrine", async () => {
    const { m, buyer } = await setup();
    const hours = [{ d: 1, open: "09:00", close: "18:00" }, { d: 6, open: "09:00", close: "13:00" }];
    assert.equal((await m.client.patch("/api/settings", { template: "roupas", hours, announcement: "Frete grátis acima de R$ 150" })).status, 200);
    const me = (await m.client.get("/api/me")).data.store;
    assert.deepEqual([me.template, me.hours.length, me.announcement], ["roupas", 2, "Frete grátis acima de R$ 150"]);
    // Editar outra configuração não apaga o horário.
    await m.client.patch("/api/settings", { name: "Loja Nova" });
    assert.equal((await m.client.get("/api/me")).data.store.hours.length, 2);
    for (const bad of [{ template: "neon" }, { hours: [{ d: 7, open: "09:00", close: "18:00" }] }, { hours: [{ d: 1, open: "18:00", close: "09:00" }] },
      { hours: [{ d: 1, open: "9h", close: "18:00" }] }, { announcement: "x".repeat(141) }]) {
      assert.equal((await m.client.patch("/api/settings", bad)).status, 400, JSON.stringify(bad));
    }
    await m.client.post("/api/products", { name: "Vestido", price_cents: 10000, stock: 2 });
    const shop = (await buyer.get(`/api/store/${m.slug}`)).data;
    assert.equal(shop.template, "roupas");
    assert.equal(shop.hours[0].open, "09:00");
    assert.equal(shop.announcement, "Frete grátis acima de R$ 150");
    assert.equal(shop.products[0].is_new, true);
  });

  test("acompanhamento do pedido: link secreto, status e nenhum dado pessoal", async () => {
    const { env, m, buyer } = await setup();
    const id = (await m.client.post("/api/products", { name: "Bolo", price_cents: 4500, stock: 5, cost_cents: 2000 })).data.id;
    await m.client.patch("/api/settings", { pickup_enabled: true });
    const order = (await buyer.post(`/api/order-request/${m.slug}`, {
      customer_name: "Maria da Silva", customer_phone: "54999990000", notes: "Portão azul", fulfillment: "pickup", items: [{ id, quantity: 2 }],
    })).data;
    assert.match(order.tracking_url, /^\/pedido\/[0-9a-f]{32}$/);
    const token = order.tracking_url.split("/")[2];
    const res = await buyer.get(`/api/order-status/${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.equal(res.data.status, "pending");
    assert.equal(res.data.first_name, "Maria");
    assert.equal(res.data.total_cents, 9000);
    const text = JSON.stringify(res.data);
    for (const secret of ["54999990000", "Portão azul", "da Silva", "cost_cents", order.id]) assert.ok(!text.includes(secret), `vazou ${secret}`);
    await m.client.patch(`/api/orders/${order.id}`, { status: "confirmed" });
    assert.equal((await buyer.get(`/api/order-status/${token}`)).data.status_label, "Confirmado pela loja");
    assert.equal((await buyer.get(`/api/order-status/${"0".repeat(32)}`)).status, 404);
    assert.equal((await buyer.get("/api/order-status/abc")).status, 404);
    // Loja suspensa: o link deixa de funcionar.
    await env.DB.prepare("UPDATE stores SET status='suspended' WHERE slug=?").bind(m.slug).run();
    assert.equal((await buyer.get(`/api/order-status/${token}`)).status, 404);
  });

  test("a página de acompanhamento não é indexada nem repassa o endereço", async () => {
    const { buyer } = await setup();
    const res = await buyer.request("GET", `/pedido/${"a".repeat(32)}`);
    assert.equal(res.headers.get("X-Robots-Tag"), "noindex");
    assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal((await buyer.request("GET", "/pedido/curto")).status, 404);
  });
});
