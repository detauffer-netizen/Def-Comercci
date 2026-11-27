// Rotas autenticadas do painel do lojista. Toda consulta filtra por
// session.store.id, que vem do banco e nunca do navegador.

import { HttpError, json, readJson } from "../lib/http.js";
import { audit, requireOwner } from "../lib/session.js";
import {
  MAX_IMAGES_PER_PRODUCT, deleteImages, imageKey, imageUrl, putImage, readImageUpload, requireBucket,
} from "../lib/images.js";
import { effectivePrice, imagesByProduct } from "./public.js";
import * as v from "../lib/validate.js";

function storeView(store) {
  return {
    name: store.name,
    slug: store.slug,
    whatsapp: store.whatsapp,
    accent: store.accent,
    description: store.description,
    logo_url: imageUrl(store.logo_key),
    banner_url: imageUrl(store.banner_key),
  };
}

export function me(request, env, session) {
  return json({ user: { email: session.user.email, role: session.user.role }, store: storeView(session.store) });
}

export async function updateSettings(request, env, session) {
  requireOwner(session);
  const body = await readJson(request);
  const name = v.requiredText(body.name ?? session.store.name, 100, "o nome da loja");
  const description = v.cleanText(body.description ?? session.store.description, 300, { multiline: true });
  const whatsapp = v.phone(body.whatsapp, { optional: true });
  const accent = v.color(body.accent ?? session.store.accent);
  await env.DB.prepare("UPDATE stores SET name=?,description=?,whatsapp=?,accent=? WHERE id=?")
    .bind(name, description, whatsapp, accent, session.store.id)
    .run();
  await audit(env.DB, { storeId: session.store.id, userId: session.user.id, action: "store.settings" });
  return json({ ok: true });
}

// ---------- Produtos ----------

function productInput(body) {
  const price = v.cents(body.price_cents, "preço");
  const promo = v.cents(body.promo_price_cents, "preço promocional", { optional: true });
  if (promo !== null && promo >= price) throw new HttpError(400, "O preço promocional deve ser menor que o preço normal");
  const sku = v.cleanText(body.sku, 60);
  if (sku && !/^[A-Za-z0-9._\-/]+$/.test(sku)) throw new HttpError(400, "SKU inválido: use letras, números, ponto, hífen ou barra");
  return {
    name: v.requiredText(body.name, 120, "o nome do produto"),
    description: v.cleanText(body.description, 2000, { multiline: true }),
    price_cents: price,
    promo_price_cents: promo,
    stock: v.quantity(body.stock, "estoque"),
    category: v.cleanText(body.category, 80),
    sku,
    featured: v.flag(body.featured),
    active: body.active === undefined ? 1 : v.flag(body.active),
  };
}

function skuConflict(error) {
  if (String(error?.message || error).includes("UNIQUE")) {
    throw new HttpError(409, "Já existe outro produto com este SKU");
  }
  throw error;
}

export async function listProducts(request, env, session) {
  const rows = await env.DB.prepare(
    `SELECT id,name,description,price_cents,promo_price_cents,stock,category,sku,featured,active
       FROM products WHERE store_id=? ORDER BY active DESC, name COLLATE NOCASE`,
  ).bind(session.store.id).all();
  const images = await imagesByProduct(env.DB, session.store.id);
  return json(rows.results.map((p) => ({
    ...p,
    featured: !!p.featured,
    active: !!p.active,
    final_price_cents: effectivePrice(p),
    images: images.get(p.id) || [],
  })));
}

export async function createProduct(request, env, session) {
  const p = productInput(await readJson(request));
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO products(id,store_id,name,description,price_cents,promo_price_cents,stock,category,sku,featured,active)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, session.store.id, p.name, p.description, p.price_cents, p.promo_price_cents, p.stock, p.category, p.sku, p.featured, p.active)
    .run()
    .catch(skuConflict);
  await audit(env.DB, { storeId: session.store.id, userId: session.user.id, action: "product.created", target: id, detail: p.name });
  return json({ created: true, id }, 201);
}

