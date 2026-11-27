import { api, h, icon, money, sortCategories, toast } from "./common.js";

const $ = (id) => document.getElementById(id);
const slug = location.pathname.split("/").filter(Boolean)[1] || "";
const productPath = (p) => `/loja/${slug}/p/${p.id}`;
let storeTitle = document.title;
const CART_KEY = `def-cart:${slug}`;
let store = null;
let cart = new Map(); // "produto|variação" -> quantidade
let category = "";
let current = null;
let currentVariant = null;
const coupon = { code: "", preview: null, timer: null }; // desconto calculado pelo servidor
// Carrinho abandonado: só é enviado à loja com a autorização marcada pelo comprador.
const TOKEN_KEY = `def-cart-token:${slug}`;
const reminder = { token: null, saved: false, timer: null };

const cartKey = (product, variant) => `${product.id}|${variant?.id || ""}`;
// Favoritos ficam só neste aparelho.
const FAV_KEY = `def-fav:${slug}`;
const quick = new Set(); // filtros rápidos: promo, new, fav
let favorites = new Set();
try { favorites = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")); } catch { /* opcional */ }
const TEMPLATES = ["geral", "roupas", "eletronicos", "utilidades", "ferramentas", "moveis", "cosmeticos"];

function toggleFavorite(p) {
  if (favorites.has(p.id)) favorites.delete(p.id);
  else favorites.add(p.id);
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...favorites])); } catch { /* opcional */ }
  renderProducts();
  updateFavButton();
}

function favButton(p) {
  const on = favorites.has(p.id);
  return h("button", { type: "button", class: "fav-btn", "aria-pressed": String(on), "aria-label": `${on ? "Tirar dos favoritos" : "Favoritar"}: ${p.name}`, onclick: () => toggleFavorite(p) }, icon("heart"));
}

function updateFavButton() {
  if (!current) return;
  const on = favorites.has(current.id);
  $("pd-fav").setAttribute("aria-pressed", String(on));
  $("pd-fav").setAttribute("aria-label", on ? "Tirar dos favoritos" : "Favoritar");
}

// Horário de funcionamento no fuso de Brasília (UTC-3).
const WEEK = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
function hoursStatus(hours, now = new Date()) {
  if (!hours?.length) return null;
  const local = new Date(now.getTime() - 3 * 3600 * 1000);
  const day = local.getUTCDay();
  const time = local.toISOString().slice(11, 16);
  const today = hours.filter((s) => s.d === day);
  const openSlot = today.find((s) => s.open <= time && time < s.close);
  if (openSlot) return { open: true, text: `Aberto agora · fecha às ${openSlot.close}` };
  const later = today.find((s) => time < s.open);
  if (later) return { open: false, text: `Fechado agora · abre hoje às ${later.open}` };
  for (let i = 1; i <= 7; i++) {
    const d = (day + i) % 7;
    const next = hours.find((s) => s.d === d);
    if (next) return { open: false, text: `Fechado agora · abre ${i === 1 ? "amanhã" : WEEK[d]} às ${next.open}` };
  }
  return null;
}

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
  scheduleReminder();
}

// O identificador só fica guardado no aparelho enquanto há autorização ativa.
function cartToken() {
  reminder.token ||= crypto.randomUUID();
  return reminder.token;
}

function restoreReminder() {
  try {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (/^[0-9a-f-]{36}$/.test(saved || "")) {
      reminder.token = saved;
      reminder.saved = true;
      $("checkout").elements.cart_consent.checked = true;
    }
  } catch { /* opcional */ }
}

function scheduleReminder() {
  clearTimeout(reminder.timer);
  reminder.timer = setTimeout(syncReminder, 1200);
}

