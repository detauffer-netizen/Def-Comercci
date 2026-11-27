import {
  ApiError, api, centsToInput, sortCategories, compressImage, downloadCsv, formatDate, formatPhone, h, icon, money, parseMoney, toast, whatsappLink,
} from "./common.js";
import { mountTwoFactor } from "./twofactor.js";

const $ = (id) => document.getElementById(id);
const state = { me: null, products: [], orders: [], metrics: null, orderStatus: "", editing: null, pendingFiles: [] };
const STATUS = {
  pending: { label: "Pendente", badge: "badge-warn" },
  confirmed: { label: "Confirmado", badge: "" },
  completed: { label: "Concluído", badge: "badge-ok" },
  cancelled: { label: "Cancelado", badge: "badge-danger" },
};
const VIEWS = ["inicio", "produtos", "pedidos", "clientes", "loja"];
const VIEW_PERMISSION = { inicio: null, produtos: "products", pedidos: "orders", clientes: "customers", loja: "owner" };

function can(permission) {
  if (!permission) return true;
  const user = state.me?.user;
  if (!user) return false;
  if (permission === "owner") return user.role === "owner";
  return user.role === "owner" || user.permissions.includes(permission);
}

function fail(error) {
  if (error instanceof ApiError && error.status === 401) return showAuth("Sua sessão expirou. Entre novamente.");
  toast(error.message || "Algo deu errado.", { error: true });
}

async function busy(button, task) {
  if (button) button.disabled = true;
  try {
    return await task();
  } catch (error) {
    fail(error);
  } finally {
    if (button) button.disabled = false;
  }
}

// ---------- Acesso ----------

function showAuth(message) {
  stopNotifications();
  $("boot").hidden = true;
  $("app").hidden = true;
  $("auth").hidden = false;
  const err = $("auth-error");
  err.hidden = !message;
  err.textContent = message || "";
  if (location.hash === "#cadastro") selectTab("register");
}

let loginChallenge = "";

function selectTab(which) {
  $("login-2fa").hidden = true;
  for (const name of ["login", "register"]) {
    $(`tab-${name}`).setAttribute("aria-selected", String(name === which));
    $(name).hidden = name !== which;
  }
  $("auth-error").hidden = true;
}

function authForm(form, path, transform) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const problem = transform?.(data);
    const err = $("auth-error");
    if (problem) {
      err.textContent = problem;
      err.hidden = false;
      return;
    }
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      await api(path, { method: "POST", body: data });
      form.reset();
      await start();
    } catch (error) {
      err.textContent = error.message;
      err.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
}

// ---------- Inicialização ----------

async function start() {
  try {
    state.me = await api("/api/me");
  } catch (error) {
    if (error.status === 401) return showAuth();
    return showAuth(error.message);
  }
  $("boot").hidden = true;
  $("auth").hidden = true;
  $("app").hidden = false;
  renderStoreHeader();
  for (const a of document.querySelectorAll(".nav a")) a.hidden = !can(a.dataset.perm);
  $("sidebar-nav").style.setProperty("--nav-items", String([...document.querySelectorAll(".nav a")].filter((a) => !a.hidden).length));
  // Com senha provisória, nada é carregado até a troca (a API recusaria).
  if (state.me.user.must_change_password) return openPassword(true);
  route();
  startNotifications();
}

// ---------- Notificações de pedidos novos ----------

const notif = { since: "", seen: new Set(), timer: null, baseTitle: document.title };
const ALERTS_KEY = "def-alerts";

function alertsEnabled() {
  try {
    return "Notification" in window && Notification.permission === "granted" && localStorage.getItem(ALERTS_KEY) === "1";
  } catch {
    return false;
  }
}

function renderAlertsButton() {
  const button = $("enable-alerts");
  button.hidden = !("Notification" in window) || Notification.permission === "denied" || alertsEnabled();
}

async function pollNotifications() {
  if (document.hidden || $("app").hidden || !can("orders") || state.me?.user.must_change_password) return;
  let data;
  try {
    data = await api(`/api/notifications${notif.since ? `?since=${encodeURIComponent(notif.since)}` : ""}`);
  } catch (error) {
    if (error.status === 401) stopNotifications();
    return;
  }
  const first = !notif.since;
  notif.since = data.now;
  const fresh = data.new_orders.filter((o) => !notif.seen.has(o.id));
  for (const o of data.new_orders) notif.seen.add(o.id);
  state.metrics = { ...(state.metrics || {}), pending: data.pending };
  updatePendingBadge();
  document.title = data.pending ? `(${data.pending}) ${notif.baseTitle}` : notif.baseTitle;
  if (first || !fresh.length) return;
  const o = fresh[0];
  const text = fresh.length > 1
    ? `${fresh.length} pedidos novos. O mais recente: ${o.customer_name}, ${money(o.total_cents)}.`
    : `Novo pedido #${o.code} de ${o.customer_name}: ${money(o.total_cents)}.`;
  toast(text);
  if (alertsEnabled()) {
    try {
      const n = new Notification("Novo pedido na sua loja", { body: text, tag: "def-order", icon: "/favicon.svg" });
      n.onclick = () => { window.focus(); location.hash = "pedidos"; n.close(); };
    } catch { /* navegador sem suporte a notificações nesta página */ }
  }
  if (location.hash === "#pedidos") loadOrders().catch(fail);
  else if ((location.hash || "#inicio") === "#inicio") loadHome().catch(fail);
}

function startNotifications() {
  stopNotifications();
  if (!can("orders")) return;
  renderAlertsButton();
  pollNotifications();
  notif.timer = setInterval(pollNotifications, 30000);
}

function stopNotifications() {
  clearInterval(notif.timer);
  notif.timer = null;
  notif.since = "";
  notif.seen.clear();
  document.title = notif.baseTitle;
}

document.addEventListener("visibilitychange", () => { if (!document.hidden && notif.timer) pollNotifications(); });

