import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client, ORIGIN, createEnv, newMerchant, workerFetch } from "./helpers/env.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);
const page = async (env, path) => {
  const res = await workerFetch(env, new Request(ORIGIN + path));
  return { status: res.status, html: await res.text() };
};

describe("página de produto", () => {
  test("título, preço, imagem e dados estruturados do produto", async () => {
    const env = createEnv();
    const m = await newMerchant(env, { name: "Moda <Sul>" });
    const id = (await m.client.post("/api/products", { name: "Vestido \"Floral\"", description: "Tecido leve.\nIdeal para o verão.", price_cents: 14990, promo_price_cents: 11990, stock: 3, sku: "VES-1" })).data.id;
    await m.client.post(`/api/products/${id}/images`, PNG, { raw: true, headers: { "Content-Type": "image/png" } });
    const { status, html } = await page(env, `/loja/${m.slug}/p/${id}`);
    assert.equal(status, 200);
    assert.match(html, /<title>Vestido &quot;Floral&quot; · R\$ 119,90 \| Moda &lt;Sul&gt;<\/title>/);
    assert.match(html, /<meta name="description" content="Tecido leve\. Ideal para o verão\.">/);
    assert.match(html, new RegExp(`<link rel="canonical" href="${ORIGIN}/loja/${m.slug}/p/${id}">`));
    assert.match(html, /<meta property="og:type" content="product">/);
    assert.match(html, /<meta property="og:image" content="https:\/\/def-commerce\.test\/img\/stores\/[^"]+\/products\//);
    assert.match(html, /<meta property="product:price:amount" content="119\.90">/);
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
    assert.equal(ld["@type"], "Product");
    assert.equal(ld.offers.price, "119.90");
    assert.equal(ld.offers.availability, "https://schema.org/InStock");
    assert.equal(ld.sku, "VES-1");
  });

  test("produto com variações usa faixa de preço e disponibilidade das variações", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const id = (await m.client.post("/api/products", { name: "Camiseta", price_cents: 5000, stock: 0, variants: [{ name: "P", stock: 0 }, { name: "G", stock: 0, price_cents: 6000 }] })).data.id;
    const { html } = await page(env, `/loja/${m.slug}/p/${id}`);
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
    assert.equal(ld.offers["@type"], "AggregateOffer");
    assert.equal(ld.offers.lowPrice, "50.00");
    assert.equal(ld.offers.highPrice, "60.00");
    assert.equal(ld.offers.availability, "https://schema.org/OutOfStock");
  });

  test("produto inexistente, inativo ou de outra loja responde 404", async () => {
    const env = createEnv();
    const a = await newMerchant(env);
    const b = await newMerchant(env);
    const id = (await a.client.post("/api/products", { name: "X", price_cents: 100, stock: 1 })).data.id;
    const hidden = (await a.client.post("/api/products", { name: "Oculto", price_cents: 100, stock: 1, active: false })).data.id;
    assert.equal((await page(env, `/loja/${b.slug}/p/${id}`)).status, 404);
    assert.equal((await page(env, `/loja/${a.slug}/p/${hidden}`)).status, 404);
    assert.equal((await page(env, `/loja/${a.slug}/p/00000000-0000-0000-0000-000000000000`)).status, 404);
    assert.equal((await page(env, `/loja/${a.slug}/p/nao-e-id`)).status, 404);
  });

  test("sitemap inclui páginas de produtos ativos", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const id = (await m.client.post("/api/products", { name: "X", price_cents: 100, stock: 1 })).data.id;
    const hidden = (await m.client.post("/api/products", { name: "Y", price_cents: 100, stock: 1, active: false })).data.id;
    const xml = (await page(env, "/sitemap.xml")).html;
    assert.match(xml, new RegExp(`/loja/${m.slug}/p/${id}</loc>`));
    assert.ok(!xml.includes(hidden));
  });
});

describe("notificações de pedidos", () => {
  test("informa pedidos novos desde a última consulta e o total pendente", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const first = (await m.client.get("/api/notifications")).data;
    assert.equal(first.pending, 0);
    assert.deepEqual(first.new_orders, []);
    assert.match(first.now, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const id = (await m.client.post("/api/products", { name: "X", price_cents: 1500, stock: 9 })).data.id;
    await new Client(env, "192.0.2.90").post(`/api/order-request/${m.slug}`, { customer_name: "Lia", customer_phone: "54999990000", items: [{ id, quantity: 2 }] });
    const next = (await m.client.get(`/api/notifications?since=${encodeURIComponent(first.now)}`)).data;
    assert.equal(next.pending, 1);
    assert.equal(next.new_orders.length, 1);
    assert.equal(next.new_orders[0].customer_name, "Lia");
    assert.equal(next.new_orders[0].total_cents, 3000);
    assert.equal(next.new_orders[0].code.length, 8);
    assert.equal((await m.client.get("/api/notifications?since=ontem")).status, 400);
  });

  test("respeita isolamento e permissão de pedidos", async () => {
    const env = createEnv();
    const a = await newMerchant(env);
    const b = await newMerchant(env);
    const id = (await a.client.post("/api/products", { name: "X", price_cents: 1, stock: 9 })).data.id;
    await new Client(env, "192.0.2.91").post(`/api/order-request/${a.slug}`, { customer_name: "Lia", customer_phone: "54999990000", items: [{ id, quantity: 1 }] });
    const r = (await b.client.get("/api/notifications?since=2000-01-01 00:00:00")).data;
    assert.equal(r.pending, 0);
    assert.deepEqual(r.new_orders, []);
    await a.client.post("/api/team", { name: "F", email: "f@x.com", password: "provisoria-123", permissions: ["products"] });
    const staff = new Client(env, "198.18.4.4");
    await staff.post("/api/login", { email: "f@x.com", password: "provisoria-123" });
    await staff.post("/api/account/password", { current_password: "provisoria-123", new_password: "nova-senha-forte" });
    assert.equal((await staff.get("/api/notifications")).status, 403);
  });
});
