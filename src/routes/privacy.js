// Direitos do titular (LGPD): exportação e exclusão dos dados da loja e
// anonimização de compradores.

import { HttpError, json, readJson } from "../lib/http.js";
import { verifyPassword } from "../lib/crypto.js";
import { audit, clearSessionCookie, rateLimit } from "../lib/session.js";
import { deleteImages } from "../lib/images.js";
import * as v from "../lib/validate.js";

const all = async (db, sql, ...params) => (await db.prepare(sql).bind(...params).all()).results;

// Exporta todos os dados da loja em JSON (portabilidade). Senhas e tokens
// nunca são incluídos.
export async function exportData(request, env, session) {
  const db = env.DB;
  const id = session.store.id;
  const store = await db.prepare("SELECT id,slug,name,description,whatsapp,accent,status,created_at FROM stores WHERE id=?").bind(id).first();
  const data = {
    exported_at: new Date().toISOString(),
    store,
    team: await all(db, `SELECT u.email,u.name,m.role,m.permissions,u.created_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.store_id=?`, id),
    products: await all(db, "SELECT id,name,description,price_cents,promo_price_cents,stock,category,sku,featured,active FROM products WHERE store_id=?", id),
    variants: await all(db, "SELECT id,product_id,name,sku,price_cents,stock,active,position FROM product_variants WHERE store_id=?", id),
    images: await all(db, "SELECT product_id,r2_key,content_type,bytes,created_at FROM product_images WHERE store_id=?", id),
    orders: (await all(db, "SELECT id,items_json,subtotal_cents,discount_cents,coupon_code,total_cents,status,created_at,customer_name,customer_phone,notes FROM orders WHERE store_id=? ORDER BY created_at", id))
      .map(({ items_json, ...o }) => ({ ...o, items: JSON.parse(items_json) })),
    coupons: await all(db, "SELECT code,kind,value,min_order_cents,max_uses,uses,expires_at,active,created_at FROM coupons WHERE store_id=?", id),
    stock_movements: await all(db, "SELECT product_id,product_name,delta,stock_after,created_at FROM stock_movements WHERE store_id=? ORDER BY id", id),
    audit_log: await all(db, "SELECT action,target,detail,created_at FROM audit_log WHERE store_id=? ORDER BY id", id),
  };
  await audit(db, { storeId: id, userId: session.user.id, action: "store.exported" });
  return json(data, 200, { "Content-Disposition": `attachment; filename="def-commerce-${store.slug}.json"` });
}

// Exclui a loja e todos os seus dados, inclusive as imagens no R2 e as
// contas da equipe que não pertencem a outra loja. Irreversível.
export async function deleteStore(request, env, session) {
  const db = env.DB;
  await rateLimit(db, "store-delete", session.user.id, 5);
  const body = await readJson(request);
  const user = await db.prepare("SELECT password_hash FROM users WHERE id=?").bind(session.user.id).first();
  if (!(await verifyPassword(String(body.password ?? "").slice(0, 128), user?.password_hash))) {
    throw new HttpError(400, "Senha incorreta");
  }
  if (String(body.confirm_slug ?? "").trim().toLowerCase() !== session.store.slug) {
    throw new HttpError(400, "Digite o endereço da loja para confirmar a exclusão");
  }
  const id = session.store.id;
  const keys = (await all(db, "SELECT r2_key FROM product_images WHERE store_id=?", id)).map((r) => r.r2_key);
  keys.push(session.store.logo_key, session.store.banner_key);
  const members = (await all(db, "SELECT user_id FROM memberships WHERE store_id=?", id)).map((r) => r.user_id);
  const membersJson = JSON.stringify(members);
  await db.batch([
    db.prepare("DELETE FROM product_images WHERE store_id=?").bind(id),
    db.prepare("DELETE FROM product_variants WHERE store_id=?").bind(id),
    db.prepare("DELETE FROM products WHERE store_id=?").bind(id),
    db.prepare("DELETE FROM orders WHERE store_id=?").bind(id),
    db.prepare("DELETE FROM coupons WHERE store_id=?").bind(id),
    db.prepare("DELETE FROM stock_movements WHERE store_id=?").bind(id),
    db.prepare("DELETE FROM audit_log WHERE store_id=?").bind(id),
    db.prepare("DELETE FROM memberships WHERE store_id=?").bind(id),
    // Contas sem outra loja e que não são administradoras deixam de existir.
    db.prepare(
      `DELETE FROM sessions WHERE user_id IN (SELECT value FROM json_each(?))
         AND user_id NOT IN (SELECT user_id FROM memberships) AND user_id NOT IN (SELECT user_id FROM platform_admins)`,
    ).bind(membersJson),
    db.prepare(
      `DELETE FROM users WHERE id IN (SELECT value FROM json_each(?))
         AND id NOT IN (SELECT user_id FROM memberships) AND id NOT IN (SELECT user_id FROM platform_admins)`,
    ).bind(membersJson),
    db.prepare("DELETE FROM stores WHERE id=?").bind(id),
  ]);
  await deleteImages(env, keys);
  // Registro mínimo, sem dados pessoais, para a administração da plataforma.
  await audit(db, { action: "store.deleted", target: session.store.slug, detail: `${members.length} conta(s) vinculada(s)` });
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

// Anonimiza um comprador: os pedidos continuam nos relatórios, mas sem nome,
// telefone ou observações.
export async function forgetCustomer(request, env, session, params) {
  const phone = v.phone(params.phone);
  const result = await env.DB.prepare(
    "UPDATE orders SET customer_name='Cliente removido', customer_phone='', notes='' WHERE store_id=? AND customer_phone=?",
  ).bind(session.store.id, phone).run();
  if (!result.meta.changes) throw new HttpError(404, "Cliente não encontrado");
  await audit(env.DB, { storeId: session.store.id, userId: session.user.id, action: "customer.anonymized", detail: `${result.meta.changes} pedido(s)` });
  return json({ ok: true, orders: result.meta.changes });
}