function renderStoreHeader() {
  const s = state.me.store;
  document.documentElement.style.setProperty("--accent", s.accent || "#2563eb");
  $("store-name").textContent = s.name;
  const url = `${location.origin}/loja/${s.slug}`;
  $("store-url").textContent = url.replace(/^https?:\/\//, "");
  $("open-store").href = url;
  const avatar = $("store-avatar");
  avatar.textContent = s.logo_url ? "" : s.name.slice(0, 1).toUpperCase();
  avatar.style.backgroundImage = s.logo_url ? `url("${s.logo_url}")` : "";
}

function route() {
  if (state.me.user.must_change_password) return;
  let view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "inicio";
  if (!can(VIEW_PERMISSION[view])) view = "inicio";
  // O filtro aberto por uma recomendação vale só até sair de Produtos.
  if (view !== "produtos") state.productIds = null;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  for (const a of document.querySelectorAll(".nav a")) {
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  window.scrollTo(0, 0);
  ({ inicio: loadHome, produtos: loadProducts, pedidos: loadOrders, clientes: loadCustomers, loja: loadStore })[view]().catch(fail);
}

function loading(container) {
  container.replaceChildren(h("div", { class: "skeleton" }), h("div", { class: "skeleton", style: { marginTop: "10px" } }));
}

function empty(container, iconName, text, action) {
  container.replaceChildren(h("div", { class: "empty" }, icon(iconName), h("p", { text }), action || null));
}

// ---------- Início ----------

async function loadHome() {
  const showReports = can("reports");
  const showOrders = can("orders");
  const showProducts = can("products");
  $("dash-card").hidden = !showReports;
  $("perf-card").hidden = !showReports;
  if (showReports) {
    loadDashboard().catch(fail);
    loadPerformance(state.perfDays || 30).catch(fail);
  }
  $("recent-card").hidden = !showOrders;
  $("stock-card").hidden = !showProducts;
  if (showOrders) loading($("recent-orders"));
  const [orders, products] = await Promise.all([
    showOrders ? api("/api/orders") : [],
    showProducts ? api("/api/products") : [],
  ]);
  state.orders = orders;
  state.products = products;
  updatePendingBadge();
  $("h-inicio").textContent = state.me.user.role === "owner" ? "Olá! Veja como está sua loja" : `Olá${state.me.user.name ? ", " + state.me.user.name.split(" ")[0] : ""}!`;


  const s = state.me.store;
  const steps = [
    ["Cadastre seu primeiro produto", products.length > 0, "#produtos"],
    ["Adicione fotos aos produtos", products.some((p) => p.images.length), "#produtos"],
    ["Informe o WhatsApp da loja", !!s.whatsapp, "#loja"],
    ["Personalize cor e logotipo", !!s.logo_url || s.accent !== "#2563eb", "#loja"],
    ["Compartilhe sua vitrine", orders.length > 0, "#loja"],
  ];
  $("onboarding").hidden = !can("owner") || steps.every(([, done]) => done);
  $("onboarding-steps").replaceChildren(...steps.map(([text, done, href]) =>
    h("li", { class: done ? "done" : "" }, h("span", { class: "dot" }, done ? icon("check", "icon icon-sm") : null),
      done ? h("span", { text }) : h("a", { href, text }))));

  if (showOrders) {
    const recent = orders.slice(0, 5);
    if (!recent.length) empty($("recent-orders"), "receipt", "Nenhum pedido ainda. Compartilhe sua vitrine para começar a vender.");
    else $("recent-orders").replaceChildren(...recent.map((o) => h("div", { class: "row" },
      h("div", { class: "grow" }, h("strong", { text: o.customer_name || "Cliente" }), h("small", { text: `#${o.code} · ${formatDate(o.created_at)}` })),
      h("div", { style: { textAlign: "right" } }, h("strong", { text: money(o.total_cents) }), h("div", {}, h("span", { class: `badge ${STATUS[o.status].badge}`, text: STATUS[o.status].label }))))));
  }

  if (showProducts) {
    const alerts = [];
    for (const p of products.filter((x) => x.active)) {
      const min = minStock(p);
      if (p.variants.length) for (const v of p.variants.filter((x) => x.active && x.stock <= min)) alerts.push({ name: `${p.name} · ${v.name}`, stock: v.stock, sub: v.sku || p.category || "" });
      else if (p.stock <= min) alerts.push({ name: p.name, stock: p.stock, sub: p.sku ? `SKU ${p.sku}` : p.category || "" });
    }
    alerts.sort((a, b) => a.stock - b.stock);
    if (!alerts.length) empty($("stock-alerts"), "check", "Nenhum produto com estoque baixo.");
    else $("stock-alerts").replaceChildren(...alerts.slice(0, 6).map((p) => h("div", { class: "row" },
      h("div", { class: "grow" }, h("strong", { text: p.name }), h("small", { text: p.sub })),
      h("span", { class: `badge ${p.stock ? "badge-warn" : "badge-danger"}`, text: p.stock ? `${p.stock} un.` : "Esgotado" }))));
  }
  if (!showReports && !showOrders && !showProducts) {
    $("dash-card").hidden = false;
    $("dash-periods").hidden = true;
    $("dash-tips-box").hidden = true;
    empty($("kpis"), "store", "Seu acesso ainda não inclui nenhuma área. Fale com o proprietário da loja.");
  }
}

// ---------- Desempenho (gráfico de vendas por dia) ----------

const SVG = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}
const shortDate = (day) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const longDate = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
const compactMoney = (cents) => {
  const v = cents / 100;
  return v >= 1000 ? `R$ ${(v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil` : `R$ ${Math.round(v).toLocaleString("pt-BR")}`;
};

// ---------- Resumo da loja (central de decisões) ----------

const PERIOD_LABEL = { today: "ontem", yesterday: "anteontem", "7d": "os 7 dias anteriores", "30d": "os 30 dias anteriores", custom: "o período anterior" };
const minStock = (p) => (p.min_stock ?? 3);

function delta(cur, prev, label) {
  if (!prev && !cur) return h("span", { class: "delta flat", text: "sem vendas para comparar" });
  if (!prev) return h("span", { class: "delta up", text: `novo em relação a ${label}` });
  const pct = Math.round(((cur - prev) / prev) * 100);
  const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  return h("span", { class: `delta ${cls}`, text: `${pct > 0 ? "▲" : pct < 0 ? "▼" : "="} ${Math.abs(pct)}% vs. ${label}` });
}

async function loadDashboard(period = state.dashPeriod || "30d", custom = state.dashCustom) {
  state.dashPeriod = period;
  state.dashCustom = custom;
  for (const c of document.querySelectorAll("#dash-periods .chip")) c.setAttribute("aria-pressed", String(c.dataset.period === period));
  $("dash-custom").hidden = period !== "custom";
  if (period === "custom" && !custom) return;
  const query = period === "custom" ? `period=custom&start=${custom.start}&end=${custom.end}` : `period=${period}`;
  const d = await api(`/api/dashboard?${query}`);
  const c = d.current;
  const label = PERIOD_LABEL[period];
  const kpi = (title, value, extra, cls = "") => h("div", { class: `kpi ${cls}` }, h("small", { text: title }), h("strong", { text: value }), extra || null);
  const profit = c.gross_profit === null
    ? kpi("Lucro bruto estimado", "—", h("span", { class: "delta flat", text: c.sales ? "informe o custo dos produtos" : "sem vendas no período" }))
    : kpi("Lucro bruto estimado", money(c.gross_profit),
      c.cost_coverage < 100 ? h("span", { class: "delta flat", text: `sobre ${c.cost_coverage}% das vendas (itens com custo)` }) : delta(c.gross_profit, d.previous.gross_profit || 0, label));
  $("kpis").replaceChildren(
    kpi("Faturamento", money(c.revenue), delta(c.revenue, d.previous.revenue, label), "highlight"),
    profit,
    kpi("Vendas", String(c.sales), delta(c.sales, d.previous.sales, label)),
    kpi("Ticket médio", money(c.average_ticket)),
    kpi("Pedidos pendentes", String(d.pending_orders)),
    kpi("Estoque baixo", String(d.stock.restock_count), h("span", { class: "delta flat", text: "itens no mínimo ou abaixo" })),
    kpi("Investido em estoque", money(d.stock.cost_value), d.stock.products_without_cost ? h("span", { class: "delta flat", text: `${d.stock.products_without_cost} produto(s) sem custo` }) : null),
    kpi("Estoque a preço de venda", money(d.stock.sale_value), d.stock.potential_profit !== null ? h("span", { class: "delta flat", text: `lucro potencial ${money(d.stock.potential_profit)}` }) : null),
  );
  const range = d.start === d.end ? formatDay(d.start) : `${formatDay(d.start)} a ${formatDay(d.end)}`;
  $("dash-note").textContent = `${range} · vendas = pedidos confirmados ou concluídos. Lucro bruto = vendas − custo dos produtos − descontos (sem despesas).`;
  const ICON = { pending: "receipt", restock: "alert", top: "star", stale: "history", cost: "edit", carts: "chat" };
  const usable = d.recommendations.filter((t) => can(t.action.view === "produtos" ? "products" : "orders"));
  if (!usable.length) return empty($("dash-tips"), "check", "Tudo em dia por aqui.");
  $("dash-tips").replaceChildren(...usable.map((t) => h("button", {
    type: "button", class: `tip ${["restock", "pending"].includes(t.kind) ? "warn" : ""}`, onclick: () => followTip(t.action),
  }, icon(ICON[t.kind] || "spark"), h("span", { text: t.text }), icon("external", "icon icon-sm"))));
}

const formatDay = (iso) => iso.split("-").reverse().join("/");

function followTip(action) {
  if (action.view === "produtos") {
    state.productIds = { label: action.label, ids: new Set(action.ids) };
    $("product-filter").value = "all";
    $("product-search").value = "";
  } else {
    state.orderStatus = action.status || "";
    for (const chip of document.querySelectorAll("#order-filters .chip")) chip.setAttribute("aria-pressed", String(chip.dataset.status === state.orderStatus));
  }
  if (location.hash === `#${action.view}`) route();
  else location.hash = action.view;
}

async function loadPerformance(days) {
  state.perfDays = days;
  for (const c of document.querySelectorAll("#perf-periods .chip")) c.setAttribute("aria-pressed", String(Number(c.dataset.days) === days));
  const r = await api(`/api/reports?days=${days}`);
  state.report = r;
  const t = r.totals;
  let delta = "Sem vendas no período anterior";
  if (r.previous.revenue > 0) {
    const pct = Math.round(((t.revenue - r.previous.revenue) / r.previous.revenue) * 100);
    delta = `${pct > 0 ? "▲" : pct < 0 ? "▼" : "="} ${Math.abs(pct)}% vs. ${days} dias anteriores`;
  }
  const item = (label, value, extra) => h("div", {}, h("small", { text: label }), h("strong", { text: value }), extra ? h("span", { class: "delta", text: extra }) : null);
  $("perf-summary").replaceChildren(
    item("Vendas no período", money(t.revenue), delta),
    item("Pedidos vendidos", String(t.sold)),
    item("Ticket médio", money(t.average_ticket)),
    item("Cancelados", String(t.cancelled), t.pending ? `${t.pending} pendente(s)` : null),
  );
  renderChart();
  $("perf-table").replaceChildren(h("table", {},
    h("thead", {}, h("tr", {}, h("th", { text: "Dia" }), h("th", { text: "Pedidos vendidos" }), h("th", { text: "Vendas" }))),
    h("tbody", {}, ...r.series.slice().reverse().map((d) => h("tr", {}, h("td", { text: longDate(d.day) }), h("td", { text: String(d.sold) }), h("td", { text: money(d.revenue) }))))));
  if (!r.top_products.length) empty($("perf-top"), "box", "Nenhuma venda no período.");
  else $("perf-top").replaceChildren(...r.top_products.map((p) => h("div", { class: "row" },
    h("div", { class: "grow" }, h("strong", { text: p.variant ? `${p.name} (${p.variant})` : p.name }), h("small", { text: `${p.quantity} unidade(s)` })),
    h("strong", { text: money(p.revenue) }))));
}

function renderChart() {
  const box = $("perf-chart");
  const r = state.report;
  if (!r || box.offsetParent === null) return;
  const series = r.series;
  const W = box.clientWidth;
  const H = box.clientHeight;
  const pad = { top: 10, right: 4, bottom: 22, left: 56 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const max = Math.max(...series.map((d) => d.revenue));
  // Escala "bonita": 3 linhas de grade em múltiplos de 1, 2 ou 5.
  const raw = Math.max(max, 100) / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((x) => x >= raw);
  const top = step * 3;
  const y = (v) => pad.top + plotH - (v / top) * plotH;
  const slot = plotW / series.length;
  const barW = Math.max(1, Math.min(24, slot - 2));
  const radius = Math.min(4, barW / 2);

  const grid = svg("g", { class: "grid" });
  const axis = svg("g", { class: "axis" });
  for (let i = 0; i <= 3; i++) {
    const v = step * i;
    grid.append(svg("line", { x1: pad.left, x2: W - pad.right, y1: y(v), y2: y(v) }));
    const label = svg("text", { x: pad.left - 8, y: y(v) + 4, "text-anchor": "end" });
    label.textContent = compactMoney(v);
    axis.append(label);
  }
  const ticks = [0, Math.floor((series.length - 1) / 2), series.length - 1];
  for (const i of [...new Set(ticks)]) {
    const t = svg("text", { x: pad.left + slot * i + slot / 2, y: H - 6, "text-anchor": i === 0 ? "start" : i === series.length - 1 ? "end" : "middle" });
    t.textContent = shortDate(series[i].day);
    axis.append(t);
  }
  const bars = svg("g");
  series.forEach((d, i) => {
    if (!d.revenue) return;
    const x = pad.left + slot * i + (slot - barW) / 2;
    const top = y(d.revenue);
    const h = Math.max(1, pad.top + plotH - top);
    const rr = Math.min(radius, h);
    // Topo arredondado, base reta na linha de base.
    const path = `M${x},${top + h} V${top + rr} Q${x},${top} ${x + rr},${top} H${x + barW - rr} Q${x + barW},${top} ${x + barW},${top + rr} V${top + h} Z`;
    bars.append(svg("path", { d: path, class: "bar", "data-i": i }));
  });
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", tabindex: "0",
    "aria-label": `Vendas por dia nos últimos ${r.days} dias. Total ${money(r.totals.revenue)}. Use as setas para percorrer os dias.` }, grid, axis, bars);
  const tip = h("div", { class: "chart-tip", hidden: true });
  box.replaceChildren(chart, tip);

  let current = -1;
  const show = (i) => {
    current = Math.max(0, Math.min(series.length - 1, i));
    const d = series[current];
    for (const b of bars.children) b.classList.toggle("on", Number(b.dataset.i) === current);
    tip.replaceChildren(h("strong", { text: money(d.revenue) }), `${longDate(d.day)} · ${d.sold} pedido(s)`);
    tip.hidden = false;
    const cx = pad.left + slot * current + slot / 2;
    const tipW = tip.offsetWidth;
    tip.style.left = `${Math.max(tipW / 2, Math.min(W - tipW / 2, cx))}px`;
    tip.style.top = `${Math.max(tip.offsetHeight + 2, y(d.revenue) - 6)}px`;
  };
  const hide = () => {
    tip.hidden = true;
    current = -1;
    for (const b of bars.children) b.classList.remove("on");
  };
  // A área de toque é a faixa inteira do dia, maior que a barra.
  const pick = (e) => {
    const rect = chart.getBoundingClientRect();
    const i = Math.floor(((e.clientX - rect.left) * (W / rect.width) - pad.left) / slot);
    if (i < 0 || i >= series.length) return hide();
    show(i);
  };
  // Mouse: acompanha o ponteiro. Toque: mostra o dia tocado.
  chart.addEventListener("pointermove", pick);
  chart.addEventListener("pointerdown", pick);
  chart.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
  chart.addEventListener("blur", hide);
  chart.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      show(current < 0 ? series.length - 1 : current + (e.key === "ArrowRight" ? 1 : -1));
    } else if (e.key === "Escape") hide();
  });
}

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderChart, 150);
});

