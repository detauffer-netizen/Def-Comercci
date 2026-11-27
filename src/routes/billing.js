// Assinaturas das lojas com Mercado Pago, webhooks e gestão de planos.

import { HttpError, json, readJson } from "../lib/http.js";
import { audit } from "../lib/session.js";
import {
  addDays, billingEnabled, defaultPlan, effectivePlan, iso, mercadoPago, requireBilling, verifyWebhookSignature,
} from "../lib/billing.js";
import * as v from "../lib/validate.js";

const money = (cents) => Number((cents / 100).toFixed(2));
const activePlan = (db, id) => db.prepare("SELECT * FROM plans WHERE id=? AND active=1").bind(String(id ?? "")).first();
const parseDate = (text) => (text ? new Date(String(text).includes("T") ? text : `${String(text).replace(" ", "T")}Z`) : null);

// ---------------- Lojista ----------------

export async function billingStatus(request, env, session) {
  const db = env.DB;
  const id = session.store.id;
  const { plan, subscription, valid } = await effectivePlan(db, id);
  const plans = (await db.prepare(
    "SELECT id,name,description,price_cents,trial_days,max_products,max_team,ai_daily,is_default FROM plans WHERE active=1 ORDER BY position, price_cents",
  ).all()).results;
  const products = (await db.prepare("SELECT COUNT(*) AS n FROM products WHERE store_id=?").bind(id).first()).n;
  const team = (await db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE store_id=?").bind(id).first()).n;
  const payments = (await db.prepare(
    "SELECT amount_cents,status,method,created_at,plan_id FROM billing_payments WHERE store_id=? ORDER BY created_at DESC LIMIT 12",
  ).bind(id).all()).results;
  return json({
    enabled: billingEnabled(env),
    plan,
    plan_valid: valid,
    subscription: subscription && {
      plan_id: subscription.plan_id,
      status: subscription.status,
      current_period_end: subscription.current_period_end,
      pending_plan_id: subscription.pending_plan_id,
      recurring: !!subscription.provider_id,
    },
    usage: { products, team },
    plans: plans.map((p) => ({ ...p, is_default: !!p.is_default })),
    payments,
  });
}

async function ownerEmail(db, storeId) {
  return (await db.prepare("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.store_id=? AND m.role='owner' LIMIT 1").bind(storeId).first())?.email;
}

// Assinatura recorrente no cartão (preapproval). O cliente conclui no
// checkout do Mercado Pago; a ativação chega pelo webhook.
export async function subscribe(request, env, session) {
  requireBilling(env);
  const db = env.DB;
  const plan = await activePlan(db, (await readJson(request)).plan_id);
  if (!plan || plan.price_cents <= 0) throw new HttpError(400, "Escolha um plano pago válido");
  const origin = new URL(request.url).origin;
  const current = await db.prepare("SELECT * FROM subscriptions WHERE store_id=?").bind(session.store.id).first();
  const hadPaid = await db.prepare("SELECT 1 FROM billing_payments WHERE store_id=? LIMIT 1").bind(session.store.id).first();
  const trial = plan.trial_days > 0 && !current?.provider_id && !hadPaid;
  const pre = await mercadoPago.createPreapproval(env, {
    reason: `Def Commerce - plano ${plan.name}`,
    external_reference: `sub:${session.store.id}:${plan.id}`,
    payer_email: await ownerEmail(db, session.store.id),
    back_url: `${origin}/painel#loja`,
    status: "pending",
    auto_recurring: {
      frequency: 1,
      frequency_type: "months",
      transaction_amount: money(plan.price_cents),
      currency_id: "BRL",
      ...(trial ? { free_trial: { frequency: plan.trial_days, frequency_type: "days" } } : {}),
    },
  });
  if (!pre?.id || !pre?.init_point) throw new HttpError(502, "O Mercado Pago não devolveu o link de pagamento");
  const fallback = await defaultPlan(db);
  await db.prepare(
    `INSERT INTO subscriptions(store_id,plan_id,status,pending_plan_id,pending_provider_id) VALUES(?,?,'pending',?,?)
     ON CONFLICT(store_id) DO UPDATE SET pending_plan_id=excluded.pending_plan_id, pending_provider_id=excluded.pending_provider_id, updated_at=CURRENT_TIMESTAMP`,
  ).bind(session.store.id, fallback.id, plan.id, pre.id).run();
  await audit(db, { storeId: session.store.id, userId: session.user.id, action: "billing.checkout", detail: `assinatura ${plan.id}` });
  return json({ checkout_url: pre.init_point });
}

// Pagamento avulso de 1 mês (Pix ou cartão) pelo Checkout Pro.
export async function payMonth(request, env, session) {
  requireBilling(env);
  const db = env.DB;
  const plan = await activePlan(db, (await readJson(request)).plan_id);
  if (!plan || plan.price_cents <= 0) throw new HttpError(400, "Escolha um plano pago válido");
  const origin = new URL(request.url).origin;
  const pref = await mercadoPago.createPreference(env, {
    items: [{ id: plan.id, title: `Def Commerce - plano ${plan.name} (1 mês)`, quantity: 1, unit_price: money(plan.price_cents), currency_id: "BRL" }],
    payer: { email: await ownerEmail(db, session.store.id) },
    external_reference: `month:${session.store.id}:${plan.id}`,
    back_urls: { success: `${origin}/painel#loja`, pending: `${origin}/painel#loja`, failure: `${origin}/painel#loja` },
    auto_return: "approved",
    notification_url: `${origin}/api/billing/webhook/mercadopago`,
  });
  if (!pref?.init_point) throw new HttpError(502, "O Mercado Pago não devolveu o link de pagamento");
  await audit(db, { storeId: session.store.id, userId: session.user.id, action: "billing.checkout", detail: `mensal ${plan.id}` });
  return json({ checkout_url: pref.init_point });
}

// Cancela a renovação; o acesso continua até o fim do período pago.
export async function cancel(request, env, session) {
  const db = env.DB;
  const sub = await db.prepare("SELECT * FROM subscriptions WHERE store_id=?").bind(session.store.id).first();
  if (!sub || sub.status === "canceled") throw new HttpError(400, "Não há assinatura ativa para cancelar");
  if (sub.provider_id && billingEnabled(env)) await mercadoPago.cancelPreapproval(env, sub.provider_id);
  await db.prepare("UPDATE subscriptions SET status='canceled', updated_at=CURRENT_TIMESTAMP WHERE store_id=?").bind(session.store.id).run();
  await audit(db, { storeId: session.store.id, userId: session.user.id, action: "billing.canceled", detail: sub.plan_id });
  return json({ ok: true, access_until: sub.current_period_end });
}

// ---------------- Webhook do Mercado Pago ----------------

function parseReference(ref, prefix) {
  const [kind, storeId, planId] = String(ref || "").split(":");
  if (kind !== prefix || !/^[0-9a-f-]{36}$/.test(storeId || "") || !planId) return null;
  return { storeId, planId };
}

async function extendPeriod(db, storeId, planId, days, fields = {}) {
  const sub = await db.prepare("SELECT current_period_end FROM subscriptions WHERE store_id=?").bind(storeId).first();
  const now = new Date();
  const end = parseDate(sub?.current_period_end);
  const base = end && end > now ? end : now;
  const until = iso(addDays(base, days));
  await db.prepare(
    `INSERT INTO subscriptions(store_id,plan_id,status,current_period_end,provider) VALUES(?,?,'active',?,?)
     ON CONFLICT(store_id) DO UPDATE SET plan_id=excluded.plan_id, status='active', current_period_end=excluded.current_period_end,
       provider=CASE WHEN subscriptions.provider='' THEN excluded.provider ELSE subscriptions.provider END, updated_at=CURRENT_TIMESTAMP`,
  ).bind(storeId, planId, until, fields.provider || "mercadopago").run();
  return until;
}

async function handlePreapproval(env, id) {
  const db = env.DB;
  const pre = await mercadoPago.getPreapproval(env, id);
  const ref = parseReference(pre.external_reference, "sub");
  if (!ref) return "ignored";
  const store = await db.prepare("SELECT id FROM stores WHERE id=?").bind(ref.storeId).first();
  const plan = await db.prepare("SELECT id FROM plans WHERE id=?").bind(ref.planId).first();
  if (!store || !plan) return "ignored";
  const sub = await db.prepare("SELECT * FROM subscriptions WHERE store_id=?").bind(ref.storeId).first();
  if (pre.status === "authorized") {
    const next = parseDate(pre.next_payment_date) || addDays(new Date(), 30);
    const trialing = !!pre.auto_recurring?.free_trial && !(await db.prepare("SELECT 1 FROM billing_payments WHERE store_id=? LIMIT 1").bind(ref.storeId).first());
    await db.prepare(
      `INSERT INTO subscriptions(store_id,plan_id,status,provider,provider_id,current_period_end) VALUES(?,?,?,'mercadopago',?,?)
       ON CONFLICT(store_id) DO UPDATE SET plan_id=excluded.plan_id, status=excluded.status, provider='mercadopago',
         provider_id=excluded.provider_id, current_period_end=excluded.current_period_end,
         pending_plan_id=CASE WHEN subscriptions.pending_provider_id=excluded.provider_id THEN NULL ELSE subscriptions.pending_plan_id END,
         pending_provider_id=CASE WHEN subscriptions.pending_provider_id=excluded.provider_id THEN '' ELSE subscriptions.pending_provider_id END,
         updated_at=CURRENT_TIMESTAMP`,
    ).bind(ref.storeId, ref.planId, trialing ? "trialing" : "active", pre.id, iso(next)).run();
    // Troca de plano: a assinatura anterior é cancelada no Mercado Pago.
    if (sub?.provider_id && sub.provider_id !== pre.id) {
      await mercadoPago.cancelPreapproval(env, sub.provider_id).catch(() => null);
    }
    await audit(db, { storeId: ref.storeId, action: "billing.activated", detail: ref.planId });
    return "activated";
  }
  if (!sub || sub.provider_id !== pre.id) return "ignored";
  if (pre.status === "paused") await db.prepare("UPDATE subscriptions SET status='past_due', updated_at=CURRENT_TIMESTAMP WHERE store_id=?").bind(ref.storeId).run();
  if (pre.status === "cancelled") await db.prepare("UPDATE subscriptions SET status='canceled', updated_at=CURRENT_TIMESTAMP WHERE store_id=?").bind(ref.storeId).run();
  return pre.status;
}

async function handleAuthorizedPayment(env, id) {
  const db = env.DB;
  const ap = await mercadoPago.getAuthorizedPayment(env, id);
  const sub = await db.prepare("SELECT * FROM subscriptions WHERE provider_id=?").bind(String(ap.preapproval_id || "")).first();
  if (!sub) return "ignored";
  const status = ap.payment?.status || ap.status || "";
  const amount = Math.round(Number(ap.transaction_amount || 0) * 100);
  const inserted = await db.prepare(
    "INSERT OR IGNORE INTO billing_payments(id,store_id,plan_id,amount_cents,status,method) VALUES(?,?,?,?,?,'assinatura')",
  ).bind(`ap:${id}`, sub.store_id, sub.plan_id, amount, status).run();
  if (status === "approved" && inserted.meta.changes) {
    await extendPeriod(db, sub.store_id, sub.plan_id, 30);
    return "paid";
  }
  if (status === "rejected") {
    await db.prepare("UPDATE subscriptions SET status='past_due', updated_at=CURRENT_TIMESTAMP WHERE store_id=?").bind(sub.store_id).run();
    await audit(db, { storeId: sub.store_id, action: "billing.payment_failed", detail: sub.plan_id });
    return "past_due";
  }
  return status || "ignored";
}

async function handlePayment(env, id) {
  const db = env.DB;
  const pay = await mercadoPago.getPayment(env, id);
  const ref = parseReference(pay.external_reference, "month");
  if (!ref) return "ignored";
  const plan = await db.prepare("SELECT id,price_cents FROM plans WHERE id=?").bind(ref.planId).first();
  const store = await db.prepare("SELECT id FROM stores WHERE id=?").bind(ref.storeId).first();
  if (!plan || !store) return "ignored";
  const amount = Math.round(Number(pay.transaction_amount || 0) * 100);
  if (pay.status !== "approved") return pay.status || "ignored";
  // Valor pago precisa cobrir o preço do plano (proteção contra adulteração).
  if (amount < plan.price_cents) {
    await audit(db, { storeId: ref.storeId, action: "billing.amount_mismatch", detail: `${amount} < ${plan.price_cents}` });
    return "amount_mismatch";
  }
  const inserted = await db.prepare(
    "INSERT OR IGNORE INTO billing_payments(id,store_id,plan_id,amount_cents,status,method) VALUES(?,?,?,?,?,?)",
  ).bind(`pay:${id}`, ref.storeId, ref.planId, amount, "approved", pay.payment_type_id === "bank_transfer" ? "pix" : String(pay.payment_type_id || "")).run();
  if (!inserted.meta.changes) return "duplicate";
  await extendPeriod(db, ref.storeId, ref.planId, 30);
  await audit(db, { storeId: ref.storeId, action: "billing.paid", detail: ref.planId });
  return "paid";
}

export async function mercadoPagoWebhook(request, env) {
  if (!env.MP_ACCESS_TOKEN || !env.MP_WEBHOOK_SECRET) throw new HttpError(503, "Pagamentos não configurados");
  const url = new URL(request.url);
  const text = await request.text();
  if (text.length > 64 * 1024) throw new HttpError(413, "Conteúdo muito grande");
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
  const dataId = String(url.searchParams.get("data.id") || body?.data?.id || "");
  const topic = String(url.searchParams.get("type") || body?.type || url.searchParams.get("topic") || "");
  if (!(await verifyWebhookSignature(env.MP_WEBHOOK_SECRET, request.headers, dataId))) {
    throw new HttpError(401, "Assinatura inválida");
  }
  if (!/^[0-9A-Za-z-]{1,64}$/.test(dataId)) return json({ ok: true, result: "ignored" });
  const eventId = request.headers.get("x-request-id") || `${topic}:${dataId}:${body?.action || ""}`;
  const fresh = await env.DB.prepare("INSERT OR IGNORE INTO billing_events(id,topic,resource_id) VALUES(?,?,?)").bind(eventId.slice(0, 120), topic, dataId).run();
  if (!fresh.meta.changes) return json({ ok: true, result: "duplicate" });
  let result = "ignored";
  try {
    if (topic === "subscription_preapproval" || topic === "preapproval") result = await handlePreapproval(env, dataId);
    else if (topic === "subscription_authorized_payment") result = await handleAuthorizedPayment(env, dataId);
    else if (topic === "payment") result = await handlePayment(env, dataId);
  } catch (error) {
    // Libera o evento para o Mercado Pago reenviar e tentar de novo.
    await env.DB.prepare("DELETE FROM billing_events WHERE id=?").bind(eventId.slice(0, 120)).run();
    throw error;
  }
  return json({ ok: true, result });
}

// ---------------- Administração ----------------

function planInput(body) {
  const optionalCount = (value, label, min = 0) => (value === null || value === undefined || value === "" ? null : (() => {
    const n = v.quantity(value, label, 1_000_000);
    if (n < min) throw new HttpError(400, `Valor inválido para ${label}`);
    return n;
  })());
  return {
    name: v.requiredText(body.name, 60, "o nome do plano"),
    description: v.cleanText(body.description, 300),
    price_cents: v.cents(body.price_cents, "preço"),
    trial_days: v.quantity(body.trial_days ?? 0, "dias de teste", 90),
    max_products: optionalCount(body.max_products, "limite de produtos"),
    max_team: optionalCount(body.max_team, "limite da equipe", 1),
    ai_daily: optionalCount(body.ai_daily, "usos de IA por dia"),
    active: body.active === undefined ? 1 : v.flag(body.active),
    position: v.quantity(body.position ?? 0, "ordem", 999),
  };
}

export async function listPlans(request, env) {
  const rows = (await env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id=p.id AND s.status IN ('active','trialing','past_due')) AS subscribers
       FROM plans p ORDER BY position, price_cents`,
  ).all()).results;
  return json(rows.map((p) => ({ ...p, is_default: !!p.is_default, active: !!p.active })));
}

export async function createPlan(request, env, session) {
  const body = await readJson(request);
  const id = String(body.id ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]{3,30}$/.test(id)) throw new HttpError(400, "Código do plano inválido (3 a 30 letras minúsculas, números ou hífen)");
  const p = planInput(body);
  try {
    await env.DB.prepare(
      "INSERT INTO plans(id,name,description,price_cents,trial_days,max_products,max_team,ai_daily,active,position) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).bind(id, p.name, p.description, p.price_cents, p.trial_days, p.max_products, p.max_team, p.ai_daily, p.active, p.position).run();
  } catch {
    throw new HttpError(409, "Já existe um plano com este código");
  }
  await audit(env.DB, { userId: session.admin.id, action: "admin.plan_created", target: id, detail: `${p.name} ${p.price_cents}` });
  return json({ created: true, id }, 201);
}

export async function updatePlan(request, env, session, params) {
  const p = planInput(await readJson(request));
  const current = await env.DB.prepare("SELECT is_default FROM plans WHERE id=?").bind(params.id).first();
  if (!current) throw new HttpError(404, "Plano não encontrado");
  if (current.is_default && (p.price_cents !== 0 || !p.active)) throw new HttpError(400, "O plano padrão precisa ser gratuito e ativo");
  await env.DB.prepare(
    "UPDATE plans SET name=?,description=?,price_cents=?,trial_days=?,max_products=?,max_team=?,ai_daily=?,active=?,position=? WHERE id=?",
  ).bind(p.name, p.description, p.price_cents, p.trial_days, p.max_products, p.max_team, p.ai_daily, p.active, p.position, params.id).run();
  await audit(env.DB, { userId: session.admin.id, action: "admin.plan_updated", target: params.id, detail: `${p.name} ${p.price_cents}` });
  return json({ ok: true });
}

export async function billingOverview(request, env) {
  const db = env.DB;
  const now = iso(new Date());
  const mrr = await db.prepare(
    `SELECT COALESCE(SUM(p.price_cents),0) AS mrr_cents, COUNT(*) AS paying
       FROM subscriptions s JOIN plans p ON p.id=s.plan_id
      WHERE s.status IN ('active','past_due') AND p.price_cents > 0 AND s.current_period_end >= ?`,
  ).bind(now).first();
  const trialing = await db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE status='trialing' AND current_period_end >= ?").bind(now).first();
  const overdue = (await db.prepare(
    `SELECT s.store_id, st.name, st.slug, p.name AS plan, s.status, s.current_period_end
       FROM subscriptions s JOIN plans p ON p.id=s.plan_id JOIN stores st ON st.id=s.store_id
      WHERE p.price_cents > 0 AND (s.status='past_due' OR (s.status IN ('active','trialing') AND s.current_period_end < ?))
      ORDER BY s.current_period_end LIMIT 100`,
  ).bind(now).all()).results;
  const received30 = await db.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS cents FROM billing_payments WHERE status='approved' AND created_at >= datetime('now','-30 days')",
  ).first();
  const recent = (await db.prepare(
    `SELECT b.amount_cents,b.status,b.method,b.created_at,b.plan_id,st.name AS store
       FROM billing_payments b JOIN stores st ON st.id=b.store_id ORDER BY b.created_at DESC LIMIT 30`,
  ).all()).results;
  return json({ enabled: billingEnabled(env), ...mrr, trialing: trialing.n, received_30d: received30.cents, overdue, recent });
}

// Cortesia ou ajuste manual: define o plano da loja por N dias.
export async function setStorePlan(request, env, session, params) {
  const storeId = v.id(params.id);
  const body = await readJson(request);
  const plan = await env.DB.prepare("SELECT id,name FROM plans WHERE id=?").bind(String(body.plan_id ?? "")).first();
  if (!plan) throw new HttpError(400, "Plano inválido");
  const days = v.quantity(body.days, "dias", 3650);
  if (days < 1) throw new HttpError(400, "Informe de 1 a 3650 dias");
  const store = await env.DB.prepare("SELECT id FROM stores WHERE id=?").bind(storeId).first();
  if (!store) throw new HttpError(404, "Loja não encontrada");
  const until = iso(addDays(new Date(), days));
  await env.DB.prepare(
    `INSERT INTO subscriptions(store_id,plan_id,status,current_period_end) VALUES(?,?,'active',?)
     ON CONFLICT(store_id) DO UPDATE SET plan_id=excluded.plan_id, status='active', current_period_end=excluded.current_period_end, updated_at=CURRENT_TIMESTAMP`,
  ).bind(storeId, plan.id, until).run();
  await audit(env.DB, { storeId, userId: session.admin.id, action: "admin.plan_granted", detail: `${plan.name} por ${days} dias` });
  return json({ ok: true, until });
}
