import { api, centsToInput, formatDate, h, icon, money, parseMoney, toast } from "./common.js";
import { mountTwoFactor } from "./twofactor.js";

const $ = (id) => document.getElementById(id);
let stores = [];
let suspending = null;

const ACTIONS = {
  "admin.store_suspended": "Loja suspensa",
  "admin.store_reactivated": "Loja reativada",
  "store.created": "Loja criada",
  "store.settings": "Configurações da loja",
  "product.created": "Produto cadastrado",
  "product.updated": "Produto alterado",
  "product.deleted": "Produto excluído",
  "order.status": "Status de pedido",
  "team.added": "Pessoa adicionada à equipe",
  "team.permissions": "Permissões alteradas",
  "team.removed": "Pessoa removida da equipe",
  "user.login": "Login",
  "user.password_changed": "Senha alterada",
  "coupon.created": "Cupom criado",
  "coupon.updated": "Cupom alterado",
  "coupon.deleted": "Cupom excluído",
  "customer.anonymized": "Dados de cliente excluídos",
  "store.exported": "Dados da loja exportados",
  "store.deleted": "Loja excluída pelo proprietário",
};

function showLogin(message) {
  $("app").hidden = true;
  $("login-view").hidden = false;
  $("login-error").hidden = !message;
  $("login-error").textContent = message || "";
}

async function start() {
  try {
    const me = await api("/api/admin/me");
    $("admin-email").textContent = me.email;
  } catch (error) {
    return showLogin(error.status === 401 ? "" : error.message);
  }
  $("login-view").hidden = true;
  $("app").hidden = false;
  await Promise.all([loadOverview(), loadStores(), loadErrors(), loadBilling()]).catch((e) => toast(e.message, { error: true }));
}

const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

async function loadOverview() {
  const o = await api("/api/admin/overview");
  const kpi = (label, value) => h("div", { class: "kpi" }, h("small", { text: label }), h("strong", { text: value }));
  $("kpis").replaceChildren(
    kpi("Lojas ativas", `${o.active} de ${o.stores}`),
    kpi("Novas (30 dias)", String(o.new_30d)),
    kpi("Suspensas", String(o.suspended)),
    kpi("Usuários", String(o.users)),
    kpi("Produtos", String(o.products)),
    kpi("Pedidos", String(o.orders)),
    kpi("Pedidos (30 dias)", String(o.orders_30d)),
    kpi("Vendas concluídas (GMV)", money(o.gmv)),
    kpi("Imagens", String(o.images)),
    kpi("Armazenamento", bytes(o.image_bytes)),
  );
}