function updatePendingBadge() {
  const pending = state.metrics?.pending ?? (state.orders || []).filter((o) => o.status === "pending").length;
  const badge = $("pending-badge");
  badge.hidden = !pending;
  badge.textContent = pending > 99 ? "99+" : String(pending);
}

// ---------- Produtos ----------

async function loadProducts() {
  if (!state.products.length) loading($("product-list"));
  state.products = await api("/api/products");
  renderProducts();
  const cats = [...new Set(state.products.map((p) => p.category).filter(Boolean))].sort();
  $("category-options").replaceChildren(...cats.map((c) => h("option", { value: c })));
  if ($("stock-history").closest("details").open) loadStockHistory();
  if ($("category-card").open) loadCategoryOrder().catch(fail);
}

function renderProducts() {
  const q = $("product-search").value.trim().toLowerCase();
  const filter = $("product-filter").value;
  const only = state.productIds;
  const list = state.products.filter((p) => {
    if (only && !only.ids.has(p.id)) return false;
    if (q && !`${p.name} ${p.sku} ${p.category} ${p.barcode || ""} ${p.supplier || ""}`.toLowerCase().includes(q)) return false;
    if (filter === "active") return p.active;
    if (filter === "inactive") return !p.active;
    if (filter === "low") return p.stock <= minStock(p) || p.variants.some((v) => v.active && v.stock <= minStock(p));
    if (filter === "featured") return p.featured;
    return true;
  });
  if (!state.products.length) {
    return empty($("product-list"), "box", "Você ainda não cadastrou produtos.",
      h("button", { class: "btn btn-primary", onclick: () => openProduct(null) }, icon("plus"), "Cadastrar primeiro produto"));
  }
  const banner = only ? h("div", { class: "filter-banner", role: "status" },
    h("span", { text: `Mostrando: ${only.label} (${list.length})` }),
    h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => { state.productIds = null; renderProducts(); } }, "Ver todos")) : null;
  if (!list.length) {
    empty($("product-list"), "search", "Nenhum produto encontrado com esse filtro.");
    if (banner) $("product-list").prepend(banner);
    return;
  }
  $("product-list").replaceChildren(...(banner ? [banner] : []), ...list.map((p) => {
    const cover = p.images[0]?.url;
    const stockBadge = p.stock === 0 ? ["badge-danger", "Esgotado"] : p.stock <= minStock(p) ? ["badge-warn", `${p.stock} em estoque`] : ["badge-ok", `${p.stock} em estoque`];
    return h("button", { class: `product-item ${p.active ? "" : "inactive"}`, type: "button", onclick: () => openProduct(p) },
      h("span", { class: "thumb", style: cover ? { backgroundImage: `url("${cover}")` } : {} }, cover ? null : icon("image")),
      h("span", { class: "info" },
        h("strong", { text: p.name }),
        h("span", {}, h("b", { text: money(p.final_price_cents) }), p.final_price_cents < p.price_cents ? h("span", { class: "price-old", text: money(p.price_cents) }) : null),
        h("span", { class: "meta" },
          h("span", { class: `badge ${stockBadge[0]}`, text: stockBadge[1] }),
          p.variants.length ? h("span", { class: "badge" }, icon("layers", "icon icon-sm"), `${p.variants.length} variações`) : null,
          p.featured ? h("span", { class: "badge badge-orange" }, icon("star", "icon icon-sm"), "Destaque") : null,
          p.active ? null : h("span", { class: "badge", text: "Oculto" }),
          p.category ? h("span", { class: "badge", text: p.category }) : null)));
  }));
}

let categoryOrder = [];
async function loadCategoryOrder() {
  const saved = (await api("/api/categories/order")).order;
  const names = [...new Set(state.products.map((p) => p.category).filter(Boolean))];
  categoryOrder = sortCategories(names, saved);
  renderCategoryOrder();
}

function renderCategoryOrder() {
  const box = $("category-order");
  if (!categoryOrder.length) return empty(box, "layers", "Cadastre categorias nos produtos para ordená-las aqui.");
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= categoryOrder.length) return;
    [categoryOrder[i], categoryOrder[j]] = [categoryOrder[j], categoryOrder[i]];
    renderCategoryOrder();
  };
  box.replaceChildren(
    h("ol", { class: "cat-order" }, ...categoryOrder.map((c, i) => h("li", {},
      h("span", { text: c }),
      h("button", { type: "button", class: "btn btn-ghost btn-icon", "aria-label": `Subir ${c}`, disabled: i === 0, onclick: () => move(i, -1) }, "↑"),
      h("button", { type: "button", class: "btn btn-ghost btn-icon", "aria-label": `Descer ${c}`, disabled: i === categoryOrder.length - 1, onclick: () => move(i, 1) }, "↓")))),
    h("button", { type: "button", class: "btn btn-blue btn-sm", onclick: (e) => busy(e.currentTarget, async () => {
      await api("/api/categories/order", { method: "PUT", body: { order: categoryOrder } });
      toast("Ordem das categorias salva.");
    }) }, "Salvar ordem"));
}

async function loadStockHistory() {
  const box = $("stock-history");
  loading(box);
  const rows = await api("/api/stock-movements");
  if (!rows.length) return empty(box, "history", "Nenhuma movimentação registrada.");
  box.replaceChildren(...rows.slice(0, 60).map((m) => h("div", { class: "row" },
    h("div", { class: "grow" }, h("strong", { text: m.product_name }), h("small", { text: formatDate(m.created_at) })),
    h("span", { class: `badge ${m.delta > 0 ? "badge-ok" : "badge-warn"}`, text: `${m.delta > 0 ? "+" : ""}${m.delta}` }),
    h("small", { text: `saldo ${m.stock_after}` }))));
}

function openProduct(product) {
  state.editing = product;
  state.pendingFiles = [];
  const form = $("product-form");
  form.reset();
  $("product-error").hidden = true;
  $("product-dialog-title").textContent = product ? "Editar produto" : "Novo produto";
  $("delete-product").hidden = !product;
  const f = form.elements;
  if (product) {
    f.name.value = product.name;
    f.description.value = product.description || "";
    f.price.value = centsToInput(product.price_cents);
    f.promo.value = centsToInput(product.promo_price_cents);
    f.stock.value = product.stock;
    f.sku.value = product.sku || "";
    f.category.value = product.category || "";
    f.featured.checked = product.featured;
    f.position.value = product.position || "";
    f.active.checked = product.active;
    f.cost.value = centsToInput(product.cost_cents);
    f.min_stock.value = product.min_stock ?? "";
    f.barcode.value = product.barcode || "";
    f.supplier.value = product.supplier || "";
    f.location.value = product.location || "";
  } else {
    f.active.checked = true;
  }
  $("product-advanced").open = !!(product && (product.cost_cents !== null || product.min_stock !== null || product.barcode || product.supplier || product.location));
  $("supplier-options").replaceChildren(...[...new Set(state.products.map((p) => p.supplier).filter(Boolean))].map((s) => h("option", { value: s })));
  updateMargin();
  $("opt1").value = "";
  $("opt2").value = "";
  setVariants(product ? product.variants : []);
  renderImages();
  resetAiBox();
  $("product-dialog").showModal();
  f.name.focus();
}

