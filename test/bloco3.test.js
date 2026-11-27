import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client, ORIGIN, createEnv, newMerchant, workerFetch } from "./helpers/env.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);

async function sell(env, m, { price = 1000, qty = 2, confirm = true, phone = "54999991111", name = "Ana Compradora" } = {}) {
  const id = (await m.client.post("/api/products", { name: `Item ${Math.random()}`, price_cents: price, stock: 50 })).data.id;
  const o = (await new Client(env, `192.0.2.${Math.floor(Math.random() * 200)}`).post(`/api/order-request/${m.slug}`, {
    customer_name: name, customer_phone: phone, notes: "Rua das Flores, 10", items: [{ id, quantity: qty }],
  })).data;
  if (confirm) await m.client.patch(`/api/orders/${o.id}`, { status: "confirmed" });
  return { productId: id, order: o };
}

describe("relatórios por período", () => {
  test("série diária completa, totais, comparação e mais vendidos", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    await sell(env, m, { price: 1000, qty: 2 });
    await sell(env, m, { price: 500, qty: 1, confirm: false });
    // Pedido de 40 dias atrás entra só no período anterior do relatório de 30 dias.
    const old = await sell(env, m, { price: 3000, qty: 1 });
    await env.DB.prepare("UPDATE orders SET created_at=datetime('now','-40 days') WHERE id=?").bind(old.order.id).run();
    const r = (await m.client.get("/api/reports?days=30")).data;
    assert.equal(r.series.length, 30);
    assert.equal(r.series.at(-1).day, r.end);
    assert.equal(r.series.reduce((s, d) => s + d.revenue, 0), 2000);
    assert.equal(r.totals.orders, 2);
    assert.equal(r.totals.sold, 1);
    assert.equal(r.totals.pending, 1);
    assert.equal(r.totals.average_ticket, 2000);
    assert.equal(r.previous.revenue, 3000);
    assert.equal(r.top_products.length, 1);
    assert.equal(r.top_products[0].quantity, 2);
    assert.equal((await m.client.get("/api/reports?days=365")).status, 400);
  });

  test("relatórios respeitam isolamento e permissão", async () => {
    const env = createEnv();
    const a = await newMerchant(env);
    const b = await newMerchant(env);
    await sell(env, a);
    assert.equal((await b.client.get("/api/reports?days=7")).data.totals.orders, 0);
    await a.client.post("/api/team", { name: "F", email: "f@x.com", password: "provisoria-123", permissions: ["orders"] });
    const staff = new Client(env, "198.18.1.1");
    await staff.post("/api/login", { email: "f@x.com", password: "provisoria-123" });
    await staff.post("/api/account/password", { current_password: "provisoria-123", new_password: "nova-senha-forte" });
    assert.equal((await staff.get("/api/reports?days=7")).status, 403);
  });
});