async function syncReminder() {
  const f = $("checkout").elements;
  const consent = f.cart_consent.checked;
  const ready = cart.size && f.customer_name.value.trim() && String(f.customer_phone.value).replace(/\D/g, "").length >= 10;
  try {
    if (consent && ready) {
      await api(`/api/cart-reminder/${encodeURIComponent(slug)}`, {
        method: "PUT",
        body: { token: cartToken(), consent: true, customer_name: f.customer_name.value, customer_phone: f.customer_phone.value, items: cartItemsPayload() },
      });
      reminder.saved = true;
      try { localStorage.setItem(TOKEN_KEY, reminder.token); } catch { /* opcional */ }
    } else if (reminder.saved && (!consent || !cart.size)) {
      await api(`/api/cart-reminder/${encodeURIComponent(slug)}/${cartToken()}`, { method: "DELETE" });
      reminder.saved = false;
      try { localStorage.removeItem(TOKEN_KEY); } catch { /* opcional */ }
    }
  } catch { /* lembrete é opcional: não atrapalha a compra */ }
}

function forgetReminderToken() {
  clearTimeout(reminder.timer);
  reminder.token = null;
  reminder.saved = false;
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* opcional */ }
  $("checkout").elements.cart_consent.checked = false;
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
      discount ? h("span", { class: "badge badge-orange tag", text: `-${discount}%` }) : soldOut ? h("span", { class: "badge badge-danger tag", text: "Esgotado" }) : null,
      p.is_new && !soldOut ? h("span", { class: `badge tag ${discount ? "tag-new" : ""}`, text: "Novo" }) : null),
    favButton(p),
    h("div", { class: "product-body" },
      h("button", { class: "product-name", text: p.name, onclick: () => openProduct(p) }),
      priceNode(p),
      action));
}

function visibleProducts() {
  const q = $("search").value.trim().toLowerCase();
  const [min, max] = ($("price-range").value || "-").split("-").map((x) => (x === "" ? null : Number(x)));
  const list = store.products.filter((p) => (!category || p.category === category) &&
    (!q || `${p.name} ${p.description} ${p.category}`.toLowerCase().includes(q)) &&
    (!quick.has("promo") || p.final_price_cents < p.price_cents) &&
    (!quick.has("new") || p.is_new) &&
    (!quick.has("fav") || favorites.has(p.id)) &&
    (min === null || p.final_price_cents >= min) && (max === null || p.final_price_cents < max));
  const sort = $("sort").value;
  const byPrice = (a, b) => a.final_price_cents - b.final_price_cents;
  if (sort === "price-asc") list.sort(byPrice);
  if (sort === "price-desc") list.sort((a, b) => byPrice(b, a));
  if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  if (sort === "new") list.sort((a, b) => Number(b.is_new) - Number(a.is_new));
  // Esgotados vão para o fim, mas continuam visíveis.
  return list.sort((a, b) => Number(a.stock === 0) - Number(b.stock === 0));
}

function renderProducts() {
  const list = visibleProducts();
  const filtering = !!(category || $("search").value.trim() || quick.size || $("price-range").value || $("sort").value);
  const favChip = document.querySelector('#quick-filters [data-filter="fav"]');
  favChip.textContent = favorites.size ? `Favoritos (${favorites.size})` : "Favoritos";
  const featured = store.products.filter((p) => p.featured);
  $("featured-section").hidden = filtering || !featured.length;
  $("featured").replaceChildren(...(filtering ? [] : featured.map(productCard)));
  $("all-title").textContent = category || ($("search").value.trim() ? "Resultados da busca" : quick.has("fav") ? "Seus favoritos" : quick.has("promo") ? "Ofertas" : quick.has("new") ? "Novidades" : "Todos os produtos");
  if (!list.length) {
    const none = !store.products.length ? "Esta loja ainda não publicou produtos." : quick.has("fav") && !favorites.size ? "Toque no coração dos produtos para guardá-los aqui." : "Nenhum produto encontrado com esses filtros.";
    $("products").replaceChildren(h("p", { class: "empty", style: { gridColumn: "1/-1" }, text: none }));
  } else {
    $("products").replaceChildren(...list.map(productCard));
  }
}

