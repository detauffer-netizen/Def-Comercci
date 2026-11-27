import {
  ApiError, api, centsToInput, compressImage, downloadCsv, formatDate, formatPhone, h, icon, money, parseMoney, toast, whatsappLink,
} from "./common.js";

const $ = (id) => document.getElementById(id);
const state = { me: null, products: [], orders: [], metrics: null, orderStatus: "", editing: null, pendingFiles: [] };
const STATUS = {
  pending: { label: "Pendente", badge: "badge-warn" },
  confirmed: { label: "Confirmado", badge: "" },
  completed: { label: "Concluído", badge: "badge-ok" },
  cancelled: { label: "Cancelado", badge: "badge-danger" },
};
const VIEWS = ["inicio", "produtos", "pedidos", "clientes", "loja"];

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
  $("boot").hidden = true;
  $("app").hidden = true;
  $("auth").hidden = false;
  const err = $("auth-error");
  err.hidden = !message;
  err.textContent = message || "";
  if (location.hash === "#cadastro") selectTab("register");
}

function selectTab(which) {
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
  route();
}

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
  const view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "inicio";
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
  loading($("recent-orders"));
  const [metrics, orders, products] = await Promise.all([api("/api/metrics"), api("/api/orders"), api("/api/products")]);
  state.metrics = metrics;
  state.orders = orders;
  state.products = products;
  updatePendingBadge();

  const kpi = (label, value, cls = "") => h("div", { class: `kpi ${cls}` }, h("small", { text: label }), h("strong", { text: value }));
  $("kpis").replaceChildren(
    kpi("Vendas concluídas", money(metrics.revenue), "highlight"),
    kpi("Últimos 30 dias", money(metrics.revenue_30d)),
    kpi("Pedidos pendentes", String(metrics.pending)),
    kpi("Ticket médio", money(metrics.average_ticket)),
    kpi("Pedidos (24 h)", String(metrics.orders_24h)),
    kpi("Clientes", String(metrics.customers)),
    kpi("Produtos ativos", String(metrics.active)),
    kpi("Unidades em estoque", String(metrics.units)),
  );

  const s = state.me.store;
  const steps = [
    ["Cadastre seu primeiro produto", products.length > 0, "#produtos"],
    ["Adicione fotos aos produtos", products.some((p) => p.images.length), "#produtos"],
    ["Informe o WhatsApp da loja", !!s.whatsapp, "#loja"],
    ["Personalize cor e logotipo", !!s.logo_url || s.accent !== "#2563eb", "#loja"],
    ["Compartilhe sua vitrine", orders.length > 0, "#loja"],
  ];
  $("onboarding").hidden = steps.every(([, done]) => done);
  $("onboarding-steps").replaceChildren(...steps.map(([text, done, href]) =>
    h("li", { class: done ? "done" : "" }, h("span", { class: "dot" }, done ? icon("check", "icon icon-sm") : null),
      done ? h("span", { text }) : h("a", { href, text }))));

  const recent = orders.slice(0, 5);
  if (!recent.length) empty($("recent-orders"), "receipt", "Nenhum pedido ainda. Compartilhe sua vitrine para começar a vender.");
  else $("recent-orders").replaceChildren(...recent.map((o) => h("div", { class: "row" },
    h("div", { class: "grow" }, h("strong", { text: o.customer_name || "Cliente" }), h("small", { text: `#${o.code} · ${formatDate(o.created_at)}` })),
    h("div", { style: { textAlign: "right" } }, h("strong", { text: money(o.total_cents) }), h("div", {}, h("span", { class: `badge ${STATUS[o.status].badge}`, text: STATUS[o.status].label }))))));

  const alerts = products.filter((p) => p.active && p.stock <= 3).sort((a, b) => a.stock - b.stock).slice(0, 6);
  if (!alerts.length) empty($("stock-alerts"), "check", "Nenhum produto com estoque baixo.");
  else $("stock-alerts").replaceChildren(...alerts.map((p) => h("div", { class: "row" },
    h("div", { class: "grow" }, h("strong", { text: p.name }), h("small", { text: p.sku ? `SKU ${p.sku}` : p.category || "" })),
    h("span", { class: `badge ${p.stock ? "badge-warn" : "badge-danger"}`, text: p.stock ? `${p.stock} un.` : "Esgotado" }))));
}

