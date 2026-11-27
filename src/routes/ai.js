// Assistente de IA do lojista (Workers AI). Toda resposta é sugestão para o
// lojista revisar; nenhuma rota daqui grava produtos ou preços.

import { HttpError, json, readJson } from "../lib/http.js";
import { audit } from "../lib/session.js";
import { readImageUpload } from "../lib/images.js";
import {
  PRODUCT_SCHEMA, SYSTEM_PRODUCT, TEXT_MODEL, VISION_MODEL, cleanProductSuggestion, consumeQuota, requireAI, runJson, usage,
} from "../lib/ai.js";
import * as v from "../lib/validate.js";

const toBase64 = (bytes) => {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
};

async function track(env, session, action) {
  await audit(env.DB, { storeId: session.store.id, userId: session.user.id, action: "ai.used", detail: action });
}

export async function aiUsage(request, env, session) {
  return json(await usage(env, session.store.id));
}

// "Camiseta azul de algodão, P M G, 59,90" → sugestão de cadastro.
export async function productFromText(request, env, session) {
  requireAI(env);
  const message = v.requiredText((await readJson(request)).text, 1000, "a descrição do produto");
  const quota = await consumeQuota(env, session.store.id);
  const raw = await runJson(env, TEXT_MODEL, [
    { role: "system", content: SYSTEM_PRODUCT },
    { role: "user", content: `Monte o cadastro deste produto a partir da mensagem do lojista:\n"""${message}"""` },
  ], PRODUCT_SCHEMA);
  await track(env, session, "product-from-text");
  return json({ suggestion: cleanProductSuggestion(raw), usage: quota });
}

// Foto do produto (JPEG/PNG/WebP, até 2 MB) → sugestão de nome, descrição e
// categoria. O preço nunca é deduzido da foto.
export async function productFromPhoto(request, env, session) {
  requireAI(env);
  const hint = v.cleanText(new URL(request.url).searchParams.get("hint"), 300);
  const upload = await readImageUpload(request);
  const quota = await consumeQuota(env, session.store.id);
  const raw = await runJson(env, VISION_MODEL, [
    { role: "system", content: SYSTEM_PRODUCT },
    {
      role: "user",
      content: [
        { type: "text", text: `Descreva este produto para cadastro na loja. Defina price_reais como null.${hint ? ` Informação do lojista: ${hint}` : ""}` },
        { type: "image_url", image_url: { url: `data:${upload.contentType};base64,${toBase64(upload.bytes)}` } },
      ],
    },
  ], PRODUCT_SCHEMA);
  const suggestion = cleanProductSuggestion(raw);
  suggestion.price_cents = null;
  await track(env, session, "product-from-photo");
  return json({ suggestion, usage: quota });
}

const DESCRIPTION_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Título comercial melhorado, curto" },
    description: { type: "string", description: "Descrição persuasiva e honesta, 2 a 4 frases" },
  },
  required: ["name", "description"],
};

export async function improveDescription(request, env, session) {
  requireAI(env);
  const body = await readJson(request);
  const name = v.requiredText(body.name, 120, "o nome do produto");
  const description = v.cleanText(body.description, 2000, { multiline: true });
  const category = v.cleanText(body.category, 80);
  const quota = await consumeQuota(env, session.store.id);
  const raw = await runJson(env, TEXT_MODEL, [
    { role: "system", content: SYSTEM_PRODUCT },
    { role: "user", content: `Melhore o título e a descrição para vender mais, sem inventar características.\nNome: ${name}\nCategoria: ${category || "-"}\nDescrição atual: ${description || "(vazia)"}` },
  ], DESCRIPTION_SCHEMA, 600);
  await track(env, session, "improve-description");
  return json({
    suggestion: { name: String(raw.name ?? "").trim().slice(0, 120) || name, description: String(raw.description ?? "").trim().slice(0, 2000) },
    usage: quota,
  });
}

const CAMPAIGN_SCHEMA = {
  type: "object",
  properties: {
    whatsapp_message: { type: "string", description: "Mensagem curta para enviar a clientes no WhatsApp, com chamada para o link" },
    instagram_caption: { type: "string", description: "Legenda para Instagram com até 5 hashtags relevantes" },
    ideas: { type: "array", items: { type: "string" }, description: "3 ideias práticas de divulgação" },
  },
  required: ["whatsapp_message", "instagram_caption", "ideas"],
};

// Textos de divulgação com base nos produtos REAIS da loja (lidos do banco).
export async function campaign(request, env, session) {
  requireAI(env);
  const body = await readJson(request);
  const goal = v.requiredText(body.goal, 300, "o objetivo da divulgação");
  const ids = Array.isArray(body.product_ids) ? body.product_ids.filter((x) => typeof x === "string").slice(0, 5) : [];
  const rows = ids.length
    ? (await env.DB.prepare(
      `SELECT name,price_cents,promo_price_cents FROM products
        WHERE store_id=? AND active=1 AND id IN (SELECT value FROM json_each(?))`,
    ).bind(session.store.id, JSON.stringify(ids)).all()).results
    : (await env.DB.prepare(
      "SELECT name,price_cents,promo_price_cents FROM products WHERE store_id=? AND active=1 ORDER BY featured DESC, position LIMIT 5",
    ).bind(session.store.id).all()).results;
  if (!rows.length) throw new HttpError(400, "Cadastre e publique produtos antes de gerar a divulgação");
  const money = (c) => `R$ ${(c / 100).toFixed(2).replace(".", ",")}`;
  const list = rows.map((p) => `- ${p.name}: ${p.promo_price_cents !== null && p.promo_price_cents < p.price_cents ? `de ${money(p.price_cents)} por ${money(p.promo_price_cents)}` : money(p.price_cents)}`).join("\n");
  const url = `${new URL(request.url).origin}/loja/${session.store.slug}`;
  const quota = await consumeQuota(env, session.store.id);
  const raw = await runJson(env, TEXT_MODEL, [
    { role: "system", content: `${SYSTEM_PRODUCT} Use somente os produtos e preços listados, exatamente como estão.` },
    { role: "user", content: `Loja: ${session.store.name}\nLink do catálogo: ${url}\nObjetivo: ${goal}\nProdutos:\n${list}` },
  ], CAMPAIGN_SCHEMA, 900);
  await track(env, session, "campaign");
  return json({
    suggestion: {
      whatsapp_message: String(raw.whatsapp_message ?? "").trim().slice(0, 1500),
      instagram_caption: String(raw.instagram_caption ?? "").trim().slice(0, 2200),
      ideas: (Array.isArray(raw.ideas) ? raw.ideas : []).map((i) => String(i).trim().slice(0, 300)).filter(Boolean).slice(0, 5),
    },
    usage: quota,
  });
}
