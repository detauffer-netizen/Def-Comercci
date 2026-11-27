import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client, ORIGIN, createEnv, newMerchant, workerFetch } from "./helpers/env.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);

async function product(client, overrides = {}) {
  const body = { name: "Camiseta", price_cents: 5990, stock: 5, category: "Roupas", ...overrides };
  const res = await client.post("/api/products", body);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.id;
}

async function order(env, slug, items, ip = "192.0.2.10") {
  const buyer = new Client(env, ip);
  return buyer.post(`/api/order-request/${slug}`, { customer_name: "Maria Cliente", customer_phone: "(54) 99999-1234", items });
}

describe("saúde e páginas", () => {
  test("health check responde ok com o banco", async () => {
    const env = createEnv();
    const res = await new Client(env).get("/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.data.status, "ok");
  });

  test("páginas estáticas são servidas com cabeçalhos de segurança", async () => {
    const env = createEnv();
    for (const path of ["/", "/painel", "/loja/minha-loja"]) {
      const res = await workerFetch(env, new Request(ORIGIN + path));
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
      assert.equal(res.headers.get("X-Frame-Options"), "DENY");
    }
    const missing = await workerFetch(env, new Request(ORIGIN + "/nao-existe"));
    assert.equal(missing.status, 404);
  });
});

describe("cadastro, login e sessão", () => {
  test("cadastro cria loja e já autentica o lojista", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const me = await m.client.get("/api/me");
    assert.equal(me.status, 200);
    assert.equal(me.data.store.slug, m.slug);
    assert.equal(me.data.user.role, "owner");
    const stored = await env.DB.prepare("SELECT password_hash FROM users WHERE email=?").bind(m.email).first();
    assert.match(stored.password_hash, /^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    assert.ok(!stored.password_hash.includes(m.password));
  });

  test("valida dados do cadastro e rejeita duplicidades", async () => {
    const env = createEnv();
    const c = new Client(env);
    assert.equal((await c.post("/api/register", { name: "X", slug: "ok-loja", email: "a@b.co", password: "curta" })).status, 400);
    assert.equal((await c.post("/api/register", { name: "X", slug: "API", email: "a@b.co", password: "senha-forte-123" })).status, 400);
    assert.equal((await c.post("/api/register", { name: "X", slug: "painel", email: "a@b.co", password: "senha-forte-123" })).status, 400);
    const m = await newMerchant(env);
    const dup = await new Client(env, "192.0.2.99").post("/api/register", { name: "Y", slug: "outra-loja", email: m.email, password: "senha-forte-123" });
    assert.equal(dup.status, 409);
  });

  test("login correto, senha errada e logout", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const c = new Client(env, "192.0.2.50");
    assert.equal((await c.post("/api/login", { email: m.email, password: "errada-errada" })).status, 401);
    assert.equal((await c.post("/api/login", { email: "ninguem@x.com", password: "errada-errada" })).status, 401);
    const ok = await c.post("/api/login", { email: m.email.toUpperCase(), password: m.password });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("Set-Cookie"), /^__Host-def_session=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict/);
    assert.equal((await c.get("/api/me")).status, 200);
    assert.equal((await c.post("/api/logout", {})).status, 200);
    assert.equal((await c.get("/api/me")).status, 401);
  });

  test("senha no formato legado continua aceita e é migrada", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    // Gera o hash legado "<salt>:<hash>" igual ao código anterior.
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(m.password), "PBKDF2", false, ["deriveBits"]);
    const salt = crypto.randomUUID();
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" }, key, 256);
    const legacy = salt + ":" + Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare("UPDATE users SET password_hash=? WHERE email=?").bind(legacy, m.email).run();
    const c = new Client(env, "192.0.2.51");
    assert.equal((await c.post("/api/login", { email: m.email, password: m.password })).status, 200);
    const after = await env.DB.prepare("SELECT password_hash FROM users WHERE email=?").bind(m.email).first();
    assert.match(after.password_hash, /^pbkdf2\$/);
  });

  test("sessão expirada ou cookie forjado não acessam o painel", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    await env.DB.prepare("UPDATE sessions SET expires_at=1").run();
    assert.equal((await m.client.get("/api/me")).status, 401);
    const forged = new Client(env);
    forged.cookie = "__Host-def_session=" + "a".repeat(64);
    assert.equal((await forged.get("/api/products")).status, 401);
  });

  test("limita tentativas de login por conta", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    let last;
    for (let i = 0; i < 11; i++) {
      last = await new Client(env, `10.0.0.${i}`).post("/api/login", { email: m.email, password: "errada-errada" });
    }
    assert.equal(last.status, 429);
  });

  test("limita cadastros por IP", async () => {
    const env = createEnv();
    const c = new Client(env, "10.9.9.9");
    let last;
    for (let i = 0; i < 6; i++) {
      last = await c.post("/api/register", { name: "L", slug: `spam-${i}`, email: `s${i}@x.com`, password: "senha-forte-123" });
    }
    assert.equal(last.status, 429);
  });
});

