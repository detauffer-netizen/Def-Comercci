// Recuperação de carrinho abandonado, sempre com consentimento do comprador.
// Sem consentimento nada é gravado; o comprador pode retirá-lo a qualquer momento.

import { HttpError, json, readJson } from "../lib/http.js";
import { audit, rateLimitByIp } from "../lib/session.js";
import * as v from "../lib/validate.js";
import { activeStore, priceItems } from "./public.js";

export const ABANDON_AFTER_MINUTES = 30;
export const RETENTION_DAYS = 7;
const MAX_OPEN_PER_STORE = 500;

function token(value) {
  const t = String(value ?? "");
  if (!/^[0-9a-f-]{36}$/.test(t)) throw new HttpError(400, "Carrinho inválido");
  return t;
}

async function purgeOld(db) {
  await db.prepare(`DELETE FROM abandoned_carts WHERE updated_at < datetime('now','-${RETENTION_DAYS} days')`).run();
}

// PUT /api/cart-reminder/:slug — grava ou atualiza o carrinho com consentimento.
export async function saveCartReminder(request, env, params) {
  const db = env.DB;
  await rateLimitByIp(db, request, "cart-reminder", 60);
  const store = await activeStore(db, params.slug);
  if (!store) throw new HttpError(404, "Loja não encontrada");
  const body = await readJson(request);
  if (body.consent !== true) throw new HttpError(400, "É preciso autorizar o contato para guardar o carrinho");
  const id = token(body.token);
  const name = v.requiredText(body.customer_name, 100, "seu nome");
  const phone = v.phone(body.customer_phone);
  const { items, subtotal } = await priceItems(db, store, body.items);
  if (Math.random() < 0.05) await purgeOld(db);
  const exists = await db.prepare("SELECT status FROM abandoned_carts WHERE store_id=? AND id=?").bind(store.id, id).first();
  if (!exists) {
    const open = await db.prepare("SELECT COUNT(*) AS n FROM abandoned_carts WHERE store_id=? AND status IN ('open','contacted')").bind(store.id).first();
    if (open.n >= MAX_OPEN_PER_STORE) return json({ saved: false });
  }
  await db.prepare(
    `INSERT INTO abandoned_carts(store_id,id,customer_name,customer_phone,items_json,total_cents)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(store_id,id) DO UPDATE SET customer_name=excluded.customer_name, customer_phone=excluded.customer_phone,
       items_json=excluded.items_json, total_cents=excluded.total_cents, updated_at=datetime('now')
     WHERE abandoned_carts.status IN ('open','contacted')`,
  ).bind(store.id, id, name, phone, JSON.stringify(items), subtotal).run();
  return json({ saved: true });
}

// DELETE /api/cart-reminder/:slug/:token — o comprador retira o consentimento.
export async function deleteCartReminder(request, env, params) {
  const db = env.DB;
  await rateLimitByIp(db, request, "cart-reminder", 60);
  const store = await activeStore(db, params.slug);
  if (!store) throw new HttpError(404, "Loja não encontrada");
  await db.prepare("DELETE FROM abandoned_carts WHERE store_id=? AND id=?").bind(store.id, token(params.token)).run();
  return json({ ok: true });
}

// Chamado ao registrar um pedido: carrinho finalizado deixa de ser abandonado.
// Se a loja já tinha chamado o cliente, conta como recuperado (sem dados pessoais).
export async function markCartOrdered(db, storeId, rawToken, orderId) {
  if (!/^[0-9a-f-]{36}$/.test(String(rawToken ?? ""))) return;
  const row = await db.prepare("SELECT status FROM abandoned_carts WHERE store_id=? AND id=?").bind(storeId, rawToken).first();
  if (!row) return;
  if (row.status === "contacted") {
    await db.prepare(
      "UPDATE abandoned_carts SET status='recovered', order_id=?, customer_name='', customer_phone='', items_json='[]', updated_at=datetime('now') WHERE store_id=? AND id=?",
    ).bind(orderId, storeId, rawToken).run();
  } else {
    await db.prepare("DELETE FROM abandoned_carts WHERE store_id=? AND id=?").bind(storeId, rawToken).run();
  }
}

// GET /api/abandoned-carts — carrinhos parados há mais de 30 minutos.
export async function listAbandonedCarts(request, env, session) {
  const db = env.DB;
  await purgeOld(db);
  const rows = await db.prepare(
    `SELECT id,customer_name,customer_phone,items_json,total_cents,status,contacted_at,created_at,updated_at
       FROM abandoned_carts
      WHERE store_id=? AND status IN ('open','contacted') AND updated_at <= datetime('now','-${ABANDON_AFTER_MINUTES} minutes')
      ORDER BY updated_at DESC LIMIT 200`,
  ).bind(session.store.id).all();
  const stats = await db.prepare(
    `SELECT SUM(status='recovered') AS recovered, SUM(status='contacted') AS contacted FROM abandoned_carts WHERE store_id=?`,
  ).bind(session.store.id).first();
  return json({
    carts: rows.results.map(({ items_json, ...c }) => ({ ...c, items: JSON.parse(items_json) })),
    recovered: stats.recovered || 0,
    contacted: stats.contacted || 0,
    retention_days: RETENTION_DAYS,
  });
}

// PATCH /api/abandoned-carts/:id — { status: "contacted" | "dismissed" }
export async function updateAbandonedCart(request, env, session, params) {
  const db = env.DB;
  const id = token(params.id);
  const { status } = await readJson(request);
  if (!["contacted", "dismissed"].includes(status)) throw new HttpError(400, "Status inválido");
  const result = status === "dismissed"
    // Descartado: os dados pessoais são apagados na hora.
    ? await db.prepare("DELETE FROM abandoned_carts WHERE store_id=? AND id=? AND status IN ('open','contacted')").bind(session.store.id, id).run()
    : await db.prepare(
      "UPDATE abandoned_carts SET status='contacted', contacted_at=datetime('now') WHERE store_id=? AND id=? AND status IN ('open','contacted')",
    ).bind(session.store.id, id).run();
  if (!result.meta.changes) throw new HttpError(404, "Carrinho não encontrado");
  await audit(db, { storeId: session.store.id, userId: session.user.id, action: `cart.${status}`, target: id });
  return json({ ok: true });
}
