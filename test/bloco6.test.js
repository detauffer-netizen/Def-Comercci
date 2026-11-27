import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client, createEnv, newMerchant } from "./helpers/env.js";

const order = (env, slug, items, extra = {}, ip = "192.0.2.140") =>
  new Client(env, ip).post(`/api/order-request/${slug}`, { customer_name: "Ana", customer_phone: "54999990000", items, ...extra });

async function store(env, settings) {
  const m = await newMerchant(env);
  const id = (await m.client.post("/api/products", { name: "Bolo", price_cents: 4000, stock: 50 })).data.id;
  if (settings) assert.equal((await m.client.patch("/api/settings", { accent: "#2563eb", ...settings })).status, 200);
  return { m, id };
}

describe("entrega e retirada", () => {
  test("sem opções configuradas o pedido segue como antes (a combinar)", async () => {
    const env = createEnv();
    const { m, id } = await store(env);
    const o = await order(env, m.slug, [{ id, quantity: 1 }]);
    assert.equal(o.status, 201);
    assert.equal(o.data.fulfillment, "");
    assert.equal(o.data.total_cents, 4000);
    assert.deepEqual((await new Client(env).get(`/api/store/${m.slug}`)).data.delivery, { pickup: false, delivery: false, fee_cents: 0, free_above_cents: null });
  });

  test("entrega soma a taxa, exige endereço e é grátis acima do valor configurado", async () => {
    const env = createEnv();
    const { m, id } = await store(env, { delivery_fee_cents: 800, free_delivery_above_cents: 10000, pickup_enabled: true });
    assert.equal((await order(env, m.slug, [{ id, quantity: 1 }])).status, 400, "precisa escolher a forma");
    assert.equal((await order(env, m.slug, [{ id, quantity: 1 }], { fulfillment: "delivery" })).status, 400, "precisa de endereço");
    const d = await order(env, m.slug, [{ id, quantity: 1 }], { fulfillment: "delivery", address: "Rua das Flores, 10 - Centro", delivery_fee_cents: 0 });
    assert.equal(d.status, 201);
    assert.equal(d.data.delivery_fee_cents, 800);
    assert.equal(d.data.total_cents, 4800);
    const free = await order(env, m.slug, [{ id, quantity: 3 }], { fulfillment: "delivery", address: "Rua das Flores, 10" }, "192.0.2.141");
    assert.equal(free.data.delivery_fee_cents, 0);
    assert.equal(free.data.total_cents, 12000);
    const pickup = await order(env, m.slug, [{ id, quantity: 1 }], { fulfillment: "pickup", address: "ignorado" }, "192.0.2.142");
    assert.equal(pickup.data.fulfillment, "pickup");
    assert.equal(pickup.data.address, "");
    assert.equal(pickup.data.total_cents, 4000);
    const orders = (await m.client.get("/api/orders")).data;
    assert.ok(orders.some((o) => o.fulfillment === "delivery" && o.address.startsWith("Rua das Flores") && o.delivery_fee_cents === 800));
  });

  test("opção não oferecida pela loja é recusada; prévia mostra a taxa", async () => {
    const env = createEnv();
    const { m, id } = await store(env, { pickup_enabled: true });
    assert.equal((await order(env, m.slug, [{ id, quantity: 1 }], { fulfillment: "delivery", address: "Rua X, 100" })).status, 400);
    const { m: m2, id: id2 } = await store(env, { delivery_fee_cents: 500 });
    const prev = await new Client(env).post(`/api/order-preview/${m2.slug}`, { items: [{ id: id2, quantity: 1 }], fulfillment: "delivery" });
    assert.equal(prev.data.delivery_fee_cents, 500);
    assert.equal(prev.data.total_cents, 4500);
  });

  test("frete grátis considera o valor já com desconto do cupom", async () => {
    const env = createEnv();
    const { m, id } = await store(env, { delivery_fee_cents: 700, free_delivery_above_cents: 8000 });
    await m.client.post("/api/coupons", { code: "DEZ", kind: "percent", value: 10 });
    const o = await order(env, m.slug, [{ id, quantity: 2 }], { coupon_code: "DEZ", fulfillment: "delivery", address: "Av. Brasil, 500" });
    assert.equal(o.data.discount_cents, 800);
    assert.equal(o.data.delivery_fee_cents, 700, "R$ 72 após desconto não atinge R$ 80");
    assert.equal(o.data.total_cents, 8000 - 800 + 700);
  });

  test("valida configurações de entrega", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    assert.equal((await m.client.patch("/api/settings", { accent: "#2563eb", delivery_fee_cents: -1 })).status, 400);
    assert.equal((await m.client.patch("/api/settings", { accent: "#2563eb", delivery_fee_cents: 12.5 })).status, 400);
    assert.equal((await m.client.patch("/api/settings", { accent: "#2563eb", delivery_fee_cents: 0, pickup_enabled: true })).status, 200);
    const s = (await m.client.get("/api/me")).data.store;
    assert.equal(s.delivery_fee_cents, 0);
    assert.equal(s.pickup_enabled, true);
    // Editar outros campos não apaga a configuração de entrega.
    await m.client.patch("/api/settings", { name: "Outro Nome", accent: "#2563eb" });
    assert.equal((await m.client.get("/api/me")).data.store.delivery_fee_cents, 0);
  });

  test("anonimizar cliente apaga também o endereço", async () => {
    const env = createEnv();
    const { m, id } = await store(env, { delivery_fee_cents: 500 });
    await order(env, m.slug, [{ id, quantity: 1 }], { fulfillment: "delivery", address: "Rua Secreta, 42" });
    await m.client.delete("/api/customers/54999990000");
    assert.equal((await m.client.get("/api/orders")).data[0].address, "");
  });
});

describe("ordem dos produtos na vitrine", () => {
  test("destaques primeiro, depois a ordem definida pelo lojista", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    await m.client.post("/api/products", { name: "Abacaxi", price_cents: 1, stock: 1, position: 3 });
    await m.client.post("/api/products", { name: "Banana", price_cents: 1, stock: 1, position: 1 });
    await m.client.post("/api/products", { name: "Caju", price_cents: 1, stock: 1, position: 2, featured: true });
    await m.client.post("/api/products", { name: "Damasco", price_cents: 1, stock: 1 });
    const names = (await new Client(env).get(`/api/store/${m.slug}`)).data.products.map((p) => p.name);
    assert.deepEqual(names, ["Caju", "Damasco", "Banana", "Abacaxi"]);
    assert.equal((await m.client.post("/api/products", { name: "X", price_cents: 1, stock: 1, position: -1 })).status, 400);
  });
});