describe("LGPD", () => {
  test("exporta todos os dados da loja sem senhas", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    await sell(env, m);
    const res = await m.client.get("/api/account/export");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Disposition"), /attachment; filename="def-commerce-/);
    const d = res.data;
    assert.equal(d.store.slug, m.slug);
    assert.equal(d.products.length, 1);
    assert.equal(d.orders[0].customer_name, "Ana Compradora");
    assert.ok(Array.isArray(d.orders[0].items));
    assert.equal(d.team[0].email, m.email);
    assert.ok(!JSON.stringify(d).includes("pbkdf2"), "sem hash de senha");
    assert.ok(!JSON.stringify(d).includes("token"), "sem tokens");
  });

  test("anonimiza um comprador mantendo os pedidos nos relatórios", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    await sell(env, m, { phone: "54988887777" });
    await sell(env, m, { phone: "54988887777" });
    const other = await newMerchant(env);
    assert.equal((await other.client.delete("/api/customers/54988887777")).status, 404, "outra loja não alcança");
    const res = await m.client.delete("/api/customers/54988887777");
    assert.equal(res.status, 200);
    assert.equal(res.data.orders, 2);
    const orders = (await m.client.get("/api/orders")).data;
    assert.ok(orders.every((o) => o.customer_name === "Cliente removido" && o.customer_phone === "" && o.notes === ""));
    assert.equal((await m.client.get("/api/customers")).data.length, 0);
    assert.equal((await m.client.get("/api/metrics")).data.revenue, 0);
    assert.equal((await m.client.get("/api/reports?days=7")).data.totals.revenue, 4000, "vendas continuam contabilizadas");
  });

  test("excluir a loja exige senha e endereço e apaga tudo, inclusive imagens e equipe", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const keep = await newMerchant(env);
    const { productId } = await sell(env, m);
    await m.client.post(`/api/products/${productId}/images`, PNG, { raw: true, headers: { "Content-Type": "image/png" } });
    await m.client.post("/api/settings/logo", PNG, { raw: true, headers: { "Content-Type": "image/png" } });
    await m.client.post("/api/team", { name: "F", email: "func@x.com", password: "provisoria-123", permissions: ["orders"] });
    const keepId = (await keep.client.post("/api/products", { name: "Fica", price_cents: 1, stock: 1 })).data.id;
    assert.equal(env.IMAGES.objects.size, 2);

    assert.equal((await m.client.post("/api/account/delete", { password: "errada-errada", confirm_slug: m.slug })).status, 400);
    assert.equal((await m.client.post("/api/account/delete", { password: m.password, confirm_slug: "outra" })).status, 400);
    const res = await m.client.post("/api/account/delete", { password: m.password, confirm_slug: m.slug.toUpperCase() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Set-Cookie"), /Max-Age=0/);

    const count = async (sql) => (await env.DB.prepare(sql).first()).n;
    assert.equal(await count("SELECT COUNT(*) AS n FROM stores"), 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM orders"), 0);
    assert.equal(await count("SELECT COUNT(*) AS n FROM products"), 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM users WHERE email IN ('func@x.com')"), 0);
    assert.equal(await count(`SELECT COUNT(*) AS n FROM users WHERE email='${m.email}'`), 0);
    assert.equal(env.IMAGES.objects.size, 0);
    assert.equal((await new Client(env).get(`/api/store/${m.slug}`)).status, 404);
    assert.equal((await new Client(env, "198.18.2.2").post("/api/login", { email: m.email, password: m.password })).status, 401);
    assert.equal((await keep.client.get("/api/products")).data[0].id, keepId, "outra loja intacta");
  });

  test("apenas o proprietário exporta ou exclui", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    await m.client.post("/api/team", { name: "F", email: "f2@x.com", password: "provisoria-123", permissions: ["products", "orders", "customers", "reports"] });
    const staff = new Client(env, "198.18.3.3");
    await staff.post("/api/login", { email: "f2@x.com", password: "provisoria-123" });
    await staff.post("/api/account/password", { current_password: "provisoria-123", new_password: "nova-senha-forte" });
    assert.equal((await staff.get("/api/account/export")).status, 403);
    assert.equal((await staff.post("/api/account/delete", { password: "nova-senha-forte", confirm_slug: m.slug })).status, 403);
  });

  test("páginas de privacidade e termos", async () => {
    const env = createEnv();
    for (const path of ["/privacidade", "/termos"]) {
      const res = await workerFetch(env, new Request(ORIGIN + path));
      assert.equal(res.status, 200, path);
      assert.match(await res.text(), /LGPD|Política de Privacidade/);
    }
  });
});

describe("SEO da vitrine", () => {
  test("título, descrição, Open Graph e dados estruturados por loja, com escape", async () => {
    const env = createEnv();
    const m = await newMerchant(env, { name: 'Loja "Boa" <script>' });
    await m.client.patch("/api/settings", { description: "Moda & acessórios", whatsapp: "", accent: "#ff7a00" });
    await m.client.post("/api/settings/banner", PNG, { raw: true, headers: { "Content-Type": "image/png" } });
    const res = await workerFetch(env, new Request(`${ORIGIN}/loja/${m.slug}`));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>Loja &quot;Boa&quot; &lt;script&gt; \| Catálogo<\/title>/);
    assert.match(html, /<meta name="description" content="Moda &amp; acessórios">/);
    assert.match(html, /<meta property="og:image" content="https:\/\/def-commerce\.test\/img\/stores\//);
    assert.match(html, new RegExp(`<link rel="canonical" href="${ORIGIN}/loja/${m.slug}">`));
    assert.match(html, /<meta name="theme-color" content="#ff7a00">/);
    const ld = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1];
    assert.ok(!ld.includes("<script"), "JSON-LD não fecha a tag");
    assert.equal(JSON.parse(ld).name, 'Loja "Boa" <script>');
  });

  test("loja inexistente responde 404 sem indexação", async () => {
    const env = createEnv();
    const res = await workerFetch(env, new Request(`${ORIGIN}/loja/nao-existe`));
    assert.equal(res.status, 404);
    assert.match(await res.text(), /<meta name="robots" content="noindex">/);
  });

  test("sitemap lista lojas ativas com produtos; robots aponta para ele", async () => {
    const env = createEnv();
    const a = await newMerchant(env);
    const empty = await newMerchant(env);
    const suspended = await newMerchant(env);
    await a.client.post("/api/products", { name: "P", price_cents: 1, stock: 1 });
    await suspended.client.post("/api/products", { name: "P", price_cents: 1, stock: 1 });
    await env.DB.prepare("UPDATE stores SET status='suspended' WHERE slug=?").bind(suspended.slug).run();
    const xml = await (await workerFetch(env, new Request(`${ORIGIN}/sitemap.xml`))).text();
    assert.match(xml, new RegExp(`<loc>${ORIGIN}/loja/${a.slug}</loc>`));
    assert.ok(!xml.includes(empty.slug) && !xml.includes(suspended.slug));
    const robots = await (await workerFetch(env, new Request(`${ORIGIN}/robots.txt`))).text();
    assert.match(robots, new RegExp(`Sitemap: ${ORIGIN}/sitemap.xml`));
    assert.match(robots, /Disallow: \/admin/);
  });
});