export async function updateProduct(request, env, session, params) {
  const id = v.id(params.id);
  const p = productInput(await readJson(request));
  const result = await env.DB.prepare(
    `UPDATE products SET name=?,description=?,price_cents=?,promo_price_cents=?,stock=?,category=?,sku=?,featured=?,active=?
      WHERE id=? AND store_id=?`,
  ).bind(p.name, p.description, p.price_cents, p.promo_price_cents, p.stock, p.category, p.sku, p.featured, p.active, id, session.store.id)
    .run()
    .catch(skuConflict);
  if (!result.meta.changes) throw new HttpError(404, "Produto não encontrado");
  await audit(env.DB, { storeId: session.store.id, userId: session.user.id, action: "product.updated", target: id, detail: p.name });
  return json({ ok: true });
}

export async function deleteProduct(request, env, session, params) {
  const id = v.id(params.id);
  const db = env.DB;
  const images = await db.prepare("SELECT r2_key FROM product_images WHERE product_id=? AND store_id=?").bind(id, session.store.id).all();
  const results = await db.batch([
    db.prepare("DELETE FROM product_images WHERE product_id=? AND store_id=?").bind(id, session.store.id),
    db.prepare("DELETE FROM products WHERE id=? AND store_id=?").bind(id, session.store.id),
  ]);
  if (!results[1].meta.changes) throw new HttpError(404, "Produto não encontrado");
  await deleteImages(env, images.results.map((r) => r.r2_key));
  await audit(db, { storeId: session.store.id, userId: session.user.id, action: "product.deleted", target: id });
  return json({ ok: true });
}

// ---------- Imagens ----------

export async function uploadProductImage(request, env, session, params) {
  requireBucket(env);
  const id = v.id(params.id);
  const db = env.DB;
  const product = await db.prepare(
    "SELECT (SELECT COUNT(*) FROM product_images WHERE product_id=products.id) AS images FROM products WHERE id=? AND store_id=?",
  ).bind(id, session.store.id).first();
  if (!product) throw new HttpError(404, "Produto não encontrado");
  if (product.images >= MAX_IMAGES_PER_PRODUCT) throw new HttpError(409, `Limite de ${MAX_IMAGES_PER_PRODUCT} imagens por produto`);
  const upload = await readImageUpload(request);
  const key = imageKey(session.store.id, `products/${id}`, upload.extension);
  await putImage(env, key, upload);
  const imageId = crypto.randomUUID();
  try {
    await db.prepare(
      "INSERT INTO product_images(id,store_id,product_id,r2_key,content_type,bytes,position) VALUES(?,?,?,?,?,?,?)",
    ).bind(imageId, session.store.id, id, key, upload.contentType, upload.bytes.byteLength, product.images).run();
  } catch (error) {
    await deleteImages(env, [key]);
    throw error;
  }
  return json({ id: imageId, url: imageUrl(key) }, 201);
}

export async function deleteProductImage(request, env, session, params) {
  const productId = v.id(params.id);
  const imageId = v.id(params.imageId);
  const row = await env.DB.prepare("SELECT r2_key FROM product_images WHERE id=? AND product_id=? AND store_id=?")
    .bind(imageId, productId, session.store.id).first();
  if (!row) throw new HttpError(404, "Imagem não encontrada");
  await env.DB.prepare("DELETE FROM product_images WHERE id=? AND store_id=?").bind(imageId, session.store.id).run();
  await deleteImages(env, [row.r2_key]);
  return json({ ok: true });
}

export async function uploadStoreImage(request, env, session, params) {
  requireOwner(session);
  requireBucket(env);
  const kind = params.kind;
  if (kind !== "logo" && kind !== "banner") throw new HttpError(404, "Não encontrado");
  const upload = await readImageUpload(request);
  const key = imageKey(session.store.id, kind, upload.extension);
  await putImage(env, key, upload);
  const column = kind === "logo" ? "logo_key" : "banner_key";
  await env.DB.prepare(`UPDATE stores SET ${column}=? WHERE id=?`).bind(key, session.store.id).run();
  await deleteImages(env, [session.store[column]]);
  return json({ url: imageUrl(key) }, 201);
}

export async function deleteStoreImage(request, env, session, params) {
  requireOwner(session);
  const kind = params.kind;
  if (kind !== "logo" && kind !== "banner") throw new HttpError(404, "Não encontrado");
  const column = kind === "logo" ? "logo_key" : "banner_key";
  await env.DB.prepare(`UPDATE stores SET ${column}='' WHERE id=?`).bind(session.store.id).run();
  await deleteImages(env, [session.store[column]]);
  return json({ ok: true });
}

// ---------- Pedidos, clientes e indicadores ----------

const STATUSES = ["pending", "confirmed", "completed", "cancelled"];

