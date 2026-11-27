import { api, h, icon, money, toast } from "./common.js";

const $ = (id) => document.getElementById(id);
const slug = location.pathname.split("/").filter(Boolean)[1] || "";
const CART_KEY = `def-cart:${slug}`;
let store = null;
let cart = new Map(); // "produto|variação" -> quantidade
let category = "";
let current = null;
let currentVariant = null;

const cartKey = (product, variant) => `${product.id}|${variant?.id || ""}`;

function resolve(key) {
  const [pid, vid] = key.split("|");
  const product = store.products.find((p) => p.id === pid);
  if (!product) return null;
  if (!vid) return product.variants.length ? null : { product, variant: null, stock: product.stock, price: product.final_price_cents };
  const variant = product.variants.find((v) => v.id === vid);
  return variant ? { product, variant, stock: variant.stock, price: variant.final_price_cents } : null;
}

function loadCart() {
  try {
    const saved = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
    for (const [key, qty] of saved) {
      const line = resolve(String(key).includes("|") ? key : `${key}|`);
      if (line && line.stock > 0) cart.set(cartKey(line.product, line.variant), Math.min(qty, line.stock));
    }
  } catch { /* armazenamento indisponível */ }
}

function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify([...cart]));
  } catch { /* armazenamento indisponível */ }
}

function setQuantity(product, qty, variant = null) {
  const stock = variant ? variant.stock : product.stock;
  const label = variant ? `${product.name} (${variant.name})` : product.name;
  const value = Math.max(0, Math.min(qty, stock));
  if (qty > stock) toast(`Só temos ${stock} unidade(s) de ${label}.`);
  const key = cartKey(product, variant);
  if (value) cart.set(key, value);
  else cart.delete(key);
  saveCart();
  renderProducts();
  renderCart();
}

function priceNode(p, cls = "price", variant = null) {
  if (variant) return h("span", { class: cls }, money(variant.final_price_cents));
  const prices = new Set(p.variants.map((v) => v.final_price_cents));
  return h("span", { class: cls },
    prices.size > 1 ? h("span", { class: "price-from", text: "a partir de" }) : null,
    money(p.final_price_cents),
    !p.variants.length && p.final_price_cents < p.price_cents ? h("span", { class: "price-old", text: money(p.price_cents) }) : null);
}

function productCard(p) {
  const qty = cart.get(cartKey(p, null)) || 0;
  const cover = p.images[0];
  const soldOut = p.stock === 0;
  const discount = p.final_price_cents < p.price_cents ? Math.round((1 - p.final_price_cents / p.price_cents) * 100) : 0;
  const action = soldOut
    ? h("button", { class: "btn", disabled: true }, "Esgotado")
    : p.variants.length
      ? h("button", { class: "btn", onclick: () => openProduct(p) }, "Escolher opção")
      : qty
      ? h("div", { class: "stepper" },
        h("button", { "aria-label": `Remover uma unidade de ${p.name}`, onclick: () => setQuantity(p, qty - 1) }, icon("minus", "icon icon-sm")),
        h("strong", { "aria-live": "polite", text: String(qty) }),
        h("button", { "aria-label": `Adicionar uma unidade de ${p.name}`, disabled: qty >= p.stock, onclick: () => setQuantity(p, qty + 1) }, icon("plus", "icon icon-sm")))
      : h("button", { class: "btn", onclick: () => setQuantity(p, 1) }, icon("plus", "icon icon-sm"), "Adicionar");
  return h("article", { class: `product ${soldOut ? "soldout" : ""}`, id: `p-${p.id}` },
    h("button", { class: "product-media", style: cover ? { backgroundImage: `url("${cover}")` } : {}, "aria-label": `Ver detalhes de ${p.name}`, onclick: () => openProduct(p) },
      cover ? null : icon("image"),
      discount ? h("span", { class: "badge badge-orange tag", text: `-${discount}%` }) : soldOut ? h("span", { class: "badge badge-danger tag", text: "Esgotado" }) : null),
    h("div", { class: "product-body" },
      h("button", { class: "product-name", text: p.name, onclick: () => openProduct(p) }),
      priceNode(p),
      action));
}

function visibleProducts() {
  const q = $("search").value.trim().toLowerCase();
  return store.products.filter((p) => (!category || p.category === category) &&
    (!q || `${p.name} ${p.description} ${p.category}`.toLowerCase().includes(q)));
}

function renderProducts() {
  const list = visibleProducts();
  const filtering = !!(category || $("search").value.trim());
  const featured = store.products.filter((p) => p.featured);
  $("featured-section").hidden = filtering || !featured.length;
  $("featured").replaceChildren(...(filtering ? [] : featured.map(productCard)));
  $("all-title").textContent = category || ($("search").value.trim() ? "Resultados da busca" : "Todos os produtos");
  if (!list.length) {
    $("products").replaceChildren(h("p", { class: "empty", style: { gridColumn: "1/-1" }, text: store.products.length ? "Nenhum produto encontrado." : "Esta loja ainda não publicou produtos." }));
  } else {
    $("products").replaceChildren(...list.map(productCard));
  }
}

