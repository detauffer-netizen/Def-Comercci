// SEO e prévia de compartilhamento da vitrine: título, descrição, Open Graph
// e dados estruturados gerados no servidor para cada loja; sitemap e robots.

import { imageUrl } from "./images.js";

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// JSON dentro de <script>: impede fechar a tag com "</script>".
const safeJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

const money = (cents) => (cents / 100).toFixed(2);
const brl = (cents) => `R$ ${(cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function productInfo(db, storeId, productId) {
  const p = await db.prepare(
    `SELECT id,name,description,price_cents,promo_price_cents,stock,sku,
            (SELECT r2_key FROM product_images i WHERE i.product_id=products.id ORDER BY position, created_at LIMIT 1) AS image_key
       FROM products WHERE id=? AND store_id=? AND active=1`,
  ).bind(productId, storeId).first();
  if (!p) return null;
  const base = p.promo_price_cents !== null && p.promo_price_cents < p.price_cents ? p.promo_price_cents : p.price_cents;
  const variants = (await db.prepare(
    "SELECT price_cents, stock FROM product_variants WHERE product_id=? AND store_id=? AND active=1",
  ).bind(productId, storeId).all()).results;
  const hasVariants = (await db.prepare("SELECT 1 FROM product_variants WHERE product_id=? LIMIT 1").bind(productId).first()) !== null;
  const prices = variants.map((v) => v.price_cents ?? base);
  return {
    ...p,
    price: prices.length ? Math.min(...prices) : base,
    highPrice: prices.length ? Math.max(...prices) : base,
    inStock: hasVariants ? variants.some((v) => v.stock > 0) : p.stock > 0,
  };
}

function notFound(page) {
  return { html: page.replace("</head>", '<meta name="robots" content="noindex">\n</head>'), status: 404 };
}

// Monta a vitrine (ou a página de um produto) com título, descrição, Open
// Graph, canonical e dados estruturados. Todos os valores são escapados.
export async function storefrontPage(env, request, slug, productId = null) {
  const origin = new URL(request.url).origin;
  const [store, page] = await Promise.all([
    env.DB.prepare(
      `SELECT s.id, s.name, s.description, s.accent, s.logo_key, s.banner_key,
              (SELECT COUNT(*) FROM products p WHERE p.store_id=s.id AND p.active=1) AS products
         FROM stores s WHERE s.slug=? AND s.status='active'`,
    ).bind(slug).first(),
    env.ASSETS.fetch(new Request(new URL("/vitrine.html", request.url))).then((r) => r.text()),
  ]);
  if (!store) return notFound(page);
  const storeUrl = `${origin}/loja/${slug}`;
  const storeImageKey = store.banner_key || store.logo_key;
  let title = `${store.name} | Catálogo`;
  let description = store.description ||
    `Catálogo da ${store.name}${store.products ? ` com ${store.products} produto(s)` : ""}. Escolha e faça seu pedido pelo WhatsApp.`;
  let url = storeUrl;
  let image = storeImageKey ? origin + imageUrl(storeImageKey) : "";
  let type = "website";
  let structured = {
    "@context": "https://schema.org",
    "@type": "Store",
    name: store.name,
    url,
    description,
    ...(store.logo_key ? { logo: origin + imageUrl(store.logo_key) } : {}),
    ...(image ? { image } : {}),
  };
  const extra = [];

  if (productId) {
    const product = await productInfo(env.DB, store.id, productId);
    if (!product) return notFound(page);
    url = `${storeUrl}/p/${product.id}`;
    title = `${product.name} · ${brl(product.price)} | ${store.name}`;
    const text = product.description.replace(/\s+/g, " ").trim();
    description = text ? (text.length > 155 ? `${text.slice(0, 152)}...` : text) : `${product.name} por ${brl(product.price)} na ${store.name}. Peça pelo WhatsApp.`;
    if (product.image_key) image = origin + imageUrl(product.image_key);
    type = "product";
    const availability = product.inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock";
    structured = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: product.name,
      url,
      ...(text ? { description: text.slice(0, 5000) } : {}),
      ...(image ? { image } : {}),
      ...(product.sku ? { sku: product.sku } : {}),
      brand: { "@type": "Brand", name: store.name },
      offers: product.highPrice > product.price
        ? { "@type": "AggregateOffer", priceCurrency: "BRL", lowPrice: money(product.price), highPrice: money(product.highPrice), availability, url }
        : { "@type": "Offer", priceCurrency: "BRL", price: money(product.price), availability, url, seller: { "@type": "Organization", name: store.name } },
    };
    extra.push(
      `<meta property="product:price:amount" content="${money(product.price)}">`,
      `<meta property="product:price:currency" content="BRL">`,
    );
  }

  const tags = [
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<meta property="og:type" content="${type}">`,
    `<meta property="og:site_name" content="Def Commerce">`,
    `<meta property="og:locale" content="pt_BR">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    image ? `<meta property="og:image" content="${escapeHtml(image)}">` : "",
    ...extra,
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">`,
    `<script type="application/ld+json">${safeJson(structured)}</script>`,
  ].filter(Boolean).join("\n");
  const html = page
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${escapeHtml(description)}">`)
    .replace(/<meta name="theme-color" content="[^"]*">/, `<meta name="theme-color" content="${escapeHtml(store.accent)}">`)
    .replace("</head>", `${tags}\n</head>`);
  return { html, status: 200 };
}

export async function sitemap(env, request) {
  const origin = new URL(request.url).origin;
  const stores = (await env.DB.prepare(
    "SELECT slug FROM stores WHERE status='active' AND EXISTS (SELECT 1 FROM products p WHERE p.store_id=stores.id AND p.active=1) ORDER BY created_at LIMIT 5000",
  ).all()).results;
  const products = (await env.DB.prepare(
    `SELECT s.slug, p.id FROM products p JOIN stores s ON s.id=p.store_id
      WHERE s.status='active' AND p.active=1 ORDER BY s.created_at, p.id LIMIT 40000`,
  ).all()).results;
  const urls = [`${origin}/`, ...stores.map((s) => `${origin}/loja/${s.slug}`), ...products.map((p) => `${origin}/loja/${p.slug}/p/${p.id}`)];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${escapeHtml(u)}</loc></url>`).join("\n")}\n</urlset>\n`;
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}

export function robots(request) {
  const origin = new URL(request.url).origin;
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /painel",
    "Disallow: /admin",
    "Disallow: /api/",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
