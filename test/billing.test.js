import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client, ORIGIN, createEnv, newMerchant, workerFetch } from "./helpers/env.js";
import { hashPassword, toHex } from "../src/lib/crypto.js";
import { verifyWebhookSignature } from "../src/lib/billing.js";

const SECRET = "segredo-webhook-teste";

// API do Mercado Pago simulada: guarda recursos e registra as chamadas.
function fakeMercadoPago() {
  const resources = new Map();
  const calls = [];
  let seq = 1;
  const fetchFn = async (url, init = {}) => {
    const path = url.replace("https://api.mercadopago.com", "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, body, auth: init.headers?.Authorization });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (init.method === "POST" && path === "/preapproval") {
      const id = `pre${seq++}`;
      resources.set(`/preapproval/${id}`, { id, status: "pending", ...body });
      return reply({ id, init_point: `https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=${id}` }, 201);
    }
    if (init.method === "POST" && path === "/checkout/preferences") return reply({ id: `pref${seq++}`, init_point: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=x" }, 201);
    if (init.method === "PUT" && path.startsWith("/preapproval/")) {
      const r = resources.get(path);
      if (r) Object.assign(r, body);
      return reply(r || {});
    }
    if (init.method === "GET" && resources.has(path)) return reply(resources.get(path));
    return reply({ message: "not found" }, 404);
  };
  return { resources, calls, fetchFn };
}

function billingEnv(mp, extra = {}) {
  return createEnv({ vars: { BILLING_ENABLED: "true", MP_ACCESS_TOKEN: "TEST-token", MP_WEBHOOK_SECRET: SECRET, MP_FETCH: mp.fetchFn, ...extra } });
}

async function sign(dataId, requestId, ts = Date.now()) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`;
  return `ts=${ts},v1=${toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest)))}`;
}

async function webhook(env, type, dataId, { requestId = crypto.randomUUID(), signature } = {}) {
  const headers = { "Content-Type": "application/json", "x-request-id": requestId, "x-signature": signature ?? await sign(dataId, requestId) };
  const res = await workerFetch(env, new Request(`${ORIGIN}/api/billing/webhook/mercadopago?data.id=${dataId}&type=${type}`, {
    method: "POST", headers, body: JSON.stringify({ type, action: "updated", data: { id: dataId } }),
  }));
  return { status: res.status, data: await res.json() };
}

async function adminClient(env) {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users(id,email,password_hash) VALUES(?,?,?)").bind(id, "adm-bill@x.com", await hashPassword("admin-senha-forte")).run();
  await env.DB.prepare("INSERT INTO platform_admins(user_id) VALUES(?)").bind(id).run();
  const c = new Client(env, "100.64.3.1");
  await c.post("/api/login", { email: "adm-bill@x.com", password: "admin-senha-forte" });
  return c;
}

async function createPaidPlan(admin, extra = {}) {
  const res = await admin.post("/api/admin/plans", { id: "pro", name: "Profissional", price_cents: 4990, max_products: 2, max_team: 2, ai_daily: 5, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.data));
}

const storeId = async (env, slug) => (await env.DB.prepare("SELECT id FROM stores WHERE slug=?").bind(slug).first()).id;

describe("pagamentos com Mercado Pago", () => {
  test("sem ativação, nenhuma cobrança é criada; loja fica no plano beta gratuito", async () => {
    const env = createEnv();
    const m = await newMerchant(env);
    const status = (await m.client.get("/api/billing")).data;
    assert.equal(status.enabled, false);
    assert.equal(status.plan.id, "beta");
    assert.equal(status.plan.price_cents, 0);
    assert.equal((await m.client.post("/api/billing/subscribe", { plan_id: "beta" })).status, 503);
    const mp = fakeMercadoPago();
    const off = createEnv({ vars: { BILLING_ENABLED: "false", MP_ACCESS_TOKEN: "x", MP_FETCH: mp.fetchFn } });
    const m2 = await newMerchant(off);
    assert.equal((await m2.client.post("/api/billing/pay-month", { plan_id: "beta" })).status, 503);
    assert.equal(mp.calls.length, 0);
  });

  test("nenhum preço comercial vem pronto: só o plano beta gratuito existe", async () => {
    const env = createEnv();
    const plans = (await env.DB.prepare("SELECT id, price_cents FROM plans").all()).results;
    assert.deepEqual(plans, [{ id: "beta", price_cents: 0 }]);
  });

  test("administrador cria planos com validação; plano padrão continua gratuito", async () => {
    const env = createEnv();
    const admin = await adminClient(env);
    await createPaidPlan(admin);
    assert.equal((await admin.post("/api/admin/plans", { id: "pro", name: "X", price_cents: 1 })).status, 409);
    assert.equal((await admin.post("/api/admin/plans", { id: "P!", name: "X", price_cents: 1 })).status, 400);
    assert.equal((await admin.post("/api/admin/plans", { id: "neg", name: "X", price_cents: -1 })).status, 400);
    assert.equal((await admin.patch("/api/admin/plans/beta", { name: "Beta", price_cents: 990 })).status, 400);
    const m = await newMerchant(env);
    assert.equal((await m.client.post("/api/admin/plans", { id: "hack", name: "X", price_cents: 0 })).status, 401);
    assert.equal((await admin.get("/api/admin/plans")).data.length, 2);
  });

  test("assinatura com cartão: cria preapproval pendente e ativa pelo webhook", async () => {
    const mp = fakeMercadoPago();
    const env = billingEnv(mp);
    const admin = await adminClient(env);
    await createPaidPlan(admin, { trial_days: 7 });
    const m = await newMerchant(env);
    const res = await m.client.post("/api/billing/subscribe", { plan_id: "pro" });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.match(res.data.checkout_url, /preapproval_id=pre1/);
    const call = mp.calls[0];
    assert.equal(call.auth, "Bearer TEST-token");
    assert.equal(call.body.auto_recurring.transaction_amount, 49.9);
    assert.equal(call.body.auto_recurring.currency_id, "BRL");
    assert.deepEqual(call.body.auto_recurring.free_trial, { frequency: 7, frequency_type: "days" });
    assert.equal(call.body.payer_email, m.email);
    const id = await storeId(env, m.slug);
    assert.equal(call.body.external_reference, `sub:${id}:pro`);
    assert.equal((await m.client.get("/api/billing")).data.plan.id, "beta", "ainda não pago");

    // Mercado Pago autoriza a assinatura.
    Object.assign(mp.resources.get("/preapproval/pre1"), { status: "authorized", next_payment_date: new Date(Date.now() + 7 * 86400000).toISOString() });
    const hook = await webhook(env, "subscription_preapproval", "pre1");
    assert.equal(hook.status, 200);
    assert.equal(hook.data.result, "activated");
    const status = (await m.client.get("/api/billing")).data;
    assert.equal(status.plan.id, "pro");
    assert.equal(status.subscription.status, "trialing");
    assert.equal(status.subscription.recurring, true);
  });

  test("webhook exige assinatura válida, recente e é idempotente", async () => {
    const mp = fakeMercadoPago();
    const env = billingEnv(mp);
    assert.equal((await webhook(env, "payment", "123", { signature: "ts=1,v1=abc" })).status, 401);
    const old = await sign("123", "req-old", Date.now() - 3 * 86400000);
    assert.equal((await webhook(env, "payment", "123", { requestId: "req-old", signature: old })).status, 401, "antiga demais");
    const forged = await sign("999", "req-x");
    assert.equal((await webhook(env, "payment", "123", { requestId: "req-x", signature: forged })).status, 401, "assinada para outro id");
    // Recurso ainda indisponível na API: 502 e o evento fica livre para o reenvio.
    assert.equal((await webhook(env, "payment", "123", { requestId: "req-1" })).status, 502);
    mp.resources.set("/v1/payments/123", { id: 123, status: "approved", transaction_amount: 1, external_reference: "outra-coisa" });
    const first = await webhook(env, "payment", "123", { requestId: "req-1" });
    assert.equal(first.status, 200);
    assert.equal(first.data.result, "ignored");
    const again = await webhook(env, "payment", "123", { requestId: "req-1" });
    assert.equal(again.data.result, "duplicate");
    const noSecret = createEnv({ vars: { BILLING_ENABLED: "true", MP_ACCESS_TOKEN: "x" } });
    assert.equal((await webhook(noSecret, "payment", "1")).status, 503);
  });

  test("validador segue o manifesto do Mercado Pago (id em minúsculas, ts em ms)", async () => {
    const ts = Date.now();
    const headers = new Headers({ "x-request-id": "abc-123", "x-signature": await sign("ABCdef", "abc-123", ts) });
    assert.equal(await verifyWebhookSignature(SECRET, headers, "ABCdef", ts), true);
    assert.equal(await verifyWebhookSignature("outro", headers, "ABCdef", ts), false);
  });

  test("pagamento avulso de 1 mês (Pix): só vale com valor correto, uma única vez", async () => {
    const mp = fakeMercadoPago();
    const env = billingEnv(mp);
    const admin = await adminClient(env);
    await createPaidPlan(admin);
    const m = await newMerchant(env);
    const res = await m.client.post("/api/billing/pay-month", { plan_id: "pro" });
    assert.equal(res.status, 200);
    const pref = mp.calls.find((c) => c.path === "/checkout/preferences").body;
    assert.equal(pref.items[0].unit_price, 49.9);
    assert.equal(pref.notification_url, `${ORIGIN}/api/billing/webhook/mercadopago`);
    const id = await storeId(env, m.slug);
    mp.resources.set("/v1/payments/555", { id: 555, status: "approved", transaction_amount: 1, payment_type_id: "bank_transfer", external_reference: `month:${id}:pro` });
    assert.equal((await webhook(env, "payment", "555")).data.result, "amount_mismatch");
    assert.equal((await m.client.get("/api/billing")).data.plan.id, "beta");
    mp.resources.set("/v1/payments/556", { id: 556, status: "approved", transaction_amount: 49.9, payment_type_id: "bank_transfer", external_reference: `month:${id}:pro` });
    assert.equal((await webhook(env, "payment", "556")).data.result, "paid");
    assert.equal((await webhook(env, "payment", "556")).data.result, "duplicate", "mesmo pagamento com outro request-id");
    const status = (await m.client.get("/api/billing")).data;
    assert.equal(status.plan.id, "pro");
    assert.equal(status.payments.length, 1);
    assert.equal(status.payments[0].method, "pix");
    const end = new Date(status.subscription.current_period_end.replace(" ", "T") + "Z");
    assert.ok(Math.abs(end - Date.now() - 30 * 86400000) < 60000, "30 dias de acesso");
  });

  test("limites do plano liberam e bloqueiam recursos automaticamente", async () => {
    const mp = fakeMercadoPago();
    const env = billingEnv(mp);
    const admin = await adminClient(env);
    await createPaidPlan(admin);
    const m = await newMerchant(env);
    const id = await storeId(env, m.slug);
    assert.equal((await admin.patch(`/api/admin/stores/${id}/plan`, { plan_id: "pro", days: 30 })).status, 200);
    assert.equal((await m.client.post("/api/products", { name: "A", price_cents: 1, stock: 1 })).status, 201);
    assert.equal((await m.client.post("/api/products", { name: "B", price_cents: 1, stock: 1 })).status, 201);
    const blocked = await m.client.post("/api/products", { name: "C", price_cents: 1, stock: 1 });
    assert.equal(blocked.status, 402);
    assert.match(blocked.data.error, /até 2 produtos/);
    assert.equal((await m.client.post("/api/team", { name: "F", email: "f1@x.com", password: "provisoria-123", permissions: [] })).status, 201);
    assert.equal((await m.client.post("/api/team", { name: "G", email: "g1@x.com", password: "provisoria-123", permissions: [] })).status, 402);
  });

  test("inadimplência: após o vencimento + carência, a loja volta ao plano padrão", async () => {
    const mp = fakeMercadoPago();
    const env = billingEnv(mp);
    const admin = await adminClient(env);
    await createPaidPlan(admin, { max_products: 0 });
    await admin.patch("/api/admin/plans/beta", { name: "Beta gratuito", price_cents: 0, max_products: 100 });
    const m = await newMerchant(env);
    const id = await storeId(env, m.slug);
    await admin.patch(`/api/admin/stores/${id}/plan`, { plan_id: "pro", days: 1 });
    await env.DB.prepare("UPDATE subscriptions SET status='past_due', current_period_end=datetime('now','-3 days') WHERE store_id=?").bind(id).run();
    assert.equal((await m.client.get("/api/billing")).data.plan.id, "pro", "dentro da carência de 7 dias");
    const overview = (await admin.get("/api/admin/billing")).data;
    assert.equal(overview.overdue.length, 1);
    await env.DB.prepare("UPDATE subscriptions SET current_period_end=datetime('now','-8 days') WHERE store_id=?").bind(id).run();
    const after = (await m.client.get("/api/billing")).data;
    assert.equal(after.plan.id, "beta");
    assert.equal(after.plan_valid, false);
  });

  test("pagamento recusado da assinatura marca atraso; cancelamento mantém acesso até o fim do período", async () => {
    const mp = fakeMercadoPago();
    const env = billingEnv(mp);
    const admin = await adminClient(env);
    await createPaidPlan(admin);
    const m = await newMerchant(env);
    await m.client.post("/api/billing/subscribe", { plan_id: "pro" });
    Object.assign(mp.resources.get("/preapproval/pre1"), { status: "authorized", next_payment_date: new Date(Date.now() + 30 * 86400000).toISOString() });
    await webhook(env, "subscription_preapproval", "pre1");
    mp.resources.set("/authorized_payments/77", { preapproval_id: "pre1", transaction_amount: 49.9, payment: { id: 1, status: "rejected" } });
    assert.equal((await webhook(env, "subscription_authorized_payment", "77")).data.result, "past_due");
    assert.equal((await m.client.get("/api/billing")).data.subscription.status, "past_due");
    const res = await m.client.post("/api/billing/cancel", {});
    assert.equal(res.status, 200);
    assert.ok(mp.calls.some((c) => c.method === "PUT" && c.path === "/preapproval/pre1" && c.body.status === "cancelled"));
    const status = (await m.client.get("/api/billing")).data;
    assert.equal(status.subscription.status, "canceled");
    assert.equal(status.plan.id, "pro", "acesso até o fim do período");
  });

  test("troca de plano cancela a assinatura anterior no Mercado Pago", async () => {
    const mp = fakeMercadoPago();
    const env = billingEnv(mp);
    const admin = await adminClient(env);
    await createPaidPlan(admin);
    await admin.post("/api/admin/plans", { id: "max", name: "Máximo", price_cents: 9990 });
    const m = await newMerchant(env);
    await m.client.post("/api/billing/subscribe", { plan_id: "pro" });
    Object.assign(mp.resources.get("/preapproval/pre1"), { status: "authorized" });
    await webhook(env, "subscription_preapproval", "pre1");
    await m.client.post("/api/billing/subscribe", { plan_id: "max" });
    Object.assign(mp.resources.get("/preapproval/pre2"), { status: "authorized" });
    await webhook(env, "subscription_preapproval", "pre2");
    assert.equal((await m.client.get("/api/billing")).data.plan.id, "max");
    assert.equal(mp.resources.get("/preapproval/pre1").status, "cancelled");
  });

  test("webhook não ativa loja inexistente nem referência forjada", async () => {
    const mp = fakeMercadoPago();
    const env = billingEnv(mp);
    mp.resources.set("/preapproval/evil", { id: "evil", status: "authorized", external_reference: "sub:00000000-0000-0000-0000-000000000000:pro" });
    assert.equal((await webhook(env, "subscription_preapproval", "evil")).data.result, "ignored");
    mp.resources.set("/v1/payments/9", { id: 9, status: "approved", transaction_amount: 999, external_reference: "qualquer-coisa" });
    assert.equal((await webhook(env, "payment", "9")).data.result, "ignored");
  });

  test("somente o proprietário vê e gerencia a assinatura; exclusão da loja cancela a cobrança", async () => {
    const mp = fakeMercadoPago();
    const env = billingEnv(mp);
    const admin = await adminClient(env);
    await createPaidPlan(admin);
    const m = await newMerchant(env);
    await m.client.post("/api/team", { name: "F", email: "fb@x.com", password: "provisoria-123", permissions: ["products", "orders", "customers", "reports"] });
    const staff = new Client(env, "198.18.10.1");
    await staff.post("/api/login", { email: "fb@x.com", password: "provisoria-123" });
    await staff.post("/api/account/password", { current_password: "provisoria-123", new_password: "nova-senha-forte" });
    assert.equal((await staff.get("/api/billing")).status, 403);
    await m.client.post("/api/billing/subscribe", { plan_id: "pro" });
    Object.assign(mp.resources.get("/preapproval/pre1"), { status: "authorized" });
    await webhook(env, "subscription_preapproval", "pre1");
    assert.equal((await m.client.post("/api/account/delete", { password: m.password, confirm_slug: m.slug })).status, 200);
    assert.equal(mp.resources.get("/preapproval/pre1").status, "cancelled");
    assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions").first()).n, 0);
  });
});
