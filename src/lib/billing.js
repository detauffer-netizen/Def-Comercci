// Planos, limites e integração com o Mercado Pago.
// Cobrança real só acontece com BILLING_ENABLED="true" e credenciais
// configuradas como segredos (MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET).

import { HttpError } from "./http.js";
import { toHex, timingSafeEqual } from "./crypto.js";

const MP_API = "https://api.mercadopago.com";
export const GRACE_DAYS = 7;

export function billingEnabled(env) {
  return env.BILLING_ENABLED === "true" && !!env.MP_ACCESS_TOKEN;
}

export function requireBilling(env) {
  if (!billingEnabled(env)) throw new HttpError(503, "Pagamentos ainda não foram ativados nesta instalação");
}

const addDays = (date, days) => new Date(date.getTime() + days * 86400000);
const iso = (date) => date.toISOString().slice(0, 19).replace("T", " ");

export async function defaultPlan(db) {
  return db.prepare("SELECT * FROM plans WHERE is_default=1 ORDER BY position LIMIT 1").first();
}

// Plano efetivo da loja: assinatura válida (ativa, em teste ou dentro da
// carência após o vencimento) ou o plano padrão.
export async function effectivePlan(db, storeId, now = new Date()) {
  const sub = await db.prepare(
    `SELECT s.*, p.name, p.price_cents, p.max_products, p.max_team, p.ai_daily
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.store_id=?`,
  ).bind(storeId).first();
  const fallback = await defaultPlan(db);
  if (!sub) return { plan: fallback, subscription: null, valid: true };
  const end = sub.current_period_end ? new Date(sub.current_period_end.replace(" ", "T") + "Z") : null;
  const withinGrace = end && addDays(end, GRACE_DAYS) > now;
  // Pendente = ainda não pagou. Ativa, em teste, atrasada ou cancelada valem
  // até o fim do período pago mais a carência.
  const valid = sub.price_cents === 0 || (sub.status !== "pending" && !!withinGrace);
  const plan = valid
    ? { id: sub.plan_id, name: sub.name, price_cents: sub.price_cents, max_products: sub.max_products, max_team: sub.max_team, ai_daily: sub.ai_daily }
    : fallback;
  return { plan, subscription: sub, valid };
}

export async function assertWithinLimit(db, storeId, key, currentCount, label) {
  const { plan } = await effectivePlan(db, storeId);
  const limit = plan?.[key];
  if (limit !== null && limit !== undefined && currentCount >= limit) {
    throw new HttpError(402, `Seu plano (${plan.name}) permite até ${limit} ${label}. Veja os planos em Minha loja.`);
  }
}

// ---- Mercado Pago ----

async function mp(env, method, path, body) {
  const doFetch = env.MP_FETCH || fetch;
  let response;
  try {
    response = await doFetch(MP_API + path, {
      method,
      headers: {
        Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        ...(method === "POST" ? { "X-Idempotency-Key": crypto.randomUUID() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    console.error("mercadopago_network", path, error?.message || error);
    throw new HttpError(502, "Não foi possível falar com o Mercado Pago. Tente novamente.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("mercadopago_error", path, response.status, JSON.stringify(data).slice(0, 500));
    throw new HttpError(502, "O Mercado Pago recusou a operação. Tente novamente ou fale com o suporte.");
  }
  return data;
}

export const mercadoPago = {
  createPreapproval: (env, body) => mp(env, "POST", "/preapproval", body),
  getPreapproval: (env, id) => mp(env, "GET", `/preapproval/${encodeURIComponent(id)}`),
  cancelPreapproval: (env, id) => mp(env, "PUT", `/preapproval/${encodeURIComponent(id)}`, { status: "cancelled" }),
  getAuthorizedPayment: (env, id) => mp(env, "GET", `/authorized_payments/${encodeURIComponent(id)}`),
  createPreference: (env, body) => mp(env, "POST", "/checkout/preferences", body),
  getPayment: (env, id) => mp(env, "GET", `/v1/payments/${encodeURIComponent(id)}`),
};

// Validação da notificação (cabeçalho x-signature: "ts=...,v1=...").
// Manifesto: id:<data.id minúsculo>;request-id:<x-request-id>;ts:<ts>;
export async function verifyWebhookSignature(secret, headers, dataId, now = Date.now()) {
  const signature = headers.get("x-signature") || "";
  const requestId = headers.get("x-request-id") || "";
  const parts = Object.fromEntries(signature.split(",").map((p) => p.trim().split("=", 2)).filter((p) => p.length === 2));
  if (!secret || !parts.ts || !parts.v1) return false;
  // Recusa notificações muito antigas (reenvio malicioso).
  const ts = Number(parts.ts);
  const tsMs = ts > 1e12 ? ts : ts * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > 24 * 3600 * 1000) return false;
  let manifest = "";
  if (dataId) manifest += `id:${String(dataId).toLowerCase()};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${parts.ts};`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest)));
  return timingSafeEqual(mac, parts.v1.toLowerCase());
}

export { addDays, iso };
