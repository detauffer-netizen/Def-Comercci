// Ponto de entrada do Worker Def Commerce: roteamento, cabeçalhos de
// segurança e páginas estáticas (servidas pelo binding ASSETS).

import { HttpError, json } from "./lib/http.js";
import { loadSession } from "./lib/session.js";
import { serveImage } from "./lib/images.js";
import * as auth from "./routes/auth.js";
import * as pub from "./routes/public.js";
import * as panel from "./routes/panel.js";

// [método, padrão, handler, exige sessão]
const ROUTES = [
  ["POST", "/api/register", auth.register, false],
  ["POST", "/api/login", auth.login, false],
  ["GET", "/api/store/:slug", pub.storefront, false],
  ["POST", "/api/order-request/:slug", pub.createOrderRequest, false],
  ["POST", "/api/logout", auth.logout, true],
  ["GET", "/api/me", panel.me, true],
  ["PATCH", "/api/settings", panel.updateSettings, true],
  ["POST", "/api/settings/:kind", panel.uploadStoreImage, true],
  ["DELETE", "/api/settings/:kind", panel.deleteStoreImage, true],
  ["GET", "/api/products", panel.listProducts, true],
  ["POST", "/api/products", panel.createProduct, true],
  ["PATCH", "/api/products/:id", panel.updateProduct, true],
  ["DELETE", "/api/products/:id", panel.deleteProduct, true],
  ["POST", "/api/products/:id/images", panel.uploadProductImage, true],
  ["DELETE", "/api/products/:id/images/:imageId", panel.deleteProductImage, true],
  ["GET", "/api/orders", panel.listOrders, true],
  ["PATCH", "/api/orders/:id", panel.updateOrderStatus, true],
  ["GET", "/api/customers", panel.listCustomers, true],
  ["GET", "/api/metrics", panel.metrics, true],
  ["GET", "/api/stock-movements", panel.stockMovements, true],
  ["GET", "/api/audit-log", panel.auditLog, true],
].map(([method, pattern, handler, needsSession]) => {
  const names = [];
  const regex = new RegExp(
    "^" + pattern.replace(/:([a-zA-Z]+)/g, (_, name) => (names.push(name), "([^/]+)")) + "$",
  );
  return { method, regex, names, handler, needsSession };
});

export const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

function withHeaders(response, extra = {}) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) res.headers.set(k, v);
  return res;
}

async function handleApi(request, env, url) {
  // Proteção CSRF: toda escrita precisa vir da própria origem.
  if (request.method !== "GET" && request.method !== "HEAD") {
    if (request.headers.get("Origin") !== url.origin) return json({ error: "Origem inválida" }, 403);
  }
  for (const route of ROUTES) {
    const match = url.pathname.match(route.regex);
    if (!match) continue;
    if (route.method !== request.method) continue;
    const params = {};
    try {
      route.names.forEach((name, i) => (params[name] = decodeURIComponent(match[i + 1])));
    } catch {
      return json({ error: "Endereço inválido" }, 400);
    }
    if (!route.needsSession) return route.handler(request, env, params);
    const session = await loadSession(env.DB, request);
    if (!session) return json({ error: "Sua sessão expirou. Entre novamente." }, 401);
    if (session.store.status !== "active") return json({ error: "Esta loja está suspensa. Fale com o suporte." }, 403);
    return route.handler(request, env, session, params);
  }
  const pathExists = ROUTES.some((r) => r.regex.test(url.pathname));
  return json({ error: pathExists ? "Método não permitido" : "Não encontrado" }, pathExists ? 405 : 404);
}

async function asset(env, request, path) {
  const response = await env.ASSETS.fetch(new Request(new URL(path, request.url), { method: "GET" }));
  return withHeaders(response, path.endsWith(".html") ? { "Cache-Control": "no-cache" } : {});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/health") {
      try {
        await env.DB.prepare("SELECT 1").first();
        return json({ status: "ok", database: "connected", images: !!env.IMAGES });
      } catch {
        return json({ status: "unavailable" }, 503);
      }
    }

    if (path.startsWith("/api/")) {
      try {
        return withHeaders(await handleApi(request, env, url));
      } catch (error) {
        if (error instanceof HttpError) return withHeaders(json({ error: error.message }, error.status));
        console.error("api_error", request.method, path, error?.stack || error);
        return withHeaders(json({ error: "Erro interno. Tente novamente em instantes." }, 500));
      }
    }

    if (path.startsWith("/img/") && (request.method === "GET" || request.method === "HEAD")) {
      return serveImage(env, path.slice(5));
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (path === "/") return asset(env, request, "/index.html");
    if (path === "/painel" || path === "/painel/") return asset(env, request, "/painel.html");
    if (/^\/loja\/[a-z0-9-]{3,60}\/?$/.test(path)) return asset(env, request, "/vitrine.html");
    if (/^\/(css|js|icons)\/[a-z0-9._-]+$/.test(path) || path === "/robots.txt" || path === "/favicon.svg") {
      return asset(env, request, path);
    }
    return withHeaders(new Response("Página não encontrada", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } }));
  },
};
