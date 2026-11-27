// Ponto de entrada do Worker Def Commerce: roteamento, cabeçalhos de
// segurança e páginas estáticas (servidas pelo binding ASSETS).

import { HttpError, json } from "./lib/http.js";
import { loadAdminSession, loadSession, requireOwner, requirePermission } from "./lib/session.js";
import { serveImage } from "./lib/images.js";
import * as auth from "./routes/auth.js";
import * as pub from "./routes/public.js";
import * as panel from "./routes/panel.js";
import * as team from "./routes/team.js";
import * as admin from "./routes/admin.js";
import * as privacy from "./routes/privacy.js";
import * as reports from "./routes/reports.js";
import * as coupons from "./routes/coupons.js";
import * as twofactor from "./routes/twofactor.js";
import * as ai from "./routes/ai.js";
import * as carts from "./routes/carts.js";
import * as dashboard from "./routes/dashboard.js";
import * as sales from "./routes/sales.js";
import * as finance from "./routes/finance.js";
import * as billing from "./routes/billing.js";
import { recordError } from "./lib/errors.js";
import { robots, sitemap, storefrontPage } from "./lib/seo.js";

// [método, padrão, handler, acesso]
// acesso: "public" · "session" (qualquer membro da loja) · uma permissão
// (products, orders, customers, reports; o proprietário tem todas) ·
// "owner" · "admin" (super administrador, isolado das lojas)
const ROUTES = [
  ["POST", "/api/register", auth.register, "public"],
  ["POST", "/api/login", auth.login, "public"],
  ["POST", "/api/login/2fa", twofactor.loginSecondStep, "public"],
  ["GET", "/api/store/:slug", pub.storefront, "public"],
  ["POST", "/api/order-request/:slug", pub.createOrderRequest, "public"],
  ["POST", "/api/order-preview/:slug", pub.orderPreview, "public"],
  ["PUT", "/api/cart-reminder/:slug", carts.saveCartReminder, "public"],
  ["DELETE", "/api/cart-reminder/:slug/:token", carts.deleteCartReminder, "public"],
  ["POST", "/api/billing/webhook/mercadopago", billing.mercadoPagoWebhook, "public"],
  ["GET", "/api/billing", billing.billingStatus, "owner"],
  ["POST", "/api/billing/subscribe", billing.subscribe, "owner"],
  ["POST", "/api/billing/pay-month", billing.payMonth, "owner"],
  ["POST", "/api/billing/cancel", billing.cancel, "owner"],
  ["POST", "/api/logout", auth.logout, "session"],
  ["GET", "/api/me", panel.me, "session"],
  ["POST", "/api/account/password", team.changePassword, "session"],
  ["GET", "/api/account/2fa", twofactor.status, "session"],
  ["POST", "/api/account/2fa/setup", twofactor.setup, "session"],
  ["POST", "/api/account/2fa/enable", twofactor.enable, "session"],
  ["POST", "/api/account/2fa/disable", twofactor.disable, "session"],
  ["PATCH", "/api/settings", panel.updateSettings, "owner"],
  ["POST", "/api/settings/:kind", panel.uploadStoreImage, "owner"],
  ["DELETE", "/api/settings/:kind", panel.deleteStoreImage, "owner"],
  ["GET", "/api/coupons", coupons.listCoupons, "owner"],
  ["POST", "/api/coupons", coupons.createCoupon, "owner"],
  ["PATCH", "/api/coupons/:id", coupons.updateCoupon, "owner"],
  ["DELETE", "/api/coupons/:id", coupons.deleteCoupon, "owner"],
  ["GET", "/api/team", team.listTeam, "owner"],
  ["POST", "/api/team", team.addMember, "owner"],
  ["PATCH", "/api/team/:id", team.updateMember, "owner"],
  ["DELETE", "/api/team/:id", team.removeMember, "owner"],
  ["GET", "/api/ai/usage", ai.aiUsage, "products"],
  ["POST", "/api/ai/product-from-text", ai.productFromText, "products"],
  ["POST", "/api/ai/product-from-photo", ai.productFromPhoto, "products"],
  ["POST", "/api/ai/improve-description", ai.improveDescription, "products"],
  ["POST", "/api/ai/campaign", ai.campaign, "products"],
  ["GET", "/api/categories/order", panel.getCategoryOrder, "products"],
  ["PUT", "/api/categories/order", panel.setCategoryOrder, "products"],
  ["GET", "/api/products", panel.listProducts, "products"],
  ["POST", "/api/products", panel.createProduct, "products"],
  ["PATCH", "/api/products/:id", panel.updateProduct, "products"],
  ["DELETE", "/api/products/:id", panel.deleteProduct, "products"],
  ["POST", "/api/products/:id/images", panel.uploadProductImage, "products"],
  ["DELETE", "/api/products/:id/images/:imageId", panel.deleteProductImage, "products"],
  ["PUT", "/api/products/:id/images/order", panel.reorderProductImages, "products"],
  ["GET", "/api/stock-movements", panel.stockMovements, "products"],
  ["GET", "/api/orders", panel.listOrders, "orders"],
  ["POST", "/api/sales", sales.createSale, "orders"],
  ["POST", "/api/orders/:id/returns", finance.createReturn, "orders"],
  ["GET", "/api/receivables", finance.listReceivables, "orders"],
  ["POST", "/api/receivables/:id", finance.receivePayment, "orders"],
  ["GET", "/api/expenses", finance.listExpenses, "reports"],
  ["POST", "/api/expenses", finance.createExpense, "reports"],
  ["DELETE", "/api/expenses/:id", finance.deleteExpense, "reports"],
  ["PATCH", "/api/orders/:id", panel.updateOrderStatus, "orders"],
  ["GET", "/api/notifications", panel.notifications, "orders"],
  ["GET", "/api/abandoned-carts", carts.listAbandonedCarts, "orders"],
  ["PATCH", "/api/abandoned-carts/:id", carts.updateAbandonedCart, "orders"],
  ["GET", "/api/customers", panel.listCustomers, "customers"],
  ["DELETE", "/api/customers/:phone", privacy.forgetCustomer, "customers"],
  ["GET", "/api/metrics", panel.metrics, "reports"],
  ["GET", "/api/reports", reports.report, "reports"],
  ["GET", "/api/dashboard", dashboard.dashboard, "reports"],
  ["GET", "/api/account/export", privacy.exportData, "owner"],
  ["POST", "/api/account/delete", privacy.deleteStore, "owner"],
  ["GET", "/api/audit-log", panel.auditLog, "owner"],
  ["POST", "/api/admin/logout", auth.logout, "admin"],
  ["GET", "/api/admin/me", admin.adminMe, "admin"],
  ["POST", "/api/admin/password", team.changePassword, "admin"],
  ["GET", "/api/admin/2fa", twofactor.status, "admin"],
  ["POST", "/api/admin/2fa/setup", twofactor.setup, "admin"],
  ["POST", "/api/admin/2fa/enable", twofactor.enable, "admin"],
  ["POST", "/api/admin/2fa/disable", twofactor.disable, "admin"],
  ["GET", "/api/admin/overview", admin.overview, "admin"],
  ["GET", "/api/admin/stores", admin.listStores, "admin"],
  ["PATCH", "/api/admin/stores/:id", admin.setStoreStatus, "admin"],
  ["GET", "/api/admin/audit", admin.adminAudit, "admin"],
  ["GET", "/api/admin/errors", admin.listErrors, "admin"],
  ["GET", "/api/admin/plans", billing.listPlans, "admin"],
  ["POST", "/api/admin/plans", billing.createPlan, "admin"],
  ["PATCH", "/api/admin/plans/:id", billing.updatePlan, "admin"],
  ["GET", "/api/admin/billing", billing.billingOverview, "admin"],
  ["PATCH", "/api/admin/stores/:id/plan", billing.setStorePlan, "admin"],
].map(([method, pattern, handler, access]) => {
  const names = [];
  const regex = new RegExp(
    "^" + pattern.replace(/:([a-zA-Z]+)/g, (_, name) => (names.push(name), "([^/]+)")) + "$",
  );
  return { method, regex, names, handler, access };
});

