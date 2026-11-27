// Rotas autenticadas do painel do lojista. Toda consulta filtra por
// session.store.id, que vem do banco e nunca do navegador.

import { HttpError, json, readJson } from "../lib/http.js";
import { audit, requireOwner } from "../lib/session.js";
import {
  MAX_IMAGES_PER_PRODUCT, deleteImages, imageKey, imageUrl, putImage, readImageUpload, requireBucket,
} from "../lib/images.js";
import { effectivePrice, imagesByProduct, parseCategoryOrder, variantsByProduct } from "./public.js";
import * as v from "../lib/validate.js";
import { assertWithinLimit } from "../lib/billing.js";
import { returnsByOrder } from "./finance.js";

function storeView(store) {
  return {
    name: store.name,
    slug: store.slug,
    whatsapp: store.whatsapp,
    accent: store.accent,
    description: store.description,
    logo_url: imageUrl(store.logo_key),
    banner_url: imageUrl(store.banner_key),
    delivery_fee_cents: store.delivery_fee_cents ?? null,
    free_delivery_above_cents: store.free_delivery_above_cents ?? null,
    pickup_enabled: !!store.pickup_enabled,
    template: store.template || "geral",
    hours: parseHours(store.hours_json),
    announcement: store.announcement || "",
  };
}

export function parseHours(text) {
  try {
    return v.hours(JSON.parse(text || "[]"));
  } catch {
    return [];
  }
}

export function me(request, env, session) {
  return json({
    user: {
      email: session.user.email,
      name: session.user.name,
      role: session.user.role,
      permissions: session.user.permissions,
      must_change_password: session.user.mustChangePassword,
    },
    store: storeView(session.store),
  });
}

export async function updateSettings(request, env, session) {
  requireOwner(session);
  const body = await readJson(request);
  const name = v.requiredText(body.name ?? session.store.name, 100, "o nome da loja");
  const description = v.cleanText(body.description ?? session.store.description, 300, { multiline: true });
  const whatsapp = v.phone(body.whatsapp, { optional: true });
  const accent = v.color(body.accent ?? session.store.accent);
  const pick = (key) => (key in body ? body[key] : session.store[key]);
  const fee = pick("delivery_fee_cents");
  const free = pick("free_delivery_above_cents");
  const deliveryFee = fee === null || fee === undefined || fee === "" ? null : v.cents(fee, "taxa de entrega");
  const freeAbove = free === null || free === undefined || free === "" ? null : v.cents(free, "frete grátis a partir de");
  const pickup = v.flag(pick("pickup_enabled"));
  const template = "template" in body ? String(body.template) : session.store.template || "geral";
  if (!v.TEMPLATES.includes(template)) throw new HttpError(400, "Modelo de vitrine inválido");
  const hoursJson = "hours" in body ? JSON.stringify(v.hours(body.hours)) : session.store.hours_json || "";
  const announcement = "announcement" in body ? v.cleanText(body.announcement, 140) : session.store.announcement || "";
  await env.DB.prepare(
    `UPDATE stores SET name=?,description=?,whatsapp=?,accent=?,delivery_fee_cents=?,free_delivery_above_cents=?,pickup_enabled=?,
                       template=?,hours_json=?,announcement=? WHERE id=?`,
  )
    .bind(name, description, whatsapp, accent, deliveryFee, freeAbove, pickup, template, hoursJson, announcement, session.store.id)
    .run();
  await audit(env.DB, { storeId: session.store.id, userId: session.user.id, action: "store.settings" });
  return json({ ok: true });
}

// Ordem das categorias na vitrine.
export async function setCategoryOrder(request, env, session) {
  const order = (await readJson(request)).order;
  if (!Array.isArray(order) || order.length > 100) throw new HttpError(400, "Lista de categorias inválida");
  const clean = [...new Set(order.map((c) => v.cleanText(c, 80)).filter(Boolean))];
  await env.DB.prepare("UPDATE stores SET category_order=? WHERE id=?").bind(JSON.stringify(clean), session.store.id).run();
  return json({ ok: true, order: clean });
}

export async function getCategoryOrder(request, env, session) {
  const row = await env.DB.prepare("SELECT category_order FROM stores WHERE id=?").bind(session.store.id).first();
  return json({ order: parseCategoryOrder(row.category_order) });
}

// ---------- Produtos ----------

const MAX_VARIANTS = 60;

