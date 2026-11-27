import { api, formatDate, h, money, whatsappLink } from "./common.js";

const $ = (id) => document.getElementById(id);
const token = location.pathname.split("/").filter(Boolean)[1] || "";

async function start() {
  let o;
  try {
    o = await api(`/api/order-status/${encodeURIComponent(token)}`);
  } catch (error) {
    $("track").removeAttribute("aria-busy");
    $("store-name").textContent = "Pedido não encontrado";
    $("error").textContent = error.status === 404 ? "Confira o link enviado pela loja." : error.message;
    $("error").hidden = false;
    return;
  }
  $("track").removeAttribute("aria-busy");
  document.documentElement.style.setProperty("--accent", o.store.accent);
  document.title = `Pedido #${o.code} | ${o.store.name}`;
  $("store-name").textContent = o.store.name;
  const logo = $("logo");
  if (o.store.logo_url) logo.style.backgroundImage = `url("${o.store.logo_url}")`;
  else logo.textContent = o.store.name.slice(0, 1).toUpperCase();

  $("order-code").textContent = `Pedido #${o.code} · ${formatDate(o.created_at)}${o.first_name ? ` · ${o.first_name}` : ""}`;
  $("status-label").textContent = o.status_label;
  const order = ["pending", "confirmed", "completed"];
  const reached = order.indexOf(o.status);
  const steps = $("steps");
  steps.classList.toggle("cancelled", o.status === "cancelled");
  steps.replaceChildren(...["Recebido", "Confirmado", "Concluído"].map((label, i) =>
    h("li", { class: o.status !== "cancelled" && i <= reached ? "done" : "", text: label })));
  $("status-note").textContent = {
    pending: "A loja vai conferir o estoque e confirmar pelo WhatsApp. O pagamento é combinado direto com a loja.",
    confirmed: o.fulfillment === "pickup" ? "Seu pedido está separado. Combine a retirada com a loja." : "A loja está preparando o seu pedido.",
    completed: o.has_returns ? "Pedido concluído (com devolução registrada)." : "Pedido entregue. Obrigado pela compra!",
    cancelled: "Este pedido foi cancelado. Em caso de dúvida, fale com a loja.",
  }[o.status] || "";
  $("status-card").hidden = false;

  $("items").replaceChildren(...o.items.map((i) => h("div", { class: "item-line" },
    h("span", { text: `${i.quantity}× ${i.name}${i.variant_name ? ` (${i.variant_name})` : ""}` }),
    h("span", { text: money(i.price_cents * i.quantity) }))));
  const row = (label, value, cls = "") => h("div", { class: cls }, h("span", { text: label }), h("span", { text: value }));
  $("totals").replaceChildren(...[
    o.discount_cents ? row("Desconto", `− ${money(o.discount_cents)}`) : null,
    o.fulfillment === "delivery" ? row("Entrega", o.delivery_fee_cents ? money(o.delivery_fee_cents) : "grátis") : null,
    o.fulfillment === "pickup" ? row("Retirada na loja", "") : null,
    row("Total", money(o.total_cents), "total"),
  ].filter(Boolean));
  $("items-card").hidden = false;

  $("back").href = `/loja/${o.store.slug}`;
  if (/^\d{10,15}$/.test(o.store.whatsapp || "")) {
    $("talk").href = whatsappLink(o.store.whatsapp, `Olá! Quero saber do meu pedido #${o.code}.`);
  } else {
    $("talk").hidden = true;
  }
  $("actions").hidden = false;
}

start();