function renderImages() {
  const p = state.editing;
  const saved = p ? p.images : [];
  const figures = saved.map((img, i) => h("figure", { style: { backgroundImage: `url("${img.url}")` } },
    h("button", { type: "button", "aria-label": "Remover foto", onclick: () => removeImage(img) }, icon("x", "icon icon-sm")),
    i > 0 ? h("button", { type: "button", class: "cover-btn", "aria-label": "Usar como capa", title: "Usar como capa", onclick: () => makeCover(img) }, icon("star", "icon icon-sm")) : null));
  const pending = state.pendingFiles.map((file, i) => h("figure", { class: "uploading", style: { backgroundImage: `url("${file.preview}")` } },
    h("button", { type: "button", "aria-label": "Remover foto", onclick: () => { URL.revokeObjectURL(file.preview); state.pendingFiles.splice(i, 1); renderImages(); } }, icon("x", "icon icon-sm"))));
  $("image-grid").replaceChildren(...figures, ...pending);
  $("image-add").hidden = saved.length + state.pendingFiles.length >= 8;
}

async function makeCover(img) {
  const p = state.editing;
  const ids = [img.id, ...p.images.filter((x) => x.id !== img.id).map((x) => x.id)];
  await busy(null, async () => {
    await api(`/api/products/${p.id}/images/order`, { method: "PUT", body: { ids } });
    p.images = ids.map((id) => p.images.find((x) => x.id === id));
    renderImages();
    toast("Capa atualizada.");
    loadProducts();
  });
}

async function removeImage(img) {
  if (!confirm("Remover esta foto?")) return;
  await busy(null, async () => {
    await api(`/api/products/${state.editing.id}/images/${img.id}`, { method: "DELETE" });
    state.editing.images = state.editing.images.filter((i) => i.id !== img.id);
    renderImages();
    loadProducts();
  });
}

async function uploadImages(productId, files) {
  let failed = 0;
  for (const file of files) {
    try {
      const blob = await compressImage(file.file);
      await api(`/api/products/${productId}/images`, { method: "POST", blob });
    } catch (error) {
      failed += 1;
      toast(error.message, { error: true });
    }
  }
  return failed;
}

// ---------- IA (Workers AI) ----------

let aiAvailable = null;
async function refreshAiUsage() {
  try {
    const u = await api("/api/ai/usage");
    aiAvailable = u.available;
    $("ai-usage").textContent = `${u.used} de ${u.limit} usos hoje`;
  } catch {
    aiAvailable = false;
  }
  $("ai-box").hidden = !aiAvailable;
  $("ai-improve").hidden = !aiAvailable;
  if (can("owner")) $("ai-campaign-card").hidden = !aiAvailable;
}

function resetAiBox() {
  $("ai-text").value = "";
  aiNote("");
  for (const el of document.querySelectorAll("#product-form .ai-filled")) el.classList.remove("ai-filled");
  if (aiAvailable === null) refreshAiUsage();
  else { $("ai-box").hidden = !aiAvailable; $("ai-improve").hidden = !aiAvailable; }
}

function aiNote(text, error = false) {
  const note = $("ai-note");
  note.textContent = text;
  note.classList.toggle("error", error);
  note.hidden = !text;
}

// Preenche o formulário com a sugestão; nada é salvo até o lojista clicar em Salvar.
function applySuggestion(s) {
  const f = $("product-form").elements;
  const fill = (input, value) => {
    if (!value) return;
    input.value = value;
    input.classList.add("ai-filled");
  };
  fill(f.name, s.name);
  fill(f.description, s.description);
  fill(f.category, s.category);
  if (s.price_cents) fill(f.price, centsToInput(s.price_cents));
  if (s.variants?.length && !document.querySelector("#variant-rows .variant-row")) {
    setVariants(s.variants.map((name) => ({ name, stock: 0 })));
    for (const input of document.querySelectorAll("#variant-rows [data-k=stock]")) input.classList.add("ai-filled");
  }
  const checks = ["nome", "descrição", s.price_cents ? "preço" : null, "estoque", s.variants?.length ? "opções" : null].filter(Boolean);
  const list = checks.length > 1 ? `${checks.slice(0, -1).join(", ")} e ${checks.at(-1)}` : checks[0];
  aiNote(`Sugestão da IA aplicada. Confira ${list} antes de salvar.${s.price_cents ? "" : " Informe o preço."}`);
}

async function aiCall(button, task) {
  button.disabled = true;
  aiNote("A IA está preparando a sugestão...");
  try {
    const result = await task();
    $("ai-usage").textContent = `${result.usage.used} de ${result.usage.limit} usos hoje`;
    return result;
  } catch (error) {
    if (error.status === 401) return fail(error);
    aiNote(error.message, true);
    return null;
  } finally {
    button.disabled = false;
  }
}

async function aiFromText(event) {
  const text = $("ai-text").value.trim();
  if (text.length < 3) return aiNote("Descreva o produto em poucas palavras, por exemplo: bolo de pote de ninho, 12 reais.", true);
  const r = await aiCall(event.currentTarget, () => api("/api/ai/product-from-text", { method: "POST", body: { text } }));
  if (r) applySuggestion(r.suggestion);
}

async function aiFromPhoto(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const button = event.target.closest("label");
  const r = await aiCall(button, async () => {
    const blob = await compressImage(file, { max: 1024 });
    const hint = $("ai-text").value.trim().slice(0, 300);
    return api(`/api/ai/product-from-photo${hint ? `?hint=${encodeURIComponent(hint)}` : ""}`, { method: "POST", blob });
  });
  if (!r) return;
  applySuggestion(r.suggestion);
  // A foto analisada também entra nas fotos do produto.
  const room = 8 - (state.editing?.images.length || 0) - state.pendingFiles.length;
  if (room > 0) {
    state.pendingFiles.push({ file, preview: URL.createObjectURL(file) });
    renderImages();
  }
}

async function aiImprove(event) {
  const f = $("product-form").elements;
  if (!f.name.value.trim()) return aiNote("Preencha o nome do produto primeiro.", true);
  const r = await aiCall(event.currentTarget, () => api("/api/ai/improve-description", {
    method: "POST", body: { name: f.name.value, description: f.description.value, category: f.category.value },
  }));
  if (!r) return;
  applySuggestion({ name: r.suggestion.name, description: r.suggestion.description });
}

async function aiCampaign(event) {
  const goal = $("campaign-goal").value.trim();
  if (!goal) return toast("Conte o que você quer divulgar.", { error: true });
  await busy(event.currentTarget, async () => {
    const { suggestion: s } = await api("/api/ai/campaign", { method: "POST", body: { goal } });
    const copy = (text) => async () => {
      try { await navigator.clipboard.writeText(text); toast("Texto copiado."); } catch { toast("Não foi possível copiar.", { error: true }); }
    };
    const block = (title, text, extra) => h("div", { class: "campaign-block" },
      h("strong", { text: title }),
      h("textarea", { readonly: true, "aria-label": title }, text),
      h("div", { class: "row-actions" }, h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: copy(text) }, icon("copy", "icon icon-sm"), "Copiar"), extra || null));
    $("campaign-out").replaceChildren(
      h("p", { class: "ai-note", text: "Gerado por IA. Revise preços e informações antes de publicar." }),
      block("Mensagem para WhatsApp", s.whatsapp_message,
        h("a", { class: "btn btn-ghost btn-sm", href: `https://wa.me/?text=${encodeURIComponent(s.whatsapp_message)}`, target: "_blank", rel: "noopener" }, icon("chat", "icon icon-sm"), "Enviar")),
      block("Legenda para Instagram", s.instagram_caption),
      s.ideas.length ? h("div", { class: "campaign-block" }, h("strong", { text: "Ideias de divulgação" }), h("ul", {}, ...s.ideas.map((i) => h("li", { text: i })))) : null);
    refreshAiUsage();
  });
}

// ---------- Variações ----------

function variantRow(v = {}) {
  const input = (k, attrs) => h("input", { "data-k": k, ...attrs });
  const row = h("div", { class: `variant-row ${v.active === false ? "inactive" : ""}`, dataset: { id: v.id || "", active: v.active === false ? "0" : "1" } },
    input("name", { value: v.name || "", maxlength: "60", placeholder: "Ex.: M / Azul", "aria-label": "Nome da variação" }),
    input("sku", { value: v.sku || "", maxlength: "60", placeholder: "SKU", "aria-label": "SKU da variação" }),
    input("price", { value: centsToInput(v.price_cents ?? null), inputmode: "decimal", placeholder: "Padrão", "aria-label": "Preço da variação" }),
    input("stock", { value: v.stock ?? 0, type: "number", min: "0", step: "1", inputmode: "numeric", "aria-label": "Estoque da variação" }),
    h("button", { type: "button", class: "btn btn-ghost btn-icon", "aria-label": "Remover variação", onclick: () => { row.remove(); updateStockField(); } }, icon("trash", "icon icon-sm")));
  row.addEventListener("input", updateStockField);
  return row;
}

function setVariants(list) {
  $("variant-rows").replaceChildren(...list.map(variantRow));
  $("has-variants").checked = list.length > 0;
  $("variant-editor").hidden = !list.length;
  updateStockField();
}

function updateStockField() {
  const stock = $("product-form").elements.stock;
  const on = $("has-variants").checked;
  stock.disabled = on;
  if (on) {
    const total = [...document.querySelectorAll("#variant-rows .variant-row")]
      .filter((r) => r.dataset.active !== "0")
      .reduce((sum, r) => sum + (Number(r.querySelector("[data-k=stock]").value) || 0), 0);
    stock.value = String(total);
  }
}

function generateVariants() {
  const split = (text) => text.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  const a = split($("opt1").value);
  const b = split($("opt2").value);
  if (!a.length) return toast("Informe as opções separadas por vírgula, por exemplo: P, M, G.", { error: true });
  const names = b.length ? a.flatMap((x) => b.map((y) => `${x} / ${y}`)) : a;
  const existing = new Set([...document.querySelectorAll("#variant-rows [data-k=name]")].map((i) => i.value.trim().toLowerCase()));
  for (const name of names.slice(0, 60)) if (!existing.has(name.toLowerCase())) $("variant-rows").append(variantRow({ name, stock: 0 }));
  updateStockField();
}

