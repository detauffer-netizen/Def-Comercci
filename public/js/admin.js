import { api, formatDate, h, icon, money, toast } from "./common.js";

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
  await Promise.all([loadOverview(), loadStores()]).catch((e) => toast(e.message, { error: true }));
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

let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadStores().catch((e) => toast(e.message, { error: true })), 250);
});
$("audit").addEventListener("toggle", (e) => { if (e.target.open) loadAudit().catch((err) => toast(err.message, { error: true })); });
$("login").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    await api("/api/login", { method: "POST", body: Object.fromEntries(new FormData(event.target)) });
    event.target.reset();
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
$("open-password").addEventListener("click", () => { $("password-form").reset(); $("password-dialog").showModal(); });
for (const b of document.querySelectorAll("[data-close]")) b.addEventListener("click", () => b.closest("dialog").close());
$("logout").addEventListener("click", async () => {
  await api("/api/admin/logout", { method: "POST", body: {} }).catch(() => {});
  showLogin();
});

start();
