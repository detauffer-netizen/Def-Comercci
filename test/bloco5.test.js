import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client, ORIGIN, createEnv, newMerchant, workerFetch } from "./helpers/env.js";
import { hashPassword } from "../src/lib/crypto.js";

const buyer = (env, ip = "192.0.2.120") => new Client(env, ip);
const order = (env, slug, items, extra = {}, ip) =>
  buyer(env, ip).post(`/api/order-request/${slug}`, { customer_name: "Ana", customer_phone: "54999990000", items, ...extra });

async function setup(env) {
  const m = await newMerchant(env);
  const id = (await m.client.post("/api/products", { name: "Bolsa", price_cents: 10000, stock: 50 })).data.id;
  return { m, id };
}

describe("cupons de desconto", () => {
  test("proprietário cria, lista, edita e exclui cupons com validação", async () => {
    const env = createEnv();
    const { m } = await setup(env);
    const bad = [
      { code: "a", kind: "percent", value: 10 },
      { code: "VALIDO", kind: "percent", value: 95 },
      { code: "VALIDO", kind: "percent", value: 0 },
      { code: "VALIDO", kind: "brinde", value: 10 },
      { code: "VALIDO", kind: "fixed", value: -1 },
      { code: "VALIDO", kind: "fixed", value: 100, expires_at: "31/12/2026" },
    ];
    for (const body of bad) assert.equal((await m.client.post("/api/coupons", body)).status, 400, JSON.stringify(body));
    const created = await m.client.post("/api/coupons", { code: "bemvindo10", kind: "percent", value: 10, min_order_cents: 5000, max_uses: 2 });
    assert.equal(created.status, 201);
    assert.equal((await m.client.post("/api/coupons", { code: "BEMVINDO10", kind: "fixed", value: 500 })).status, 409);
    const list = (await m.client.get("/api/coupons")).data;
    assert.equal(list[0].code, "BEMVINDO10");
    assert.equal((await m.client.patch(`/api/coupons/${created.data.id}`, { code: "BEMVINDO10", kind: "percent", value: 15, active: false })).status, 200);
    assert.equal((await m.client.get("/api/coupons")).data[0].active, false);
    assert.equal((await m.client.delete(`/api/coupons/${created.data.id}`)).status, 200);
    assert.equal((await m.client.get("/api/coupons")).data.length, 0);
  });

  test("pedido com cupom percentual e fixo calcula o desconto no servidor", async () => {
    const env = createEnv();
    const { m, id } = await setup(env);
    await m.client.post("/api/coupons", { code: "DEZ", kind: "percent", value: 10 });
    await m.client.post("/api/coupons", { code: "MENOS30", kind: "fixed", value: 3000 });
    const preview = await buyer(env).post(`/api/order-preview/${m.slug}`, { items: [{ id, quantity: 2 }], coupon_code: "dez" });
    assert.deepEqual(preview.data, { valid: true, subtotal_cents: 20000, discount_cents: 2000, delivery_fee_cents: 0, total_cents: 18000, coupon_code: "DEZ" });
    const refused = await buyer(env).post(`/api/order-preview/${m.slug}`, { items: [{ id, quantity: 1 }], coupon_code: "NAOEXISTE" });
    assert.equal(refused.status, 200);
    assert.equal(refused.data.valid, false);
    assert.match(refused.data.error, /Cupom inválido/);
    const o = await order(env, m.slug, [{ id, quantity: 2 }], { coupon_code: "DEZ", discount_cents: 19999, total_cents: 1 });
    assert.equal(o.status, 201);
    assert.equal(o.data.total_cents, 18000);
    assert.equal(o.data.discount_cents, 2000);
    const fixed = await order(env, m.slug, [{ id, quantity: 1 }], { coupon_code: "MENOS30" }, "192.0.2.121");
    assert.equal(fixed.data.total_cents, 7000);
    const orders = (await m.client.get("/api/orders")).data;
    assert.ok(orders.some((x) => x.coupon_code === "DEZ" && x.subtotal_cents === 20000 && x.discount_cents === 2000));
  });

  test("desconto fixo nunca deixa o total negativo", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const id = (await m.client.post("/api/products", { name: "Bala", price_cents: 500, stock: 50 })).data.id;
    await m.client.post("/api/coupons", { code: "GRANDE", kind: "fixed", value: 100000 });
    const o = await order(env, m.slug, [{ id, quantity: 1 }], { coupon_code: "GRANDE" });
    assert.equal(o.data.total_cents, 0);
    assert.equal(o.data.discount_cents, 500);
  });

  test("respeita pedido mínimo, validade, status e limite de usos", async () => {
    const env = createEnv();
    const { m, id } = await setup(env);
    await m.client.post("/api/coupons", { code: "MINIMO", kind: "fixed", value: 1000, min_order_cents: 15000 });
    await m.client.post("/api/coupons", { code: "VENCIDO", kind: "fixed", value: 1000, expires_at: "2020-01-01" });
    await m.client.post("/api/coupons", { code: "PAUSADO", kind: "fixed", value: 1000, active: false });
    await m.client.post("/api/coupons", { code: "UMAVEZ", kind: "fixed", value: 1000, max_uses: 1 });
    assert.equal((await order(env, m.slug, [{ id, quantity: 1 }], { coupon_code: "MINIMO" })).status, 400);
    assert.equal((await order(env, m.slug, [{ id, quantity: 2 }], { coupon_code: "MINIMO" })).status, 201);
    assert.equal((await order(env, m.slug, [{ id, quantity: 1 }], { coupon_code: "VENCIDO" })).status, 400);
    assert.equal((await order(env, m.slug, [{ id, quantity: 1 }], { coupon_code: "PAUSADO" })).status, 400);
    assert.equal((await order(env, m.slug, [{ id, quantity: 1 }], { coupon_code: "INEXISTE" })).status, 400);
    const results = await Promise.all([
      order(env, m.slug, [{ id, quantity: 1 }], { coupon_code: "UMAVEZ" }, "192.0.2.130"),
      order(env, m.slug, [{ id, quantity: 1 }], { coupon_code: "UMAVEZ" }, "192.0.2.131"),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.equal(statuses[0], 201, "um pedido usa o cupom de uso único");
    assert.ok([400, 409].includes(statuses[1]), "o outro é recusado");
    const coupon = (await m.client.get("/api/coupons")).data.find((c) => c.code === "UMAVEZ");
    assert.equal(coupon.uses, 1);
  });

  test("cupom de uma loja não vale em outra e só o proprietário gerencia", async () => {
    const env = createEnv();
    const a = await setup(env);
    const b = await setup(env);
    const created = (await a.m.client.post("/api/coupons", { code: "SOAQUI", kind: "percent", value: 10 })).data;
    assert.equal((await order(env, b.m.slug, [{ id: b.id, quantity: 1 }], { coupon_code: "SOAQUI" })).status, 400);
    assert.equal((await b.m.client.patch(`/api/coupons/${created.id}`, { code: "X12", kind: "fixed", value: 1 })).status, 404);
    assert.equal((await b.m.client.delete(`/api/coupons/${created.id}`)).status, 404);
    assert.equal((await b.m.client.get("/api/coupons")).data.length, 0);
    await a.m.client.post("/api/team", { name: "F", email: "fc@x.com", password: "provisoria-123", permissions: ["products", "orders"] });
    const staff = new Client(env, "198.18.5.5");
    await staff.post("/api/login", { email: "fc@x.com", password: "provisoria-123" });
    await staff.post("/api/account/password", { current_password: "provisoria-123", new_password: "nova-senha-forte" });
    assert.equal((await staff.get("/api/coupons")).status, 403);
  });

  test("exclusão da loja também remove os cupons", async () => {
    const env = createEnv();
    const { m } = await setup(env);
    await m.client.post("/api/coupons", { code: "TCHAU", kind: "percent", value: 5 });
    assert.equal((await m.client.post("/api/account/delete", { password: m.password, confirm_slug: m.slug })).status, 200);
    assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM coupons").first()).n, 0);
  });
});

describe("monitoramento de erros", () => {
  test("erros inesperados ficam registrados para o administrador, sem números longos", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    // Simula uma falha interna só na listagem de clientes.
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql) => {
      if (sql.includes("GROUP BY customer_phone")) throw new Error("falha simulada");
      return realPrepare(sql);
    };
    assert.equal((await m.client.get("/api/customers")).status, 500);
    env.DB.prepare = realPrepare;
    const adminId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO users(id,email,password_hash) VALUES(?,?,?)").bind(adminId, "adm@x.com", await hashPassword("admin-senha-forte")).run();
    await env.DB.prepare("INSERT INTO platform_admins(user_id) VALUES(?)").bind(adminId).run();
    const admin = new Client(env, "100.64.1.1");
    await admin.post("/api/login", { email: "adm@x.com", password: "admin-senha-forte" });
    const errors = (await admin.get("/api/admin/errors")).data;
    assert.equal(errors.last_24h, 1);
    assert.equal(errors.grouped[0].path, "/api/customers");
    assert.equal(errors.grouped[0].message, "falha simulada");
    assert.equal((await m.client.get("/api/admin/errors")).status, 401);
  });

  test("caminhos com telefone são mascarados", async () => {
    const { safePath } = await import("../src/lib/errors.js");
    assert.equal(safePath("/api/customers/5554999990000"), "/api/customers/:n");
  });
});

describe("aplicativo instalável (PWA)", () => {
  test("manifesto e service worker são servidos com os tipos corretos", async () => {
    const env = createEnv();
    const manifest = await workerFetch(env, new Request(`${ORIGIN}/manifest.webmanifest`));
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get("Content-Type"), /application\/manifest\+json/);
    const data = await manifest.json();
    assert.equal(data.start_url, "/painel");
    assert.equal(data.display, "standalone");
    assert.ok(data.icons.some((i) => i.sizes === "512x512"));
    const sw = await workerFetch(env, new Request(`${ORIGIN}/sw.js`));
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get("Content-Type"), /javascript/);
    assert.equal(sw.headers.get("Cache-Control"), "no-cache");
    for (const icon of ["/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png"]) {
      assert.equal((await workerFetch(env, new Request(ORIGIN + icon))).status, 200, icon);
    }
  });
});