function readVariants() {
  if (!$("has-variants").checked) return { variants: [] };
  const rows = [...document.querySelectorAll("#variant-rows .variant-row")];
  if (!rows.length) return { error: "Adicione ao menos uma variação ou desmarque a opção de variações." };
  const variants = [];
  for (const row of rows) {
    const get = (k) => row.querySelector(`[data-k=${k}]`).value.trim();
    const name = get("name");
    if (!name) return { error: "Dê um nome a cada variação (ex.: P / Azul)." };
    const price = parseMoney(get("price"));
    if (Number.isNaN(price)) return { error: `Preço inválido na variação ${name}.` };
    const stock = Number(get("stock"));
    if (!Number.isInteger(stock) || stock < 0) return { error: `Estoque inválido na variação ${name}.` };
    variants.push({ id: row.dataset.id || undefined, name, sku: get("sku"), price_cents: price, stock, active: row.dataset.active !== "0" });
  }
  return { variants };
}

function readProductForm() {
  const f = $("product-form").elements;
  const price = parseMoney(f.price.value);
  const promo = parseMoney(f.promo.value);
  const stock = Number(f.stock.value);
  if (!f.name.value.trim()) return "Informe o nome do produto.";
  if (price === null || Number.isNaN(price)) return "Informe um preço válido, por exemplo 59,90.";
  if (Number.isNaN(promo)) return "Preço promocional inválido.";
  if (promo !== null && promo >= price) return "O preço promocional deve ser menor que o preço normal.";
  const cost = parseMoney(f.cost.value);
  if (Number.isNaN(cost)) return "Preço de custo inválido, por exemplo 25,00.";
  const minStockValue = f.min_stock.value === "" ? null : Number(f.min_stock.value);
  if (minStockValue !== null && (!Number.isInteger(minStockValue) || minStockValue < 0)) return "O alerta de reposição deve ser um número inteiro, zero ou maior.";
  const v = readVariants();
  if (v.error) return v.error;
  if (!v.variants.length && (f.stock.value === "" || !Number.isInteger(stock) || stock < 0)) return "Informe o estoque (número inteiro, zero ou maior).";
  return {
    name: f.name.value, description: f.description.value, price_cents: price, promo_price_cents: promo,
    stock: v.variants.length ? 0 : stock, sku: f.sku.value, category: f.category.value, featured: f.featured.checked, active: f.active.checked,
    position: f.position.value ? Number(f.position.value) : 0,
    variants: v.variants,
    cost_cents: cost, min_stock: minStockValue, barcode: f.barcode.value.trim(), supplier: f.supplier.value, location: f.location.value,
  };
}

// Margem (lucro sobre o preço de venda) e markup (lucro sobre o custo).
function updateMargin() {
  const f = $("product-form").elements;
  const price = parseMoney(f.promo.value) || parseMoney(f.price.value);
  const cost = parseMoney(f.cost.value);
  const box = $("margin-info");
  if (!price || cost === null || Number.isNaN(cost) || Number.isNaN(price)) {
    box.textContent = "Informe o preço de custo para ver o lucro por unidade, a margem e o markup.";
    return;
  }
  const profit = price - cost;
  const margin = Math.round((profit / price) * 1000) / 10;
  const markup = cost ? Math.round((profit / cost) * 1000) / 10 : null;
  box.replaceChildren(
    "Lucro por unidade: ", h("strong", { text: money(profit) }),
    ` · margem ${String(margin).replace(".", ",")}%`,
    markup === null ? "" : ` · markup ${String(markup).replace(".", ",")}%`,
    profit < 0 ? h("span", { class: "form-error", text: " (vendendo abaixo do custo)" }) : "");
}

async function saveProduct(event) {
  event.preventDefault();
  const data = readProductForm();
  const err = $("product-error");
  if (typeof data === "string") {
    err.textContent = data;
    err.hidden = false;
    return;
  }
  const button = $("save-product");
  button.disabled = true;
  button.textContent = "Salvando...";
  try {
    let id = state.editing?.id;
    if (id) await api(`/api/products/${id}`, { method: "PATCH", body: data });
    else {
      id = (await api("/api/products", { method: "POST", body: data })).id;
      state.productIds = null;
    }
    if (state.pendingFiles.length) {
      button.textContent = "Enviando fotos...";
      const failed = await uploadImages(id, state.pendingFiles);
      state.pendingFiles.forEach((f) => URL.revokeObjectURL(f.preview));
      state.pendingFiles = [];
      if (failed) toast(`Produto salvo, mas ${failed} foto(s) não foram enviadas.`, { error: true });
    }
    $("product-dialog").close();
    toast("Produto salvo.");
    await loadProducts();
  } catch (error) {
    if (error.status === 401) return fail(error);
    err.textContent = error.message;
    err.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Salvar produto";
  }
}

async function deleteProduct() {
  const p = state.editing;
  if (!p || !confirm(`Excluir "${p.name}"? As fotos também serão apagadas. Pedidos antigos continuam registrados.`)) return;
  await busy($("delete-product"), async () => {
    await api(`/api/products/${p.id}`, { method: "DELETE" });
    $("product-dialog").close();
    toast("Produto excluído.");
    await loadProducts();
  });
}

// ---------- Pedidos ----------

async function loadOrders() {
  loading($("order-list"));
  if (state.orderStatus === "abandoned") return loadAbandoned();
  const query = state.orderStatus ? `?status=${state.orderStatus}` : "";
  state.orders = await api(`/api/orders${query}`);
  renderOrders();
  if (!state.orderStatus) {
    state.metrics = { pending: state.orders.filter((o) => o.status === "pending").length };
    updatePendingBadge();
  }
}

function renderOrders() {
  if (!state.orders.length) return empty($("order-list"), "receipt", state.orderStatus ? "Nenhum pedido com este status." : "Nenhum pedido ainda.");
  const store = state.me.store;
  $("order-list").replaceChildren(...state.orders.map((o) => {
    const st = STATUS[o.status];
    const actions = [];
    const change = (status, label, cls) => h("button", { class: `btn btn-sm ${cls}`, onclick: (e) => setOrderStatus(o, status, e.currentTarget) }, label);
    if (o.status === "pending") actions.push(change("confirmed", "Confirmar e baixar estoque", "btn-blue"), change("cancelled", "Cancelar", "btn-danger"));
    if (o.status === "confirmed") actions.push(change("completed", "Marcar como concluído", "btn-blue"), change("cancelled", "Cancelar e repor estoque", "btn-danger"));
    actions.push(h("button", { class: "btn btn-sm btn-ghost", "aria-label": `Imprimir pedido ${o.code}`, onclick: (e) => printOrder(e.currentTarget.closest(".order")) }, icon("print", "icon icon-sm"), "Imprimir"));
    if (o.customer_phone) {
      const msg = `Olá, ${o.customer_name.split(" ")[0]}! Aqui é da ${store.name}. Sobre o seu pedido #${o.code} (${money(o.total_cents)}): `;
      actions.push(h("a", { class: "btn btn-sm btn-ghost", href: whatsappLink(o.customer_phone, msg), target: "_blank", rel: "noopener" }, icon("chat", "icon icon-sm"), "WhatsApp"));
    }
    return h("article", { class: "order" },
      h("div", { class: "order-top" },
        h("div", {}, h("strong", { text: o.customer_name || "Cliente não identificado" }),
          h("div", { class: "muted", text: `#${o.code} · ${formatDate(o.created_at)}${o.customer_phone ? " · " + formatPhone(o.customer_phone) : ""}` })),
        h("span", { class: `badge ${st.badge}`, text: st.label })),
      h("div", { class: "order-items" },
        ...o.items.map((i) => h("div", {}, h("span", { text: `${i.quantity}× ${i.name}${i.variant_name ? ` (${i.variant_name})` : ""}` }), h("span", { text: money(i.price_cents * i.quantity) }))),
        o.discount_cents ? h("div", { class: "order-discount" }, h("span", { text: `Cupom ${o.coupon_code}` }), h("span", { text: `− ${money(o.discount_cents)}` })) : null,
        h("div", { style: { fontWeight: "700", marginTop: "6px" } }, h("span", { text: "Total" }), h("span", { text: money(o.total_cents) }))),
      o.fulfillment ? h("p", { class: "order-ship" },
        h("strong", { text: o.fulfillment === "pickup" ? "Retirada na loja" : `Entrega${o.delivery_fee_cents ? ` (taxa ${money(o.delivery_fee_cents)})` : " (grátis)"}` }),
        o.fulfillment === "delivery" ? o.address : null) : null,
      o.notes ? h("p", { class: "order-notes", text: `Observações: ${o.notes}` }) : null,
      h("div", { class: "order-actions" }, ...actions));
  }));
}

