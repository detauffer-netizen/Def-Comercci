// SEO e prévia de compartilhamento da vitrine: título, descrição, Open Graph
// e dados estruturados gerados no servidor para cada loja; sitemap e robots.

import { imageUrl } from "./images.js";

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// JSON dentro de <script>: impede fechar a tag com "</script>".
const safeJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

export async function storefrontPage(env, request, slug) {
  const origin = new URL(request.url).origin;
  const [store, page] = await Promise.all([
    env.DB.prepare(
      `SELECT s.name, s.description, s.accent, s.logo_key, s.banner_key,
              (SELECT COUNT(*) FROM products p WHERE p.store_id=s.id AND p.active=1) AS products
         FROM stores s WHERE s.slug=? AND s.status='active'`,
    ).bind(slug).first(),
    env.ASSETS.fetch(new Request(new URL("/vitrine.html", request.url))).then((r) => r.text()),
  ]);
  const url = `${origin}/loja/${slug}`;
  if (!store) {
    const html = page.replace("</head>", '<meta name="robots" content="noindex">\n</head>');
    return { html, status: 404 };
  }
  const description = store.description ||
    `Catálogo da ${store.name}${store.products ? ` com ${store.products} produto(s)` : ""}. Escolha e faça seu pedido pelo WhatsApp.`;
  const imageKey = store.banner_key || store.logo_key;
  const image = imageKey ? origin + imageUrl(imageKey) : "";
  const title = `${store.name} | Catálogo`;
  const structured = {
    "@context": "https://schema.org",
    "@type": "Store",
    name: store.name,
    url,
    description,
    ...(store.logo_key ? { logo: origin + imageUrl(store.logo_key) } : {}),
    ...(image ? { image } : {}),
  };
  const tags = [
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Def Commerce">`,
    `<meta property="og:locale" content="pt_BR">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    image ? `<meta property="og:image" content="${escapeHtml(image)}">` : "",
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
    "SELECT slug FROM stores WHERE status='active' AND EXISTS (SELECT 1 FROM products p WHERE p.store_id=stores.id AND p.active=1) ORDER BY created_at LIMIT 45000",
  ).all()).results;
  const urls = [`${origin}/`, ...stores.map((s) => `${origin}/loja/${s.slug}`)];
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