describe("proteções de requisição", () => {
  test("bloqueia escrita de outra origem (CSRF)", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const res = await m.client.request("POST", "/api/products", { name: "X", price_cents: 1, stock: 1 }, { headers: { Origin: "https://malicioso.example" } });
    assert.equal(res.status, 403);
  });

  test("exige JSON no corpo", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const res = await m.client.request("POST", "/api/products", "name=X", { raw: true, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    assert.equal(res.status, 415);
    const bad = await m.client.request("POST", "/api/products", "{quebrado", { raw: true, headers: { "Content-Type": "application/json" } });
    assert.equal(bad.status, 400);
  });

  test("tentativa de SQL injection é tratada como texto", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    await product(m.client, { name: "x'); DROP TABLE products; --" });
    const list = await m.client.get("/api/products");
    assert.equal(list.data[0].name, "x'); DROP TABLE products; --");
    const res = await new Client(env).get("/api/store/" + encodeURIComponent("x' OR '1'='1"));
    assert.equal(res.status, 404);
  });

  test("erros inesperados retornam 500 sem detalhes internos", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const broken = { ...env, DB: { prepare() { throw new Error("segredo interno do banco"); } } };
    const res = await workerFetch(broken, new Request(ORIGIN + "/api/me", { headers: { Cookie: m.client.cookie } }));
    assert.equal(res.status, 500);
    assert.ok(!(await res.text()).includes("segredo"));
  });
});

describe("produtos e isolamento entre lojas", () => {
  test("CRUD completo com campos de catálogo", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const id = await product(m.client, { description: "Algodão", sku: "CAM-01", promo_price_cents: 4990, featured: true });
    let list = (await m.client.get("/api/products")).data;
    assert.equal(list.length, 1);
    assert.equal(list[0].final_price_cents, 4990);
    assert.equal(list[0].featured, true);
    const upd = await m.client.patch(`/api/products/${id}`, { name: "Camiseta Azul", price_cents: 6990, stock: 3, sku: "CAM-01", active: false });
    assert.equal(upd.status, 200);
    list = (await m.client.get("/api/products")).data;
    assert.equal(list[0].name, "Camiseta Azul");
    assert.equal(list[0].active, false);
    assert.equal((await m.client.delete(`/api/products/${id}`)).status, 200);
    assert.equal((await m.client.get("/api/products")).data.length, 0);
  });

  test("valida preço, promoção, estoque e SKU", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const bad = [
      { name: "", price_cents: 100, stock: 1 },
      { name: "A", price_cents: -1, stock: 1 },
      { name: "A", price_cents: 10.5, stock: 1 },
      { name: "A", price_cents: 100, stock: -1 },
      { name: "A", price_cents: 100, stock: 1, promo_price_cents: 100 },
      { name: "A", price_cents: 100, stock: 1, sku: "com espaço" },
    ];
    for (const body of bad) assert.equal((await m.client.post("/api/products", body)).status, 400, JSON.stringify(body));
    await product(m.client, { sku: "UNICO" });
    assert.equal((await m.client.post("/api/products", { name: "B", price_cents: 1, stock: 1, sku: "UNICO" })).status, 409);
  });

  test("uma loja não lê, altera nem apaga produtos de outra", async () => {
    const env = createEnv();
    const a = await newMerchant(env);
    const b = await newMerchant(env);
    const id = await product(a.client);
    assert.equal((await b.client.get("/api/products")).data.length, 0);
    assert.equal((await b.client.patch(`/api/products/${id}`, { name: "Hack", price_cents: 1, stock: 999 })).status, 404);
    assert.equal((await b.client.delete(`/api/products/${id}`)).status, 404);
    assert.equal((await b.client.post(`/api/products/${id}/images`, PNG, { raw: true, headers: { "Content-Type": "image/png" } })).status, 404);
    const still = (await a.client.get("/api/products")).data[0];
    assert.equal(still.name, "Camiseta");
    assert.equal(still.stock, 5);
  });

  test("uma loja não vê nem altera pedidos e clientes de outra", async () => {
    const env = createEnv();
    const a = await newMerchant(env);
    const b = await newMerchant(env);
    const id = await product(a.client);
    const o = await order(env, a.slug, [{ id, quantity: 1 }]);
    assert.equal(o.status, 201);
    assert.equal((await b.client.get("/api/orders")).data.length, 0);
    assert.equal((await b.client.get("/api/customers")).data.length, 0);
    assert.equal((await b.client.patch(`/api/orders/${o.data.id}`, { status: "confirmed" })).status, 404);
    assert.equal((await b.client.get("/api/metrics")).data.orders, 0);
    // Pedido na loja B com produto da loja A é recusado.
    assert.equal((await order(env, b.slug, [{ id, quantity: 1 }])).status, 409);
  });
});

