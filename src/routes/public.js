// Rotas públicas da vitrine: dados da loja e registro de pedidos.

import { HttpError, json, readJson } from "../lib/http.js";
import { rateLimitByIp } from "../lib/session.js";
import { imageUrl } from "../lib/images.js";
import * as v from "../lib/validate.js";
import { markCartOrdered } from "./carts.js";

export function effectivePrice(product) {
  const promo = product.promo_price_cents;
  return promo !== null && promo !== undefined && promo < product.price_cents ? promo : product.price_cents;
}

export async function activeStore(db, slug) {
  if (!/^[a-z0-9-]{3,60}$/.test(slug)) return null;
  return db
    .prepare("SELECT id,name,slug,whatsapp,accent,description,logo_key,banner_key,delivery_fee_cents,free_delivery_above_cents,pickup_enabled,category_order FROM stores WHERE slug=? AND status='active'")
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
        ORDER BY featured DESC, position, name COLLATE NOCASE`,
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
      delivery: deliveryOptions(store),
      category_order: parseCategoryOrder(store.category_order),
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

// Calcula itens e subtotal com preços e estoque do banco (nunca do navegador).
// includeHidden: o PDV vende também produtos ocultos da vitrine.
export async function priceItems(db, store, list, { includeHidden = false, maxItems = 30 } = {}) {
  if (!Array.isArray(list) || list.length < 1 || list.length > maxItems) throw new HttpError(400, "Pedido inválido");
  const body = { items: list };
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
        `SELECT name,price_cents,promo_price_cents,stock,sku,cost_cents,
                EXISTS (SELECT 1 FROM product_variants WHERE product_id=products.id) AS has_variants
           FROM products WHERE id=? AND store_id=? AND (active=1 OR ?)`,
      )
      .bind(item.id, store.id, includeHidden ? 1 : 0)
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
    // Custo no momento da venda (uso interno; nunca vai para o comprador).
    items.push(product.cost_cents === null || product.cost_cents === undefined ? line : { ...line, cost_cents: product.cost_cents });
  }
  return { items, subtotal: total };
}

// Valida o cupom e calcula o desconto. Não consome o cupom.
export async function couponDiscount(db, storeId, rawCode, subtotal) {
  const code = String(rawCode ?? "").trim().toUpperCase();
  if (!code) return { coupon: null, discount: 0 };
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) throw new HttpError(400, "Cupom inválido");
  const coupon = await db.prepare(
    `SELECT id,code,kind,value,min_order_cents,max_uses,uses,expires_at FROM coupons
      WHERE store_id=? AND code=? AND active=1`,
  ).bind(storeId, code).first();
  if (!coupon) throw new HttpError(400, "Cupom inválido ou inativo");
  if (coupon.expires_at && coupon.expires_at < new Date().toISOString().slice(0, 10)) throw new HttpError(400, "Este cupom expirou");
  if (coupon.max_uses !== null && coupon.uses >= coupon.max_uses) throw new HttpError(400, "Este cupom já atingiu o limite de usos");
  if (subtotal < coupon.min_order_cents) {
    throw new HttpError(400, `Este cupom vale para pedidos a partir de R$ ${(coupon.min_order_cents / 100).toFixed(2).replace(".", ",")}`);
  }
  const discount = coupon.kind === "percent"
    ? Math.floor((subtotal * coupon.value) / 100)
    : Math.min(coupon.value, subtotal);
  return { coupon, discount };
}

export function parseCategoryOrder(text) {
  try {
    const list = JSON.parse(text || "[]");
    return Array.isArray(list) ? list.filter((x) => typeof x === "string").slice(0, 100) : [];
  } catch {
    return [];
  }
}

export function deliveryOptions(store) {
  return {
    pickup: !!store.pickup_enabled,
    delivery: store.delivery_fee_cents !== null && store.delivery_fee_cents !== undefined,
    fee_cents: store.delivery_fee_cents ?? 0,
    free_above_cents: store.free_delivery_above_cents ?? null,
  };
}

// Forma de receber o pedido. Sem opções configuradas, fica "a combinar".
function fulfillmentFor(store, body, amount, { requireAddress = true } = {}) {
  const options = deliveryOptions(store);
  if (!options.pickup && !options.delivery) return { fulfillment: "", fee: 0, address: "" };
  const fulfillment = body.fulfillment;
  if (fulfillment === "pickup" && options.pickup) return { fulfillment, fee: 0, address: "" };
  if (fulfillment === "delivery" && options.delivery) {
    const address = v.cleanText(body.address, 300, { multiline: true });
    if (requireAddress && address.length < 8) throw new HttpError(400, "Informe o endereço de entrega");
    const free = options.free_above_cents !== null && amount >= options.free_above_cents;
    return { fulfillment, fee: free ? 0 : options.fee_cents, address };
  }
  throw new HttpError(400, "Escolha entre retirar na loja ou receber em casa");
}

export async function orderPreview(request, env, params) {
  const db = env.DB;
  await rateLimitByIp(db, request, "order-preview", 60);
  const store = await activeStore(db, params.slug);
  if (!store) throw new HttpError(404, "Loja não encontrada");
  const body = await readJson(request);
  const { subtotal } = await priceItems(db, store, body.items);
  try {
    const { coupon, discount } = await couponDiscount(db, store.id, body.coupon_code, subtotal);
    const ship = body.fulfillment ? fulfillmentFor(store, body, subtotal - discount, { requireAddress: false }) : { fee: 0 };
    return json({
      valid: true, subtotal_cents: subtotal, discount_cents: discount, delivery_fee_cents: ship.fee,
      total_cents: subtotal - discount + ship.fee, coupon_code: coupon?.code || "",
    });
  } catch (error) {
    // Cupom recusado é uma resposta normal da prévia, não um erro da requisição.
    if (error instanceof HttpError && error.status === 400) {
      return json({ valid: false, error: error.message, subtotal_cents: subtotal, discount_cents: 0, delivery_fee_cents: 0, total_cents: subtotal, coupon_code: "" });
    }
    throw error;
  }
}

export async function createOrderRequest(request, env, params) {
  const db = env.DB;
  await rateLimitByIp(db, request, "order-request", 20);
  const store = await activeStore(db, params.slug);
  if (!store) throw new HttpError(404, "Loja não encontrada");
  const body = await readJson(request);
  const { items, subtotal } = await priceItems(db, store, body.items);
  const customerName = v.requiredText(body.customer_name, 100, "seu nome");
  const customerPhone = v.phone(body.customer_phone);
  const notes = v.cleanText(body.notes, 500, { multiline: true });
  const { coupon, discount } = await couponDiscount(db, store.id, body.coupon_code, subtotal);
  const ship = fulfillmentFor(store, body, subtotal - discount);
  // Consome o uso do cupom de forma atômica: dois pedidos simultâneos não
  // passam do limite.
  if (coupon) {
    const used = await db.prepare(
      "UPDATE coupons SET uses=uses+1 WHERE id=? AND store_id=? AND active=1 AND (max_uses IS NULL OR uses < max_uses)",
    ).bind(coupon.id, store.id).run();
    if (!used.meta.changes) throw new HttpError(409, "Este cupom acabou de atingir o limite de usos");
  }
  const total = subtotal - discount + ship.fee;
  const orderId = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO orders(id,store_id,items_json,total_cents,subtotal_cents,discount_cents,coupon_code,customer_name,customer_phone,notes,
                            fulfillment,delivery_fee_cents,address)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(orderId, store.id, JSON.stringify(items), total, subtotal, discount, coupon?.code || "", customerName, customerPhone, notes,
        ship.fulfillment, ship.fee, ship.address)
      .run();
  } catch (error) {
    if (coupon) await db.prepare("UPDATE coupons SET uses=uses-1 WHERE id=? AND uses>0").bind(coupon.id).run();
    throw error;
  }
  await markCartOrdered(db, store.id, body.cart_token, orderId);
  return json({
    id: orderId, code: orderId.slice(0, 8).toUpperCase(), subtotal_cents: subtotal, discount_cents: discount,
    coupon_code: coupon?.code || "", fulfillment: ship.fulfillment, delivery_fee_cents: ship.fee, address: ship.address,
    total_cents: total, items: items.map(({ cost_cents: _c, ...i }) => i),
  }, 201);
}