function skuText(value) {
  const sku = v.cleanText(value, 60);
  if (sku && !/^[A-Za-z0-9._\-/]+$/.test(sku)) throw new HttpError(400, "SKU inválido: use letras, números, ponto, hífen ou barra");
  return sku;
}

// variants: undefined = não mexe nas variações; [] = produto sem variações.
function variantsInput(list) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || list.length > MAX_VARIANTS) throw new HttpError(400, `Use no máximo ${MAX_VARIANTS} variações`);
  const names = new Set();
  const skus = new Set();
  return list.map((item, position) => {
    if (!item || typeof item !== "object") throw new HttpError(400, "Variação inválida");
    const name = v.requiredText(item.name, 60, "o nome de cada variação (ex.: P / Azul)");
    const key = name.toLowerCase();
    if (names.has(key)) throw new HttpError(400, `Variação repetida: ${name}`);
    names.add(key);
    const sku = skuText(item.sku);
    if (sku && skus.has(sku)) throw new HttpError(400, `SKU repetido nas variações: ${sku}`);
    if (sku) skus.add(sku);
    return {
      id: typeof item.id === "string" && /^[0-9a-f-]{36}$/.test(item.id) ? item.id : null,
      name,
      sku,
      price_cents: v.cents(item.price_cents, `preço da variação ${name}`, { optional: true }),
      stock: v.quantity(item.stock, `estoque da variação ${name}`),
      active: item.active === undefined ? 1 : v.flag(item.active),
      position,
    };
  });
}

function productInput(body) {
  const price = v.cents(body.price_cents, "preço");
  const promo = v.cents(body.promo_price_cents, "preço promocional", { optional: true });
  if (promo !== null && promo >= price) throw new HttpError(400, "O preço promocional deve ser menor que o preço normal");
  const variants = variantsInput(body.variants);
  return {
    name: v.requiredText(body.name, 120, "o nome do produto"),
    description: v.cleanText(body.description, 2000, { multiline: true }),
    price_cents: price,
    promo_price_cents: promo,
    // Com variações, o estoque do produto é a soma delas (calculada no banco).
    stock: variants?.length ? 0 : v.quantity(body.stock, "estoque"),
    category: v.cleanText(body.category, 80),
    sku: skuText(body.sku),
    featured: v.flag(body.featured),
    active: body.active === undefined ? 1 : v.flag(body.active),
    position: body.position === undefined || body.position === "" ? 0 : v.quantity(body.position, "ordem na vitrine", 9999),
    variants,
    extras: extrasInput(body),
  };
}

// Campos opcionais do cadastro (custo e dados de compra). Só os enviados são
// alterados, para que clientes antigos do painel não apaguem o que já existe.
const EXTRA_FIELDS = ["cost_cents", "min_stock", "barcode", "supplier", "location"];
function extrasInput(body) {
  const out = {};
  if ("cost_cents" in body) out.cost_cents = v.cents(body.cost_cents, "preço de custo", { optional: true });
  if ("min_stock" in body) out.min_stock = body.min_stock === null || body.min_stock === "" ? null : v.quantity(body.min_stock, "estoque mínimo", 100000);
  if ("barcode" in body) {
    const code = String(body.barcode ?? "").replace(/\s/g, "");
    if (code && !/^[0-9A-Za-z-]{4,40}$/.test(code)) throw new HttpError(400, "Código de barras inválido");
    out.barcode = code;
  }
  if ("supplier" in body) out.supplier = v.cleanText(body.supplier, 100);
  if ("location" in body) out.location = v.cleanText(body.location, 60);
  return out;
}

function extrasSql(extras) {
  const keys = EXTRA_FIELDS.filter((k) => k in extras);
  return { set: keys.map((k) => `,${k}=?`).join(""), values: keys.map((k) => extras[k]) };
}

function skuConflict(error) {
  if (String(error?.message || error).includes("UNIQUE")) {
    throw new HttpError(409, "Já existe outro produto ou variação com este SKU");
  }
  throw error;
}