async function loadStores() {
  const q = $("search").value.trim();
  stores = await api(`/api/admin/stores${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  if (!stores.length) {
    $("stores").replaceChildren(h("tr", {}, h("td", { colspan: "9", class: "muted", text: q ? "Nenhuma loja encontrada." : "Nenhuma loja cadastrada." })));
    return;
  }
  $("stores").replaceChildren(...stores.map((s) => {
    const active = s.status === "active";
    return h("tr", {},
      h("td", {}, h("strong", { text: s.name }), h("small", { text: `/loja/${s.slug} · equipe ${s.team}` })),
      h("td", {}, h("span", { text: s.owner_email || "—" })),
      h("td", { class: "num", text: String(s.products) }),
      h("td", { class: "num" }, String(s.orders), s.last_order ? h("small", { text: `último ${formatDate(s.last_order)}` }) : null),
      h("td", { class: "num", text: money(s.revenue) }),
      h("td", { class: "num", text: bytes(s.image_bytes) }),
      h("td", { text: formatDate(s.created_at) }),
      h("td", {}, h("span", { class: `badge ${active ? "badge-ok" : "badge-danger"}`, text: active ? "Ativa" : "Suspensa" })),
      h("td", {}, h("div", { style: { display: "flex", gap: "6px" } },
        h("a", { class: "btn btn-ghost btn-icon", href: `/loja/${s.slug}`, target: "_blank", rel: "noopener", "aria-label": `Abrir vitrine de ${s.name}` }, icon("external", "icon icon-sm")),
        h("button", { class: "btn btn-ghost btn-sm", onclick: () => openGrant(s) }, "Plano"),
        active
          ? h("button", { class: "btn btn-danger btn-sm", onclick: () => openSuspend(s) }, "Suspender")
          : h("button", { class: "btn btn-blue btn-sm", onclick: (e) => reactivate(s, e.currentTarget) }, "Reativar"))));
  }));
}

function openSuspend(store) {
  suspending = store;
  $("suspend-title").textContent = `Suspender ${store.name}`;
  $("suspend-form").reset();
  $("suspend-dialog").showModal();
}

async function changeStatus(store, status, reason) {
  await api(`/api/admin/stores/${store.id}`, { method: "PATCH", body: { status, reason } });
  toast(status === "active" ? `${store.name} reativada.` : `${store.name} suspensa.`);
  await Promise.all([loadOverview(), loadStores()]);
  if ($("audit").open) loadAudit();
}

async function reactivate(store, button) {
  if (!confirm(`Reativar ${store.name}? A vitrine e o painel voltam a funcionar.`)) return;
  button.disabled = true;
  try {
    await changeStatus(store, "active", "");
  } catch (error) {
    toast(error.message, { error: true });
    button.disabled = false;
  }
}

async function loadAudit() {
  const rows = await api("/api/admin/audit");
  $("audit-list").replaceChildren(...(rows.length ? rows.map((r) => h("div", { class: "row" },
    h("div", { class: "grow" },
      h("strong", { text: ACTIONS[r.action] || r.action }),
      h("small", { text: [r.store_name, r.email, r.detail].filter(Boolean).join(" · ") })),
    h("small", { text: formatDate(r.created_at) }))) : [h("p", { class: "muted", text: "Nenhuma operação registrada." })]));
}

async function loadErrors() {
  const e = await api("/api/admin/errors");
  $("errors-summary").textContent = `${e.last_24h} erro(s) nas últimas 24 horas · ${e.last_7d} nos últimos 7 dias.`;
  $("errors-list").replaceChildren(...(e.grouped.length ? e.grouped.map((g) => h("div", { class: "error-row" },
    h("code", { text: `${g.method} ${g.path}` }),
    h("span", { class: "msg", text: g.message }),
    h("small", { text: `${g.count} ocorrência(s) · última em ${formatDate(g.last_seen)}` }))) : [h("p", { class: "muted", text: "Nenhum erro nos últimos 7 dias." })]));
}

// ---------- Planos e assinaturas ----------

let plans = [];
let granting = null;
const limitCell = (p) => [
  p.max_products === null ? "produtos ∞" : `${p.max_products} produtos`,
  p.max_team === null ? "equipe ∞" : `equipe ${p.max_team}`,
  p.ai_daily === null ? "IA padrão" : `IA ${p.ai_daily}/dia`,
].join(" · ");

async function loadBilling() {
  const [b, list] = await Promise.all([api("/api/admin/billing"), api("/api/admin/plans")]);
  plans = list;
  $("billing-flag").textContent = b.enabled ? "Cobrança ativa" : "Cobrança desativada";
  $("billing-flag").className = `badge ${b.enabled ? "badge-ok" : "badge-warn"}`;
  const kpi = (label, value) => h("div", { class: "kpi" }, h("small", { text: label }), h("strong", { text: value }));
  $("billing-kpis").replaceChildren(
    kpi("Receita recorrente (MRR)", money(b.mrr_cents)), kpi("Lojas pagantes", String(b.paying)),
    kpi("Em teste grátis", String(b.trialing)), kpi("Recebido (30 dias)", money(b.received_30d)), kpi("Inadimplentes", String(b.overdue.length)));
  $("overdue-list").replaceChildren(...(b.overdue.length ? b.overdue.map((o) => h("div", { class: "row" },
    h("div", { class: "grow" }, h("strong", { text: o.name }), h("small", { text: `${o.plan} · venceu em ${formatDate(o.current_period_end)}` })),
    h("span", { class: "badge badge-danger", text: o.status === "past_due" ? "Pagamento recusado" : "Vencida" }))) : [h("p", { class: "muted", text: "Nenhuma loja inadimplente." })]));
  $("plans-body").replaceChildren(...plans.map((p) => h("tr", {},
    h("td", {}, h("code", { text: p.id })),
    h("td", {}, h("strong", { text: p.name }), p.is_default ? h("small", { text: "plano padrão" }) : null),
    h("td", { class: "num", text: p.price_cents ? money(p.price_cents) : "Grátis" }),
    h("td", { text: limitCell(p) }),
    h("td", { class: "num", text: String(p.subscribers) }),
    h("td", {}, h("span", { class: `badge ${p.active ? "badge-ok" : ""}`, text: p.active ? "Disponível" : "Oculto" })),
    h("td", {}, h("button", { class: "btn btn-ghost btn-sm", onclick: () => editPlan(p) }, "Editar")))));
}

function editPlan(p) {
  const f = $("plan-form").elements;
  $("plan-form").dataset.editing = p ? p.id : "";
  $("plan-form").reset();
  f.id.disabled = !!p;
  if (p) {
    f.id.value = p.id;
    f.name.value = p.name;
    f.description.value = p.description || "";
    f.price.value = centsToInput(p.price_cents);
    f.trial_days.value = p.trial_days;
    f.max_products.value = p.max_products ?? "";
    f.max_team.value = p.max_team ?? "";
    f.ai_daily.value = p.ai_daily ?? "";
    f.position.value = p.position;
    f.active.checked = p.active;
  }
  $("plan-form-title").textContent = p ? `Editando: ${p.name}` : "Novo plano";
  $("plan-form-box").open = true;
  f.name.focus();
}

async function savePlan(event) {
  event.preventDefault();
  const f = event.target.elements;
  const price = parseMoney(f.price.value);
  if (price === null || Number.isNaN(price)) return toast("Informe o preço, por exemplo 49,90 (ou 0 para grátis).", { error: true });
  const num = (input) => (input.value === "" ? null : Number(input.value));
  const body = {
    id: f.id.value, name: f.name.value, description: f.description.value, price_cents: price,
    trial_days: Number(f.trial_days.value || 0), max_products: num(f.max_products), max_team: num(f.max_team),
    ai_daily: num(f.ai_daily), position: Number(f.position.value || 0), active: f.active.checked,
  };
  const editing = event.target.dataset.editing;
  try {
    if (editing) await api(`/api/admin/plans/${editing}`, { method: "PATCH", body });
    else await api("/api/admin/plans", { method: "POST", body });
    toast("Plano salvo.");
    event.target.reset();
    event.target.dataset.editing = "";
    f.id.disabled = false;
    $("plan-form-box").open = false;
    $("plan-form-title").textContent = "Novo plano";
    await loadBilling();
  } catch (error) {
    toast(error.message, { error: true });
  }
}

function openGrant(store) {
  granting = store;
  $("grant-title").textContent = `Plano de ${store.name}`;
  $("grant-plan").replaceChildren(...plans.map((p) => h("option", { value: p.id, text: `${p.name} (${p.price_cents ? money(p.price_cents) : "grátis"})` })));
  $("grant-dialog").showModal();
}

let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadStores().catch((e) => toast(e.message, { error: true })), 250);
});
$("plan-form").addEventListener("submit", savePlan);
$("plan-form-cancel").addEventListener("click", () => { editPlan(null); $("plan-form-box").open = false; });
$("grant-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  try {
    await api(`/api/admin/stores/${granting.id}/plan`, { method: "PATCH", body: { plan_id: data.plan_id, days: Number(data.days) } });
    $("grant-dialog").close();
    toast(`Plano aplicado a ${granting.name}.`);
    await loadBilling();
  } catch (error) {
    toast(error.message, { error: true });
  }
});
$("reload-errors").addEventListener("click", () => loadErrors().catch((e) => toast(e.message, { error: true })));
$("audit").addEventListener("toggle", (e) => { if (e.target.open) loadAudit().catch((err) => toast(err.message, { error: true })); });
$("login").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const result = await api("/api/login", { method: "POST", body: Object.fromEntries(new FormData(event.target)) });
    event.target.reset();
    if (result.two_factor_required) {
      challenge = result.challenge;
      $("login").hidden = true;
      $("login-2fa").hidden = false;
      $("login-error").hidden = true;
      $("login-2fa").elements.code.focus();
      return;
    }
    await start();
    if (!$("app").hidden) return;
    showLogin("Esta conta não tem acesso à administração da plataforma.");
    await api("/api/logout", { method: "POST", body: {} }).catch(() => {});
  } catch (error) {
    showLogin(error.message);
  } finally {
    button.disabled = false;
  }
});
let challenge = "";
$("login-2fa").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/login/2fa", { method: "POST", body: { challenge, code: event.target.elements.code.value } });
    event.target.reset();
    $("login-2fa").hidden = true;
    $("login").hidden = false;
    await start();
    if ($("app").hidden) showLogin("Esta conta não tem acesso à administração da plataforma.");
  } catch (error) {
    toast(error.message, { error: true });
    if (error.status === 401) { $("login-2fa").hidden = true; $("login").hidden = false; }
  }
});
$("suspend-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const reason = new FormData(event.target).get("reason").trim();
  if (!reason) return toast("Informe o motivo da suspensão.", { error: true });
  event.submitter.disabled = true;
  try {
    await changeStatus(suspending, "suspended", reason);
    $("suspend-dialog").close();
  } catch (error) {
    toast(error.message, { error: true });
  } finally {
    event.submitter.disabled = false;
  }
});
$("password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  try {
    await api("/api/admin/password", { method: "POST", body: data });
    $("password-dialog").close();
    toast("Senha alterada.");
  } catch (error) {
    toast(error.message, { error: true });
  }
});
$("open-password").addEventListener("click", () => {
  $("password-form").reset();
  mountTwoFactor($("tfa-box"), "/api/admin/2fa");
  $("password-dialog").showModal();
});
for (const b of document.querySelectorAll("[data-close]")) b.addEventListener("click", () => b.closest("dialog").close());
$("logout").addEventListener("click", async () => {
  await api("/api/admin/logout", { method: "POST", body: {} }).catch(() => {});
  showLogin();
});

start();
