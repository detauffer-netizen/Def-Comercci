// Catálogo para imprimir ou salvar em PDF, a partir dos dados públicos da vitrine.
import { api, h, money, sortCategories } from "./common.js";

const $ = (id) => document.getElementById(id);
const slug = location.pathname.split("/").filter(Boolean)[1] || "";

function item(p) {
  const promo = !p.variants.length && p.final_price_cents < p.price_cents;
  const prices = new Set(p.variants.map((v) => v.final_price_cents));
  return h("article", { class: "cat-item" },
    h("div", { class: "cat-img", style: p.images[0] ? { backgroundImage: `url("${p.images[0]}")` } : {} }),
    h("div", { class: "cat-body" },
      h("strong", { text: p.name }),
      h("div", { class: "cat-price" }, prices.size > 1 ? "a partir de " : "", money(p.final_price_cents), promo ? h("s", { text: money(p.price_cents) }) : null),
      p.variants.length ? h("div", { class: "cat-opts", text: `Opções: ${p.variants.map((v) => v.name).join(", ")}` }) : null,
      p.stock === 0 ? h("div", { class: "cat-out", text: "Esgotado" }) : null));
}

async function start() {
  $("back").href = `/loja/${slug}`;
  let store;
  try {
    store = await api(`/api/store/${encodeURIComponent(slug)}`);
  } catch {
    $("name").textContent = "Loja não encontrada";
    return;
  }
  document.documentElement.style.setProperty("--accent", store.accent);
  document.title = `Catálogo ${store.name}`;
  $("name").textContent = store.name;
  $("description").textContent = store.description || "";
  if (store.logo_url) $("logo").style.backgroundImage = `url("${store.logo_url}")`;
  else $("logo").textContent = store.name.slice(0, 1).toUpperCase();
  const groups = new Map();
  for (const p of store.products) {
    const key = p.category || "Outros";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const names = sortCategories([...groups.keys()].filter((c) => c !== "Outros"), store.category_order);
  if (groups.has("Outros")) names.push("Outros");
  $("sections").replaceChildren(...(names.length ? names.map((c) => h("section", { class: "cat-section" },
    h("h2", { text: groups.size === 1 && c === "Outros" ? "Produtos" : c }),
    h("div", { class: "cat-grid" }, ...groups.get(c).map(item)))) : [h("p", { class: "muted", text: "Nenhum produto publicado." })]));
  const phone = store.whatsapp ? store.whatsapp.replace(/^55(\d{2})(\d{4,5})(\d{4})$/, "($1) $2-$3") : "";
  $("foot").replaceChildren(
    phone ? h("span", {}, "Pedidos pelo WhatsApp: ", h("strong", { text: phone })) : null,
    h("span", {}, "Catálogo online: ", h("strong", { text: `${location.host}/loja/${slug}` })),
    h("span", { text: `Preços válidos em ${new Date().toLocaleDateString("pt-BR")}, sujeitos a alteração e disponibilidade.` }));
  $("sheet").removeAttribute("aria-busy");
}

$("print").addEventListener("click", () => window.print());
start();
