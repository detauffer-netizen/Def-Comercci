// Cupons de desconto da loja (somente o proprietário gerencia).

import { HttpError, json, readJson } from "../lib/http.js";
import { audit } from "../lib/session.js";
import * as v from "../lib/validate.js";

function couponInput(body) {
  const code = String(body.code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) throw new HttpError(400, "Código inválido: use de 3 a 30 letras, números, hífen ou _");
  if (body.kind !== "percent" && body.kind !== "fixed") throw new HttpError(400, "Tipo de desconto inválido");
  const value = body.kind === "percent"
    ? v.quantity(body.value, "percentual", 90)
    : v.cents(body.value, "valor do desconto");
  if (value < 1) throw new HttpError(400, "O desconto precisa ser maior que zero");
  const maxUses = body.max_uses === null || body.max_uses === undefined || body.max_uses === "" ? null : v.quantity(body.max_uses, "limite de usos");
  if (maxUses === 0) throw new HttpError(400, "O limite de usos precisa ser maior que zero");
  const expires = body.expires_at ? String(body.expires_at) : null;
  if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw new HttpError(400, "Data de validade inválida");
  return {
    code,
    kind: body.kind,
    value,
    min_order_cents: body.min_order_cents ? v.cents(body.min_order_cents, "pedido mínimo") : 0,
    max_uses: maxUses,
    expires_at: expires,
    active: body.active === undefined ? 1 : v.flag(body.active),
  };
}

const duplicate = (error) => {
  if (String(error?.message || error).includes("UNIQUE")) throw new HttpError(409, "Já existe um cupom com este código");
  throw error;
};

export async function listCoupons(request, env, session) {
  const rows = await env.DB.prepare(
    `SELECT c.id,c.code,c.kind,c.value,c.min_order_cents,c.max_uses,c.uses,c.expires_at,c.active,c.created_at,
            (SELECT COALESCE(SUM(discount_cents),0) FROM orders o WHERE o.store_id=c.store_id AND o.coupon_code=c.code AND o.status IN ('confirmed','completed')) AS discount_given
       FROM coupons c WHERE c.store_id=? ORDER BY c.active DESC, c.created_at DESC`,
  ).bind(session.store.id).all();
  return json(rows.results.map((c) => ({ ...c, active: !!c.active })));
}

export async function createCoupon(request, env, session) {
  const c = couponInput(await readJson(request));
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO coupons(id,store_id,code,kind,value,min_order_cents,max_uses,expires_at,active) VALUES(?,?,?,?,?,?,?,?,?)",
  ).bind(id, session.store.id, c.code, c.kind, c.value, c.min_order_cents, c.max_uses, c.expires_at, c.active).run().catch(duplicate);
  await audit(env.DB, { storeId: session.store.id, userId: session.user.id, action: "coupon.created", target: id, detail: c.code });
  return json({ created: true, id }, 201);
}

export async function updateCoupon(request, env, session, params) {
  const id = v.id(params.id);
  const c = couponInput(await readJson(request));
  const result = await env.DB.prepare(
    "UPDATE coupons SET code=?,kind=?,value=?,min_order_cents=?,max_uses=?,expires_at=?,active=? WHERE id=? AND store_id=?",
  ).bind(c.code, c.kind, c.value, c.min_order_cents, c.max_uses, c.expires_at, c.active, id, session.store.id).run().catch(duplicate);
  if (!result.meta.changes) throw new HttpError(404, "Cupom não encontrado");
  await audit(env.DB, { storeId: session.store.id, userId: session.user.id, action: "coupon.updated", target: id, detail: c.code });
  return json({ ok: true });
}

export async function deleteCoupon(request, env, session, params) {
  const id = v.id(params.id);
  const result = await env.DB.prepare("DELETE FROM coupons WHERE id=? AND store_id=?").bind(id, session.store.id).run();
  if (!result.meta.changes) throw new HttpError(404, "Cupom não encontrado");
  await audit(env.DB, { storeId: session.store.id, userId: session.user.id, action: "coupon.deleted", target: id });
  return json({ ok: true });
}