// Enquanto a senha provisória não for trocada, só estas rotas funcionam.
const ALLOWED_BEFORE_PASSWORD_CHANGE = new Set([panel.me, auth.logout, team.changePassword]);

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
  // Webhooks vêm de servidores externos (sem Origin) e são autenticados por assinatura.
  const webhook = url.pathname.startsWith("/api/billing/webhook/");
  if (request.method !== "GET" && request.method !== "HEAD" && !webhook) {
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
    if (route.access === "public") return route.handler(request, env, params);
    if (route.access === "admin") {
      const adminSession = await loadAdminSession(env.DB, request);
      if (!adminSession) return json({ error: "Acesso restrito à administração da plataforma." }, 401);
      // changePassword e logout esperam session.user
      return route.handler(request, env, { ...adminSession, user: { id: adminSession.admin.id }, store: null }, params);
    }
    const session = await loadSession(env.DB, request);
    if (!session) return json({ error: "Sua sessão expirou. Entre novamente." }, 401);
    if (session.store.status !== "active") return json({ error: "Esta loja está suspensa. Fale com o suporte." }, 403);
    if (session.user.mustChangePassword && !ALLOWED_BEFORE_PASSWORD_CHANGE.has(route.handler)) {
      return json({ error: "Defina uma nova senha para continuar." }, 403);
    }
    if (route.access === "owner") requireOwner(session);
    else if (route.access !== "session") requirePermission(session, route.access);
    return route.handler(request, env, session, params);
  }
  const pathExists = ROUTES.some((r) => r.regex.test(url.pathname));
  return json({ error: pathExists ? "Método não permitido" : "Não encontrado" }, pathExists ? 405 : 404);
}

