// TOTP (RFC 6238): códigos de 6 dígitos a cada 30 s, compatíveis com Google
// Authenticator, Microsoft Authenticator, Authy etc.

import { randomToken, sha256, timingSafeEqual } from "./crypto.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("base32 inválido");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function newSecret() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

export async function totpAt(secret, step) {
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = new ArrayBuffer(8);
  const view = new DataView(counter);
  view.setUint32(0, Math.floor(step / 2 ** 32));
  view.setUint32(4, step >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = mac[mac.length - 1] & 15;
  const code = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

export const currentStep = (now = Date.now()) => Math.floor(now / 30000);

// Aceita o passo atual e um de cada lado (relógios fora de sincronia) e
// recusa passos já usados (proteção contra reutilização do mesmo código).
export async function verifyTotp(secret, code, lastStep, now = Date.now()) {
  const value = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(value) || !secret) return null;
  const step = currentStep(now);
  for (const s of [step - 1, step, step + 1]) {
    if (s <= lastStep) continue;
    if (timingSafeEqual(await totpAt(secret, s), value)) return s;
  }
  return null;
}

export function otpauthUri(secret, account) {
  const label = encodeURIComponent(`Def Commerce:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=Def%20Commerce&algorithm=SHA1&digits=6&period=30`;
}

// Códigos de recuperação: usados uma única vez, guardados só como hash.
export async function newRecoveryCodes(count = 8) {
  const codes = Array.from({ length: count }, () => randomToken(5).toUpperCase().replace(/(.{5})(.{5})/, "$1-$2"));
  const hashes = await Promise.all(codes.map((c) => sha256(c)));
  return { codes, stored: hashes.join(",") };
}

export async function useRecoveryCode(stored, code) {
  const normalized = String(code ?? "").trim().toUpperCase();
  if (!/^[0-9A-F]{5}-[0-9A-F]{5}$/.test(normalized)) return null;
  const hash = await sha256(normalized);
  const list = String(stored || "").split(",").filter(Boolean);
  if (!list.includes(hash)) return null;
  return list.filter((h) => h !== hash).join(",");
}