// Monta as instruções que sincronizam as variações de um produto.
async function variantStatements(db, storeId, productId, variants) {
  const existing = await db.prepare("SELECT id FROM product_variants WHERE product_id=? AND store_id=?").bind(productId, storeId).all();
  const known = new Set(existing.results.map((r) => r.id));
  const keep = variants.filter((x) => x.id && known.has(x.id)).map((x) => x.id);
  const statements = [
    db.prepare("DELETE FROM product_variants WHERE product_id=? AND store_id=? AND id NOT IN (SELECT value FROM json_each(?))")
      .bind(productId, storeId, JSON.stringify(keep)),
  ];
  for (const x of variants) {
    if (x.id && known.has(x.id)) {
      statements.push(db.prepare(
        "UPDATE product_variants SET name=?,sku=?,price_cents=?,stock=?,active=?,position=? WHERE id=? AND product_id=? AND store_id=?",
      ).bind(x.name, x.sku, x.price_cents, x.stock, x.active, x.position, x.id, productId, storeId));
    } else {
      statements.push(db.prepare(
        "INSERT INTO product_variants(id,store_id,product_id,name,sku,price_cents,stock,active,position) VALUES(?,?,?,?,?,?,?,?,?)",
      ).bind(crypto.randomUUID(), storeId, productId, x.name, x.sku, x.price_cents, x.stock, x.active, x.position));
    }
  }
  return statements;
}

export async function listProducts(request, env, session) {
  const rows = await env.DB.prepare(
    `SELECT id,name,description,price_cents,promo_price_cents,stock,category,sku,featured,active,position,
            cost_cents,min_stock,barcode,supplier,location
       FROM products WHERE store_id=? ORDER BY active DESC, featured DESC, position, name COLLATE NOCASE`,
  ).bind(session.store.id).all();
  const images = await imagesByProduct(env.DB, session.store.id);
  const variants = await variantsByProduct(env.DB, session.store.id);
  return json(rows.results.map((p) => ({
    ...p,
    featured: !!p.featured,
    active: !!p.active,
    final_price_cents: effectivePrice(p),
    images: images.get(p.id) || [],
    variants: (variants.get(p.id) || []).map((x) => ({ ...x, active: !!x.active })),
  })));
}