async function asset(env, request, path, headers = {}) {
  const response = await env.ASSETS.fetch(new Request(new URL(path, request.url), { method: "GET" }));
  return withHeaders(response, { ...(path.endsWith(".html") ? { "Cache-Control": "no-cache" } : {}), ...headers });
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
        await recordError(env, request, error);
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
    if (path === "/admin" || path === "/admin/") return asset(env, request, "/admin.html");
    const shop = path.match(/^\/loja\/([a-z0-9-]{3,60})(?:\/p\/([0-9a-f-]{36}))?\/?$/);
    if (shop) {
      const { html, status } = await storefrontPage(env, request, shop[1], shop[2] || null);
      return withHeaders(new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } }));
    }
    const catalog = path.match(/^\/loja\/([a-z0-9-]{3,60})\/catalogo\/?$/);
    if (catalog) return asset(env, request, "/catalogo.html", { "X-Robots-Tag": "noindex" });
    if (path === "/privacidade") return asset(env, request, "/privacidade.html");
    if (path === "/termos") return asset(env, request, "/termos.html");
    if (path === "/sitemap.xml") return withHeaders(await sitemap(env, request));
    if (path === "/robots.txt") return withHeaders(robots(request));
    if (path === "/sw.js") return asset(env, request, "/sw.js", { "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" });
    if (path === "/manifest.webmanifest") return asset(env, request, "/manifest.webmanifest", { "Cache-Control": "public, max-age=3600" });
    if (/^\/(css|js|icons)\/[a-z0-9._-]+$/.test(path) || path === "/favicon.svg") {
      return asset(env, request, path);
    }
    return withHeaders(new Response("Página não encontrada", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } }));
  },
};
