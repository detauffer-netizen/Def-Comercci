// Rotas públicas da vitrine: dados da loja e registro de pedidos.

import { HttpError, json, readJson } from "../lib/http.js";
import { rateLimitByIp } from "../lib/session.js";
import { imageUrl } from "../lib/images.js";
import * as v from "../lib/validate.js";

export function effectivePrice(product) {
  const promo = product.promo_price_cents;
  return promo !== null && promo !== undefined && promo < product.price_cents ? promo : product.price_cents;
}

async function activeStore(db, slug) {
  if (!/^[a-z0-9-]{3,60}$/.test(slug)) return null;
  return db
    .prepare("SELECT id,name,slug,whatsapp,accent,description,logo_key,banner_key FROM stores WHERE slug=? AND status='active'")
    .bind(slug)
    .first();
}

export async function imagesByProduct(db, storeId) {
  const rows = await db
    .prepare("SELECT id,product_id,r2_key FROM product_images WHERE store_id=? ORDER BY position, created_at")
    .bind(storeId)
    .all();
  const map = new Map();
  for (const row of rows.results) {
    if (!map.has(row.product_id)) map.set(row.product_id, []);
    map.get(row.product_id).push({ id: row.id, url: imageUrl(row.r2_key) });
  }
  return map;
}

export async function variantsByProduct(db, storeId, { activeOnly = false } = {}) {
  const rows = await db
    .prepare(
      `SELECT id,product_id,name,sku,price_cents,stock,active FROM product_variants
        WHERE store_id=? ${activeOnly ? "AND active=1" : ""} ORDER BY position, name`,
    )
    .bind(storeId)
    .all();
  const map = new Map();
  for (const { product_id, ...row } of rows.results) {
    if (!map.has(product_id)) map.set(product_id, []);
    map.get(product_id).push(row);
  }
  return map;
}

export function variantPrice(product, variant) {
  return variant.price_cents ?? effectivePrice(product);
}

export async function storefront(request, env, params) {
  const db = env.DB;
  const store = await activeStore(db, params.slug);
  if (!store) throw new HttpError(404, "Loja não encontrada");
  const products = await db
    .prepare(
      `SELECT id,name,description,price_cents,promo_price_cents,stock,category,sku,featured
         FROM products WHERE store_id=? AND active=1
        ORDER BY featured DESC, name COLLATE NOCASE`,
    )
    .bind(store.id)
    .all();
  const images = await imagesByProduct(db, store.id);
  const variants = await variantsByProduct(db, store.id, { activeOnly: true });
  const hasVariants = new Set(
    (await db.prepare("SELECT DISTINCT product_id FROM product_variants WHERE store_id=?").bind(store.id).all()).results.map((r) => r.product_id),
  );
  return json(
    {
      name: store.name,
      slug: store.slug,
      whatsapp: store.whatsapp,
      accent: store.accent,
      description: store.description,
      logo_url: imageUrl(store.logo_key),
      banner_url: imageUrl(store.banner_key),
      products: products.results.map((p) => {
        const options = (variants.get(p.id) || []).map((x) => ({
          id: x.id, name: x.name, stock: x.stock, final_price_cents: variantPrice(p, x),
        }));
        return {
          ...p,
          // Produto com variações: só as ativas contam para a vitrine.
          stock: hasVariants.has(p.id) ? options.reduce((sum, x) => sum + x.stock, 0) : p.stock,
          featured: !!p.featured,
          final_price_cents: options.length ? Math.min(...options.map((x) => x.final_price_cents)) : effectivePrice(p),
          images: (images.get(p.id) || []).map((i) => i.url),
          variants: options,
        };
      }),
    },
    200,
    // Cache curto na borda; o estoque é revalidado de novo no pedido.
    { "Cache-Control": "public, max-age=15" },
  );
}

export async function createOrderRequest(request, env, params) {
  const db = env.DB;
  await rateLimitByIp(db, request, "order-request", 20);
  const store = await activeStore(db, params.slug);
  if (!store) throw new HttpError(404, "Loja não encontrada");
  const body = await readJson(request);
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) {
    throw new HttpError(400, "Pedido inválido");
  }
  const customerName = v.requiredText(body.customer_name, 100, "seu nome");
  const customerPhone = v.phone(body.customer_phone);
  const notes = v.cleanText(body.notes, 500, { multiline: true });

  const seen = new Set();
  const items = [];
  let total = 0;
  for (const item of body.items) {
    const variantId = item?.variant_id ?? null;
    const key = `${item?.id}:${variantId}`;
    if (typeof item?.id !== "string" || item.id.length > 64 || seen.has(key)) throw new HttpError(400, "Pedido inválido");
    if (variantId !== null && (typeof variantId !== "string" || variantId.length > 64)) throw new HttpError(400, "Pedido inválido");
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 100) {
      throw new HttpError(400, "Quantidade inválida");
    }
    seen.add(key);
    // Preço e nome sempre vêm do banco, nunca do navegador.
    const product = await db
      .prepare(
        `SELECT name,price_cents,promo_price_cents,stock,sku,
                EXISTS (SELECT 1 FROM product_variants WHERE product_id=products.id) AS has_variants
           FROM products WHERE id=? AND store_id=? AND active=1`,
      )
      .bind(item.id, store.id)
      .first();
    if (!product) throw new HttpError(409, "Um dos produtos não está mais disponível");
    if (product.has_variants && variantId === null) throw new HttpError(400, `Escolha uma opção de ${product.name}`);
    if (!product.has_variants && variantId !== null) throw new HttpError(400, "Pedido inválido");
    let line = { id: item.id, name: product.name, sku: product.sku, quantity: item.quantity, price_cents: effectivePrice(product) };
    let stock = product.stock;
    if (variantId !== null) {
      const variant = await db
        .prepare("SELECT id,name,sku,price_cents,stock FROM product_variants WHERE id=? AND product_id=? AND store_id=? AND active=1")
        .bind(variantId, item.id, store.id)
        .first();
      if (!variant) throw new HttpError(409, `A opção escolhida de ${product.name} não está mais disponível`);
      stock = variant.stock;
      line = { ...line, variant_id: variant.id, variant_name: variant.name, sku: variant.sku || product.sku, price_cents: variantPrice(product, variant) };
    }
    if (stock < item.quantity) {
      throw new HttpError(409, `Estoque insuficiente para ${product.name}${line.variant_name ? ` (${line.variant_name})` : ""}`);
    }
    total += line.price_cents * item.quantity;
    items.push(line);
  }
  const orderId = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO orders(id,store_id,items_json,total_cents,customer_name,customer_phone,notes) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(orderId, store.id, JSON.stringify(items), total, customerName, customerPhone, notes)
    .run();
  return json({ id: orderId, code: orderId.slice(0, 8).toUpperCase(), total_cents: total, items }, 201);
}