function updatePendingBadge() {
  const pending = state.metrics?.pending ?? state.orders.filter((o) => o.status === "pending").length;
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
}

function renderProducts() {
  const q = $("product-search").value.trim().toLowerCase();
  const filter = $("product-filter").value;
  const list = state.products.filter((p) => {
    if (q && !`${p.name} ${p.sku} ${p.category}`.toLowerCase().includes(q)) return false;
    if (filter === "active") return p.active;
    if (filter === "inactive") return !p.active;
    if (filter === "low") return p.stock <= 3;
    if (filter === "featured") return p.featured;
    return true;
  });
  if (!state.products.length) {
    return empty($("product-list"), "box", "Você ainda não cadastrou produtos.",
      h("button", { class: "btn btn-primary", onclick: () => openProduct(null) }, icon("plus"), "Cadastrar primeiro produto"));
  }
  if (!list.length) return empty($("product-list"), "search", "Nenhum produto encontrado com esse filtro.");
  $("product-list").replaceChildren(...list.map((p) => {
    const cover = p.images[0]?.url;
    const stockBadge = p.stock === 0 ? ["badge-danger", "Esgotado"] : p.stock <= 3 ? ["badge-warn", `${p.stock} em estoque`] : ["badge-ok", `${p.stock} em estoque`];
    return h("button", { class: `product-item ${p.active ? "" : "inactive"}`, type: "button", onclick: () => openProduct(p) },
      h("span", { class: "thumb", style: cover ? { backgroundImage: `url("${cover}")` } : {} }, cover ? null : icon("image")),
      h("span", { class: "info" },
        h("strong", { text: p.name }),
        h("span", {}, h("b", { text: money(p.final_price_cents) }), p.final_price_cents < p.price_cents ? h("span", { class: "price-old", text: money(p.price_cents) }) : null),
        h("span", { class: "meta" },
          h("span", { class: `badge ${stockBadge[0]}`, text: stockBadge[1] }),
          p.featured ? h("span", { class: "badge badge-orange" }, icon("star", "icon icon-sm"), "Destaque") : null,
          p.active ? null : h("span", { class: "badge", text: "Oculto" }),
          p.category ? h("span", { class: "badge", text: p.category }) : null)));
  }));
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
    f.active.checked = product.active;
  } else {
    f.active.checked = true;
  }
  renderImages();
  $("product-dialog").showModal();
  f.name.focus();
}