export async function listOrders(request, env, session) {
  const status = new URL(request.url).searchParams.get("status");
  const filter = STATUSES.includes(status) ? status : null;
  const rows = await env.DB.prepare(
    `SELECT id,items_json,total_cents,status,created_at,customer_name,customer_phone,notes
       FROM orders WHERE store_id=? AND (? IS NULL OR status=?)
      ORDER BY created_at DESC LIMIT 200`,
  ).bind(session.store.id, filter, filter).all();
  return json(rows.results.map(({ items_json, ...o }) => ({ ...o, code: o.id.slice(0, 8).toUpperCase(), items: JSON.parse(items_json) })));
}

export async function updateOrderStatus(request, env, session, params) {
  const id = v.id(params.id);
  const body = await readJson(request);
  if (!STATUSES.includes(body.status)) throw new HttpError(400, "Status inválido");
  let result;
  try {
    // Os gatilhos do banco validam a transição e movimentam o estoque de
    // forma atômica (sem estoque negativo e sem baixa duplicada).
    result = await env.DB.prepare("UPDATE orders SET status=? WHERE id=? AND store_id=?").bind(body.status, id, session.store.id).run();
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("Estoque")) throw new HttpError(409, "Estoque insuficiente para confirmar este pedido");
    if (message.includes("Transição")) throw new HttpError(409, "Esta mudança de status não é permitida");
    throw error;
  }
  if (!result.meta.changes) throw new HttpError(404, "Pedido não encontrado");
  await audit(env.DB, { storeId: session.store.id, userId: session.user.id, action: "order.status", target: id, detail: body.status });
  return json({ ok: true });
}

export async function listCustomers(request, env, session) {
  const rows = await env.DB.prepare(
    `SELECT customer_phone AS phone, MAX(customer_name) AS name, COUNT(*) AS orders,
            COALESCE(SUM(CASE WHEN status='completed' THEN total_cents ELSE 0 END),0) AS spent,
            MAX(created_at) AS last_order
       FROM orders WHERE store_id=? AND customer_phone<>''
      GROUP BY customer_phone ORDER BY last_order DESC LIMIT 500`,
  ).bind(session.store.id).all();
  return json(rows.results);
}

export async function metrics(request, env, session) {
  const db = env.DB;
  const orders = await db.prepare(
    `SELECT COUNT(*) AS orders,
            COALESCE(SUM(status='pending'),0) AS pending,
            COALESCE(SUM(status='completed'),0) AS completed,
            COALESCE(SUM(CASE WHEN status='completed' THEN total_cents END),0) AS revenue,
            COALESCE(SUM(CASE WHEN status='completed' AND created_at >= datetime('now','-30 days') THEN total_cents END),0) AS revenue_30d,
            COALESCE(SUM(created_at >= datetime('now','-1 day')),0) AS orders_24h
       FROM orders WHERE store_id=?`,
  ).bind(session.store.id).first();
  const products = await db.prepare(
    `SELECT COUNT(*) AS products, COALESCE(SUM(active=1),0) AS active,
            COALESCE(SUM(active=1 AND stock=0),0) AS out_of_stock,
            COALESCE(SUM(active=1 AND stock BETWEEN 1 AND 3),0) AS low_stock,
            COALESCE(SUM(stock),0) AS units
       FROM products WHERE store_id=?`,
  ).bind(session.store.id).first();
  const customers = await db.prepare(
    "SELECT COUNT(DISTINCT customer_phone) AS customers FROM orders WHERE store_id=? AND customer_phone<>''",
  ).bind(session.store.id).first();
  return json({
    ...orders,
    ...products,
    ...customers,
    average_ticket: orders.completed ? Math.round(orders.revenue / orders.completed) : 0,
  });
}

export async function stockMovements(request, env, session) {
  const rows = await env.DB.prepare(
    "SELECT product_id,product_name,delta,stock_after,created_at FROM stock_movements WHERE store_id=? ORDER BY id DESC LIMIT 200",
  ).bind(session.store.id).all();
  return json(rows.results);
}

export async function auditLog(request, env, session) {
  requireOwner(session);
  const rows = await env.DB.prepare(
    `SELECT a.action,a.target,a.detail,a.created_at,u.email
       FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.store_id=? ORDER BY a.id DESC LIMIT 200`,
  ).bind(session.store.id).all();
  return json(rows.results);
}
