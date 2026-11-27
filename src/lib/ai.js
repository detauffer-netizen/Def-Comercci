// Inteligência artificial com Cloudflare Workers AI (binding AI).
// Toda saída do modelo é tratada como sugestão: validada, limitada e sempre
// revisada pelo lojista antes de salvar. Nada é gravado automaticamente.

import { HttpError } from "./http.js";

export const TEXT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const DEFAULT_DAILY_LIMIT = 30;

export function requireAI(env) {
  if (!env.AI) throw new HttpError(503, "Inteligência artificial ainda não configurada nesta instalação");
  return env.AI;
}

export function dailyLimit(env) {
  const n = Number(env.AI_DAILY_LIMIT);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT;
}

const today = () => new Date().toISOString().slice(0, 10);

// Reserva um uso do dia de forma atômica; recusa acima do limite.
export async function consumeQuota(env, storeId) {
  const limit = dailyLimit(env);
  const row = await env.DB.prepare(
    `INSERT INTO ai_usage(store_id,day,requests) VALUES(?,?,1)
     ON CONFLICT(store_id,day) DO UPDATE SET requests=requests+1 WHERE requests < ?
     RETURNING requests`,
  ).bind(storeId, today(), limit).first();
  if (!row) throw new HttpError(429, `Limite diário de ${limit} usos de IA atingido. Tente novamente amanhã.`);
  return { used: row.requests, limit };
}

export async function usage(env, storeId) {
  const row = await env.DB.prepare("SELECT requests FROM ai_usage WHERE store_id=? AND day=?").bind(storeId, today()).first();
  return { used: row?.requests || 0, limit: dailyLimit(env), available: !!env.AI };
}

// Extrai o objeto JSON da resposta (objeto pronto ou texto com JSON).
export function parseModelJson(result) {
  const value = result?.response ?? result?.result?.response ?? result;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const text = String(value ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function runJson(env, model, messages, schema, maxTokens = 900) {
  let result;
  try {
    result = await requireAI(env).run(model, {
      messages,
      response_format: { type: "json_schema", json_schema: schema },
      max_tokens: maxTokens,
      temperature: 0.4,
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error("ai_error", model, error?.message || error);
    throw new HttpError(502, "A IA não respondeu agora. Tente novamente em instantes.");
  }
  const data = parseModelJson(result);
  if (!data) throw new HttpError(502, "A IA não conseguiu gerar uma resposta válida. Tente reformular.");
  return data;
}

// ---- Higienização das sugestões ----

const text = (value, max) => String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);

export function cleanProductSuggestion(raw) {
  const price = Number(raw?.price_reais);
  const variants = Array.isArray(raw?.variants) ? raw.variants : [];
  const seen = new Set();
  return {
    name: text(raw?.name, 120),
    description: text(raw?.description, 2000),
    category: text(raw?.category, 80),
    // Preço só quando informado pelo lojista; nunca inventado pela foto.
    price_cents: Number.isFinite(price) && price > 0 && price < 1e8 ? Math.round(price * 100) : null,
    variants: variants
      .map((v) => text(typeof v === "string" ? v : v?.name, 60))
      .filter((v) => v && !seen.has(v.toLowerCase()) && seen.add(v.toLowerCase()))
      .slice(0, 30),
    features: (Array.isArray(raw?.features) ? raw.features : []).map((f) => text(f, 120)).filter(Boolean).slice(0, 8),
  };
}

export const PRODUCT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Título comercial curto do produto, em português" },
    description: { type: "string", description: "Descrição persuasiva e honesta, 2 a 4 frases, em português" },
    category: { type: "string", description: "Categoria curta, ex.: Camisetas, Bolos, Brincos" },
    price_reais: { type: ["number", "null"], description: "Preço em reais SOMENTE se informado pelo lojista; caso contrário null" },
    variants: { type: "array", items: { type: "string" }, description: "Opções informadas (tamanhos, cores, sabores); vazio se não houver" },
    features: { type: "array", items: { type: "string" }, description: "Características observadas ou informadas" },
  },
  required: ["name", "description", "category", "price_reais", "variants", "features"],
};

export const SYSTEM_PRODUCT = [
  "Você é um assistente de cadastro de produtos para pequenas lojas brasileiras que vendem pelo WhatsApp.",
  "Responda sempre em português do Brasil, em JSON conforme o schema.",
  "Não invente informações: preço, tamanhos, cores, materiais e medidas só se forem informados ou claramente visíveis.",
  "Não faça promessas de saúde, resultado ou ganho financeiro. Não use emojis nem letras maiúsculas exageradas.",
].join(" ");