function renderImages() {
  const p = state.editing;
  const saved = p ? p.images : [];
  const figures = saved.map((img) => h("figure", { style: { backgroundImage: `url("${img.url}")` } },
    h("button", { type: "button", "aria-label": "Remover foto", onclick: () => removeImage(img) }, icon("x", "icon icon-sm"))));
  const pending = state.pendingFiles.map((file, i) => h("figure", { class: "uploading", style: { backgroundImage: `url("${file.preview}")` } },
    h("button", { type: "button", "aria-label": "Remover foto", onclick: () => { URL.revokeObjectURL(file.preview); state.pendingFiles.splice(i, 1); renderImages(); } }, icon("x", "icon icon-sm"))));
  $("image-grid").replaceChildren(...figures, ...pending);
  $("image-add").hidden = saved.length + state.pendingFiles.length >= 8;
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

function readProductForm() {
  const f = $("product-form").elements;
  const price = parseMoney(f.price.value);
  const promo = parseMoney(f.promo.value);
  const stock = Number(f.stock.value);
  if (!f.name.value.trim()) return "Informe o nome do produto.";
  if (price === null || Number.isNaN(price)) return "Informe um preço válido, por exemplo 59,90.";
  if (Number.isNaN(promo)) return "Preço promocional inválido.";
  if (promo !== null && promo >= price) return "O preço promocional deve ser menor que o preço normal.";
  if (f.stock.value === "" || !Number.isInteger(stock) || stock < 0) return "Informe o estoque (número inteiro, zero ou maior).";
  return {
    name: f.name.value, description: f.description.value, price_cents: price, promo_price_cents: promo,
    stock, sku: f.sku.value, category: f.category.value, featured: f.featured.checked, active: f.active.checked,
  };
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
    else id = (await api("/api/products", { method: "POST", body: data })).id;
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
        ...o.items.map((i) => h("div", {}, h("span", { text: `${i.quantity}× ${i.name}` }), h("span", { text: money(i.price_cents * i.quantity) }))),
        h("div", { style: { fontWeight: "700", marginTop: "6px" } }, h("span", { text: "Total" }), h("span", { text: money(o.total_cents) }))),
      o.notes ? h("p", { class: "order-notes", text: `Observações: ${o.notes}` }) : null,
      h("div", { class: "order-actions" }, ...actions));
  }));
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
      ["Pedido", "Data", "Status", "Cliente", "Telefone", "Itens", "Total (R$)", "Observações"],
      orders.map((o) => [o.code, o.created_at, STATUS[o.status].label, o.customer_name, o.customer_phone,
        o.items.map((i) => `${i.quantity}x ${i.name}`).join(", "), (o.total_cents / 100).toFixed(2).replace(".", ","), o.notes || ""]));
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
    h("a", { class: "btn btn-ghost btn-icon", href: whatsappLink(c.phone, `Olá, ${c.name.split(" ")[0]}! `), target: "_blank", rel: "noopener", "aria-label": `WhatsApp de ${c.name}` }, icon("chat"))))));
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
  const url = `${location.origin}/loja/${s.slug}`;
  $("share-url").value = url;
  $("share-whatsapp").href = `https://wa.me/?text=${encodeURIComponent(`Confira o catálogo da ${s.name}: ${url}`)}`;
  for (const kind of ["logo", "banner"]) {
    const preview = $(`${kind}-preview`);
    preview.style.backgroundImage = s[`${kind}_url`] ? `url("${s[`${kind}_url`]}")` : "";
    document.querySelector(`[data-remove-asset=${kind}]`).hidden = !s[`${kind}_url`];
  }
  const owner = state.me.user.role === "owner";
  $("audit-card").hidden = !owner;
}

async function saveSettings(event) {
  event.preventDefault();
  const button = event.submitter;
  await busy(button, async () => {
    await api("/api/settings", { method: "PATCH", body: Object.fromEntries(new FormData(event.target)) });
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
  };
  if (!rows.length) return empty(box, "history", "Nenhuma atividade registrada.");
  box.replaceChildren(...rows.slice(0, 50).map((r) => h("div", { class: "row" },
    h("div", { class: "grow" }, h("strong", { text: labels[r.action] || r.action }), h("small", { text: [r.detail, r.email].filter(Boolean).join(" · ") })),
    h("small", { text: formatDate(r.created_at) }))));
}

// ---------- Eventos ----------

$("tab-login").addEventListener("click", () => selectTab("login"));
$("tab-register").addEventListener("click", () => selectTab("register"));
authForm($("login"), "/api/login");
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

$("logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST", body: {} });
  } catch { /* sessão já encerrada */ }
  location.hash = "";
  showAuth();
});
window.addEventListener("hashchange", () => { if (!$("app").hidden) route(); });

$("new-product").addEventListener("click", () => openProduct(null));
$("product-search").addEventListener("input", renderProducts);
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
$("audit-card").addEventListener("toggle", (e) => { if (e.target.open) loadAudit().catch(fail); });

start();