// Carrinhos que o comprador autorizou a loja a retomar pelo WhatsApp.
async function loadAbandoned() {
  const data = await api("/api/abandoned-carts");
  const store = state.me.store;
  const note = h("p", { class: "muted abandoned-note", text:
    `Aparecem aqui só os compradores que autorizaram o contato e não finalizaram o pedido há mais de 30 minutos. ` +
    `Os dados são apagados em ${data.retention_days} dias. Recuperados após contato: ${data.recovered}.` });
  if (!data.carts.length) {
    empty($("order-list"), "receipt", "Nenhum carrinho abandonado no momento.");
    return $("order-list").prepend(note);
  }
  const update = (c, status, button) => busy(button, async () => {
    await api(`/api/abandoned-carts/${c.id}`, { method: "PATCH", body: { status } });
    if (status === "dismissed") toast("Carrinho descartado e dados apagados.");
    await loadAbandoned();
  });
  $("order-list").replaceChildren(note, ...data.carts.map((c) => {
    const first = c.customer_name.split(" ")[0];
    const list = c.items.map((i) => `${i.quantity}x ${i.name}${i.variant_name ? ` (${i.variant_name})` : ""}`).join(", ");
    const msg = `Olá, ${first}! Aqui é da ${store.name}. Vi que você separou ${list} (${money(c.total_cents)}) e não finalizou. Posso ajudar com alguma dúvida?`;
    return h("article", { class: "order abandoned" },
      h("div", { class: "order-top" },
        h("div", {}, h("strong", { text: c.customer_name }),
          h("div", { class: "muted", text: `${formatPhone(c.customer_phone)} · atualizado ${formatDate(c.updated_at)}` })),
        h("span", { class: `badge ${c.status === "contacted" ? "badge-ok" : "badge-warn"}`, text: c.status === "contacted" ? "Contatado" : "Não finalizado" })),
      h("div", { class: "order-items" },
        ...c.items.map((i) => h("div", {}, h("span", { text: `${i.quantity}× ${i.name}${i.variant_name ? ` (${i.variant_name})` : ""}` }), h("span", { text: money(i.price_cents * i.quantity) }))),
        h("div", { style: { fontWeight: "700", marginTop: "6px" } }, h("span", { text: "Total" }), h("span", { text: money(c.total_cents) }))),
      h("div", { class: "order-actions" },
        h("a", { class: "btn btn-sm btn-blue", href: whatsappLink(c.customer_phone, msg), target: "_blank", rel: "noopener",
          onclick: () => { if (c.status !== "contacted") api(`/api/abandoned-carts/${c.id}`, { method: "PATCH", body: { status: "contacted" } }).then(loadAbandoned).catch(fail); } },
          icon("chat", "icon icon-sm"), "Chamar no WhatsApp"),
        h("button", { class: "btn btn-sm btn-ghost", onclick: (e) => update(c, "dismissed", e.currentTarget) }, "Descartar")));
  }));
}

