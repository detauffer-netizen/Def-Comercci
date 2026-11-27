import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client, createEnv, newMerchant } from "./helpers/env.js";

async function setup() {
  const env = createEnv();
  const m = await newMerchant(env);
  const pid = (await m.client.post("/api/products", { name: "Bolo", price_cents: 2500, stock: 10 })).data.id;
  const buyer = new Client(env, "203.0.113.77");
  return { env, m, pid, buyer };
}
const token = () => crypto.randomUUID();
const age = (env, id, minutes) =>
  env.DB.prepare(`UPDATE abandoned_carts SET updated_at=datetime('now','-${minutes} minutes') WHERE id=?`).bind(id).run();

describe("carrinho abandonado", () => {
  test("sem consentimento nada é guardado", async () => {
    const { env, m, pid, buyer } = await setup();
    const res = await buyer.request("PUT", `/api/cart-reminder/${m.slug}`, { token: token(), customer_name: "Ana", customer_phone: "54999990000", items: [{ id: pid, quantity: 1 }] });
    assert.equal(res.status, 400);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM abandoned_carts").first();
    assert.equal(n.n, 0);
  });

  test("com consentimento aparece para a loja depois de 30 minutos, com preço do banco", async () => {
    const { env, m, pid, buyer } = await setup();
    const t = token();
    const body = { token: t, consent: true, customer_name: "Ana", customer_phone: "(54) 99999-0000", items: [{ id: pid, quantity: 2, price_cents: 1 }] };
    assert.equal((await buyer.request("PUT", `/api/cart-reminder/${m.slug}`, body)).status, 200);
    assert.equal((await m.client.get("/api/abandoned-carts")).data.carts.length, 0, "recente ainda não é abandonado");
    await age(env, t, 31);
    const list = (await m.client.get("/api/abandoned-carts")).data;
    assert.equal(list.carts.length, 1);
    assert.equal(list.carts[0].total_cents, 5000);
    assert.equal(list.carts[0].customer_phone, "54999990000");
    assert.equal(list.carts[0].items[0].name, "Bolo");
    // Atualizar o carrinho mantém um só registro.
    await buyer.request("PUT", `/api/cart-reminder/${m.slug}`, { ...body, items: [{ id: pid, quantity: 3 }] });
    const rows = await env.DB.prepare("SELECT total_cents FROM abandoned_carts").all();
    assert.deepEqual(rows.results.map((r) => r.total_cents), [7500]);
  });

  test("outra loja não vê nem altera o carrinho", async () => {
    const { env, m, pid, buyer } = await setup();
    const other = await newMerchant(env);
    const t = token();
    await buyer.request("PUT", `/api/cart-reminder/${m.slug}`, { token: t, consent: true, customer_name: "Ana", customer_phone: "54999990000", items: [{ id: pid, quantity: 1 }] });
    await age(env, t, 60);
    assert.equal((await other.client.get("/api/abandoned-carts")).data.carts.length, 0);
    assert.equal((await other.client.patch(`/api/abandoned-carts/${t}`, { status: "contacted" })).status, 404);
    // Produto de outra loja não entra no carrinho.
    const res = await buyer.request("PUT", `/api/cart-reminder/${other.slug}`, { token: token(), consent: true, customer_name: "Ana", customer_phone: "54999990000", items: [{ id: pid, quantity: 1 }] });
    assert.equal(res.status, 409);
  });

  test("pedido finalizado apaga o carrinho; depois do contato conta como recuperado, sem dados pessoais", async () => {
    const { env, m, pid, buyer } = await setup();
    const order = (t) => buyer.post(`/api/order-request/${m.slug}`, { cart_token: t, customer_name: "Ana", customer_phone: "54999990000", items: [{ id: pid, quantity: 1 }] });
    const save = (t) => buyer.request("PUT", `/api/cart-reminder/${m.slug}`, { token: t, consent: true, customer_name: "Ana", customer_phone: "54999990000", items: [{ id: pid, quantity: 1 }] });
    const t1 = token();
    await save(t1);
    assert.equal((await order(t1)).status, 201);
    assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM abandoned_carts").first()).n, 0);

    const t2 = token();
    await save(t2);
    await age(env, t2, 45);
    assert.equal((await m.client.patch(`/api/abandoned-carts/${t2}`, { status: "contacted" })).status, 200);
    assert.equal((await order(t2)).status, 201);
    const row = await env.DB.prepare("SELECT status,customer_name,customer_phone,order_id FROM abandoned_carts WHERE id=?").bind(t2).first();
    assert.equal(row.status, "recovered");
    assert.equal(row.customer_phone, "");
    assert.ok(row.order_id);
    const list = (await m.client.get("/api/abandoned-carts")).data;
    assert.equal(list.recovered, 1);
    assert.equal(list.carts.length, 0);
  });

  test("comprador retira o consentimento e a loja descarta: dados apagados", async () => {
    const { env, m, pid, buyer } = await setup();
    const save = (t) => buyer.request("PUT", `/api/cart-reminder/${m.slug}`, { token: t, consent: true, customer_name: "Ana", customer_phone: "54999990000", items: [{ id: pid, quantity: 1 }] });
    const t1 = token();
    await save(t1);
    assert.equal((await buyer.delete(`/api/cart-reminder/${m.slug}/${t1}`)).status, 200);
    const t2 = token();
    await save(t2);
    await age(env, t2, 40);
    assert.equal((await m.client.patch(`/api/abandoned-carts/${t2}`, { status: "dismissed" })).status, 200);
    assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM abandoned_carts").first()).n, 0);
    assert.equal((await m.client.patch(`/api/abandoned-carts/${t2}`, { status: "outro" })).status, 400);
  });

  test("anonimizar cliente apaga os carrinhos dele; carrinhos com mais de 7 dias somem", async () => {
    const { env, m, pid, buyer } = await setup();
    const save = (t, phone) => buyer.request("PUT", `/api/cart-reminder/${m.slug}`, { token: t, consent: true, customer_name: "Ana", customer_phone: phone, items: [{ id: pid, quantity: 1 }] });
    const t1 = token();
    await save(t1, "54999990000");
    assert.equal((await m.client.delete("/api/customers/54999990000")).status, 200);
    const t2 = token();
    await save(t2, "54988887777");
    await age(env, t2, 8 * 24 * 60);
    assert.equal((await m.client.get("/api/abandoned-carts")).data.carts.length, 0);
    assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM abandoned_carts").first()).n, 0);
  });

  test("funcionário sem acesso a pedidos não vê carrinhos; exclusão da loja apaga tudo", async () => {
    const { env, m, pid, buyer } = await setup();
    await m.client.post("/api/team", { name: "Beto", email: "beto-carrinho@exemplo.com.br", password: "senha-provisoria-1", permissions: ["products"] });
    const staff = new Client(env, "198.51.100.251");
    await staff.post("/api/login", { email: "beto-carrinho@exemplo.com.br", password: "senha-provisoria-1" });
    await staff.post("/api/account/password", { current_password: "senha-provisoria-1", new_password: "senha-nova-forte-1" });
    assert.equal((await staff.get("/api/abandoned-carts")).status, 403);
    await buyer.request("PUT", `/api/cart-reminder/${m.slug}`, { token: token(), consent: true, customer_name: "Ana", customer_phone: "54999990000", items: [{ id: pid, quantity: 1 }] });
    const exported = (await m.client.get("/api/account/export")).data;
    assert.equal(exported.abandoned_carts.length, 1);
    assert.equal((await m.client.post("/api/account/delete", { password: m.password, confirm_slug: m.slug })).status, 200);
    assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM abandoned_carts").first()).n, 0);
  });
});