describe("vitrine e pedidos", () => {
  test("vitrine pública mostra apenas produtos ativos com preço final", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    await product(m.client, { name: "Ativo", promo_price_cents: 3000 });
    await product(m.client, { name: "Inativo", active: false });
    const res = await new Client(env).get(`/api/store/${m.slug}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.products.map((p) => p.name), ["Ativo"]);
    assert.equal(res.data.products[0].final_price_cents, 3000);
    assert.equal((await new Client(env).get("/api/store/nao-existe")).status, 404);
  });

  test("pedido usa preço do servidor, não do navegador", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const id = await product(m.client, { price_cents: 10000, promo_price_cents: 8000 });
    const res = await new Client(env).post(`/api/order-request/${m.slug}`, {
      customer_name: "Ana", customer_phone: "5554999990000", items: [{ id, quantity: 2, price_cents: 1 }], total_cents: 2,
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.total_cents, 16000);
  });

  test("valida itens, quantidades e dados do comprador", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const id = await product(m.client);
    const cases = [
      [[], "Maria", "54999991234"],
      [[{ id, quantity: 0 }], "Maria", "54999991234"],
      [[{ id, quantity: 1 }, { id, quantity: 1 }], "Maria", "54999991234"],
      [[{ id, quantity: 1 }], "", "54999991234"],
      [[{ id, quantity: 1 }], "Maria", "123"],
    ];
    for (const [items, name, phone] of cases) {
      const r = await new Client(env).post(`/api/order-request/${m.slug}`, { customer_name: name, customer_phone: phone, items });
      assert.equal(r.status, 400, JSON.stringify(items));
    }
    assert.equal((await order(env, m.slug, [{ id, quantity: 6 }])).status, 409);
  });

  test("confirmação baixa estoque, cancelamento repõe e não há baixa duplicada", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const id = await product(m.client, { stock: 5 });
    const o = (await order(env, m.slug, [{ id, quantity: 3 }])).data;
    const stock = async () => (await m.client.get("/api/products")).data[0].stock;
    assert.equal(await stock(), 5, "pedido pendente não baixa estoque");
    assert.equal((await m.client.patch(`/api/orders/${o.id}`, { status: "confirmed" })).status, 200);
    assert.equal(await stock(), 2);
    assert.equal((await m.client.patch(`/api/orders/${o.id}`, { status: "confirmed" })).status, 200, "repetir o mesmo status não altera nada");
    assert.equal(await stock(), 2, "sem baixa duplicada");
    assert.equal((await m.client.patch(`/api/orders/${o.id}`, { status: "cancelled" })).status, 200);
    assert.equal(await stock(), 5);
    assert.equal((await m.client.patch(`/api/orders/${o.id}`, { status: "confirmed" })).status, 409, "cancelado não volta");
    const moves = (await m.client.get("/api/stock-movements")).data;
    assert.deepEqual(moves.map((x) => x.delta), [3, -3, 5]);
  });

  test("estoque nunca fica negativo com pedidos concorrentes", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const id = await product(m.client, { stock: 4 });
    const o1 = (await order(env, m.slug, [{ id, quantity: 3 }], "192.0.2.1")).data;
    const o2 = (await order(env, m.slug, [{ id, quantity: 3 }], "192.0.2.2")).data;
    const results = await Promise.all([
      m.client.patch(`/api/orders/${o1.id}`, { status: "confirmed" }),
      m.client.patch(`/api/orders/${o2.id}`, { status: "confirmed" }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await m.client.get("/api/products")).data[0].stock, 1);
  });

  test("transições de status inválidas são recusadas", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const id = await product(m.client);
    const o = (await order(env, m.slug, [{ id, quantity: 1 }])).data;
    assert.equal((await m.client.patch(`/api/orders/${o.id}`, { status: "completed" })).status, 409);
    assert.equal((await m.client.patch(`/api/orders/${o.id}`, { status: "enviado" })).status, 400);
  });

  test("clientes e indicadores refletem pedidos concluídos", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const id = await product(m.client, { price_cents: 2500, stock: 10 });
    const o = (await order(env, m.slug, [{ id, quantity: 2 }])).data;
    await m.client.patch(`/api/orders/${o.id}`, { status: "confirmed" });
    await m.client.patch(`/api/orders/${o.id}`, { status: "completed" });
    await order(env, m.slug, [{ id, quantity: 1 }], "192.0.2.77");
    const metrics = (await m.client.get("/api/metrics")).data;
    assert.equal(metrics.orders, 2);
    assert.equal(metrics.pending, 1);
    assert.equal(metrics.revenue, 5000);
    assert.equal(metrics.average_ticket, 5000);
    assert.equal(metrics.customers, 1);
    const customers = (await m.client.get("/api/customers")).data;
    assert.equal(customers[0].phone, "54999991234");
    assert.equal(customers[0].orders, 2);
    assert.equal(customers[0].spent, 5000);
  });

  test("loja suspensa sai do ar e perde acesso ao painel", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    await env.DB.prepare("UPDATE stores SET status='suspended' WHERE slug=?").bind(m.slug).run();
    assert.equal((await new Client(env).get(`/api/store/${m.slug}`)).status, 404);
    assert.equal((await m.client.get("/api/products")).status, 403);
  });
});

describe("configurações e imagens", () => {
  test("atualiza dados da loja com validação", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    assert.equal((await m.client.patch("/api/settings", { whatsapp: "123", accent: "#ff7900" })).status, 400);
    assert.equal((await m.client.patch("/api/settings", { whatsapp: "", accent: "red" })).status, 400);
    const ok = await m.client.patch("/api/settings", { name: "Nova", description: "Moda", whatsapp: "+55 (54) 99999-0000", accent: "#FF7900" });
    assert.equal(ok.status, 200);
    const me = (await m.client.get("/api/me")).data.store;
    assert.equal(me.whatsapp, "5554999990000");
    assert.equal(me.accent, "#ff7900");
    assert.equal(me.name, "Nova");
  });

  test("upload valida tipo real e tamanho, isola chave por loja e serve a imagem", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const id = await product(m.client);
    const fake = await m.client.post(`/api/products/${id}/images`, new TextEncoder().encode("<svg onload=alert(1)>"), { raw: true, headers: { "Content-Type": "image/png" } });
    assert.equal(fake.status, 415);
    const svg = await m.client.post(`/api/products/${id}/images`, PNG, { raw: true, headers: { "Content-Type": "image/svg+xml" } });
    assert.equal(svg.status, 415);
    const big = await m.client.post(`/api/products/${id}/images`, new Uint8Array(2 * 1024 * 1024 + 1).fill(0x89), { raw: true, headers: { "Content-Type": "image/png" } });
    assert.equal(big.status, 413);
    const up = await m.client.post(`/api/products/${id}/images`, PNG, { raw: true, headers: { "Content-Type": "image/png" } });
    assert.equal(up.status, 201);
    const storeId = (await env.DB.prepare("SELECT id FROM stores WHERE slug=?").bind(m.slug).first()).id;
    assert.ok(up.data.url.startsWith(`/img/stores/${storeId}/products/${id}/`));
    const img = await workerFetch(env, new Request(ORIGIN + up.data.url));
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("Content-Type"), "image/png");
    const pub = await new Client(env).get(`/api/store/${m.slug}`);
    assert.deepEqual(pub.data.products[0].images, [up.data.url]);
    // Excluir o produto remove o arquivo do armazenamento.
    await m.client.delete(`/api/products/${id}`);
    assert.equal(env.IMAGES.objects.size, 0);
    assert.equal((await workerFetch(env, new Request(ORIGIN + up.data.url))).status, 404);
  });

  test("logotipo substitui o anterior e apaga o arquivo antigo", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const first = await m.client.post("/api/settings/logo", PNG, { raw: true, headers: { "Content-Type": "image/png" } });
    assert.equal(first.status, 201);
    const second = await m.client.post("/api/settings/logo", PNG, { raw: true, headers: { "Content-Type": "image/png" } });
    assert.equal(second.status, 201);
    assert.equal(env.IMAGES.objects.size, 1);
    assert.equal((await m.client.get("/api/me")).data.store.logo_url, second.data.url);
  });

  test("sem bucket R2 configurado, o upload responde 503 e o resto funciona", async () => {
    const env = createEnv({ images: false });
    const m = await newMerchant(env);
    const id = await product(m.client);
    const res = await m.client.post(`/api/products/${id}/images`, PNG, { raw: true, headers: { "Content-Type": "image/png" } });
    assert.equal(res.status, 503);
    assert.equal((await new Client(env).get(`/api/store/${m.slug}`)).status, 200);
  });

  test("rotas de imagem rejeitam caminhos fora do padrão", async () => {
    const env = createEnv();
    for (const path of ["/img/../secrets", "/img/stores/x/logo/a.png", "/img/qualquer.png"]) {
      assert.equal((await workerFetch(env, new Request(ORIGIN + path))).status, 404, path);
    }
  });

  test("auditoria registra ações do lojista", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    await product(m.client);
    const log = (await m.client.get("/api/audit-log")).data;
    assert.deepEqual(log.map((x) => x.action), ["product.created", "store.created"]);
  });
});
