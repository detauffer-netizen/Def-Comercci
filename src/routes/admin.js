// Super administrador da plataforma. Isolado do painel do lojista: exige
// registro em platform_admins (ver loadAdminSession) e usa rotas /api/admin/*.

import { HttpError, json, readJson } from "../lib/http.js";
import { audit } from "../lib/session.js";
import * as v from "../lib/validate.js";

export function adminMe(request, env, session) {
  return json({ email: session.admin.email });
}

export async function overview(request, env) {
  const db = env.DB;
  const stores = await db.prepare(
    `SELECT COUNT(*) AS stores, COALESCE(SUM(status='active'),0) AS active, COALESCE(SUM(status='suspended'),0) AS suspended,
            COALESCE(SUM(created_at >= datetime('now','-30 days')),0) AS new_30d
       FROM stores`,
  ).first();
  const users = await db.prepare("SELECT COUNT(*) AS users FROM users").first();
  const products = await db.prepare("SELECT COUNT(*) AS products FROM products").first();
  const images = await db.prepare("SELECT COUNT(*) AS images, COALESCE(SUM(bytes),0) AS image_bytes FROM product_images").first();
  const orders = await db.prepare(
    `SELECT COUNT(*) AS orders,
            COALESCE(SUM(CASE WHEN status='completed' THEN total_cents END),0) AS gmv,
            COALESCE(SUM(created_at >= datetime('now','-30 days')),0) AS orders_30d
       FROM orders`,
  ).first();
  return json({ ...stores, ...users, ...products, ...images, ...orders });
}

export async function listStores(request, env) {
  const q = (new URL(request.url).searchParams.get("q") || "").trim().toLowerCase().slice(0, 100);
  const like = `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
  const rows = await env.DB.prepare(
    `SELECT s.id, s.slug, s.name, s.status, s.created_at,
            (SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.store_id=s.id AND m.role='owner' LIMIT 1) AS owner_email,
            (SELECT COUNT(*) FROM memberships m WHERE m.store_id=s.id) AS team,
            (SELECT COUNT(*) FROM products p WHERE p.store_id=s.id) AS products,
            (SELECT COUNT(*) FROM orders o WHERE o.store_id=s.id) AS orders,
            (SELECT COALESCE(SUM(total_cents),0) FROM orders o WHERE o.store_id=s.id AND o.status='completed') AS revenue,
            (SELECT COALESCE(SUM(bytes),0) FROM product_images i WHERE i.store_id=s.id) AS image_bytes,
            (SELECT MAX(created_at) FROM orders o WHERE o.store_id=s.id) AS last_order
       FROM stores s
      WHERE (? = '' OR lower(s.name) LIKE ? ESCAPE '\\' OR s.slug LIKE ? ESCAPE '\\'
             OR EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
                         WHERE m.store_id=s.id AND u.email LIKE ? ESCAPE '\\'))
      ORDER BY s.created_at DESC LIMIT 200`,
  ).bind(q, like, like, like).all();
  return json(rows.results);
}

export async function setStoreStatus(request, env, session, params) {
  const id = v.id(params.id);
  const body = await readJson(request);
  if (body.status !== "active" && body.status !== "suspended") throw new HttpError(400, "Status inválido");
  const reason = v.cleanText(body.reason, 300);
  if (body.status === "suspended" && !reason) throw new HttpError(400, "Informe o motivo da suspensão");
  const result = await env.DB.prepare("UPDATE stores SET status=? WHERE id=?").bind(body.status, id).run();
  if (!result.meta.changes) throw new HttpError(404, "Loja não encontrada");
  await audit(env.DB, {
    storeId: id,
    userId: session.admin.id,
    action: body.status === "suspended" ? "admin.store_suspended" : "admin.store_reactivated",
    target: id,
    detail: reason,
  });
  return json({ ok: true });
}

export async function adminAudit(request, env) {
  const rows = await env.DB.prepare(
    `SELECT a.action, a.target, a.detail, a.created_at, u.email, s.name AS store_name, s.slug
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN stores s ON s.id = a.store_id
      ORDER BY a.id DESC LIMIT 300`,
  ).all();
  return json(rows.results);
}

export async function listErrors(request, env) {
  const db = env.DB;
  const summary = await db.prepare(
    `SELECT COALESCE(SUM(created_at >= datetime('now','-1 day')),0) AS last_24h,
            COALESCE(SUM(created_at >= datetime('now','-7 days')),0) AS last_7d
       FROM error_log`,
  ).first();
  const grouped = (await db.prepare(
    `SELECT method, path, message, COUNT(*) AS count, MAX(created_at) AS last_seen, MAX(id) AS last_id
       FROM error_log WHERE created_at >= datetime('now','-7 days')
      GROUP BY method, path, message ORDER BY last_seen DESC LIMIT 50`,
  ).all()).results;
  const recent = (await db.prepare("SELECT id,created_at,method,path,message,stack FROM error_log ORDER BY id DESC LIMIT 20").all()).results;
  return json({ ...summary, grouped, recent });
}