// Imprime só o pedido escolhido (folha A4 ou impressora térmica).
function printOrder(card) {
  const header = h("div", { class: "print-only" }, h("h2", { text: state.me.store.name }), h("p", { text: `Impresso em ${new Date().toLocaleString("pt-BR")}` }));
  card.prepend(header);
  card.classList.add("print-target");
  card.closest(".view").classList.add("print-view");
  document.body.classList.add("printing");
  const done = () => {
    header.remove();
    card.classList.remove("print-target");
    card.closest(".view")?.classList.remove("print-view");
    document.body.classList.remove("printing");
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  window.print();
  setTimeout(done, 1000);
}

async function setOrderStatus(order, status, button) {
  const confirmText = {
    cancelled: order.status === "confirmed" ? "Cancelar o pedido e devolver os itens ao estoque?" : "Cancelar este pedido?",
    confirmed: "Confirmar o pedido? Os itens serão baixados do estoque.",
  }[status];
  if (confirmText && !confirm(confirmText)) return;
  await busy(button, async () => {
    await api(`/api/orders/${order.id}`, { method: "PATCH", body: { status } });
    toast(`Pedido #${order.code}: ${STATUS[status].label.toLowerCase()}.`);
    await loadOrders();
    state.products = [];
  });
}

async function exportOrders(button) {
  await busy(button, async () => {
    const orders = await api("/api/orders");
    downloadCsv(`pedidos-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Pedido", "Data", "Status", "Cliente", "Telefone", "Itens", "Cupom", "Desconto (R$)", "Total (R$)", "Observações"],
      orders.map((o) => [o.code, o.created_at, STATUS[o.status].label, o.customer_name, o.customer_phone,
        o.items.map((i) => `${i.quantity}x ${i.name}${i.variant_name ? ` (${i.variant_name})` : ""}`).join(", "), o.coupon_code || "", (o.discount_cents / 100).toFixed(2).replace(".", ","), (o.total_cents / 100).toFixed(2).replace(".", ","), o.notes || ""]));
  });
}

// ---------- Clientes ----------

let customers = [];
async function loadCustomers() {
  loading($("customer-list"));
  customers = await api("/api/customers");
  const box = $("customer-list");
  if (!customers.length) return empty(box, "users", "Seus clientes aparecerão aqui após o primeiro pedido.");
  box.replaceChildren(h("div", { class: "card" }, ...customers.map((c) => h("div", { class: "row" },
    h("div", { class: "grow" }, h("strong", { text: c.name }), h("small", { text: `${formatPhone(c.phone)} · último pedido ${formatDate(c.last_order)}` })),
    h("div", { style: { textAlign: "right" } }, h("strong", { text: money(c.spent) }), h("small", { class: "muted", style: { display: "block" }, text: `${c.orders} pedido(s)` })),
    h("a", { class: "btn btn-ghost btn-icon", href: whatsappLink(c.phone, `Olá, ${c.name.split(" ")[0]}! `), target: "_blank", rel: "noopener", "aria-label": `WhatsApp de ${c.name}` }, icon("chat")),
    h("button", { class: "btn btn-ghost btn-icon", "aria-label": `Excluir dados de ${c.name}`, title: "Excluir dados (LGPD)", onclick: (e) => forgetCustomer(c, e.currentTarget) }, icon("trash"))))));
}

async function forgetCustomer(customer, button) {
  if (!confirm(`Excluir os dados de ${customer.name}? Nome, telefone e observações serão apagados de ${customer.orders} pedido(s). Os valores continuam nos relatórios. Esta ação não pode ser desfeita.`)) return;
  await busy(button, async () => {
    await api(`/api/customers/${customer.phone}`, { method: "DELETE" });
    toast("Dados do cliente excluídos.");
    await loadCustomers();
  });
}

// ---------- Loja ----------

async function loadStore() {
  state.me = await api("/api/me");
  renderStoreHeader();
  const s = state.me.store;
  const f = $("settings").elements;
  f.name.value = s.name;
  f.description.value = s.description || "";
  f.whatsapp.value = s.whatsapp || "";
  f.accent.value = s.accent || "#2563eb";
  f.pickup_enabled.checked = s.pickup_enabled;
  f.delivery_on.checked = s.delivery_fee_cents !== null;
  f.delivery_fee.value = s.delivery_fee_cents === null ? "" : centsToInput(s.delivery_fee_cents);
  f.free_above.value = centsToInput(s.free_delivery_above_cents);
  $("delivery-fields").hidden = !f.delivery_on.checked;
  const url = `${location.origin}/loja/${s.slug}`;
  $("share-url").value = url;
  $("catalog-pdf").href = `/loja/${s.slug}/catalogo`;
  $("share-whatsapp").href = `https://wa.me/?text=${encodeURIComponent(`Confira o catálogo da ${s.name}: ${url}`)}`;
  for (const kind of ["logo", "banner"]) {
    const preview = $(`${kind}-preview`);
    preview.style.backgroundImage = s[`${kind}_url`] ? `url("${s[`${kind}_url`]}")` : "";
    document.querySelector(`[data-remove-asset=${kind}]`).hidden = !s[`${kind}_url`];
  }
  await Promise.all([loadTeam(), loadCoupons(), refreshAiUsage(), loadPlan()]);
}

// ---------- Plano e assinatura ----------

const SUB_STATUS = {
  pending: ["Aguardando pagamento", "badge-warn"], trialing: ["Em período de teste", "badge"], active: ["Ativa", "badge-ok"],
  past_due: ["Pagamento atrasado", "badge-danger"], canceled: ["Cancelada", "badge"],
};

function limitsText(p) {
  const lim = (value, unit) => (value === null || value === undefined ? `${unit} ilimitados` : `até ${value} ${unit}`);
  return [lim(p.max_products, "produtos"), lim(p.max_team, "pessoas na equipe"), p.ai_daily === 0 ? "sem IA" : p.ai_daily ? `${p.ai_daily} usos de IA por dia` : "IA no limite padrão"];
}

async function loadPlan() {
  const box = $("plan-box");
  const b = await api("/api/billing");
  const sub = b.subscription;
  const st = sub ? SUB_STATUS[sub.status] : null;
  const until = sub?.current_period_end ? formatDate(sub.current_period_end).split(",")[0] : "";
  const checkout = (path, plan, button) => busy(button, async () => {
    const r = await api(path, { method: "POST", body: { plan_id: plan.id } });
    location.href = r.checkout_url;
  });
  box.replaceChildren(
    h("div", { class: "plan-current" },
      h("div", {}, h("small", { class: "muted", text: "Plano atual" }), h("div", {}, h("strong", { text: b.plan.name }))),
      st && b.plan.price_cents > 0 ? h("span", { class: `badge ${st[1]}`, text: st[0] }) : null),
    h("p", { class: "plan-usage", text: [
      `${b.usage.products} produto(s) · ${b.usage.team} pessoa(s) na equipe`,
      until && b.plan.price_cents > 0 ? (sub.status === "canceled" ? `acesso até ${until}` : `próxima renovação ${until}`) : null,
    ].filter(Boolean).join(" · ") }),
    !b.enabled ? h("p", { class: "ai-note", text: "Os pagamentos ainda não foram ativados. Durante o beta, a sua loja usa o plano gratuito." }) : null,
    sub?.status === "past_due" ? h("p", { class: "form-error", text: "Não conseguimos cobrar a assinatura. Atualize o pagamento para não perder os recursos do plano." }) : null,
    h("div", { class: "plan-list" }, ...b.plans.filter((p) => p.price_cents > 0 || p.id === b.plan.id).map((p) => {
      const current = p.id === b.plan.id;
      return h("div", { class: `plan-option ${current ? "current" : ""}` },
        h("strong", { text: p.name }),
        h("div", { class: "price" }, p.price_cents ? money(p.price_cents) : "Grátis", p.price_cents ? h("small", { text: " /mês" }) : null),
        p.description ? h("p", { class: "muted", text: p.description }) : null,
        h("ul", {}, ...limitsText(p).map((t) => h("li", { text: t })), p.trial_days ? h("li", { text: `${p.trial_days} dias grátis para testar` }) : null),
        p.price_cents > 0 && b.enabled ? h("div", { class: "row-actions" },
          h("button", { class: "btn btn-blue btn-sm", onclick: (e) => checkout("/api/billing/subscribe", p, e.currentTarget) }, current && sub?.recurring ? "Assinatura ativa" : "Assinar no cartão (mensal)"),
          h("button", { class: "btn btn-ghost btn-sm", onclick: (e) => checkout("/api/billing/pay-month", p, e.currentTarget) }, "Pagar 1 mês (Pix ou cartão)")) : null);
    })),
    sub?.recurring && sub.status !== "canceled" ? h("button", { class: "btn btn-danger btn-sm", style: { marginTop: "12px" }, onclick: (e) => busy(e.currentTarget, async () => {
      if (!confirm("Cancelar a renovação automática? Você continua com o plano até o fim do período já pago.")) return;
      await api("/api/billing/cancel", { method: "POST", body: {} });
      toast("Renovação cancelada.");
      await loadPlan();
    }) }, "Cancelar renovação") : null,
    b.payments.length ? h("details", { class: "plan-history" }, h("summary", { text: "Pagamentos" }),
      ...b.payments.map((p) => h("div", { class: "row" }, h("div", { class: "grow" }, h("strong", { text: money(p.amount_cents) }), h("small", { text: `${p.method || "Mercado Pago"} · ${formatDate(p.created_at)}` })), h("span", { class: `badge ${p.status === "approved" ? "badge-ok" : "badge-warn"}`, text: p.status === "approved" ? "Aprovado" : p.status })))) : null);
}

// ---------- Cupons ----------

function couponLabel(c) {
  const value = c.kind === "percent" ? `${c.value}% de desconto` : `${money(c.value)} de desconto`;
  const rules = [
    c.min_order_cents ? `pedido mínimo ${money(c.min_order_cents)}` : null,
    c.max_uses ? `${c.uses}/${c.max_uses} usos` : `${c.uses} uso(s)`,
    c.expires_at ? `até ${c.expires_at.split("-").reverse().join("/")}` : null,
  ].filter(Boolean).join(" · ");
  return { value, rules };
}

async function loadCoupons() {
  const list = await api("/api/coupons");
  const box = $("coupon-list");
  if (!list.length) return empty(box, "ticket", "Nenhum cupom criado.");
  box.replaceChildren(...list.map((c) => {
    const { value, rules } = couponLabel(c);
    const toggle = h("input", { type: "checkbox", "aria-label": `Cupom ${c.code} ativo` });
    toggle.checked = c.active;
    toggle.addEventListener("change", () => busy(null, async () => {
      await api(`/api/coupons/${c.id}`, { method: "PATCH", body: { ...c, active: toggle.checked } });
      toast(toggle.checked ? `Cupom ${c.code} ativado.` : `Cupom ${c.code} pausado.`);
      await loadCoupons();
    }));
    return h("div", { class: `coupon ${c.active ? "" : "off"}` },
      h("div", { class: "grow" }, h("code", { text: c.code }), " ", h("strong", { text: value }), h("small", { text: rules })),
      h("label", { class: "check", title: "Ativo" }, toggle, h("span", { class: "sr-only", text: "Ativo" })),
      h("button", { class: "btn btn-ghost btn-icon", "aria-label": `Excluir cupom ${c.code}`, onclick: (e) => busy(e.currentTarget, async () => {
        if (!confirm(`Excluir o cupom ${c.code}? Pedidos que já o usaram não mudam.`)) return;
        await api(`/api/coupons/${c.id}`, { method: "DELETE" });
        await loadCoupons();
      }) }, icon("trash", "icon icon-sm")));
  }));
}

async function createCoupon(event) {
  event.preventDefault();
  const f = event.target.elements;
  const kind = f.kind.value;
  const value = kind === "percent" ? Number(String(f.value.value).replace(",", ".")) : parseMoney(f.value.value);
  if (kind === "percent" && (!Number.isInteger(value) || value < 1 || value > 90)) return toast("Use uma porcentagem inteira entre 1 e 90.", { error: true });
  if (kind === "fixed" && (!value || Number.isNaN(value))) return toast("Informe o valor do desconto, por exemplo 15,00.", { error: true });
  const min = parseMoney(f.min_order.value);
  if (Number.isNaN(min)) return toast("Pedido mínimo inválido.", { error: true });
  await busy(event.submitter, async () => {
    await api("/api/coupons", { method: "POST", body: {
      code: f.code.value, kind, value, min_order_cents: min || 0,
      max_uses: f.max_uses.value ? Number(f.max_uses.value) : null, expires_at: f.expires_at.value || null,
    } });
    event.target.reset();
    $("coupon-add").open = false;
    toast("Cupom criado. Divulgue o código para seus clientes.");
    await loadCoupons();
  });
}

// ---------- Equipe ----------

const PERM_LABELS = { products: "Produtos", orders: "Pedidos", customers: "Clientes", reports: "Indicadores" };

async function loadTeam() {
  const box = $("team-list");
  const team = await api("/api/team");
  box.replaceChildren(...team.map((m) => {
    const toggles = m.role === "owner"
      ? h("small", { class: "muted", text: "Proprietário: acesso total" })
      : h("div", { class: "perm-toggles" }, ...Object.entries(PERM_LABELS).map(([key, label]) => {
        const input = h("input", { type: "checkbox", value: key });
        input.checked = m.permissions.includes(key);
        input.addEventListener("change", async () => {
          const permissions = [...input.closest(".perm-toggles").querySelectorAll("input:checked")].map((i) => i.value);
          try {
            await api(`/api/team/${m.id}`, { method: "PATCH", body: { permissions } });
            toast(`Acesso de ${m.name || m.email} atualizado.`);
          } catch (error) {
            input.checked = !input.checked;
            fail(error);
          }
        });
        return h("label", { class: "check" }, input, h("span", { text: label }));
      }));
    return h("div", { class: "team-member" },
      h("div", { class: "top" },
        h("div", {}, h("strong", { text: `${m.name || m.email}${m.is_me ? " (você)" : ""}` }), h("small", { class: "muted", text: m.email })),
        m.pending_password ? h("span", { class: "badge badge-warn", text: "Aguardando 1º acesso" }) : null,
        m.role === "owner" ? null : h("button", { class: "btn btn-danger btn-sm", onclick: (e) => removeMember(m, e.currentTarget) }, "Remover")),
      toggles);
  }));
}

async function removeMember(member, button) {
  if (!confirm(`Remover ${member.name || member.email} da equipe? O acesso ao painel será encerrado imediatamente.`)) return;
  await busy(button, async () => {
    await api(`/api/team/${member.id}`, { method: "DELETE" });
    toast("Pessoa removida da equipe.");
    await loadTeam();
  });
}

async function addMember(event) {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  const permissions = [...form.querySelectorAll("input[name=perm]:checked")].map((i) => i.value);
  if ((data.password || "").length < 12) return toast("A senha provisória precisa ter pelo menos 12 caracteres.", { error: true });
  await busy(event.submitter, async () => {
    await api("/api/team", { method: "POST", body: { name: data.name, email: data.email, password: data.password, permissions } });
    form.reset();
    form.closest("details").open = false;
    toast("Pessoa adicionada. Entregue o e-mail e a senha provisória a ela.");
    await loadTeam();
  });
}

// ---------- Senha ----------

function openPassword(forced = false) {
  const dialog = $("password-dialog");
  $("password-form").reset();
  $("password-error").hidden = true;
  $("password-intro").hidden = !forced;
  $("password-close").hidden = forced;
  $("tfa-section").hidden = forced;
  if (!forced) mountTwoFactor($("tfa-box"));
  $("password-title").textContent = forced ? "Crie sua senha" : "Senha e segurança";
  dialog.dataset.forced = forced ? "1" : "";
  dialog.showModal();
}

async function savePassword(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const err = $("password-error");
  const show = (text) => { err.textContent = text; err.hidden = false; };
  if (data.new_password.length < 12) return show("A nova senha precisa ter pelo menos 12 caracteres.");
  if (data.new_password !== data.confirm) return show("As senhas não conferem.");
  const button = event.submitter;
  button.disabled = true;
  try {
    await api("/api/account/password", { method: "POST", body: { current_password: data.current_password, new_password: data.new_password } });
    $("password-dialog").close();
    toast("Senha alterada. Outras sessões abertas foram encerradas.");
    if (state.me.user.must_change_password) {
      state.me.user.must_change_password = false;
      route();
      startNotifications();
    }
  } catch (error) {
    if (error.status === 401) return fail(error);
    show(error.message);
  } finally {
    button.disabled = false;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const button = event.submitter;
  await busy(button, async () => {
    const f = event.target.elements;
    const fee = f.delivery_on.checked ? parseMoney(f.delivery_fee.value) ?? 0 : null;
    const free = f.delivery_on.checked ? parseMoney(f.free_above.value) : null;
    if (Number.isNaN(fee) || Number.isNaN(free)) throw new Error("Valor de entrega inválido. Use, por exemplo, 8,00.");
    await api("/api/settings", { method: "PATCH", body: {
      name: f.name.value, description: f.description.value, whatsapp: f.whatsapp.value, accent: f.accent.value,
      pickup_enabled: f.pickup_enabled.checked, delivery_fee_cents: fee, free_delivery_above_cents: free,
    } });
    toast("Configurações salvas.");
    await loadStore();
  });
}

async function uploadAsset(input) {
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  const kind = input.dataset.asset;
  await busy(null, async () => {
    toast("Enviando imagem...");
    const blob = await compressImage(file, { max: kind === "logo" ? 600 : 1800 });
    await api(`/api/settings/${kind}`, { method: "POST", blob });
    toast("Imagem atualizada.");
    await loadStore();
  });
}

async function loadAudit() {
  const box = $("audit-list");
  loading(box);
  const rows = await api("/api/audit-log");
  const labels = {
    "store.created": "Loja criada", "store.settings": "Configurações alteradas", "product.created": "Produto cadastrado",
    "product.updated": "Produto alterado", "product.deleted": "Produto excluído", "order.status": "Status de pedido alterado",
    "coupon.created": "Cupom criado", "coupon.updated": "Cupom alterado", "coupon.deleted": "Cupom excluído",
    "team.added": "Pessoa adicionada à equipe", "team.permissions": "Permissões alteradas", "team.removed": "Pessoa removida da equipe",
    "customer.anonymized": "Dados de cliente excluídos", "store.exported": "Dados exportados", "user.password_changed": "Senha alterada",
  };
  if (!rows.length) return empty(box, "history", "Nenhuma atividade registrada.");
  box.replaceChildren(...rows.slice(0, 50).map((r) => h("div", { class: "row" },
    h("div", { class: "grow" }, h("strong", { text: labels[r.action] || r.action }), h("small", { text: [r.detail, r.email].filter(Boolean).join(" · ") })),
    h("small", { text: formatDate(r.created_at) }))));
}

// ---------- Eventos ----------

$("tab-login").addEventListener("click", () => selectTab("login"));
$("tab-register").addEventListener("click", () => selectTab("register"));
$("login").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const err = $("auth-error");
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const result = await api("/api/login", { method: "POST", body: Object.fromEntries(new FormData(form)) });
    if (result.two_factor_required) {
      loginChallenge = result.challenge;
      form.hidden = true;
      $("login-2fa").hidden = false;
      err.hidden = true;
      $("login-2fa").elements.code.focus();
      return;
    }
    form.reset();
    await start();
  } catch (error) {
    err.textContent = error.message;
    err.hidden = false;
  } finally {
    button.disabled = false;
  }
});
$("login-2fa").addEventListener("submit", async (event) => {
  event.preventDefault();
  const err = $("auth-error");
  const button = event.target.querySelector("button");
  button.disabled = true;
  try {
    await api("/api/login/2fa", { method: "POST", body: { challenge: loginChallenge, code: event.target.elements.code.value } });
    event.target.reset();
    $("login").reset();
    $("login-2fa").hidden = true;
    $("login").hidden = false;
    await start();
  } catch (error) {
    err.textContent = error.message;
    err.hidden = false;
    if (error.status === 401) $("login-2fa-back").click();
  } finally {
    button.disabled = false;
  }
});
$("login-2fa-back").addEventListener("click", () => {
  loginChallenge = "";
  $("login-2fa").reset();
  $("login-2fa").hidden = true;
  $("login").hidden = false;
});
authForm($("register"), "/api/register", (data) => {
  data.slug = String(data.slug || "").trim().toLowerCase();
  if (!data.terms) return "Para criar a loja, aceite o tratamento dos dados.";
  if ((data.password || "").length < 12) return "A senha precisa ter pelo menos 12 caracteres.";
  delete data.terms;
  return null;
});
$("register").elements.name.addEventListener("input", (e) => {
  const slugInput = $("register").elements.slug;
  if (slugInput.dataset.touched) return;
  slugInput.value = e.target.value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
});
$("register").elements.slug.addEventListener("input", (e) => (e.target.dataset.touched = "1"));

$("enable-alerts").addEventListener("click", async () => {
  try {
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      try { localStorage.setItem(ALERTS_KEY, "1"); } catch { /* preferência só nesta sessão */ }
      toast("Alertas ativados. Você será avisado de novos pedidos enquanto o painel estiver aberto.");
    } else {
      toast("O navegador bloqueou os alertas. Você pode liberá-los nas configurações do site.", { error: true });
    }
  } catch {
    toast("Este navegador não permite alertas.", { error: true });
  }
  renderAlertsButton();
});
$("logout").addEventListener("click", async () => {
  stopNotifications();
  try {
    await api("/api/logout", { method: "POST", body: {} });
  } catch { /* sessão já encerrada */ }
  location.hash = "";
  showAuth();
});
window.addEventListener("hashchange", () => { if (!$("app").hidden) route(); });

$("new-product").addEventListener("click", () => openProduct(null));
$("product-search").addEventListener("input", renderProducts);
for (const name of ["price", "promo", "cost"]) $("product-form").elements[name].addEventListener("input", updateMargin);
$("dash-periods").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  loadDashboard(chip.dataset.period, chip.dataset.period === "custom" ? state.dashCustom : null).catch(fail);
});
$("dash-custom").addEventListener("submit", (e) => {
  e.preventDefault();
  const { start, end } = Object.fromEntries(new FormData(e.target));
  if (!start || !end || start > end) return toast("Escolha a data inicial e a final.", { error: true });
  loadDashboard("custom", { start, end }).catch(fail);
});
$("product-filter").addEventListener("change", renderProducts);
$("product-form").addEventListener("submit", saveProduct);
$("delete-product").addEventListener("click", deleteProduct);
for (const btn of document.querySelectorAll("[data-close]")) btn.addEventListener("click", () => $("product-dialog").close());
$("image-input").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  const room = 8 - (state.editing?.images.length || 0) - state.pendingFiles.length;
  if (files.length > room) toast(`Limite de 8 fotos por produto. ${room} foto(s) adicionada(s).`, { error: true });
  for (const file of files.slice(0, Math.max(0, room))) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      toast("Use fotos em JPEG, PNG ou WebP.", { error: true });
      continue;
    }
    state.pendingFiles.push({ file, preview: URL.createObjectURL(file) });
  }
  renderImages();
});
$("category-card").addEventListener("toggle", (e) => { if (e.target.open) loadCategoryOrder().catch(fail); });
$("stock-history").closest("details").addEventListener("toggle", (e) => { if (e.target.open) loadStockHistory().catch(fail); });