export async function createProduct(request, env, session) {
  const db = env.DB;
  const p = productInput(await readJson(request));
  const count = (await db.prepare("SELECT COUNT(*) AS n FROM products WHERE store_id=?").bind(session.store.id).first()).n;
  await assertWithinLimit(db, session.store.id, "max_products", count, "produtos");
  const id = crypto.randomUUID();
  const statements = [
    db.prepare(
      `INSERT INTO products(id,store_id,name,description,price_cents,promo_price_cents,stock,category,sku,featured,active,position,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
    ).bind(id, session.store.id, p.name, p.description, p.price_cents, p.promo_price_cents, p.stock, p.category, p.sku, p.featured, p.active, p.position),
  ];
  const extras = extrasSql(p.extras);
  if (extras.values.length) {
    statements.push(db.prepare(`UPDATE products SET id=id${extras.set} WHERE id=? AND store_id=?`).bind(...extras.values, id, session.store.id));
  }
  if (p.variants?.length) statements.push(...(await variantStatements(db, session.store.id, id, p.variants)));
  await db.batch(statements).catch(skuConflict);
  await audit(db, { storeId: session.store.id, userId: session.user.id, action: "product.created", target: id, detail: p.name });
  return json({ created: true, id }, 201);
}

export async function updateProduct(request, env, session, params) {
  const db = env.DB;
  const id = v.id(params.id);
  const p = productInput(await readJson(request));
  const exists = await db.prepare("SELECT 1 FROM products WHERE id=? AND store_id=?").bind(id, session.store.id).first();
  if (!exists) throw new HttpError(404, "Produto não encontrado");
  const statements = p.variants === undefined ? [] : await variantStatements(db, session.store.id, id, p.variants);
  // Se o produto tem variações, o estoque vem delas e não é alterado aqui.
  statements.push(db.prepare(
    `UPDATE products SET name=?,description=?,price_cents=?,promo_price_cents=?,category=?,sku=?,featured=?,active=?,position=?,
            stock = CASE WHEN EXISTS (SELECT 1 FROM product_variants WHERE product_id=products.id) THEN stock ELSE ? END
      WHERE id=? AND store_id=?`,
  ).bind(p.name, p.description, p.price_cents, p.promo_price_cents, p.category, p.sku, p.featured, p.active, p.position, p.stock, id, session.store.id));
  const extras = extrasSql(p.extras);
  if (extras.values.length) {
    statements.push(db.prepare(`UPDATE products SET id=id${extras.set} WHERE id=? AND store_id=?`).bind(...extras.values, id, session.store.id));
  }
  await db.batch(statements).catch(skuConflict);
  await audit(db, { storeId: session.store.id, userId: session.user.id, action: "product.updated", target: id, detail: p.name });
  return json({ ok: true });
}

export async function deleteProduct(request, env, session, params) {
  const id = v.id(params.id);
  const db = env.DB;
  const images = await db.prepare("SELECT r2_key FROM product_images WHERE product_id=? AND store_id=?").bind(id, session.store.id).all();
  const results = await db.batch([
    db.prepare("DELETE FROM product_images WHERE product_id=? AND store_id=?").bind(id, session.store.id),
    db.prepare("DELETE FROM product_variants WHERE product_id=? AND store_id=?").bind(id, session.store.id),
    db.prepare("DELETE FROM products WHERE id=? AND store_id=?").bind(id, session.store.id),
  ]);
  if (!results[2].meta.changes) throw new HttpError(404, "Produto não encontrado");
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

// Define a ordem das fotos; a primeira é a capa.
export async function reorderProductImages(request, env, session, params) {
  const productId = v.id(params.id);
  const ids = (await readJson(request)).ids;
  const current = (await env.DB.prepare("SELECT id FROM product_images WHERE product_id=? AND store_id=?").bind(productId, session.store.id).all())
    .results.map((r) => r.id);
  if (!Array.isArray(ids) || ids.length !== current.length || new Set(ids).size !== ids.length || ids.some((x) => !current.includes(x))) {
    throw new HttpError(400, "Envie todas as fotos do produto, cada uma uma vez");
  }
  await env.DB.batch(ids.map((id, position) =>
    env.DB.prepare("UPDATE product_images SET position=? WHERE id=? AND product_id=? AND store_id=?").bind(position, id, productId, session.store.id)));
  return json({ ok: true });
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
  const params = new URL(request.url).searchParams;
  const status = params.get("status");
  const filter = STATUSES.includes(status) ? status : null;
  const channel = ["online", "pos"].includes(params.get("channel")) ? params.get("channel") : null;
  const rows = await env.DB.prepare(
    `SELECT id,items_json,subtotal_cents,discount_cents,coupon_code,total_cents,status,created_at,customer_name,customer_phone,notes,
            fulfillment,delivery_fee_cents,address,channel,payments_json,receivable_cents
       FROM orders WHERE store_id=? AND (? IS NULL OR status=?) AND (? IS NULL OR channel=?)
      ORDER BY created_at DESC LIMIT 200`,
  ).bind(session.store.id, filter, filter, channel, channel).all();
  const returns = await returnsByOrder(env.DB, session.store.id);
  return json(rows.results.map(({ items_json, payments_json, ...o }) => {
    const ret = returns.get(o.id);
    return {
      ...o, code: o.id.slice(0, 8).toUpperCase(),
      items: JSON.parse(items_json).map(({ cost_cents: _c, ...i }) => ({ ...i, returned: ret?.quantities[`${i.id}|${i.variant_id || ""}`] || 0 })),
      payments: JSON.parse(payments_json || "[]"),
      returned_cents: ret?.value_cents || 0,
    };
  }));
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

// Consulta leve usada pelo painel a cada 30 s para avisar de pedidos novos.
// "since" é o "now" devolvido na consulta anterior (horário do banco). Usa >=
// para não perder pedidos criados no mesmo segundo; o painel ignora repetidos.
export async function notifications(request, env, session) {
  const since = new URL(request.url).searchParams.get("since") || "";
  if (since && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(since)) throw new HttpError(400, "Parâmetro inválido");
  const db = env.DB;
  const now = (await db.prepare("SELECT CURRENT_TIMESTAMP AS now").first()).now;
  const pending = (await db.prepare("SELECT COUNT(*) AS n FROM orders WHERE store_id=? AND status='pending'").bind(session.store.id).first()).n;
  const fresh = since
    ? (await db.prepare(
      `SELECT id,total_cents,customer_name,created_at FROM orders
        WHERE store_id=? AND channel='online' AND created_at >= ? ORDER BY created_at DESC LIMIT 20`,
    ).bind(session.store.id, since).all()).results
    : [];
  return json({ now, pending, new_orders: fresh.map((o) => ({ ...o, code: o.id.slice(0, 8).toUpperCase() })) });
}