function renderCategories() {
  const cats = [...new Set(store.products.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const box = $("categories");
  box.hidden = !cats.length;
  const chip = (value, label) => h("button", {
    class: "chip", "aria-pressed": String(category === value),
    onclick: () => { category = value; renderCategories(); renderProducts(); },
  }, label);
  box.replaceChildren(chip("", "Todos"), ...cats.map((c) => chip(c, c)));
}

function cartLines() {
  return [...cart].map(([key, qty]) => ({ ...resolve(key), qty })).filter((l) => l.product);
}

function renderCart() {
  const lines = cartLines();
  const count = lines.reduce((s, l) => s + l.qty, 0);
  const total = lines.reduce((s, l) => s + l.qty * l.price, 0);
  $("cart-bar").hidden = !count;
  $("cart-count").textContent = String(count);
  $("cart-total").textContent = money(total);
  $("cart-sum").textContent = money(total);
  $("cart-items").replaceChildren(...(lines.length ? lines.map(({ product: p, variant: v, qty, price, stock }) => h("div", { class: "cart-line" },
    h("span", { class: "thumb", style: p.images[0] ? { backgroundImage: `url("${p.images[0]}")` } : {} }),
    h("div", { class: "grow" }, h("strong", { text: p.name }), v ? h("span", { class: "variant", text: v.name }) : null, h("small", { class: "muted", text: `${money(price)} cada` })),
    h("div", { class: "stepper", style: { marginTop: 0 } },
      h("button", { type: "button", "aria-label": "Diminuir", onclick: () => setQuantity(p, qty - 1, v) }, icon("minus", "icon icon-sm")),
      h("strong", { style: { padding: "0 8px" }, text: String(qty) }),
      h("button", { type: "button", "aria-label": "Aumentar", disabled: qty >= stock, onclick: () => setQuantity(p, qty + 1, v) }, icon("plus", "icon icon-sm")))))
    : [h("p", { class: "empty", text: "Seu pedido está vazio." })]));
  if (!count && $("cart-dialog").open) $("cart-dialog").close();
}

function openProduct(p) {
  current = p;
  const gallery = $("pd-gallery");
  if (p.images.length) {
    const track = h("div", { class: "gallery-track" }, ...p.images.map((src, i) => h("img", { src, alt: `${p.name} — foto ${i + 1}`, loading: "lazy" })));
    const dots = h("div", { class: "gallery-dots" }, ...p.images.map((_, i) => h("span", { class: i ? "" : "on" })));
    track.addEventListener("scroll", () => {
      const index = Math.round(track.scrollLeft / track.clientWidth);
      [...dots.children].forEach((d, i) => d.classList.toggle("on", i === index));
    }, { passive: true });
    gallery.replaceChildren(track, p.images.length > 1 ? dots : "");
  } else {
    gallery.replaceChildren(h("div", { class: "gallery-empty" }, icon("image")));
  }
  $("pd-name").textContent = p.name;
  currentVariant = p.variants.length === 1 && p.variants[0].stock > 0 ? p.variants[0] : null;
  renderVariantChoice();
  $("pd-description").textContent = p.description || "";

  history.replaceState(null, "", `#p-${p.id}`);
  $("product-dialog").showModal();
}

function renderVariantChoice() {
  const p = current;
  const box = $("pd-variants");
  box.hidden = !p.variants.length;
  box.replaceChildren(...p.variants.map((v) => h("button", {
    type: "button", class: "chip", role: "radio", "aria-checked": String(currentVariant?.id === v.id),
    "aria-pressed": String(currentVariant?.id === v.id), disabled: v.stock === 0,
    onclick: () => { currentVariant = v; renderVariantChoice(); },
  }, v.name)));
  $("pd-price").replaceChildren(priceNode(p, "", currentVariant));
  const stock = currentVariant ? currentVariant.stock : p.stock;
  $("pd-meta").textContent = [p.category, p.variants.length && !currentVariant ? "Escolha uma opção" : stock ? `${stock} disponível(is)` : "Esgotado"].filter(Boolean).join(" · ");
  $("pd-add").disabled = !stock || (p.variants.length > 0 && !currentVariant);
}

async function share(title, url) {
  try {
    if (navigator.share) return await navigator.share({ title, url });
    await navigator.clipboard.writeText(url);
    toast("Link copiado.");
  } catch (error) {
    if (error?.name !== "AbortError") toast("Não foi possível compartilhar.", { error: true });
  }
}

function orderMessage(order, data) {
  const lines = order.items.map((i) => `${i.quantity}x ${i.name}${i.variant_name ? ` (${i.variant_name})` : ""} — ${money(i.price_cents * i.quantity)}`);
  return [
    `Olá, ${store.name}! Quero fazer o pedido #${order.code}:`,
    "",
    ...lines,
    "",
    `Total: ${money(order.total_cents)}`,
    `Nome: ${data.customer_name}`,
    data.notes ? `Observações: ${data.notes}` : null,
  ].filter((l) => l !== null).join("\n");
}

async function checkout(event) {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  const err = $("checkout-error");
  err.hidden = true;
  const digits = String(data.customer_phone).replace(/\D/g, "");
  if (!data.customer_name.trim()) return showError("Informe seu nome.");
  if (digits.length < 10) return showError("Informe um telefone com DDD.");
  const button = $("send-order");
  button.disabled = true;
  try {
    const order = await api(`/api/order-request/${encodeURIComponent(slug)}`, {
      method: "POST",
      body: { ...data, items: cartLines().map((l) => ({ id: l.product.id, ...(l.variant ? { variant_id: l.variant.id } : {}), quantity: l.qty })) },
    });
    cart.clear();
    saveCart();
    renderCart();
    renderProducts();
    try { localStorage.setItem("def-buyer", JSON.stringify({ customer_name: data.customer_name, customer_phone: data.customer_phone })); } catch { /* opcional */ }
    if (/^\d{10,15}$/.test(store.whatsapp || "")) {
      location.href = `https://wa.me/${store.whatsapp}?text=${encodeURIComponent(orderMessage(order, data))}`;
    } else {
      toast(`Pedido #${order.code} enviado! A loja entrará em contato.`);
    }
  } catch (error) {
    showError(error.message);
    if (error.status === 409) refresh();
  } finally {
    button.disabled = false;
  }

  function showError(text) {
    err.textContent = text;
    err.hidden = false;
  }
}

async function refresh() {
  try {
    store = await api(`/api/store/${encodeURIComponent(slug)}`);
  } catch (error) {
    return error;
  }
  for (const [key, qty] of cart) {
    const line = resolve(key);
    if (!line || line.stock <= 0) cart.delete(key);
    else if (qty > line.stock) cart.set(key, line.stock);
  }
  renderProducts();
  renderCart();
  return null;
}

async function start() {
  const error = await refresh().catch((e) => e) || (store ? null : new Error("Loja indisponível"));
  $("shop").removeAttribute("aria-busy");
  if (error || !store) {
    $("store-name").textContent = "Loja não encontrada";
    $("error").textContent = "Confira o endereço digitado ou fale com a loja.";
    $("error").hidden = false;
    $("featured-section").hidden = true;
    $("products").replaceChildren();
    $("categories").hidden = true;
    return;
  }
  document.documentElement.style.setProperty("--accent", store.accent);
  document.title = `${store.name} | Catálogo`;
  document.querySelector('meta[name="description"]').setAttribute("content", store.description || `Catálogo da ${store.name}. Faça seu pedido pelo WhatsApp.`);
  $("store-name").textContent = store.name;
  $("store-description").textContent = store.description || "";
  const logo = $("logo");
  logo.textContent = store.logo_url ? "" : store.name.slice(0, 1).toUpperCase();
  if (store.logo_url) logo.style.backgroundImage = `url("${store.logo_url}")`;
  if (store.banner_url) {
    $("banner").style.backgroundImage = `url("${store.banner_url}")`;
    $("banner").classList.add("has-image");
  }
  $("share-store").hidden = false;
  try {
    const buyer = JSON.parse(localStorage.getItem("def-buyer") || "null");
    if (buyer) for (const k of ["customer_name", "customer_phone"]) $("checkout").elements[k].value = buyer[k] || "";
  } catch { /* opcional */ }
  loadCart();
  renderCategories();
  renderProducts();
  renderCart();
  const linked = location.hash.match(/^#p-([0-9a-f-]{36})$/);
  const target = linked && store.products.find((p) => p.id === linked[1]);
  if (target) openProduct(target);
}

$("search").addEventListener("input", renderProducts);
$("cart-bar").addEventListener("click", () => $("cart-dialog").showModal());
$("checkout").addEventListener("submit", checkout);
$("share-store").addEventListener("click", () => share(store.name, `${location.origin}/loja/${slug}`));
$("pd-add").addEventListener("click", () => {
  const key = cartKey(current, currentVariant);
  setQuantity(current, (cart.get(key) || 0) + 1, currentVariant);
  $("product-dialog").close();
  toast(`${current.name}${currentVariant ? ` (${currentVariant.name})` : ""} adicionado ao pedido.`);
});
$("pd-share").addEventListener("click", () => share(current.name, `${location.origin}/loja/${slug}#p-${current.id}`));
$("product-dialog").addEventListener("close", () => history.replaceState(null, "", location.pathname));
for (const btn of document.querySelectorAll("[data-close]")) btn.addEventListener("click", () => btn.closest("dialog").close());

start();