$("order-filters").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  state.orderStatus = chip.dataset.status;
  for (const c of document.querySelectorAll("#order-filters .chip")) c.setAttribute("aria-pressed", String(c === chip));
  loadOrders().catch(fail);
});
$("export-orders").addEventListener("click", (e) => exportOrders(e.currentTarget));
$("export-customers").addEventListener("click", () => {
  if (!customers.length) return toast("Nenhum cliente para exportar.");
  downloadCsv("clientes.csv", ["Nome", "Telefone", "Pedidos", "Total em compras concluídas (R$)", "Último pedido"],
    customers.map((c) => [c.name, c.phone, c.orders, (c.spent / 100).toFixed(2).replace(".", ","), c.last_order]));
});

$("settings").addEventListener("submit", saveSettings);
$("copy-url").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("share-url").value);
    toast("Link copiado.");
  } catch {
    $("share-url").select();
  }
});
for (const input of document.querySelectorAll("[data-asset]")) input.addEventListener("change", () => uploadAsset(input));
for (const btn of document.querySelectorAll("[data-remove-asset]")) {
  btn.addEventListener("click", () => busy(btn, async () => {
    if (!confirm("Remover esta imagem?")) return;
    await api(`/api/settings/${btn.dataset.removeAsset}`, { method: "DELETE" });
    await loadStore();
  }));
}
$("has-variants").addEventListener("change", (e) => {
  if (!e.target.checked && document.querySelector("#variant-rows .variant-row") &&
      !confirm("Remover as variações deste produto? Ao salvar, ele passa a ter um estoque único.")) {
    e.target.checked = true;
    return;
  }
  if (!e.target.checked) $("variant-rows").replaceChildren();
  $("variant-editor").hidden = !e.target.checked;
  if (e.target.checked && !document.querySelector("#variant-rows .variant-row")) $("opt1").focus();
  updateStockField();
});
$("gen-variants").addEventListener("click", generateVariants);
$("add-variant").addEventListener("click", () => {
  const row = variantRow({ stock: 0 });
  $("variant-rows").append(row);
  row.querySelector("input").focus();
});
$("team-form").addEventListener("submit", addMember);
$("coupon-form").addEventListener("submit", createCoupon);
$("ai-from-text").addEventListener("click", aiFromText);
$("ai-photo").addEventListener("change", aiFromPhoto);
$("ai-improve").addEventListener("click", aiImprove);
$("campaign-go").addEventListener("click", aiCampaign);
$("delivery-on").addEventListener("change", (e) => { $("delivery-fields").hidden = !e.target.checked; });

// ---------- Aplicativo instalável e conexão ----------

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("install-app").hidden = false;
});
window.addEventListener("appinstalled", () => {
  $("install-app").hidden = true;
  toast("Painel instalado. Abra pelo ícone na tela inicial.");
});
$("install-app").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  $("install-app").hidden = true;
});
window.addEventListener("offline", () => toast("Você está sem internet. As alterações só serão salvas quando a conexão voltar.", { error: true }));
window.addEventListener("online", () => { toast("Conexão restabelecida."); if (!$("app").hidden) route(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => { /* PWA opcional */ });
$("perf-periods").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) loadPerformance(Number(chip.dataset.days)).catch(fail);
});
$("export-data").addEventListener("click", (e) => busy(e.currentTarget, async () => {
  const data = await api("/api/account/export");
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = h("a", { href: url, download: `def-commerce-${state.me.store.slug}-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Dados exportados.");
}));
$("open-delete-store").addEventListener("click", () => {
  $("delete-store-form").reset();
  $("delete-slug-hint").textContent = state.me.store.slug;
  $("delete-store-dialog").showModal();
});
for (const b of document.querySelectorAll("[data-close-dialog]")) b.addEventListener("click", () => b.closest("dialog").close());
$("delete-store-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  if (data.confirm_slug.trim().toLowerCase() !== state.me.store.slug) return toast("O endereço digitado não confere.", { error: true });
  await busy($("confirm-delete-store"), async () => {
    await api("/api/account/delete", { method: "POST", body: data });
    $("delete-store-dialog").close();
    location.hash = "";
    showAuth("Sua loja e todos os dados foram excluídos.");
  });
});
$("open-password").addEventListener("click", () => openPassword(false));
$("password-close").addEventListener("click", () => $("password-dialog").close());
$("password-form").addEventListener("submit", savePassword);
$("password-dialog").addEventListener("cancel", (e) => { if (e.currentTarget.dataset.forced) e.preventDefault(); });
$("audit-card").addEventListener("toggle", (e) => { if (e.target.open) loadAudit().catch(fail); });

start();