function renderCategories() {
  const cats = sortCategories(new Set(store.products.map((p) => p.category).filter(Boolean)), store.category_order);
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
  const subtotal = lines.reduce((s, l) => s + l.qty * l.price, 0);
  const preview = coupon.preview && coupon.preview.subtotal_cents === subtotal ? coupon.preview : null;
  const afterDiscount = preview ? preview.total_cents : subtotal;
  const fee = deliveryFee(afterDiscount);
  const total = afterDiscount + fee;
  $("cart-fee-row").hidden = selectedFulfillment() !== "delivery" || !count;
  $("cart-fee").textContent = fee ? money(fee) : "Grátis";
  $("cart-sub-row").hidden = !preview;
  $("cart-disc-row").hidden = !preview;
  if (preview) {
    $("cart-subtotal").textContent = money(subtotal);
    $("cart-disc-label").textContent = `Cupom ${preview.coupon_code}`;
    $("cart-disc-value").textContent = `− ${money(preview.discount_cents)}`;
  }
  // O carrinho mudou com um cupom aplicado: recalcula no servidor.
  if (coupon.code && !preview && count) {
    clearTimeout(coupon.timer);
    coupon.timer = setTimeout(() => applyCoupon(coupon.code, { quiet: true }), 300);
  }
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
  updateFavButton();
  const related = store.products.filter((x) => x.id !== p.id && x.stock > 0 && p.category && x.category === p.category).slice(0, 4);
  const fill = related.length >= 2 ? related : [...related, ...store.products.filter((x) => x.id !== p.id && x.stock > 0 && x.featured && !related.includes(x))].slice(0, 4);
  $("pd-related-box").hidden = !fill.length;
  $("pd-related").replaceChildren(...fill.map((x) => h("button", { type: "button", class: "related-item", onclick: () => openProduct(x) },
    h("span", { class: "thumb", style: x.images[0] ? { backgroundImage: `url("${x.images[0]}")` } : {} }),
    h("span", { text: x.name }), h("strong", { text: money(x.final_price_cents) }))));

  // Cada produto tem endereço próprio (com título e prévia gerados no servidor).
  history.replaceState(null, "", productPath(p));
  document.title = `${p.name} | ${store.name}`;
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

function selectedFulfillment() {
  return document.querySelector('input[name="fulfillment"]:checked')?.value || "";
}

// Mesma regra do servidor: frete grátis compara o valor já com desconto.
function deliveryFee(amount) {
  const d = store?.delivery;
  if (!d?.delivery || selectedFulfillment() !== "delivery") return 0;
  return d.free_above_cents !== null && amount >= d.free_above_cents ? 0 : d.fee_cents;
}

function setupDelivery() {
  const d = store.delivery || {};
  $("ship-box").hidden = !d.pickup && !d.delivery;
  $("opt-pickup").hidden = !d.pickup;
  $("opt-delivery").hidden = !d.delivery;
  $("fee-note").textContent = !d.delivery ? "" : (d.fee_cents ? `Taxa de ${money(d.fee_cents)}` : "Entrega grátis") +
    (d.free_above_cents !== null && d.fee_cents ? ` · grátis acima de ${money(d.free_above_cents)}` : "");
  const only = d.pickup && !d.delivery ? "pickup" : d.delivery && !d.pickup ? "delivery" : "";
  if (only) document.querySelector(`input[name="fulfillment"][value="${only}"]`).checked = true;
  updateShipping();
}

function updateShipping() {
  const delivery = selectedFulfillment() === "delivery";
  $("address-field").hidden = !delivery;
  $("checkout").elements.address.required = delivery;
  renderCart();
}

function cartItemsPayload() {
  return cartLines().map((l) => ({ id: l.product.id, ...(l.variant ? { variant_id: l.variant.id } : {}), quantity: l.qty }));
}

function couponMessage(text, kind) {
  const el = $("coupon-msg");
  el.textContent = text;
  el.className = `coupon-msg ${kind}`;
  el.hidden = !text;
}

async function applyCoupon(code, { quiet = false } = {}) {
  code = String(code || "").trim().toUpperCase();
  if (!code) {
    coupon.code = "";
    coupon.preview = null;
    couponMessage("", "");
    return renderCart();
  }
  const button = $("apply-coupon");
  button.disabled = true;
  try {
    const preview = await api(`/api/order-preview/${encodeURIComponent(slug)}`, { method: "POST", body: { items: cartItemsPayload(), coupon_code: code } });
    if (!preview.valid) {
      coupon.code = "";
      coupon.preview = null;
      couponMessage(quiet ? `O cupom deixou de valer para este pedido: ${preview.error}` : preview.error, "error");
      return;
    }
    coupon.preview = preview;
    coupon.code = code;
    couponMessage(`Cupom aplicado: você economiza ${money(preview.discount_cents)}.`, "ok");
  } catch (error) {
    coupon.code = "";
    coupon.preview = null;
    couponMessage(error.message, "error");
  } finally {
    button.disabled = false;
    renderCart();
  }
}

function orderMessage(order, data) {
  const lines = order.items.map((i) => `${i.quantity}x ${i.name}${i.variant_name ? ` (${i.variant_name})` : ""} — ${money(i.price_cents * i.quantity)}`);
  return [
    `Olá, ${store.name}! Quero fazer o pedido #${order.code}:`,
    "",
    ...lines,
    "",
    order.discount_cents ? `Subtotal: ${money(order.subtotal_cents)}` : null,
    order.discount_cents ? `Cupom ${order.coupon_code}: − ${money(order.discount_cents)}` : null,
    order.fulfillment === "delivery" ? `Entrega: ${order.delivery_fee_cents ? money(order.delivery_fee_cents) : "grátis"}` : null,
    `Total: ${money(order.total_cents)}`,
    `Nome: ${data.customer_name}`,
    order.fulfillment === "pickup" ? "Retirada na loja" : null,
    order.fulfillment === "delivery" ? `Entrega em: ${order.address}` : null,
    data.notes ? `Observações: ${data.notes}` : null,
    order.tracking_url ? `Acompanhe o pedido: ${location.origin}${order.tracking_url}` : null,
  ].filter((l) => l !== null).join("\n");
}

async function checkout(event) {
  event.preventDefault();
  const form = event.target;
  const { cart_consent: _consent, ...data } = Object.fromEntries(new FormData(form));
  const err = $("checkout-error");
  err.hidden = true;
  const digits = String(data.customer_phone).replace(/\D/g, "");
  if (!data.customer_name.trim()) return showError("Informe seu nome.");
  if (digits.length < 10) return showError("Informe um telefone com DDD.");
  if (!$("ship-box").hidden && !selectedFulfillment()) return showError("Escolha se vai retirar na loja ou receber em casa.");
  if (selectedFulfillment() === "delivery" && String(data.address || "").trim().length < 8) return showError("Informe o endereço de entrega.");
  const button = $("send-order");
  button.disabled = true;
  try {
    const order = await api(`/api/order-request/${encodeURIComponent(slug)}`, {
      method: "POST",
      body: { ...data, coupon_code: coupon.code, items: cartItemsPayload(), cart_token: cartToken() },
    });
    forgetReminderToken();
    cart.clear();
    coupon.code = "";
    coupon.preview = null;
    $("coupon-input").value = "";
    couponMessage("", "");
    saveCart();
    renderCart();
    renderProducts();
    try { localStorage.setItem("def-buyer", JSON.stringify({ customer_name: data.customer_name, customer_phone: data.customer_phone })); } catch { /* opcional */ }
    if (/^\d{10,15}$/.test(store.whatsapp || "")) {
      location.href = `https://wa.me/${store.whatsapp}?text=${encodeURIComponent(orderMessage(order, data))}`;
    } else {
      toast(`Pedido #${order.code} enviado! A loja entrará em contato.`);
      if (order.tracking_url) setTimeout(() => { location.href = order.tracking_url; }, 1500);
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
  // ?modelo= mostra a prévia de outro modelo sem salvar (usado no painel).
  const preview = new URLSearchParams(location.search).get("modelo");
  const template = TEMPLATES.includes(preview) ? preview : store.template;
  document.body.classList.add(`tpl-${template || "geral"}`);
  if (preview && TEMPLATES.includes(preview)) {
    $("preview-bar").textContent = "Prévia do modelo: salve em Minha loja para aplicar.";
    $("preview-bar").hidden = false;
  }
  $("announce").textContent = store.announcement || "";
  $("announce").hidden = !store.announcement;
  const hours = hoursStatus(store.hours);
  if (hours) {
    const line = $("store-hours");
    line.classList.toggle("open", hours.open);
    line.replaceChildren(h("span", { class: "dot" }), hours.text);
    line.hidden = false;
  }
  storeTitle = `${store.name} | Catálogo`;
  if (!location.pathname.includes("/p/")) document.title = storeTitle;
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
  // Link de QR Code/campanha para uma categoria: ?categoria=Vestidos
  const fromLink = new URLSearchParams(location.search).get("categoria");
  if (fromLink && store.products.some((p) => p.category === fromLink)) category = fromLink;
  restoreReminder();
  loadCart();
  setupDelivery();
  renderCategories();
  renderProducts();
  renderCart();
  // /loja/<loja>/p/<id> ou o formato antigo #p-<id>
  const linked = location.pathname.match(/\/p\/([0-9a-f-]{36})\/?$/) || location.hash.match(/^#p-([0-9a-f-]{36})$/);
  const target = linked && store.products.find((p) => p.id === linked[1]);
  if (target) openProduct(target);
}

$("search").addEventListener("input", renderProducts);
$("price-range").addEventListener("change", renderProducts);
$("sort").addEventListener("change", renderProducts);
$("quick-filters").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-filter]");
  if (!chip) return;
  const f = chip.dataset.filter;
  if (quick.has(f)) quick.delete(f); else quick.add(f);
  chip.setAttribute("aria-pressed", String(quick.has(f)));
  renderProducts();
});
$("pd-fav").addEventListener("click", () => current && toggleFavorite(current));
$("cart-bar").addEventListener("click", () => $("cart-dialog").showModal());
$("checkout").addEventListener("submit", checkout);
for (const name of ["customer_name", "customer_phone", "cart_consent"]) {
  $("checkout").elements[name].addEventListener(name === "cart_consent" ? "change" : "input", scheduleReminder);
}
$("share-store").addEventListener("click", () => share(store.name, `${location.origin}/loja/${slug}`));
for (const radio of document.querySelectorAll('input[name="fulfillment"]')) radio.addEventListener("change", updateShipping);
$("apply-coupon").addEventListener("click", () => applyCoupon($("coupon-input").value));
$("coupon-input").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault(); // Enter aqui aplica o cupom em vez de enviar o pedido
  applyCoupon(e.target.value);
});
$("pd-add").addEventListener("click", () => {
  const key = cartKey(current, currentVariant);
  setQuantity(current, (cart.get(key) || 0) + 1, currentVariant);
  $("product-dialog").close();
  toast(`${current.name}${currentVariant ? ` (${currentVariant.name})` : ""} adicionado ao pedido.`);
});
$("pd-share").addEventListener("click", () => share(current.name, location.origin + productPath(current)));
$("product-dialog").addEventListener("close", () => {
  history.replaceState(null, "", `/loja/${slug}`);
  document.title = storeTitle;
});
for (const btn of document.querySelectorAll("[data-close]")) btn.addEventListener("click", () => btn.closest("dialog").close());

start();
