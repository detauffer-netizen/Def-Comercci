// Validação de entradas. Todo dado vindo do cliente passa por aqui.

import { HttpError } from "./http.js";

// Remove caracteres de controle (exceto quebra de linha quando permitido).
export function cleanText(value, max, { multiline = false } = {}) {
  let text = String(value ?? "");
  text = multiline
    ? text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "")
    : text.replace(/[\u0000-\u001F\u007F]/g, " ");
  text = text.trim();
  if (text.length > max) throw new HttpError(400, `Texto muito longo (máximo ${max} caracteres)`);
  return text;
}

export function requiredText(value, max, label) {
  const text = cleanText(value, max);
  if (!text) throw new HttpError(400, `Informe ${label}`);
  return text;
}

export function cents(value, label, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === "")) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000_000_00) {
    throw new HttpError(400, `Valor inválido para ${label}`);
  }
  return value;
}

export function quantity(value, label, max = 1_000_000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new HttpError(400, `Quantidade inválida para ${label}`);
  }
  return value;
}

export function phone(value, { optional = false } = {}) {
  const digits = String(value ?? "").replace(/[^0-9]/g, "");
  if (optional && !digits) return "";
  if (!/^[0-9]{10,15}$/.test(digits)) {
    throw new HttpError(400, "Telefone inválido: use DDD e número (com DDI para WhatsApp)");
  }
  return digits;
}

export function email(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    throw new HttpError(400, "E-mail inválido");
  }
  return text;
}

export function slug(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,58})[a-z0-9]$/.test(text) || text.includes("--")) {
    throw new HttpError(400, "Endereço da loja inválido: use de 3 a 60 letras minúsculas, números e hífens");
  }
  if (RESERVED_SLUGS.has(text)) throw new HttpError(400, "Este endereço é reservado; escolha outro");
  return text;
}

export function password(value) {
  const text = String(value ?? "");
  if (text.length < 12 || text.length > 128) {
    throw new HttpError(400, "A senha deve ter de 12 a 128 caracteres");
  }
  return text;
}

export function color(value) {
  const text = String(value ?? "");
  if (!/^#[0-9a-fA-F]{6}$/.test(text)) throw new HttpError(400, "Cor inválida");
  return text.toLowerCase();
}

export const TEMPLATES = ["geral", "roupas", "eletronicos", "utilidades", "ferramentas", "moveis", "cosmeticos"];

// Horário de funcionamento: até 2 faixas por dia da semana.
export function hours(value) {
  if (value === null || value === undefined || value === "") return [];
  if (!Array.isArray(value) || value.length > 14) throw new HttpError(400, "Horário de funcionamento inválido");
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  const perDay = new Map();
  const out = value.map((slot) => {
    const d = Number(slot?.d);
    if (!Number.isInteger(d) || d < 0 || d > 6 || !time.test(slot?.open || "") || !time.test(slot?.close || "") || slot.open >= slot.close) {
      throw new HttpError(400, "Horário de funcionamento inválido: confira os dias e horas");
    }
    perDay.set(d, (perDay.get(d) || 0) + 1);
    if (perDay.get(d) > 2) throw new HttpError(400, "Use no máximo dois horários por dia");
    return { d, open: slot.open, close: slot.close };
  });
  return out.sort((a, b) => a.d - b.d || a.open.localeCompare(b.open));
}

export function flag(value) {
  return value === true || value === 1 || value === "1" ? 1 : 0;
}

export function id(value) {
  const text = String(value ?? "");
  if (!/^[0-9a-f-]{36}$/.test(text)) throw new HttpError(404, "Registro não encontrado");
  return text;
}

const RESERVED_SLUGS = new Set([
  "admin", "api", "painel", "loja", "img", "www", "app", "suporte", "ajuda", "def-commerce", "defcommerce",
]);
