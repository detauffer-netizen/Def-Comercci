// Funções compartilhadas pelo painel e pela vitrine.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = "GET", body, blob } = {}) {
  const init = { method, headers: {}, credentials: "same-origin" };
  if (blob) {
    init.body = blob;
    init.headers["Content-Type"] = blob.type;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, "Sem conexão. Verifique sua internet e tente novamente.");
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* resposta sem JSON */
  }
  if (!response.ok) throw new ApiError(response.status, data?.error || "Não foi possível concluir a operação.");
  return data;
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const money = (cents) => BRL.format((cents || 0) / 100);

// "59,90", "1.299,00", "59.9" → centavos. Retorna null quando inválido.
export function parseMoney(text) {
  let value = String(text ?? "").trim().replace(/[R$\s]/g, "");
  if (!value) return null;
  if (value.includes(",")) value = value.replace(/\./g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return NaN;
  return Math.round(Number(value) * 100);
}

export const centsToInput = (cents) => (cents === null || cents === undefined ? "" : (cents / 100).toFixed(2).replace(".", ","));

// Construtor de elementos seguro: texto sempre via textContent.
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function icon(name, cls = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

let toastTimer;
export function toast(message, { error = false } = {}) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), error ? 6000 : 3200);
}

// Redimensiona para no máximo `max` px e converte para WebP (ou JPEG),
// reduzindo bastante o tamanho antes do upload.
export async function compressImage(file, { max = 1600, quality = 0.82 } = {}) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Use fotos em JPEG, PNG ou WebP.");
  if (file.size > 25 * 1024 * 1024) throw new Error("Foto muito grande (máximo 25 MB).");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const toBlob = (type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));
  let blob = await toBlob("image/webp", quality);
  if (!blob || blob.type !== "image/webp") blob = await toBlob("image/jpeg", quality);
  if (blob.size > 2 * 1024 * 1024) blob = await toBlob("image/jpeg", 0.65);
  if (blob.size > 2 * 1024 * 1024) throw new Error("Não foi possível reduzir a foto para menos de 2 MB.");
  return blob;
}

// Evita injeção de fórmulas ao abrir o CSV no Excel/Planilhas.
export function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function downloadCsv(filename, header, rows) {
  const csv = [header.map(csvCell).join(";"), ...rows.map((r) => r.map(csvCell).join(";"))].join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatDate(sqlDate) {
  if (!sqlDate) return "";
  const date = new Date(sqlDate.replace(" ", "T") + "Z");
  return date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function formatPhone(digits) {
  const d = String(digits || "");
  const m = d.match(/^(55)?(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[2]}) ${m[3]}-${m[4]}` : d;
}

export function whatsappLink(phone, text) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) digits = "55" + digits;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
